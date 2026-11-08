import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const standalone = resolve(".next/standalone");
async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
function cli(cwd, env, script, args = [], input) {
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}
async function start(cwd, env) {
  let output = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (v) => {
      output = (output + v).slice(-20000);
    });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await once(child, "exit");
    clearTimeout(timer);
  };
  const base = `http://127.0.0.1:${env.PORT}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { base, stop };
    } catch {
      /* starting */
    }
    await delay(25);
  }
  await stop();
  throw new Error("Server startup failed: " + output);
}
test("standalone real HTTP", { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "monitor-http-")),
    cwd = join(directory, "app");
  cpSync(standalone, cwd, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: join(directory, "events.db"),
    NODE_ENV: "production",
  };
  let app;
  try {
    cli(cwd, env, "scripts/db.ts", ["migrate"]);
    app = await start(cwd, env);
    const call = (path, init) => fetch(app.base + path, init);
    const write = (value, extra = {}) =>
      call("/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(value),
      });
    const read = async (path) => {
      const response = await call(path);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const input = {
      id: "http/stream/%/тест",
      source: "CRM demo",
      type: "lead.created",
      status: "error",
      message: "Ошибка тестовой передачи",
      error_code: "TEST",
      created_at: new Date().toISOString(),
      payload: { test: true },
    };
    const created = await write(input);
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.replayed, false);
    const replayed = await write(input);
    assert.equal(replayed.status, 200);
    assert.deepEqual((await replayed.json()).event, body.event);
    assert.equal((await write({ ...input, message: "different" })).status, 409);
    assert.equal(
      (await write({ ...input, id: "invalid", status: "pending" })).status,
      400,
    );
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => write({ ...input, id: "concurrent" })),
    );
    assert.equal(outcomes.filter((r) => r.status === 201).length, 1);
    assert.equal(outcomes.filter((r) => r.status === 200).length, 5);
    const first = await read("/api/events?limit=1"),
      snapshot = first.snapshot;
    assert.equal(first.items.length, 1);
    assert.equal(first.page.has_more, true);
    const next = await read(
      "/api/events?cursor=" + encodeURIComponent(first.page.next_cursor),
    );
    assert.notEqual(next.items[0].id, first.items[0].id);
    assert.equal(
      (
        await read(
          "/api/events?cursor=" + encodeURIComponent(next.page.previous_cursor),
        )
      ).items[0].id,
      first.items[0].id,
    );
    await write({ ...input, id: "after-snapshot" });
    const overview = await read(
      "/api/overview?snapshot=" + encodeURIComponent(snapshot.token),
    );
    assert.equal(overview.totals.total, 2);
    assert.equal(overview.totals.error, 2);
    const slug = "~" + Buffer.from(input.id).toString("base64url");
    assert.deepEqual((await read("/api/events/" + slug)).event.payload, {
      test: true,
    });
    assert.equal(
      (
        await read(
          "/api/facets?field=source&snapshot=" +
            encodeURIComponent(snapshot.token),
        )
      ).items[0].count,
      2,
    );
    const invalid = await call("/api/events?q=***");
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).error.request_id,
      invalid.headers.get("x-request-id"),
    );
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    assert.equal((await call("/api/events", { method: "PATCH" })).status, 405);
    assert.equal(
      (await call("/api/auth/sign-up/email", { method: "POST" })).status,
      404,
    );
    const head = await call("/api/events", {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const large = await call("/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(40000)));
          c.enqueue(new TextEncoder().encode("x".repeat(40000)));
          c.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(large.status, 413);
    await app.stop();
    app = await start(cwd, env);
    // Signed snapshot survive a full server process restart.
    assert.equal(
      (
        await read(
          "/api/overview?snapshot=" + encodeURIComponent(snapshot.token),
        )
      ).totals.total,
      2,
    );
    const current = await read("/api/events");
    assert.equal(current.items.length, 3);
    assert.equal(current.snapshot.history_id, snapshot.history_id);
    const competing = await Promise.all([
      write({ ...input, id: "competing-id", message: "candidate one" }),
      write({ ...input, id: "competing-id", message: "candidate two" }),
    ]);
    assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  } finally {
    await app?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
