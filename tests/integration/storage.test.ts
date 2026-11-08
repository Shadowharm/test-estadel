import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, type AppDatabase } from "../../src/server/db/connection";
import {
  assertCurrentSchema,
  migrateDatabase,
} from "../../src/server/db/migrations";
import {
  backupDatabase,
  checkDatabase,
  rebuildSearch,
  restoreDatabase,
} from "../../src/server/db/maintenance";
import {
  FIXTURE_ANCHOR,
  seedDemo,
  seedEvents,
  smallFixtures,
} from "../../src/server/db/fixtures";
import { insertEvent, findEvent } from "../../src/server/events/store";
import { compileSearch, searchEvents } from "../../src/server/events/search";
import { normalizeEvent } from "../../src/server/events/normalize";

let directory: string;
let db: AppDatabase;
let path: string;
const base = () => smallFixtures()[1]!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "monitor-storage-test-"));
  path = join(directory, "events.db");
  db = openDatabase(path, { create: true });
  migrateDatabase(db);
});
afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("uses the pinned engine settings, STRICT tables and repeatable non-destructive migrations", () => {
  const first = checkDatabase(db);
  seedEvents(db, smallFixtures(), Date.parse(FIXTURE_ANCHOR));
  migrateDatabase(db);
  expect(checkDatabase(db)).toMatchObject({
    history_id: first.history_id,
    count: 12,
  });
  expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.sqlite.pragma("synchronous", { simple: true })).toBe(2);
  expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.sqlite.pragma("busy_timeout", { simple: true })).toBe(1000);
  expect(
    (db.sqlite.pragma("table_list") as { name: string; strict: number }[]).find(
      (t) => t.name === "events",
    )?.strict,
  ).toBe(1);
  expect(() => openDatabase(join(directory, "missing.db"))).toThrow();
  db.sqlite.prepare("UPDATE __drizzle_migrations SET hash='tampered'").run();
  expect(() => assertCurrentSchema(db)).toThrow("История миграций");
  expect(() => migrateDatabase(db)).toThrow("История миграций");
});

it("keeps rows, history and FTS across independent writer/reader processes", () => {
  db.close();
  const writer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {openDatabase} from './src/server/db/connection.ts';
    import {insertEvent} from './src/server/events/store.ts';
    const db=openDatabase(process.env.TEST_DATABASE_PATH);
    insertEvent(db, JSON.parse(process.env.TEST_EVENT));
    // Abrupt exit: committed WAL must survive without close/checkpoint.
    process.exit(0);
  `,
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_PATH: path,
        TEST_EVENT: JSON.stringify(base()),
      },
      encoding: "utf8",
    },
  );
  expect(writer.stderr).toBe("");
  expect(writer.status).toBe(0);
  const reader = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {openDatabase} from './src/server/db/connection.ts';
    import {findEvent} from './src/server/events/store.ts';
    import {searchEvents} from './src/server/events/search.ts';
    const db=openDatabase(process.env.TEST_DATABASE_PATH);
    console.log(JSON.stringify({event:findEvent(db,'test-v1-000002'),found:searchEvents(db,'ЗАЯВ УСПЕШ').length}));
    db.close();
  `,
    ],
    { env: { ...process.env, TEST_DATABASE_PATH: path }, encoding: "utf8" },
  );
  expect(reader.status, reader.stderr).toBe(0);
  expect(JSON.parse(reader.stdout)).toMatchObject({
    event: { id: base().id },
    found: 1,
  });
  db = openDatabase(path);
  expect(checkDatabase(db).count).toBe(1);
});

it("seeds both fixtures idempotently, preserves unrelated rows and rolls back conflicting batches", () => {
  insertEvent(db, { ...base(), id: "user-event" });
  expect(seedEvents(db, smallFixtures(), Date.parse(FIXTURE_ANCHOR))).toEqual({
    inserted: 12,
    existing: 0,
  });
  expect(seedEvents(db, smallFixtures(), Date.parse(FIXTURE_ANCHOR))).toEqual({
    inserted: 0,
    existing: 12,
  });
  expect(seedDemo(db, Date.parse(FIXTURE_ANCHOR)).inserted).toBe(360);
  expect(seedDemo(db, Date.parse(FIXTURE_ANCHOR) + 86400000)).toEqual({
    inserted: 0,
    existing: 360,
  });
  expect(checkDatabase(db).count).toBe(373);
  expect(findEvent(db, "user-event")).toBeDefined();
  expect(() =>
    seedEvents(
      db,
      [
        { ...base(), id: "must-rollback", message: "Откатитьнепременно" },
        { ...base(), message: "conflict" },
      ],
      Date.now(),
    ),
  ).toThrow("EVENT_ID_CONFLICT");
  expect(findEvent(db, "must-rollback")).toBeUndefined();
  expect(searchEvents(db, "Откатитьнепременно")).toHaveLength(0);
  expect(checkDatabase(db).count).toBe(373);
});

it("deduplicates normalized Unicode/time/payload, keeps immutable rows and rejects altered payloads", () => {
  const input = {
    ...base(),
    source: "  Cafe\u0301  ",
    created_at: "2026-11-07T15:00:00+03:00",
    payload: { z: 2, a: { y: 1, x: [2, 1] } },
  };
  const first = insertEvent(db, input, 1);
  const second = insertEvent(
    db,
    {
      ...input,
      source: "Café",
      created_at: FIXTURE_ANCHOR,
      payload: { a: { x: [2, 1], y: 1 }, z: 2 },
    },
    2,
  );
  expect(second).toMatchObject({
    inserted: false,
    event: { seq: first.event.seq, receivedAtMs: 1 },
  });
  expect(() => insertEvent(db, { ...input, payload: {} })).toThrow(
    "EVENT_ID_CONFLICT",
  );
  expect(() => db.sqlite.exec("UPDATE events SET message='changed'")).toThrow(
    "append-only",
  );
  expect(() => db.sqlite.exec("DELETE FROM events")).toThrow("append-only");
  // OR REPLACE must not bypass immutable external IDs, even with recursive_triggers off.
  expect(() =>
    db.sqlite
      .prepare("INSERT OR REPLACE INTO events SELECT * FROM events WHERE id=?")
      .run(input.id),
  ).toThrow();
});

describe("SQL constraints independent of application validation", () => {
  const raw = (overrides: Record<string, unknown>) => {
    const row = {
      seq: 1,
      id: "raw",
      source: "test",
      type: "test",
      status: "success",
      created_at_ms: 0,
      received_at_ms: 0,
      message: "text",
      error_code: null,
      payload_json: null,
      canonical_hash: "a".repeat(64),
      source_sort: "test",
      type_sort: "test",
      ...overrides,
    };
    return () =>
      db.sqlite
        .prepare(
          `INSERT INTO events (${Object.keys(row).join(",")}) VALUES (${Object.keys(
            row,
          )
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(row));
  };
  it.each([
    { status: "pending" },
    { id: "" },
    { id: null },
    { source: "a".repeat(101) },
    { type: "a".repeat(151) },
    { message: "a".repeat(2001) },
    { id: "bad\0id" },
    { seq: 0 },
    { created_at_ms: "bad" },
    { created_at_ms: 253402300800000 },
    { error_code: "ONLY_ERROR" },
    { payload_json: "[]" },
    { payload_json: "{" },
    { payload_json: JSON.stringify({ x: "я".repeat(9000) }) },
    { canonical_hash: "z".repeat(64) },
  ])("rejects invalid SQL insertion %j", (override) => {
    expect(raw(override)).toThrow();
    expect(checkDatabase(db).count).toBe(0);
  });
});

it("atomically rolls back base row and FTS and detects/rebuilds index divergence", () => {
  expect(() =>
    db.sqlite
      .transaction(() => {
        insertEvent(db, base());
        throw new Error("rollback");
      })
      .immediate(),
  ).toThrow("rollback");
  expect(searchEvents(db, "Заявка")).toHaveLength(0);
  const row = insertEvent(db, base()).event;
  db.sqlite
    .prepare(
      "INSERT INTO events_fts(events_fts,rowid,id,source,type,message) VALUES('delete',?,?,?,?,?)",
    )
    .run(row.seq, row.id, row.source, row.type, row.message);
  expect(searchEvents(db, "Заявка")).toHaveLength(0);
  expect(() => checkDatabase(db)).toThrow();
  rebuildSearch(db);
  expect(searchEvents(db, "Заявка")).toHaveLength(1);
  expect(checkDatabase(db).count).toBe(1);
});

it("compiles literal bounded Unicode prefix queries with AND, no MATCH injection", () => {
  seedEvents(db, smallFixtures(), 0);
  expect(searchEvents(db, "ЗАЯВ УСПЕШ").length).toBeGreaterThan(0);
  expect(searchEvents(db, "ошиб тестов").length).toBeGreaterThan(0);
  expect(searchEvents(db, "test-v1-000002")).toHaveLength(1);
  expect(searchEvents(db, "заяв несуществующий")).toHaveLength(0);
  expect(searchEvents(db, '" OR *')).toEqual(searchEvents(db, "or"));
  expect(compileSearch('" OR *')).toBe('"or"*');
  expect(compileSearch("café")).toBe(compileSearch("cafe\u0301"));
  for (const query of [
    "***",
    "",
    "а".repeat(201),
    "a b c d e f g h i j k",
    "bad\0value",
  ])
    expect(() => compileSearch(query)).toThrow("INVALID_SEARCH");
  expect(() => searchEvents(db, "заяв", 101)).toThrow();
});

it("makes verified live WAL backups and restores separately with a fresh generation", async () => {
  seedEvents(db, smallFixtures(), 0);
  const before = checkDatabase(db);
  const backup = join(directory, "backup.db");
  expect(await backupDatabase(db, backup)).toMatchObject(before);
  insertEvent(db, { ...base(), id: "after-backup" });
  const backupBytes = readFileSync(backup);
  const restored = join(directory, "restored.db");
  const report = await restoreDatabase(backup, restored);
  expect(report.count).toBe(12);
  expect(report.history_id).not.toBe(before.history_id);
  expect(readFileSync(backup)).toEqual(backupBytes);
  const copy = openDatabase(restored);
  try {
    expect(searchEvents(copy, "заяв").length).toBeGreaterThan(0);
    expect(
      insertEvent(copy, { ...base(), id: "after-restore" }).event.seq,
    ).toBeGreaterThan(before.max_seq);
  } finally {
    copy.close();
  }
  expect(checkDatabase(db)).toMatchObject({
    history_id: before.history_id,
    count: 13,
  });
  await expect(backupDatabase(db, backup)).rejects.toThrow("уже существует");
  await expect(restoreDatabase(backup, path)).rejects.toThrow("уже существует");
  const alias = join(directory, "alias.db");
  symlinkSync(path, alias);
  await expect(backupDatabase(db, alias)).rejects.toThrow("уже существует");
  const target = join(directory, "sidecar.db");
  writeFileSync(target + "-wal", "do not touch");
  await expect(backupDatabase(db, target)).rejects.toThrow("уже существует");
  expect(readFileSync(target + "-wal", "utf8")).toBe("do not touch");
  await expect(backupDatabase(db, resolve("public/backup.db"))).rejects.toThrow(
    "public",
  );
  const bad = join(directory, "bad.db");
  writeFileSync(bad, "not a database");
  await expect(
    restoreDatabase(bad, join(directory, "bad-restored.db")),
  ).rejects.toThrow();
});

it("fails controlled writes on a busy writer without acknowledging a new row", () => {
  const second = openDatabase(path);
  try {
    db.sqlite.exec("BEGIN IMMEDIATE");
    expect(() => insertEvent(second, base())).toThrow(/locked/);
    db.sqlite.exec("ROLLBACK");
    expect(checkDatabase(db).count).toBe(0);
    expect(insertEvent(second, base()).inserted).toBe(true);
  } finally {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    second.close();
  }
});

it.each([
  { ...base(), created_at: "2026-02-30T12:00:00Z" },
  { ...base(), created_at: "2026-11-07T24:00:00Z" },
  { ...base(), created_at: "2026-11-07T12:00:00.1234Z" },
  { ...base(), id: "  " },
  { ...base(), extra: true },
  { ...base(), payload: { x: "я".repeat(9000) } },
  { ...base(), error_code: "not-an-error" },
  { ...base(), source: "\ud800" },
])("rejects malformed storage input before insertion %j", (input) => {
  expect(() => normalizeEvent(input)).toThrow();
  expect(checkDatabase(db).count).toBe(0);
});

it("backs up consistently while new commits arrive on the live WAL connection", async () => {
  seedEvents(db, smallFixtures(), 0);
  const destination = join(directory, "during-writes.db");
  const pending = backupDatabase(db, destination);
  for (let i = 0; i < 25; i++) {
    insertEvent(db, { ...base(), id: `during-backup-${i}` });
    // Interleave commits with Online Backup's setImmediate page transfers.
    await new Promise<void>((done) => setImmediate(done));
  }
  const result = await pending;
  expect(result.count).toBeGreaterThanOrEqual(12);
  expect(result.count).toBeLessThanOrEqual(37);
  const copy = openDatabase(destination);
  try {
    expect(checkDatabase(copy).count).toBe(result.count);
    expect(searchEvents(copy, "заяв", 100)).toHaveLength(result.count - 2);
  } finally {
    copy.close();
  }
  expect(checkDatabase(db).count).toBe(37);
});

it("serializes concurrent identical and conflicting deliveries from separate processes", async () => {
  const { spawn } = await import("node:child_process");
  const run = (event: unknown) =>
    new Promise<{ inserted?: boolean; error?: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {openDatabase} from './src/server/db/connection.ts';
      import {insertEvent} from './src/server/events/store.ts';
      const db=openDatabase(process.env.TEST_DATABASE_PATH);
      try { console.log(JSON.stringify({inserted:insertEvent(db,JSON.parse(process.env.TEST_EVENT)).inserted})); }
      catch(e) { console.log(JSON.stringify({error:e.message})); }
      finally { db.close(); }
    `,
        ],
        {
          env: {
            ...process.env,
            TEST_DATABASE_PATH: path,
            TEST_EVENT: JSON.stringify(event),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(stderr));
        else {
          try {
            done(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  const identical = await Promise.all([run(base()), run(base()), run(base())]);
  expect(identical.filter((r) => r.inserted)).toHaveLength(1);
  expect(identical.filter((r) => r.inserted === false)).toHaveLength(2);
  const conflict = await Promise.all([
    run({ ...base(), id: "competing", message: "first" }),
    run({ ...base(), id: "competing", message: "second" }),
  ]);
  expect(conflict.filter((r) => r.inserted)).toHaveLength(1);
  expect(conflict.filter((r) => r.error === "EVENT_ID_CONFLICT")).toHaveLength(
    1,
  );
  expect(checkDatabase(db).count).toBe(2);
});

it("preserves all JSON keys and distinguishes payload changes without prototype pollution", () => {
  const payload = JSON.parse(
    '{"__proto__":{"polluted":true},"nested":{"__proto__":1},"constructor":2}',
  ) as Record<string, never>;
  const first = insertEvent(db, { ...base(), payload });
  expect(first.event.payloadJson).toBe(
    '{"__proto__":{"polluted":true},"constructor":2,"nested":{"__proto__":1}}',
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(() =>
    insertEvent(db, { ...base(), payload: { constructor: 2, nested: {} } }),
  ).toThrow("EVENT_ID_CONFLICT");
  const nested = (levels: number): unknown =>
    levels === 1 ? {} : { child: nested(levels - 1) };
  expect(() =>
    normalizeEvent({ ...base(), payload: nested(16) }),
  ).not.toThrow();
  expect(() => normalizeEvent({ ...base(), payload: nested(17) })).toThrow();
  expect(() =>
    normalizeEvent({ ...base(), payload: { value: undefined } }),
  ).toThrow();
});
