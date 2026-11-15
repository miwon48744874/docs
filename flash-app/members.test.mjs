import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

test("admin member details preserve legacy users and never expose credentials", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "flash-members-"));
  const password = randomBytes(16).toString("hex");
  // Simulate a pre-feature database with more than one page of members.
  const db = new DatabaseSync(join(data, "app.sqlite"));
  db.exec(
    `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL)`
  );
  const insert = db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 52; i++)
    insert.run(
      `legacy-${i}`,
      `legacy${i}@example.test`,
      "legacy-hash",
      "customer",
      "2020-01-01T00:00:00.000Z"
    );
  db.close();
  let child;
  async function stop() {
    if (child?.exitCode === null) {
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await done;
    }
  }
  t.after(async () => {
    await stop();
    rmSync(data, { recursive: true, force: true });
  });
  async function start() {
    child = spawn(process.execPath, [join(import.meta.dirname, "server.mjs")], {
      env: {
        ...process.env,
        DATABASE_URL: "",
        FLASH_REQUIRE_POSTGRES: "0",
        FLASH_SECURE_COOKIE: "0",
        PORT: "0",
        FLASH_DATA_DIR: data,
        FLASH_ADMIN_EMAIL: "admin@example.test",
        FLASH_ADMIN_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/listening on (\d+)/);
        if (match) resolve(match[1]);
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Startup exited: ${code}`))
      );
    });
    return `http://127.0.0.1:${port}`;
  }
  let base = await start();
  async function call(path, cookie, body) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body
          ? {
              "content-type": "application/json",
              "x-requested-with": "flash-app",
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      cache: response.headers.get("cache-control"),
    };
  }
  assert.equal((await call("/api/admin/members")).status, 401);
  const customer = await call("/api/signup", null, {
    email: "member@example.test",
    password,
  });
  assert.equal(customer.status, 200);
  assert.equal((await call("/api/admin/members", customer.cookie)).status, 403);
  const admin = await call("/api/login", null, {
    email: "admin@example.test",
    password,
  });
  const first = await call("/api/admin/members", admin.cookie);
  assert.equal(first.status, 200);
  assert.equal(first.cache, "no-store");
  assert.equal(first.body.members.length, 50);
  assert.equal(first.body.hasMore, true);
  const second = await call("/api/admin/members?page=2", admin.cookie);
  assert.equal(second.body.members.length, 4);
  assert.equal(second.body.hasMore, false);
  assert.equal(
    new Set([...first.body.members, ...second.body.members].map((m) => m.id))
      .size,
    54
  );
  const legacy = first.body.members.find((m) => m.id.startsWith("legacy-"));
  assert.equal(legacy.last_login_at, null);
  assert.equal(legacy.last_seen_at, null);
  assert.equal(legacy.login_count, 0);
  const lookup = () =>
    call("/api/admin/members?q=MEMBER%40example.test", admin.cookie);
  let member = (await lookup()).body.members[0];
  assert.equal(member.login_count, 1);
  assert.ok(member.last_login_at);
  assert.deepEqual(
    Object.keys(member).sort(),
    [
      "id",
      "email",
      "role",
      "created_at",
      "last_login_at",
      "last_seen_at",
      "login_count",
    ].sort()
  );
  assert.ok(!JSON.stringify(first.body).includes(password));
  assert.ok(!JSON.stringify(first.body).includes("legacy-hash"));
  assert.equal(
    (
      await call("/api/login", null, {
        email: "member@example.test",
        password: "wrong-password-123",
      })
    ).status,
    401
  );
  assert.equal((await lookup()).body.members[0].login_count, 1);
  await call("/api/login", null, { email: "member@example.test", password });
  assert.equal((await lookup()).body.members[0].login_count, 2);
  const direct = new DatabaseSync(join(data, "app.sqlite"));
  direct
    .prepare("UPDATE member_activity SET last_seen_at = ? WHERE user_id = ?")
    .run("2000-01-01T00:00:00.000Z", customer.body.user.id);
  direct.close();
  await call("/api/session", customer.cookie);
  member = (await lookup()).body.members[0];
  assert.ok(member.last_seen_at > "2000-01-01T00:00:00.000Z");
  assert.equal(member.login_count, 2);
  for (const page of ["0", "-1", "abc", "1.5", "1000001"])
    assert.equal(
      (await call(`/api/admin/members?page=${page}`, admin.cookie)).status,
      400
    );
  assert.equal(
    (await call("/api/admin/members?q=%25", admin.cookie)).body.members.length,
    0
  );
  await stop();
  base = await start();
  assert.equal((await lookup()).body.members[0].login_count, 2);
  assert.equal(
    (await call("/api/admin/members?page=2", admin.cookie)).body.members.length,
    4
  );
  await call("/api/logout", admin.cookie, {});
  assert.equal((await call("/api/admin/members", admin.cookie)).status, 401);
});
