import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type AppDatabase } from "../../src/server/db/connection";
import { migrateDatabase } from "../../src/server/db/migrations";
import { insertEvent } from "../../src/server/events/store";
import { createApi } from "../../src/server/api/handler";
import { EXPORT_LIMIT } from "../../src/server/api/export";

let db: AppDatabase, directory: string, api: ReturnType<typeof createApi>;
const input = (i: number) => ({
  id: `экспорт-${i}`,
  source: i % 3 ? "CRM" : "Сайт",
  type: i % 2 ? "lead.created" : "order.paid",
  status: i % 3 ? "error" : "success",
  created_at: `2026-11-0${(i % 2) + 1}T12:00:00Z`,
  message: "Ошибка передачи, кириллица 🧩",
  payload: { i, nested: { value: "Данные" } },
});
const call = (path: string, init?: RequestInit) =>
  api(new Request(`http://local${path}`, init));
const path = (params: Record<string, string> = {}) =>
  `/api/events/export?${new URLSearchParams({ format: "json", ...params })}`;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "monitor-export-"));
  db = openDatabase(join(directory, "events.db"), { create: true });
  migrateDatabase(db);
  api = createApi({ database: () => db });
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("exports more than a page with combined filters, complete payloads and a fixed watermark during writes", async () => {
  db.sqlite.transaction(() => {
    for (let i = 0; i < 450; i++) insertEvent(db, input(i));
  })();
  const params = new URLSearchParams({
    status: "error",
    source: "CRM",
    type: "lead.created",
    q: "ошибка кирил",
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-03T00:00:00Z",
  });
  const overview = await (await call(`/api/overview?${params}`)).json();
  const snapshot = overview.snapshot.token;
  const response = await call(
    path({ snapshot, sort: "created_at", direction: "asc" }),
  );
  const reader = response.body!.getReader();
  const chunks = [(await reader.read()).value!];
  insertEvent(db, { ...input(999), source: "CRM", status: "error" });
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  expect(result.count).toBe(150);
  expect(result.count).toBe(overview.totals.total);
  expect(result.items).toHaveLength(result.count);
  expect(result.snapshot).toEqual(overview.snapshot);
  expect(
    result.items.every((item: { payload?: unknown }) => item.payload),
  ).toBe(true);
  expect(
    result.items.some((item: { id: string }) => item.id === "экспорт-999"),
  ).toBe(false);
  const ids: string[] = [];
  let next: string | null =
    `/api/events?${new URLSearchParams({ snapshot, sort: "created_at", direction: "asc" })}`;
  while (next) {
    const page = await (await call(next)).json();
    ids.push(...page.items.map((item: { id: string }) => item.id));
    next = page.page.next_cursor
      ? `/api/events?${new URLSearchParams({ cursor: page.page.next_cursor })}`
      : null;
  }
  expect(result.items.map((item: { id: string }) => item.id)).toEqual(ids);
});

it("uses the journal ordering for every sort and direction, including equal keys", async () => {
  db.sqlite.transaction(() => {
    for (let i = 0; i < 215; i++) insertEvent(db, input(i));
  })();
  for (const sort of ["seq", "created_at", "source", "type", "status"]) {
    for (const direction of ["asc", "desc"]) {
      const result = await (await call(path({ sort, direction }))).json();
      const ids: string[] = [];
      let next: string | null =
        `/api/events?${new URLSearchParams({ snapshot: result.snapshot.token, sort, direction, limit: "100" })}`;
      while (next) {
        const page = await (await call(next)).json();
        ids.push(...page.items.map((item: { id: string }) => item.id));
        next = page.page.next_cursor
          ? `/api/events?${new URLSearchParams({ cursor: page.page.next_cursor })}`
          : null;
      }
      expect(result.items.map((item: { id: string }) => item.id)).toEqual(ids);
    }
  }
});

// Parse actual CSV cells rather than comparing to the serializer implementation.
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}
it("escapes CSV quotes, commas and newlines; neutralizes formulas and preserves original JSON", async () => {
  const messages = [
    'Кириллица, "кавычки"\nВторая строка 🧩',
    '=HYPERLINK("https://invalid")',
    "+SUM(1,2)",
    "-1+2",
    "@SUM(1)",
    " \t=1+1",
  ];
  messages.forEach((message, i) => insertEvent(db, { ...input(i), message }));
  const response = await call(
    path({ format: "csv", sort: "seq", direction: "asc" }),
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
  const rows = parseCsv(bytes.toString());
  expect(rows[0]).toEqual([
    "id",
    "source",
    "type",
    "status",
    "created_at",
    "message",
    "seq",
    "received_at",
    "error_code",
    "payload",
  ]);
  expect(rows[1]![5]).toBe(messages[0]);
  for (let i = 1; i < messages.length; i++)
    expect(rows[i + 1]![5]).toBe("'" + messages[i]!.trim());
  expect(JSON.parse(rows[1]![9]!)).toEqual(input(0).payload);
  const json = await (
    await call(path({ sort: "seq", direction: "asc" }))
  ).json();
  expect(json.items.map((item: { message: string }) => item.message)).toEqual(
    messages.map((s) => s.trim()),
  );
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="events-[\w-]+\.csv"$/,
  );
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
});

it("exports empty results and returns count without a stream for HEAD", async () => {
  const json = await (await call(path())).json();
  expect(json.count).toBe(0);
  expect(json.items).toEqual([]);
  const head = await call(path(), { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
  expect(head.headers.get("x-export-count")).toBe("0");
  const csv = await call(path({ format: "csv" }));
  expect(
    parseCsv(Buffer.from(await csv.arrayBuffer()).toString()),
  ).toHaveLength(1);
});

it("rejects invalid formats, paging parameters, mismatched filters and stale snapshots before streaming", async () => {
  const summary = await (await call("/api/overview")).json();
  for (const query of [
    "",
    "?format=xml",
    "?format=json&format=csv",
    "?format=json&limit=100",
    "?format=json&cursor=bad",
    "?format=json&unknown=x",
    "?format=json&snapshot=bad",
  ]) {
    expect((await call(`/api/events/export${query}`)).status).toBe(400);
  }
  expect(
    (await call(path({ snapshot: summary.snapshot.token, status: "error" })))
      .status,
  ).toBe(400);
  db.sqlite
    .prepare("UPDATE app_meta SET value=? WHERE key='history_id'")
    .run(crypto.randomUUID());
  const stale = await call(path({ snapshot: summary.snapshot.token }), {
    method: "HEAD",
  });
  expect(stale.status).toBe(409);
  expect(stale.headers.get("x-error-code")).toBe("SNAPSHOT_STALE");
  expect((await call(path(), { method: "POST" })).status).toBe(405);
});

it("honors backpressure, releases slots on cancel/abort and permits writes between chunks", async () => {
  const prepare = vi.spyOn(db.sqlite, "prepare");
  const eventReads = () =>
    prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT e.seq")).length;
  const first = await call(path());
  const second = await call(path());
  expect(eventReads()).toBe(0);
  expect((await call(path())).status).toBe(429);
  await first.body!.cancel();
  const controller = new AbortController();
  const third = await call(path(), { signal: controller.signal });
  const reader = third.body!.getReader();
  await reader.read();
  // Consuming only the metadata must not eagerly read the next event batch.
  expect(eventReads()).toBe(0);
  insertEvent(db, input(1));
  expect(db.sqlite.inTransaction).toBe(false);
  controller.abort();
  await expect(reader.read()).rejects.toThrow();
  await second.body!.cancel();
  const final = await call(path());
  expect(final.status).toBe(200);
  await final.body!.cancel();
  prepare.mockRestore();
});

it("exports the 100k boundary in bounded chunks and rejects 100001 before attachment headers", async () => {
  db.sqlite
    .exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${EXPORT_LIMIT})
    INSERT INTO events(id,source,type,status,created_at_ms,received_at_ms,message,canonical_hash,source_sort,type_sort)
    SELECT 'bulk-'||i,'CRM','bulk','success',0,0,'Synthetic',printf('%064d',0),'crm','bulk' FROM n`);
  const response = await call(path());
  expect(response.status).toBe(200);
  let count = 0,
    maxChunk = 0;
  const reader = response.body!.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    maxChunk = Math.max(maxChunk, chunk.value.length);
    count += (new TextDecoder().decode(chunk.value).match(/"id":"bulk-/g) ?? [])
      .length;
  }
  expect(count).toBe(EXPORT_LIMIT);
  expect(maxChunk).toBeLessThan(100_000);
  insertEvent(db, input(999999));
  const rejected = await call(path());
  expect(rejected.status).toBe(413);
  expect(rejected.headers.has("content-disposition")).toBe(false);
  expect((await rejected.json()).error.code).toBe("EXPORT_LIMIT");
}, 30_000);
