import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const { mountLocationSharing } = await import(
  "data:text/javascript;base64," +
    readFileSync(
      new URL("./public/location-sharing.js", import.meta.url)
    ).toString("base64")
);
import { openDatabase } from "./database.mjs";
import { locationShares } from "./locations.mjs";

test("location is requested only on click and sent only after separate confirmation", async () => {
  const nodes = new Map();
  const doc = {
    querySelector(id) {
      if (!nodes.has(id))
        nodes.set(id, {
          hidden: true,
          addEventListener(event, handler) {
            this[event] = handler;
          },
        });
      return nodes.get(id);
    },
  };
  let granted,
    denied,
    requests = 0,
    transmissions = 0;
  mountLocationSharing(
    doc,
    {
      geolocation: {
        getCurrentPosition(ok, fail) {
          requests++;
          granted = ok;
          denied = fail;
        },
      },
    },
    async () => {
      transmissions++;
      return { ok: true };
    },
    true
  );
  assert.equal(requests, 0);
  doc.querySelector("#location-request").click();
  assert.equal(requests, 1);
  denied({ code: 1 });
  assert.equal(transmissions, 0);
  doc.querySelector("#location-request").click();
  granted({ coords: { latitude: 37.5, longitude: 127, accuracy: 200 } });
  assert.equal(transmissions, 0);
  doc.querySelector("#location-cancel").click();
  await doc.querySelector("#location-send").click();
  assert.equal(transmissions, 0);
  doc.querySelector("#location-request").click();
  granted({ coords: { latitude: 37.5, longitude: 127, accuracy: 200 } });
  await doc.querySelector("#location-send").click();
  assert.equal(transmissions, 1);
});

test("expired location shares are removed", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "flash-location-db-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const db = await openDatabase({ dataDir: data });
  const store = await locationShares(db);
  await db
    .prepare("INSERT INTO location_shares VALUES (?, ?, ?, ?, ?, ?)")
    .run("expired", "192.0.2.1", 0, 0, 10, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(await store.recent(), []);
  assert.equal(
    (await db.prepare("SELECT count(*) AS count FROM location_shares").get())
      .count,
    0
  );
});

test("location API requires explicit consent, validates coordinates and restricts reads to admins", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "flash-location-api-"));
  const password = randomBytes(16).toString("hex");
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "server.mjs")],
    {
      env: {
        ...process.env,
        DATABASE_URL: "",
        FLASH_REQUIRE_POSTGRES: "0",
        FLASH_SECURE_COOKIE: "0",
        FLASH_TRUST_PROXY: "0",
        FLASH_DATA_DIR: data,
        PORT: "0",
        FLASH_ADMIN_EMAIL: "admin@example.test",
        FLASH_ADMIN_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await stopped;
    }
    rmSync(data, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (\d+)/);
      if (match) resolve(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Startup exited: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(path, body, cookie) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body
          ? {
              "content-type": "application/json",
              "x-requested-with": "flash-app",
            }
          : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  assert.equal((await call("/api/admin/visits")).status, 401);
  const coords = { latitude: 37.5, longitude: 127, accuracy: 200 };
  assert.equal((await call("/api/location-shares", coords)).status, 400);
  for (const bad of [
    { latitude: 91 },
    { longitude: -181 },
    { accuracy: -1 },
    { latitude: "37.5" },
  ])
    assert.equal(
      (await call("/api/location-shares", { ...coords, consent: true, ...bad }))
        .status,
      400
    );
  const crossOrigin = await fetch(base + "/api/location-shares", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "flash-app",
      origin: "https://other.example",
    },
    body: JSON.stringify({ ...coords, consent: true }),
  });
  assert.equal(crossOrigin.status, 403);
  const customer = await call("/api/signup", {
    email: "customer@example.test",
    password,
  });
  assert.equal(
    (await call("/api/admin/visits", null, customer.cookie)).status,
    403
  );
  const admin = await call("/api/login", {
    email: "admin@example.test",
    password,
  });
  assert.deepEqual(
    (await call("/api/admin/visits", null, admin.cookie)).body.locations,
    []
  );
  assert.equal(
    (await call("/api/location-shares", { ...coords, consent: true })).status,
    201
  );
  const rows = (await call("/api/admin/visits", null, admin.cookie)).body
    .locations;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latitude, coords.latitude);
  assert.equal(rows[0].accuracy, coords.accuracy);
  assert.equal(
    (await call("/api/location-shares", { ...coords, consent: true })).status,
    429
  );
});
