import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

for (const backend of ['sqlite', 'postgres']) test(`accounts, demo limits and administrator authorization (${backend})`, { skip: backend === 'postgres' && !process.env.FLASH_TEST_DATABASE_URL }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'flash-test-'));
  const password = randomBytes(16).toString('hex');
  let pool, schema, databaseUrl = '';
  if (backend === 'postgres') {
    schema = `flash_test_${randomBytes(6).toString('hex')}`;
    pool = new pg.Pool({ connectionString: process.env.FLASH_TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.FLASH_TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { env: { ...process.env, DATABASE_URL: databaseUrl, FLASH_REQUIRE_POSTGRES: backend === 'postgres' ? '1' : '0', FLASH_SECURE_COOKIE: backend === 'postgres' ? '1' : '0', FLASH_TRUST_PROXY: backend === 'postgres' ? '1' : '0', PORT: '0', FLASH_DATA_DIR: data, FLASH_ADMIN_EMAIL: 'admin@example.test', FLASH_ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    rmSync(data, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(path, { cookie, body, method = 'GET', headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'content-type': 'application/json', 'x-requested-with': 'flash-app' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieAttributes: response.headers.get('set-cookie') };
  }
  assert.equal((await call('/api/admin/visits')).status, 401);
  const navigationHeaders = { 'sec-fetch-dest': 'document', 'x-forwarded-for': '203.0.113.9, 198.51.100.12' };
  assert.equal((await fetch(base + '/', { headers: navigationHeaders })).status, 200);
  assert.equal((await fetch(base + '/style.css', { headers: navigationHeaders })).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/', { headers: { accept: 'text/html', 'user-agent': 'Render-Healthcheck' } })).status, 200);
  assert.equal((await fetch(base + '/', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '192.0.2.13' } })).status, 200);
  if (backend === 'postgres') {
    assert.equal((await fetch(base + '/', { headers: { 'sec-fetch-dest': 'document', 'x-forwarded-for': 'invalid' } })).status, 200);
    assert.equal((await fetch(base + '/', { headers: { 'sec-fetch-dest': 'document', 'x-forwarded-for': 'fe80::1%eth0' } })).status, 200);
    assert.equal((await fetch(base + '/sign-in', { headers: { 'sec-fetch-dest': 'document', 'x-forwarded-for': '2001:db8::1' } })).status, 200);
  }
  assert.equal((await call('/api/admin/orders')).status, 401);
  const customer = await call('/api/signup', { method: 'POST', body: { email: 'customer@example.test', password, role: 'admin' } });
  assert.equal(customer.status, 200);
  assert.equal(customer.body.user.role, 'customer');
  if (backend === 'postgres') { assert.match(customer.cookieAttributes, /Secure/); assert.match(customer.cookieAttributes, /HttpOnly/); assert.match(customer.cookieAttributes, /SameSite=Strict/); }
  assert.equal((await call('/api/admin/orders', { cookie: customer.cookie })).status, 403);
  assert.equal((await call('/api/admin/visits', { cookie: customer.cookie })).status, 403);
  assert.equal((await call('/api/orders', { method: 'POST', cookie: customer.cookie, body: { plan: 'Free demo', network: 'BEP20', address: 'invalid' } })).status, 400);
  const orderBody = { plan: 'Free demo', network: 'BEP20', address: '0x' + '1'.repeat(40) };
  const order = await call('/api/orders', { method: 'POST', cookie: customer.cookie, body: orderBody });
  assert.equal(order.status, 201);
  assert.equal((await call('/api/orders', { method: 'POST', cookie: customer.cookie, body: orderBody })).status, 409);
  const another = await call('/api/signup', { method: 'POST', body: { email: 'concurrent@example.test', password } });
  const concurrent = await Promise.all([call('/api/orders', { method: 'POST', cookie: another.cookie, body: orderBody }), call('/api/orders', { method: 'POST', cookie: another.cookie, body: orderBody })]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409]);
  const other = await call('/api/signup', { method: 'POST', body: { email: 'other@example.test', password } });
  assert.equal((await call('/api/orders', { cookie: other.cookie })).body.orders.length, 0);
  assert.equal((await call(`/api/admin/orders/${order.body.id}`, { method: 'PATCH', cookie: customer.cookie, body: { status: 'completed' } })).status, 403);
  const admin = await call('/api/login', { method: 'POST', body: { email: 'admin@example.test', password } });
  assert.equal(admin.body.user.role, 'admin');
  if (backend === 'postgres') await pool.query(`INSERT INTO "${schema}".visits (id, ip, visited_at) VALUES ($1, $2, $3)`, ['old-visit', '192.0.2.4', '2000-01-01T00:00:00.000Z']);
  else { const direct = new DatabaseSync(join(data, 'app.sqlite')); direct.prepare('INSERT INTO visits (id, ip, visited_at) VALUES (?, ?, ?)').run('old-visit', '192.0.2.4', '2000-01-01T00:00:00.000Z'); direct.close(); }
  const visitResult = await call('/api/admin/visits', { cookie: admin.cookie });
  assert.equal(visitResult.status, 200);
  assert.equal(visitResult.body.visits.length, backend === 'postgres' ? 3 : 2);
  assert.ok(visitResult.body.visits.some(visit => visit.ip === (backend === 'postgres' ? '198.51.100.12' : '127.0.0.1')));
  assert.equal(visitResult.body.visits.some(visit => visit.ip === '203.0.113.9' || visit.ip === '192.0.2.4'), false);
  if (backend === 'postgres') {
    assert.ok(visitResult.body.visits.some(visit => visit.ip === '2001:db8::1'));
    assert.ok(visitResult.body.visits.some(visit => visit.ip === '192.0.2.13'));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".visits WHERE id = $1`, ['old-visit'])).rows[0].count, 0);
  } else { const direct = new DatabaseSync(join(data, 'app.sqlite')); assert.equal(direct.prepare('SELECT count(*) AS count FROM visits WHERE id = ?').get('old-visit').count, 0); direct.close(); }
  assert.equal((await call('/api/admin/orders', { cookie: admin.cookie })).body.orders.length, 2);
  assert.equal((await call('/api/admin/products', { cookie: customer.cookie })).status, 403);
  assert.equal((await call('/api/admin/products', { method: 'POST', cookie: customer.cookie, body: { name: 'Intruder', priceCents: 1, active: true } })).status, 403);
  assert.equal((await call('/api/admin/products', { method: 'POST', cookie: admin.cookie, body: { name: 'Invalid', priceCents: 1.5, active: true } })).status, 400);
  assert.equal((await call('/api/admin/products/free-demo', { method: 'PATCH', cookie: admin.cookie, body: { name: 'Free demo', priceCents: 100, active: true } })).status, 400);
  const product = await call('/api/admin/products', { method: 'POST', cookie: admin.cookie, body: { name: 'Test package', priceCents: 1234, active: true } });
  assert.equal(product.status, 201);
  assert.equal((await call('/api/admin/products', { method: 'POST', cookie: admin.cookie, body: { name: 'test PACKAGE', priceCents: 0, active: true } })).status, 409);
  assert.equal((await call('/api/products')).body.products.find(p => p.id === product.body.id).price_cents, 1234);
  const paidOrder = await call('/api/orders', { method: 'POST', cookie: other.cookie, body: { productId: product.body.id, expectedPriceCents: 1234, priceCents: 1, network: 'BEP20', address: orderBody.address } });
  assert.equal(paidOrder.status, 201);
  assert.equal((await call('/api/admin/products/' + product.body.id, { method: 'PATCH', cookie: admin.cookie, body: { name: 'Renamed package', priceCents: 2500, active: true } })).status, 200);
  const snapshot = (await call('/api/orders', { cookie: other.cookie })).body.orders[0];
  assert.equal(snapshot.plan, 'Test package');
  assert.equal(snapshot.price_cents, 1234);
  assert.equal((await call('/api/orders', { method: 'POST', cookie: other.cookie, body: { productId: product.body.id, expectedPriceCents: 1234, network: 'BEP20', address: orderBody.address } })).status, 409);
  assert.equal((await call('/api/admin/products/' + product.body.id, { method: 'PATCH', cookie: admin.cookie, body: { name: 'Renamed package', priceCents: 2500, active: false } })).status, 200);
  assert.equal((await call('/api/products')).body.products.some(p => p.id === product.body.id), false);
  assert.equal((await call('/api/orders', { method: 'POST', cookie: other.cookie, body: { productId: product.body.id, network: 'BEP20', address: orderBody.address } })).status, 400);
  assert.equal((await call(`/api/admin/orders/${order.body.id}`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'completed' }, headers: { origin: 'https://another.example' } })).status, 403);
  assert.equal((await call(`/api/admin/orders/${order.body.id}`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'completed' } })).status, 200);
  assert.equal((await call('/api/orders', { cookie: customer.cookie })).body.orders[0].status, 'completed');
  await call('/api/logout', { method: 'POST', cookie: admin.cookie, body: {} });
  assert.equal((await call('/api/admin/orders', { cookie: admin.cookie })).status, 401);
});

for (const backend of ['sqlite', 'postgres']) test(`Cloudflare visitor IP uses the edge address and ignores other forwarded headers (${backend})`, { skip: backend === 'postgres' && !process.env.FLASH_TEST_DATABASE_URL }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'flash-cloudflare-'));
  const password = randomBytes(16).toString('hex');
  let pool, schema, databaseUrl = '';
  if (backend === 'postgres') {
    schema = `flash_test_${randomBytes(6).toString('hex')}`;
    pool = new pg.Pool({ connectionString: process.env.FLASH_TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.FLASH_TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  }
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, DATABASE_URL: databaseUrl, FLASH_REQUIRE_POSTGRES: backend === 'postgres' ? '1' : '0', FLASH_SECURE_COOKIE: '0', FLASH_TRUST_PROXY: 'cloudflare', PORT: '0', FLASH_DATA_DIR: data, FLASH_ADMIN_EMAIL: 'admin@example.test', FLASH_ADMIN_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    rmSync(data, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const forwarded = { 'sec-fetch-dest': 'document', 'x-forwarded-for': '203.0.113.10, 10.0.0.1' };
  for (const ip of ['198.51.100.23', '2001:db8::23', '::ffff:198.51.100.24', 'invalid', 'fe80::1%eth0', '198.51.100.25, 198.51.100.26']) {
    assert.equal((await fetch(base + '/', { headers: { ...forwarded, 'cf-connecting-ip': ip } })).status, 200);
  }
  assert.equal((await fetch(base + '/', { headers: forwarded })).status, 200);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'flash-app' }, body: JSON.stringify({ email: 'admin@example.test', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/admin/visits', { headers: { cookie } });
  assert.equal(response.status, 200);
  const { visits } = await response.json();
  assert.deepEqual(visits.map(visit => visit.ip).sort(), ['198.51.100.23', '198.51.100.24', '2001:db8::23'].sort());
});


test('legacy free-demo orders migrate without losing their limit', async t => {
  const data = mkdtempSync(join(tmpdir(), 'flash-migration-'));
  const password = randomBytes(16).toString('hex');
  const salt = randomBytes(16).toString('hex');
  const db = new DatabaseSync(join(data, 'app.sqlite'));
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX one_demo_per_user ON orders(user_id) WHERE plan = 'Free demo';`);
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run('legacy-user', 'legacy@example.test', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, 'customer', timestamp);
  db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-order', 'legacy-user', 'Free demo', 'BEP20', '0x' + '1'.repeat(40), 'reviewing', timestamp, timestamp);
  db.close();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { env: { ...process.env, DATABASE_URL: '', FLASH_REQUIRE_POSTGRES: '0', PORT: '0', FLASH_DATA_DIR: data, FLASH_ADMIN_EMAIL: 'admin@example.test', FLASH_ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); rmSync(data, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error(`Migration server exited: ${code}`)));
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'flash-app' }, body: JSON.stringify({ email: 'legacy@example.test', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const existing = await (await fetch(base + '/api/orders', { headers: { cookie } })).json();
  assert.equal(existing.orders[0].id, 'legacy-order');
  assert.equal(existing.orders[0].status, 'reviewing');
  assert.equal(existing.orders[0].price_cents, 0);
  assert.equal(existing.orders[0].product_id, 'free-demo');
  const repeated = await fetch(base + '/api/orders', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'flash-app' }, body: JSON.stringify({ plan: 'Free demo', network: 'BEP20', address: '0x' + '1'.repeat(40) }) });
  assert.equal(repeated.status, 409);
});


test('production configuration refuses ephemeral SQLite when PostgreSQL is required', async () => {
  const data = mkdtempSync(join(tmpdir(), 'flash-require-db-'));
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { env: { ...process.env, PORT: '0', FLASH_DATA_DIR: data, DATABASE_URL: '', FLASH_REQUIRE_POSTGRES: '1', FLASH_ADMIN_EMAIL: '', FLASH_ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  try { assert.notEqual(code, 0); assert.match(errors, /DATABASE_URL is required/); }
  finally { rmSync(data, { recursive: true, force: true }); }
});

test('PostgreSQL keeps accounts, sessions, orders and products across restarts', { skip: !process.env.FLASH_TEST_DATABASE_URL }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'flash-pg-restart-'));
  const password = randomBytes(16).toString('hex');
  const schema = `flash_restart_${randomBytes(6).toString('hex')}`;
  const pool = new pg.Pool({ connectionString: process.env.FLASH_TEST_DATABASE_URL });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.FLASH_TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  let child;
  async function stop() {
    if (child && child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; }
  }
  t.after(async () => { await stop(); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); rmSync(data, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { env: { ...process.env, DATABASE_URL: url.toString(), FLASH_REQUIRE_POSTGRES: '1', PORT: '0', FLASH_DATA_DIR: data, FLASH_ADMIN_EMAIL: 'admin@example.test', FLASH_ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) resolve(Number(match[1])); });
      child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
      child.once('error', reject);
    });
    return `http://127.0.0.1:${port}`;
  }
  async function call(base, path, { cookie, body, method = 'GET' } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'content-type': 'application/json', 'x-requested-with': 'flash-app' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let base = await start();
  assert.equal((await fetch(base + '/', { headers: { 'sec-fetch-dest': 'document' } })).status, 200);
  const customer = await call(base, '/api/signup', { method: 'POST', body: { email: 'customer@example.test', password } });
  assert.equal(customer.status, 200);
  const order = await call(base, '/api/orders', { method: 'POST', cookie: customer.cookie, body: { plan: 'Free demo', network: 'BEP20', address: '0x' + '1'.repeat(40) } });
  assert.equal(order.status, 201);
  const admin = await call(base, '/api/login', { method: 'POST', body: { email: 'admin@example.test', password } });
  assert.equal(admin.status, 200);
  assert.equal((await call(base, `/api/admin/orders/${order.body.id}`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'reviewing' } })).status, 200);
  assert.equal((await call(base, '/api/admin/products', { method: 'POST', cookie: admin.cookie, body: { name: 'Persistent package', priceCents: 987, active: true } })).status, 201);
  await stop();
  base = await start();
  assert.equal((await call(base, '/api/session', { cookie: customer.cookie })).body.user.email, 'customer@example.test');
  const restored = await call(base, '/api/orders', { cookie: customer.cookie });
  assert.equal(restored.body.orders[0].id, order.body.id);
  assert.equal(restored.body.orders[0].status, 'reviewing');
  assert.ok((await call(base, '/api/products')).body.products.some(product => product.name === 'Persistent package' && product.price_cents === 987));
  const visits = await call(base, '/api/admin/visits', { cookie: admin.cookie });
  assert.equal(visits.status, 200);
  assert.equal(visits.body.visits.length, 1);
});
