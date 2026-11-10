import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const now = () => new Date().toISOString();
const postgresProductLookup = 'SELECT id FROM products WHERE lower(name COLLATE "C") = lower(?::text COLLATE "C") AND id != ?';
const sqliteProductLookup = 'SELECT id FROM products WHERE name = ? COLLATE NOCASE AND id != ?';

export async function openDatabase({ url, dataDir, requirePostgres = false }) {
  if (requirePostgres && !url) throw new Error('DATABASE_URL is required for persistent storage.');
  if (!url) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(dataDir, 'app.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, price_cents INTEGER NOT NULL CHECK(price_cents >= 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_demo_per_user ON orders(user_id) WHERE plan = 'Free demo';
      CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, ip TEXT NOT NULL, visited_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visits_visited_at_idx ON visits(visited_at);
    `);
    const columns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
    db.exec('BEGIN');
    try {
      if (!columns.includes('product_id')) db.exec('ALTER TABLE orders ADD COLUMN product_id TEXT REFERENCES products(id)');
      if (!columns.includes('price_cents')) db.exec('ALTER TABLE orders ADD COLUMN price_cents INTEGER');
      db.prepare('INSERT OR IGNORE INTO products (id, name, price_cents, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('free-demo', 'Free demo', 0, 1, now(), now());
      db.prepare("UPDATE orders SET product_id = 'free-demo', price_cents = 0 WHERE plan = 'Free demo' AND product_id IS NULL").run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { productLookup: sqliteProductLookup, prepare(sql) {
      const statement = db.prepare(sql);
      return { async get(...args) { return statement.get(...args); }, async all(...args) { return statement.all(...args); }, async run(...args) { return statement.run(...args); } };
    } };
  }
  const pool = new pg.Pool({ connectionString: url, enableChannelBinding: true, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS products_name_case_insensitive ON products (lower(name COLLATE "C"));
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL, network TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_demo_per_user ON orders(user_id) WHERE plan = 'Free demo';
      CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, ip TEXT NOT NULL, visited_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visits_visited_at_idx ON visits(visited_at);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_id TEXT REFERENCES products(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_cents INTEGER;
    `);
    await client.query('INSERT INTO products (id, name, price_cents, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', ['free-demo', 'Free demo', 0, 1, now(), now()]);
    await client.query("UPDATE orders SET product_id = 'free-demo', price_cents = 0 WHERE plan = 'Free demo' AND product_id IS NULL");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { productLookup: postgresProductLookup, prepare(sql) {
    let position = 0;
    const text = sql.replace(/\?/g, () => `$${++position}`);
    return {
      async get(...args) { return (await pool.query(text, args)).rows[0]; },
      async all(...args) { return (await pool.query(text, args)).rows; },
      async run(...args) { const result = await pool.query(text, args); return { changes: result.rowCount }; }
    };
  } };
}

export function isUniqueViolation(error) {
  return error?.code === '23505' || (error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message));
}
