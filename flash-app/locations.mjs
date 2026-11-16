import { randomUUID } from "node:crypto";

// Keep location separate from ordinary visits: a page view never creates one.
export async function locationShares(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS location_shares (
    id TEXT PRIMARY KEY, ip TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION NOT NULL, shared_at TEXT NOT NULL
  )`
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS location_shared_at_idx ON location_shares(shared_at)"
    )
    .run();
  const cutoff = () => new Date(Date.now() - 86400_000).toISOString();
  const cleanup = () =>
    db.prepare("DELETE FROM location_shares WHERE shared_at < ?").run(cutoff());
  await cleanup();
  const timer = setInterval(() => {
    cleanup().catch(() => console.error("Location cleanup failed."));
  }, 60_000);
  timer.unref();
  const attempts = new Map();
  return {
    valid(body) {
      return (
        body?.consent === true &&
        [body.latitude, body.longitude, body.accuracy].every(
          (v) => typeof v === "number" && Number.isFinite(v)
        ) &&
        Math.abs(body.latitude) <= 90 &&
        Math.abs(body.longitude) <= 180 &&
        body.accuracy >= 0 &&
        body.accuracy <= 40_100_000
      );
    },
    allow(ip) {
      const now = Date.now();
      for (const [key, expires] of attempts)
        if (expires <= now) attempts.delete(key);
      if (attempts.has(ip) || attempts.size >= 10000) return false;
      attempts.set(ip, now + 60_000);
      return true;
    },
    async save(ip, body) {
      await cleanup();
      await db
        .prepare("INSERT INTO location_shares VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          randomUUID(),
          ip,
          body.latitude,
          body.longitude,
          body.accuracy,
          new Date().toISOString()
        );
    },
    async recent() {
      await cleanup();
      return db
        .prepare(
          "SELECT ip, latitude, longitude, accuracy, shared_at FROM location_shares WHERE shared_at >= ? ORDER BY shared_at DESC LIMIT 200"
        )
        .all(cutoff());
    },
  };
}
