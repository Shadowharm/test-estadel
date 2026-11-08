import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, type AppDatabase } from "../../src/server/db/connection";
import { migrateDatabase } from "../../src/server/db/migrations";
import { insertEvent } from "../../src/server/events/store";
import { createApi } from "../../src/server/api/handler";
import { metadata } from "../../src/server/api/read-models";
import { streamDefaults } from "../../src/server/api/stream";

let directory: string, db: AppDatabase, api: ReturnType<typeof createApi>;
const controllers: AbortController[] = [];
const input = () => ({
  id: randomUUID(),
  source: "Тест",
  type: "lead.created",
  status: "error",
  created_at: "2020-01-01T00:00:00Z",
  message: "Тестовая причина",
});
const options = {
  ...streamDefaults,
  maxConnections: 2,
  pollMs: 10,
  heartbeatMs: 100,
  batchSize: 2,
  maxBacklog: 4,
};
const call = (path: string, init?: RequestInit) =>
  api(new Request(`http://localhost${path}`, init));
function after(seq = 0, history = metadata(db).history) {
  return `${history}:${seq}`;
}
async function open(value = after(), headers?: Record<string, string>) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await call(`/api/events/stream?after=${value}`, {
    signal: controller.signal,
    headers,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "retry: 2000",
  );
  return { reader, controller };
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 10) {
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(ms);
  return new TextDecoder().decode((await next).value);
}
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), "monitor-sse-"));
  db = openDatabase(join(directory, "events.db"), { create: true });
  migrateDatabase(db);
  api = createApi({ database: () => db, streamOptions: () => options });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.useRealTimers();
  if (db.sqlite.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("notifies two subscribers after commit, replays a snapshot/subscribe gap and never emits for idempotent or rejected POST", async () => {
  const a = await open(),
    b = await open();
  const event = input();
  const post = (body: unknown) =>
    call("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post(event)).status).toBe(201);
  const messageA = await frame(a.reader),
    messageB = await frame(b.reader);
  for (const message of [messageA, messageB]) {
    expect(message).toContain(`id: ${after(1)}`);
    expect(message).toContain('"count":1');
    expect(message).toContain("event: events.changed");
  }
  a.controller.abort();
  const gap = await open(after(0));
  expect(await frame(gap.reader)).toContain(`id: ${after(1)}`);
  expect((await post(event)).status).toBe(200);
  expect((await post({ ...event, message: "Конфликт" })).status).toBe(409);
  expect((await post({ source: "неполное событие" })).status).toBe(400);
  expect(await frame(gap.reader)).toContain("event: ready");
  expect(await frame(gap.reader, 100)).toContain("event: heartbeat");
  expect(metadata(db).max).toBe(1);
});

it("recovers persisted events after process services/database reopen, with Last-Event-ID taking precedence", async () => {
  insertEvent(db, input());
  const history = metadata(db).history;
  const original = await open(after());
  expect(await frame(original.reader)).toContain(`id: ${history}:1`);
  original.controller.abort();
  db.close();
  db = openDatabase(join(directory, "events.db"));
  insertEvent(db, input());
  api = createApi({ database: () => db, streamOptions: () => options });
  const reconnected = await open(`${history}:0`, {
    "Last-Event-ID": `${history}:1`,
  });
  const message = await frame(reconnected.reader);
  expect(message).toContain(`id: ${history}:2`);
  expect(message).toContain('"count":1');
});

it("bounds catch-up batches and explicitly resyncs large backlogs, future cursors and other database generations", async () => {
  for (let i = 0; i < 4; i++) insertEvent(db, input());
  const stream = await open();
  expect(await frame(stream.reader)).toContain(`id: ${after(2)}`);
  expect(await frame(stream.reader)).toContain(`id: ${after(4)}`);
  stream.controller.abort();
  insertEvent(db, input());
  const large = await open();
  expect(await frame(large.reader)).toContain('"reason":"backlog_limit"');
  expect((await large.reader.read()).done).toBe(true);
  const future = await open(after(100));
  expect(await frame(future.reader)).toContain("event: resync");
  const other = await open(after(0, randomUUID()));
  expect(await frame(other.reader)).toContain("event: resync");
});

it("detects a generation change on an already open stream", async () => {
  const stream = await open();
  expect(await frame(stream.reader)).toContain("event: ready");
  db.sqlite
    .prepare("UPDATE app_meta SET value=? WHERE key='history_id'")
    .run(randomUUID());
  expect(await frame(stream.reader)).toContain('"reason":"history_changed"');
});

it("rejects malformed cursors, duplicate/unknown query parameters and unsupported methods", async () => {
  for (const query of [
    "",
    "after=bad",
    `after=${after()}&after=${after()}`,
    `after=${after()}&q=x`,
    `after=${after(-1)}`,
    `after=${after(9007199254740992)}`,
  ])
    expect((await call(`/api/events/stream?${query}`)).status).toBe(400);
  expect(
    (
      await call(`/api/events/stream?after=${after()}`, {
        headers: { "Last-Event-ID": "bad" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(`/api/events/stream?after=${after()}`, { method: "POST" }))
      .status,
  ).toBe(405);
});

it("enforces connection limits and releases slots/timers on abort, cancellation and HEAD", async () => {
  const a = await open(),
    b = await open();
  const limited = await call(`/api/events/stream?after=${after()}`);
  expect(limited.status).toBe(503);
  expect(limited.headers.get("retry-after")).toBe("5");
  a.controller.abort();
  await b.reader.cancel();
  expect(vi.getTimerCount()).toBe(0);
  const head = await call(`/api/events/stream?after=${after()}`, {
    method: "HEAD",
  });
  expect(head.status).toBe(200);
  expect(head.body).toBe(null);
  expect(vi.getTimerCount()).toBe(0);
  await open();
  await open();
});

it("disconnects a slow reader with a bounded queue and frees its connection slot", async () => {
  const slow = await open();
  await vi.advanceTimersByTimeAsync(250);
  await expect(slow.reader.read()).rejects.toThrow("SLOW_STREAM_READER");
  expect(vi.getTimerCount()).toBe(0);
  await open();
});
