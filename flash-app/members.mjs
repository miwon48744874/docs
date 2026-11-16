export async function memberTracking(db) {
  // A separate table preserves existing accounts and five-column user inserts.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS member_activity (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_login_at TEXT, last_seen_at TEXT NOT NULL,
    login_count INTEGER NOT NULL DEFAULT 0
  )`
    )
    .run();
  const login =
    db.prepare(`INSERT INTO member_activity (user_id, last_login_at, last_seen_at, login_count)
    VALUES (?, ?, ?, 1) ON CONFLICT (user_id) DO UPDATE SET
    last_login_at = excluded.last_login_at, last_seen_at = excluded.last_seen_at,
    login_count = member_activity.login_count + 1`);
  const seen =
    db.prepare(`INSERT INTO member_activity (user_id, last_seen_at) VALUES (?, ?)
    ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    WHERE member_activity.last_seen_at < ?`);
  return {
    async login(id) {
      const timestamp = new Date().toISOString();
      await login.run(id, timestamp, timestamp);
    },
    async seen(id) {
      await seen.run(
        id,
        new Date().toISOString(),
        new Date(Date.now() - 60000).toISOString()
      );
    },
    async list(params) {
      const page = Number(params.get("page") || 1);
      const query = (params.get("q") || "").trim().toLowerCase();
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        query.length > 254
      )
        return null;
      const pattern = "%" + query.replace(/[!%_]/g, "!$&") + "%";
      // Explicit allowlist: never return password hashes or session tokens.
      const members = await db
        .prepare(
          `SELECT users.id, users.email, users.role, users.created_at,
        member_activity.last_login_at, member_activity.last_seen_at,
        COALESCE(member_activity.login_count, 0) AS login_count
        FROM users LEFT JOIN member_activity ON users.id = member_activity.user_id
        WHERE lower(users.email) LIKE ? ESCAPE '!' OR lower(users.id) LIKE ? ESCAPE '!'
        ORDER BY users.created_at DESC, users.id LIMIT 51 OFFSET ?`
        )
        .all(pattern, pattern, (page - 1) * 50);
      return {
        members: members.slice(0, 50),
        page,
        hasMore: members.length > 50,
      };
    },
  };
}
