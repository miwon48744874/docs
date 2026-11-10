import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';

const root = import.meta.dirname;
const dataDir = process.env.FLASH_DATA_DIR || join(root, 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'app.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, price_cents INTEGER NOT NULL CHECK(price_cents >= 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS one_demo_per_user ON orders(user_id) WHERE plan = 'Free demo';
`);
const now = () => new Date().toISOString();
// Add catalog snapshots without changing existing order records or the free-demo limit.
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
db.exec('BEGIN');
try {
  if (!orderColumns.includes('product_id')) db.exec('ALTER TABLE orders ADD COLUMN product_id TEXT REFERENCES products(id)');
  if (!orderColumns.includes('price_cents')) db.exec('ALTER TABLE orders ADD COLUMN price_cents INTEGER');
  db.prepare('INSERT OR IGNORE INTO products (id, name, price_cents, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('free-demo', 'Free demo', 0, 1, now(), now());
  db.prepare("UPDATE orders SET product_id = 'free-demo', price_cents = 0 WHERE plan = 'Free demo' AND product_id IS NULL").run();
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }

const hash = value => createHash('sha256').update(value).digest('hex');
function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const [salt, digest] = stored.split(':');
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const emailValid = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeEmail = value => value.trim().toLowerCase();
const adminEmail = process.env.FLASH_ADMIN_EMAIL;
const adminPassword = process.env.FLASH_ADMIN_PASSWORD;
if (adminEmail || adminPassword) {
  if (!adminEmail || !emailValid(adminEmail) || !adminPassword || adminPassword.length < 12) throw new Error('Provide FLASH_ADMIN_EMAIL and a FLASH_ADMIN_PASSWORD of at least 12 characters.');
  const email = normalizeEmail(adminEmail);
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (!existing) db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(randomUUID(), email, passwordHash(adminPassword), 'admin', now());
  else if (existing.role !== 'admin') throw new Error('Admin email already belongs to a customer. Use a separate address.');
}
const secureCookie = process.env.FLASH_SECURE_COOKIE === '1';
const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;
const attempts = new Map();
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function currentUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='));
  const token = cookie?.slice('session='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare('SELECT users.id, users.email, users.role FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').get(hash(token), Date.now());
}
function sessionCookie(res, user) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), user.id, Date.now() + 7 * 86400_000);
  res.setHeader('Set-Cookie', `session=${token}; ${cookieOptions}; Max-Age=604800`);
}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(raw || '{}');
}
function allowAttempt(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const record = attempts.get(ip);
  if (!record || record.until < Date.now()) { attempts.set(ip, { count: 1, until: Date.now() + 60_000 }); return true; }
  record.count++;
  return record.count <= 20;
}
const ordersForUser = db.prepare('SELECT id, plan, product_id, price_cents, network, address, status, created_at, updated_at FROM orders WHERE user_id = ? ORDER BY created_at DESC');
const allOrders = db.prepare('SELECT orders.id, orders.plan, orders.product_id, orders.price_cents, orders.network, orders.address, orders.status, orders.created_at, orders.updated_at, users.email FROM orders JOIN users ON users.id = orders.user_id ORDER BY orders.created_at DESC');
async function api(req, res, path) {
  if (req.method !== 'GET') {
    if (req.headers['x-requested-with'] !== 'flash-app' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 403, { error: 'Invalid request.' });
    if (req.headers.origin) {
      let originHost;
      try { originHost = new URL(req.headers.origin).host; } catch { return json(res, 403, { error: 'Invalid origin.' }); }
      if (originHost !== req.headers.host) return json(res, 403, { error: 'Invalid origin.' });
    }
  }
  if (path === '/api/products' && req.method === 'GET') return json(res, 200, { products: db.prepare('SELECT id, name, price_cents FROM products WHERE active = 1 ORDER BY created_at, id').all() });
  if (path === '/api/session' && req.method === 'GET') return json(res, 200, { user: currentUser(req) });
  if ((path === '/api/signup' || path === '/api/login') && req.method === 'POST') {
    if (!allowAttempt(req)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await bodyJson(req);
    if (!emailValid(body.email) || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) return json(res, 400, { error: 'Use a valid email and a password of 12 to 256 characters.' });
    const email = normalizeEmail(body.email);
    let user = db.prepare('SELECT id, email, role, password FROM users WHERE email = ?').get(email);
    if (path === '/api/signup') {
      if (user) return json(res, 409, { error: 'Unable to create account with this email.' });
      user = { id: randomUUID(), email, role: 'customer' };
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(user.id, email, passwordHash(body.password), 'customer', now());
    } else if (!user || !passwordMatches(body.password, user.password)) {
      return json(res, 401, { error: 'Invalid email or password.' });
    }
    sessionCookie(res, user);
    return json(res, 200, { user: { id: user.id, email: user.email, role: user.role } });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': `session=; ${cookieOptions}; Max-Age=0` });
  }
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Please sign in.' });
  if (path === '/api/orders' && req.method === 'GET') return json(res, 200, { orders: ordersForUser.all(user.id) });
  if (path === '/api/orders' && req.method === 'POST') {
    const body = await bodyJson(req);
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const formats = { BEP20: /^0x[0-9a-fA-F]{40}$/, ERC20: /^0x[0-9a-fA-F]{40}$/, TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, Solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
    if (!Object.hasOwn(formats, body.network) || !formats[body.network].test(address)) return json(res, 400, { error: 'Choose a network and enter a matching test address.' });
    // Preserve the original free-demo request format for existing clients.
    const productId = body.productId === undefined && body.plan === 'Free demo' ? 'free-demo' : body.productId;
    if (typeof productId !== 'string') return json(res, 400, { error: 'Choose an available product.' });
    const product = db.prepare('SELECT id, name, price_cents FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return json(res, 400, { error: 'Choose an available product.' });
    if (body.expectedPriceCents !== undefined && body.expectedPriceCents !== product.price_cents) return json(res, 409, { error: 'The product price changed. Please review the latest price.' });
    if (product.id === 'free-demo' && db.prepare("SELECT id FROM orders WHERE user_id = ? AND plan = 'Free demo'").get(user.id)) return json(res, 409, { error: 'The free demo is limited to one request per account.' });
    const id = randomUUID(); const timestamp = now();
    db.prepare('INSERT INTO orders (id, user_id, plan, network, address, status, created_at, updated_at, product_id, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, product.name, body.network, address, 'pending', timestamp, timestamp, product.id, product.price_cents);
    return json(res, 201, { id });
  }
  if (path === '/api/admin/products' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Administrator access required.' });
    return json(res, 200, { products: db.prepare('SELECT id, name, price_cents, active FROM products ORDER BY created_at, id').all() });
  }
  const productMatch = path.match(/^\/api\/admin\/products\/([0-9a-f-]+|free-demo)$/);
  if ((path === '/api/admin/products' && req.method === 'POST') || (productMatch && req.method === 'PATCH')) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Administrator access required.' });
    const body = await bodyJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !Number.isSafeInteger(body.priceCents) || body.priceCents < 0 || body.priceCents > 100_000_000 || typeof body.active !== 'boolean') return json(res, 400, { error: 'Enter a product name, a valid price, and availability.' });
    const productId = productMatch ? productMatch[1] : randomUUID();
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (productMatch && !existing) return json(res, 404, { error: 'Product not found.' });
    if (productId === 'free-demo' && (name !== 'Free demo' || body.priceCents !== 0 || !body.active)) return json(res, 400, { error: 'The free demo must remain available and free.' });
    const duplicate = db.prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE AND id != ?').get(name, productId);
    if (duplicate) return json(res, 409, { error: 'A product with this name already exists.' });
    const timestamp = now();
    if (productMatch) db.prepare('UPDATE products SET name = ?, price_cents = ?, active = ?, updated_at = ? WHERE id = ?').run(name, body.priceCents, Number(body.active), timestamp, productId);
    else db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)').run(productId, name, body.priceCents, Number(body.active), timestamp, timestamp);
    return json(res, productMatch ? 200 : 201, { id: productId });
  }
  if (path === '/api/admin/orders' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Administrator access required.' });
    return json(res, 200, { orders: allOrders.all() });
  }
  const match = path.match(/^\/api\/admin\/orders\/([0-9a-f-]+)$/);
  if (match && req.method === 'PATCH') {
    if (user.role !== 'admin') return json(res, 403, { error: 'Administrator access required.' });
    const body = await bodyJson(req);
    if (!['pending', 'reviewing', 'completed', 'rejected'].includes(body.status)) return json(res, 400, { error: 'Invalid status.' });
    const result = db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(body.status, now(), match[1]);
    if (!result.changes) return json(res, 404, { error: 'Order not found.' });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found.' });
}
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    const file = files[path] || (['/sign-in', '/sign-up', '/dashboard', '/admin'].includes(path) ? files['/'] : null);
    if (!file) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(readFileSync(join(root, 'public', file[0])));
  } catch (error) {
    console.error('Request failed:', error.message);
    if (!res.headersSent) json(res, 400, { error: 'Unable to process request.' });
    else res.end();
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Flash app listening on ${server.address().port}`));
