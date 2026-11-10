import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDatabase, isUniqueViolation } from './database.mjs';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { isIP } from 'node:net';

const root = import.meta.dirname;
const dataDir = process.env.FLASH_DATA_DIR || join(root, 'data');
const now = () => new Date().toISOString();
const db = await openDatabase({ url: process.env.DATABASE_URL, dataDir, requirePostgres: process.env.FLASH_REQUIRE_POSTGRES === '1' });

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
  const existing = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (!existing) await db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(randomUUID(), email, passwordHash(adminPassword), 'admin', now());
  else if (existing.role !== 'admin') throw new Error('Admin email already belongs to a customer. Use a separate address.');
}
const secureCookie = process.env.FLASH_SECURE_COOKIE === '1';
const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;
const attempts = new Map();
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function currentUser(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='));
  const token = cookie?.slice('session='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare('SELECT users.id, users.email, users.role FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').get(hash(token), Date.now());
}
async function sessionCookie(res, user) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), user.id, Date.now() + 7 * 86400_000);
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
const insertVisit = db.prepare('INSERT INTO visits (id, ip, visited_at) VALUES (?, ?, ?)');
const deleteOldVisits = db.prepare('DELETE FROM visits WHERE visited_at < ?');
const recentVisits = db.prepare('SELECT ip, visited_at FROM visits WHERE visited_at >= ? ORDER BY visited_at DESC LIMIT 200');
const visitCutoff = () => new Date(Date.now() - 30 * 86400_000).toISOString();
let lastVisitCleanup = 0;
async function cleanVisits(force = false) {
  if (!force && Date.now() - lastVisitCleanup < 300_000) return;
  await deleteOldVisits.run(visitCutoff());
  lastVisitCleanup = Date.now();
}
function visitorSource() {
  // Render can deploy code before a Blueprint environment update is applied.
  if (process.env.FLASH_TRUST_PROXY === 'cloudflare' || (process.env.RENDER === 'true' && process.env.FLASH_TRUST_PROXY === '1')) return 'cloudflare';
  return process.env.FLASH_TRUST_PROXY === '1' ? 'forwarded' : 'socket';
}
function visitorAddress(req) {
  let address;
  if (visitorSource() === 'cloudflare') {
    address = req.headers['cf-connecting-ip'];
    if (typeof address !== 'string') return null;
    address = address.trim();
  } else if (visitorSource() === 'forwarded') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string') return null;
    address = forwarded.split(',').at(-1).trim();
  } else address = req.socket.remoteAddress || '';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return address.length <= 45 && !address.includes('%') && isIP(address) ? address : null;
}
async function recordVisit(req) {
  const destination = req.headers['sec-fetch-dest'];
  const legacyBrowser = !destination && /text\/html/i.test(req.headers.accept || '') && /^Mozilla\//i.test(req.headers['user-agent'] || '');
  if (destination !== 'document' && !legacyBrowser) return;
  const address = visitorAddress(req);
  if (!address) return;
  await insertVisit.run(randomUUID(), address, now());
  await cleanVisits();
}
async function api(req, res, path) {
  if (req.method !== 'GET') {
    if (req.headers['x-requested-with'] !== 'flash-app' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 403, { error: '올바르지 않은 요청입니다.' });
    if (req.headers.origin) {
      let originHost;
      try { originHost = new URL(req.headers.origin).host; } catch { return json(res, 403, { error: '허용되지 않은 사이트에서 보낸 요청입니다.' }); }
      if (originHost !== req.headers.host) return json(res, 403, { error: '허용되지 않은 사이트에서 보낸 요청입니다.' });
    }
  }
  if (path === '/api/products' && req.method === 'GET') return json(res, 200, { products: await db.prepare('SELECT id, name, price_cents FROM products WHERE active = 1 ORDER BY created_at, id').all() });
  if (path === '/api/session' && req.method === 'GET') return json(res, 200, { user: await currentUser(req) });
  if ((path === '/api/signup' || path === '/api/login') && req.method === 'POST') {
    if (!allowAttempt(req)) return json(res, 429, { error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.' });
    const body = await bodyJson(req);
    if (!emailValid(body.email) || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) return json(res, 400, { error: '올바른 이메일과 12~256자의 비밀번호를 입력하세요.' });
    const email = normalizeEmail(body.email);
    let user = await db.prepare('SELECT id, email, role, password FROM users WHERE email = ?').get(email);
    if (path === '/api/signup') {
      if (user) return json(res, 409, { error: '이 이메일로 계정을 만들 수 없습니다.' });
      user = { id: randomUUID(), email, role: 'customer' };
      try { await db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(user.id, email, passwordHash(body.password), 'customer', now()); }
      catch (error) { if (isUniqueViolation(error)) return json(res, 409, { error: '이 이메일로 계정을 만들 수 없습니다.' }); throw error; }
    } else if (!user || !passwordMatches(body.password, user.password)) {
      return json(res, 401, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }
    await sessionCookie(res, user);
    return json(res, 200, { user: { id: user.id, email: user.email, role: user.role } });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': `session=; ${cookieOptions}; Max-Age=0` });
  }
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
  if (path === '/api/orders' && req.method === 'GET') return json(res, 200, { orders: await ordersForUser.all(user.id) });
  if (path === '/api/orders' && req.method === 'POST') {
    const body = await bodyJson(req);
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const formats = { BEP20: /^0x[0-9a-fA-F]{40}$/, ERC20: /^0x[0-9a-fA-F]{40}$/, TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, Solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
    if (!Object.hasOwn(formats, body.network) || !formats[body.network].test(address)) return json(res, 400, { error: '네트워크를 선택하고 해당 네트워크에 맞는 테스트 주소를 입력하세요.' });
    // Preserve the original free-demo request format for existing clients.
    const productId = body.productId === undefined && body.plan === 'Free demo' ? 'free-demo' : body.productId;
    if (typeof productId !== 'string') return json(res, 400, { error: '이용 가능한 상품을 선택하세요.' });
    const product = await db.prepare('SELECT id, name, price_cents FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return json(res, 400, { error: '이용 가능한 상품을 선택하세요.' });
    if (body.expectedPriceCents !== undefined && body.expectedPriceCents !== product.price_cents) return json(res, 409, { error: '상품 가격이 변경되었습니다. 최신 가격을 확인하세요.' });
    if (product.id === 'free-demo' && await db.prepare("SELECT id FROM orders WHERE user_id = ? AND plan = 'Free demo'").get(user.id)) return json(res, 409, { error: '무료 데모는 계정당 한 번만 요청할 수 있습니다.' });
    const id = randomUUID(); const timestamp = now();
    try {
      const inserted = await db.prepare("INSERT INTO orders (id, user_id, plan, network, address, status, created_at, updated_at, product_id, price_cents) SELECT ?, ?, name, ?, ?, 'pending', ?, ?, id, price_cents FROM products WHERE id = ? AND active = 1 AND price_cents = ?").run(id, user.id, body.network, address, timestamp, timestamp, product.id, product.price_cents);
      if (!inserted.changes) return json(res, 409, { error: '상품 정보가 변경되었습니다. 최신 상품 정보를 확인하세요.' });
    } catch (error) {
      if (product.id === 'free-demo' && isUniqueViolation(error)) return json(res, 409, { error: '무료 데모는 계정당 한 번만 요청할 수 있습니다.' });
      throw error;
    }
    return json(res, 201, { id });
  }
  if (path === '/api/admin/products' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자 권한이 필요합니다.' });
    return json(res, 200, { products: await db.prepare('SELECT id, name, price_cents, active FROM products ORDER BY created_at, id').all() });
  }
  const productMatch = path.match(/^\/api\/admin\/products\/([0-9a-f-]+|free-demo)$/);
  if ((path === '/api/admin/products' && req.method === 'POST') || (productMatch && req.method === 'PATCH')) {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자 권한이 필요합니다.' });
    const body = await bodyJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !Number.isSafeInteger(body.priceCents) || body.priceCents < 0 || body.priceCents > 100_000_000 || typeof body.active !== 'boolean') return json(res, 400, { error: '상품명과 올바른 가격, 판매 여부를 입력하세요.' });
    const productId = productMatch ? productMatch[1] : randomUUID();
    const existing = await db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (productMatch && !existing) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    if (productId === 'free-demo' && (name !== 'Free demo' || body.priceCents !== 0 || !body.active)) return json(res, 400, { error: '무료 데모는 항상 무료로 이용할 수 있어야 합니다.' });
    const duplicate = await db.prepare(db.productLookup).get(name, productId);
    if (duplicate) return json(res, 409, { error: '같은 이름의 상품이 이미 있습니다.' });
    const timestamp = now();
    try {
      if (productMatch) await db.prepare('UPDATE products SET name = ?, price_cents = ?, active = ?, updated_at = ? WHERE id = ?').run(name, body.priceCents, Number(body.active), timestamp, productId);
      else await db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)').run(productId, name, body.priceCents, Number(body.active), timestamp, timestamp);
    } catch (error) { if (isUniqueViolation(error)) return json(res, 409, { error: '같은 이름의 상품이 이미 있습니다.' }); throw error; }
    return json(res, productMatch ? 200 : 201, { id: productId });
  }
  if (path === '/api/admin/visits' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자 권한이 필요합니다.' });
    await cleanVisits(true);
    return json(res, 200, { visits: await recentVisits.all(visitCutoff()), tracking: { source: visitorSource(), currentIp: visitorAddress(req), release: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) } });
  }
  if (path === '/api/admin/orders' && req.method === 'GET') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자 권한이 필요합니다.' });
    return json(res, 200, { orders: await allOrders.all() });
  }
  const match = path.match(/^\/api\/admin\/orders\/([0-9a-f-]+)$/);
  if (match && req.method === 'PATCH') {
    if (user.role !== 'admin') return json(res, 403, { error: '관리자 권한이 필요합니다.' });
    const body = await bodyJson(req);
    if (!['pending', 'reviewing', 'completed', 'rejected'].includes(body.status)) return json(res, 400, { error: '올바른 상태를 선택하세요.' });
    const result = await db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(body.status, now(), match[1]);
    if (!result.changes) return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: '요청한 항목을 찾을 수 없습니다.' });
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
    if (req.method !== 'GET') return json(res, 405, { error: '허용되지 않은 요청 방식입니다.' });
    const file = files[path] || (['/sign-in', '/sign-up', '/dashboard', '/account', '/admin'].includes(path) ? files['/'] : null);
    if (!file) return json(res, 404, { error: '요청한 항목을 찾을 수 없습니다.' });
    if (file === files['/']) {
      try { await recordVisit(req); } catch { console.error('Visit recording failed.'); }
    }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(readFileSync(join(root, 'public', file[0])));
  } catch (error) {
    console.error('Request failed:', error.message);
    if (!res.headersSent) json(res, 400, { error: '요청을 처리하지 못했습니다. 다시 시도하세요.' });
    else res.end();
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Flash app listening on ${server.address().port}`));
