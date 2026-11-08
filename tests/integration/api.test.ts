import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, type AppDatabase } from "../../src/server/db/connection";
import { migrateDatabase } from "../../src/server/db/migrations";
import { smallFixtures } from "../../src/server/db/fixtures";
import { insertEvent } from "../../src/server/events/store";
import { eventSlug } from "../../src/shared/events";
import { createApi } from "../../src/server/api/handler";
import { Tokens } from "../../src/server/api/tokens";
import { RateLimiter } from "../../src/server/api/rate-limit";
import { signingSecret } from "../../src/server/api/tokens";

let db: AppDatabase, directory: string, handler: ReturnType<typeof createApi>;
const event = () => ({
  ...smallFixtures()[1]!,
  id: randomUUID(),
  created_at: new Date().toISOString(),
});
const url = (params: Record<string, string> = {}, path = "/api/events") =>
  path + "?" + new URLSearchParams(params);
const fullRange = { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" };
async function call(path: string, init?: RequestInit) {
  return handler(new Request("https://monitor.example.test" + path, init));
}
async function get(path: string) {
  const response = await call(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  call("/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "monitor-api-test-"));
  db = openDatabase(join(directory, "events.db"), { create: true });
  migrateDatabase(db);
  handler = createApi({ database: () => db });
});
afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("returns all-time defaults, an empty timeline and a reusable snapshot on empty DB", async () => {
  const first = await get("/api/events");
  expect(first.items).toEqual([]);
  expect(first.page).toEqual({
    next_cursor: null,
    previous_cursor: null,
    has_more: false,
    has_previous: false,
  });
  const summary = await get(
    url({ snapshot: first.snapshot.token }, "/api/overview"),
  );
  expect(summary.totals).toEqual({
    total: 0,
    success: 0,
    error: 0,
    error_rate: null,
  });
  expect(summary.timeline.buckets).toEqual([]);
  expect(summary.snapshot).toEqual(first.snapshot);
});
it("creates, replays normalized delivery and preserves detail payload and original receipt time", async () => {
  const input = {
    ...event(),
    id: "stream/%/Клиент 🧩",
    payload: JSON.parse('{"__proto__":{"safe":true},"a":1}'),
  };
  const response = await post(input);
  expect(response.status).toBe(201);
  const result = await response.json();
  const again = await post({ ...input, id: " " + input.id + " " });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ event: result.event, replayed: true });
  expect(await get("/api/events/" + eventSlug(input.id))).toEqual({
    event: result.event,
  });
  expect(result.event).not.toHaveProperty("canonicalHash");
  const list = await get("/api/events");
  expect(list.items[0]).not.toHaveProperty("payload");
  expect((await post({ ...input, message: "Другое" })).status).toBe(409);
  expect((await get("/api/events")).items).toHaveLength(1);
});
it("handles concurrent repeats and conflicts without duplicate commits", async () => {
  const input = event();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => post(input)),
  );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(7);
  const conflict = await Promise.all([
    post({ ...input, message: "changed" }),
    post(input),
  ]);
  expect(conflict.map((r) => r.status)).toEqual([409, 200]);
  expect((await get("/api/events")).items).toHaveLength(1);
});
describe("strict POST validation without insertion", () => {
  for (const field of [
    "id",
    "source",
    "type",
    "status",
    "created_at",
    "message",
  ] as const) {
    it(`rejects missing ${field}`, async () => {
      const value: Record<string, unknown> = event();
      delete value[field];
      const response = await post(value);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("VALIDATION_ERROR");
      expect(data.error.fields).toContainEqual(
        expect.objectContaining({ path: `/${field}`, code: "required" }),
      );
      expect((await get("/api/events")).items).toEqual([]);
    });
  }
  for (const invalid of [
    null,
    [],
    {},
    { extra: true },
    { id: "   " },
    { source: 3 },
    { status: "pending" },
    { created_at: "2026-02-30T00:00:00Z" },
    { created_at: "2026-01-01" },
    { payload: [] },
    { payload: { text: "x".repeat(17000) } },
    { status: "success", error_code: "bad" },
  ]) {
    it(`rejects malformed value ${JSON.stringify(invalid).slice(0, 65)}`, async () => {
      const input =
        invalid === null ||
        Array.isArray(invalid) ||
        Object.keys(invalid).length === 0
          ? invalid
          : { ...event(), ...invalid };
      expect((await post(input)).status).toBe(400);
      expect((await get("/api/events")).items).toEqual([]);
    });
  }
});
it("enforces transport/body/UTF8/encoding limits, headers and safe error envelopes", async () => {
  const send = (body: BodyInit, headers: Record<string, string>) =>
    call("/api/events", {
      method: "POST",
      headers,
      body,
    });
  expect((await send("{", { "content-type": "application/json" })).status).toBe(
    400,
  );
  expect(
    (await send(new Uint8Array([0xff]), { "content-type": "application/json" }))
      .status,
  ).toBe(400);
  expect((await send("{}", { "content-type": "text/plain" })).status).toBe(415);
  expect(
    (
      await send("{}", {
        "content-type": "application/json",
        "content-encoding": "gzip",
      })
    ).status,
  ).toBe(415);
  expect(
    (await send("x".repeat(65537), { "content-type": "application/json" }))
      .status,
  ).toBe(413);
  const response = await send("{}", {
    "content-type": "application/json",
    "content-length": "65537",
  });
  expect(response.status).toBe(413);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data.error.request_id).toBe(response.headers.get("x-request-id"));
  expect(JSON.stringify(data)).not.toContain(directory);
  expect((await get("/api/events")).items).toEqual([]);
});
it("rejects malformed query, unknown fields, repeated scalars, search syntax, ranges and malformed IDs", async () => {
  for (const query of [
    "status=all",
    "status=error&status=success",
    "limit=1.1",
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=",
    "foo=1",
    "sort=seq%20DESC",
    "preset=wrong",
    "from=2020-01-01T00:00:00Z",
    "from=2020-01-01T00:00:00Z&to=2022-01-01T00:00:00Z",
    "q=***",
    "q=" + "a%20".repeat(11),
    "snapshot=x",
    "cursor=x",
    "q=" + "x".repeat(17000),
  ])
    expect((await call("/api/events?" + query)).status, query).toBe(400);
  for (const slug of ["evt-1", "~", "~YQ=", "~_w", "~IA"])
    expect((await call("/api/events/" + slug)).status).toBe(400);
  expect((await call("/api/events/" + eventSlug("missing"))).status).toBe(404);
  const wrong = await call("/api/events", { method: "DELETE" });
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("allow")).toBe("GET, POST, HEAD");
  expect((await call("/api/unknown")).status).toBe(404);
});

it("rejects signed tampering, domain confusion, mismatched conditions and stale/ahead snapshots", async () => {
  await post(event());
  const first = await get("/api/events?limit=1");
  const token = first.snapshot.token;
  expect(
    (await call(url({ snapshot: token.slice(0, -4) + "aaaa" }))).status,
  ).toBe(400);
  expect((await call(url({ snapshot: token, status: "error" }))).status).toBe(
    400,
  );
  expect((await call(url({ snapshot: token, preset: "7d" }))).status).toBe(400);
  const tokens = new Tokens(signingSecret(db));
  const data = tokens.read("snapshot", token) as Record<string, unknown>;
  for (const [patch, code] of [
    [{ history_id: randomUUID() }, "SNAPSHOT_STALE"],
    [{ max_seq: 999 }, "SNAPSHOT_AHEAD"],
  ] as const) {
    const response = await call(
      url({ snapshot: tokens.sign("snapshot", { ...data, ...patch }) }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(code);
  }
  expect(
    (await call(url({ snapshot: tokens.sign("cursor", data) }))).status,
  ).toBe(400);
});

for (const sort of ["seq", "created_at", "source", "type", "status"] as const)
  for (const direction of ["asc", "desc"] as const) {
    it(`traverses HTTP keysets and previous pages for ${sort}/${direction}, including equal keys`, async () => {
      for (let i = 0; i < 67; i++)
        insertEvent(db, {
          ...event(),
          id: `id-${i}`,
          source: ["C", "a", "Б", "A"][i % 4]!,
          type: `t${i % 3}`,
          created_at: `2020-01-0${(i % 3) + 1}T00:00:00Z`,
          status: i % 2 ? "success" : "error",
        });
      const rows = db.orm
        .select()
        .from((await import("../../src/server/db/schema")).events)
        .all();
      const sortValue = (row: (typeof rows)[number]) =>
        sort === "seq"
          ? row.seq
          : sort === "created_at"
            ? row.createdAtMs
            : sort === "source"
              ? row.sourceSort
              : sort === "type"
                ? row.typeSort
                : row.status;
      const compare = (a: string | number, b: string | number) =>
        typeof a === "number" && typeof b === "number"
          ? a - b
          : Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
      rows.sort(
        (a, b) =>
          (compare(sortValue(a), sortValue(b)) || a.seq - b.seq) *
          (direction === "asc" ? 1 : -1),
      );
      let page = await get(url({ ...fullRange, sort, direction, limit: "7" }));
      const seen = [...page.items];
      expect(page.page.has_previous).toBe(false);
      const firstSnapshot = page.snapshot;
      // New arrival belongs to the same event-time range but is excluded by watermark.
      insertEvent(db, { ...event(), created_at: "2020-01-01T00:00:00Z" });
      while (page.page.has_more) {
        const before = page;
        page = await get(url({ cursor: page.page.next_cursor }));
        seen.push(...page.items);
        expect(page.snapshot).toEqual(firstSnapshot);
        const previous = await get(url({ cursor: page.page.previous_cursor }));
        expect(previous.items).toEqual(before.items);
      }
      expect(seen.map((r) => r.id)).toEqual(rows.map((r) => r.id));
      expect(page.page.next_cursor).toBeNull();
      expect(
        (await call(url({ cursor: page.page.previous_cursor, limit: "8" })))
          .status,
      ).toBe(400);
      expect(
        (
          await call(
            url({
              cursor: page.page.previous_cursor,
              sort: sort === "seq" ? "source" : "seq",
            }),
          )
        ).status,
      ).toBe(400);
    });
  }
it("applies AND/OR/Unicode prefix search consistently to list, timeline, sources and recent errors", async () => {
  for (let i = 0; i < 24; i++)
    insertEvent(db, {
      ...event(),
      source: `CRM-${i % 12}`,
      type: i % 2 ? "lead.updated" : "order.created",
      status: i % 3 ? "success" : "error",
      message: i % 2 ? "Ошибка передачи заявки" : "Успешная синхронизация",
      created_at: `2020-01-0${(i % 4) + 1}T00:00:00Z`,
    });
  for (const filters of [
    {},
    { status: "error" },
    { status: "success", q: "ЗАЯВ" },
    { q: "ошиб перед" },
    { source: "CRM-3", type: "lead.updated" },
  ] as Record<string, string>[]) {
    const summary = await get(
      url({ ...fullRange, ...filters }, "/api/overview"),
    );
    const list = await get(url({ snapshot: summary.snapshot.token }));
    expect(list.items.length).toBe(summary.totals.total);
    expect(
      list.items.filter((r: { status: string }) => r.status === "success")
        .length,
    ).toBe(summary.totals.success);
    for (const status of ["success", "error"] as const) {
      expect(
        summary.timeline.buckets.reduce(
          (n: number, b: Record<string, number>) => n + b[status]!,
          0,
        ),
      ).toBe(summary.totals[status]);
      expect(
        summary.sources.items.reduce(
          (n: number, b: Record<string, number>) => n + b[status]!,
          summary.sources.other[status],
        ),
      ).toBe(summary.totals[status]);
    }
    expect(summary.recent_errors.length).toBeLessThanOrEqual(5);
    if (filters.status === "success") expect(summary.recent_errors).toEqual([]);
  }
  const multiple = await get(
    "/api/events?" +
      new URLSearchParams(fullRange) +
      "&source=CRM-1&source=CRM-3&type=lead.updated",
  );
  expect(multiple.items).toHaveLength(4);
  const same = await get(
    "/api/events?" +
      new URLSearchParams(fullRange) +
      "&source=CRM-3&source=CRM-1&source=CRM-1&type=lead.updated&snapshot=" +
      encodeURIComponent(multiple.snapshot.token),
  );
  expect(same.items).toEqual(multiple.items);
});
it("facets exclude only their own category, retain absent selections and paginate normalized ties", async () => {
  for (const source of ["A", "a", "a_b", "a%b", "Битрикс24", "CRM"])
    insertEvent(db, {
      ...event(),
      source,
      type: "chosen",
      status: "error",
      created_at: "2020-01-01T00:00:00Z",
    });
  insertEvent(db, {
    ...event(),
    source: "excluded",
    type: "other",
    status: "success",
    created_at: "2020-01-01T00:00:00Z",
  });
  let page = await get(
    url(
      {
        ...fullRange,
        field: "source",
        source: "missing",
        type: "chosen",
        status: "error",
        limit: "2",
      },
      "/api/facets",
    ),
  );
  expect(page.selected).toEqual([{ value: "missing", count: 0 }]);
  const seen = [...page.items];
  while (page.page.has_more) {
    page = await get(
      url({ field: "source", cursor: page.page.next_cursor }, "/api/facets"),
    );
    seen.push(...page.items);
  }
  expect(seen.map((r) => r.value)).toEqual([
    "A",
    "a",
    "a%b",
    "a_b",
    "CRM",
    "Битрикс24",
  ]);
  expect(
    (
      await get(
        url({ ...fullRange, field: "source", "facet-q": "a%" }, "/api/facets"),
      )
    ).items,
  ).toEqual([{ value: "a%b", count: 1 }]);
  expect((await call("/api/facets")).status).toBe(400);
});
it("keeps pagination signing secret stable across database reopen", () => {
  const first = signingSecret(db);
  db.close();
  db = openDatabase(join(directory, "events.db"));
  expect(signingSecret(db)).toBe(first);
});
it("maps writer contention to safe 503 with retry without committing", async () => {
  const blocker = openDatabase(join(directory, "events.db"));
  blocker.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const response = await post(event());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect((await response.json()).error.code).toBe("DB_BUSY");
  } finally {
    blocker.sqlite.exec("ROLLBACK");
    blocker.close();
  }
  expect((await get("/api/events")).items).toEqual([]);
});
it("bounds limiter memory, uses shared IP bucket, expires windows and returns retry-after", () => {
  let now = 0;
  const limiter = new RateLimiter(1, () => now);
  limiter.consume("a", 1, 1000);
  expect(() => limiter.consume("a", 1, 1000)).toThrow("Слишком много запросов");
  expect(() => limiter.consume("b", 1, 1000)).toThrow("Повторите позже");
  now = 1000;
  expect(() => limiter.consume("b", 1, 1000)).not.toThrow();
});
it("uses half-open event-time ranges with timezone normalization and supports pre-epoch keysets", async () => {
  for (const [id, date] of [
    ["before", "1969-12-31T22:00:00Z"],
    ["start", "1970-01-01T02:00:00+03:00"],
    ["end", "1970-01-01T00:00:00Z"],
  ])
    insertEvent(db, { ...event(), id, created_at: date });
  const list = await get(
    url({
      from: "1969-12-31T23:00:00Z",
      to: "1970-01-01T00:00:00Z",
      sort: "created_at",
      limit: "1",
    }),
  );
  expect(list.items.map((r: { id: string }) => r.id)).toEqual(["start"]);
  const whole = await get(
    url({
      from: "1969-12-31T00:00:00Z",
      to: "1970-01-02T00:00:00Z",
      sort: "created_at",
      direction: "asc",
      limit: "1",
    }),
  );
  expect((await get(url({ cursor: whole.page.next_cursor }))).items[0].id).toBe(
    "start",
  );
  const summary = await get(
    url({ snapshot: list.snapshot.token }, "/api/overview"),
  );
  expect(summary.totals.total).toBe(1);
  expect(
    summary.timeline.buckets.reduce(
      (sum: number, b: { success: number; error: number }) =>
        sum + b.success + b.error,
      0,
    ),
  ).toBe(1);
});
it("rejects deeply nested JSON payloads safely and enforces query filter byte/cardinality limits", async () => {
  const input =
    JSON.stringify(event()).slice(0, -1) +
    ',"payload":' +
    '{"v":'.repeat(6000) +
    "{}" +
    "}".repeat(6000) +
    "}";
  const response = await call("/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: input,
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  expect(
    (
      await call(
        "/api/events?" +
          Array.from({ length: 21 }, (_, i) => `source=s${i}`).join("&"),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        "/api/events?" +
          Array.from(
            { length: 20 },
            (_, i) => `source=${i}${"x".repeat(99)}`,
          ).join("&"),
      )
    ).status,
  ).toBe(400);
});
it("inherits facet search from cursor and rejects cross-field or cross-domain reuse", async () => {
  for (const source of ["a", "ab", "ac", "b"])
    insertEvent(db, { ...event(), source });
  const first = await get("/api/facets?field=source&facet-q=a&limit=1");
  const second = await get(
    url({ field: "source", cursor: first.page.next_cursor }, "/api/facets"),
  );
  expect(second.items[0].value).toBe("ab");
  expect(
    (
      await call(
        url({ field: "type", cursor: first.page.next_cursor }, "/api/facets"),
      )
    ).status,
  ).toBe(400);
  expect((await call(url({ cursor: first.page.next_cursor }))).status).toBe(
    400,
  );
  expect(
    (
      await call(
        url(
          { field: "source", "facet-q": "b", cursor: first.page.next_cursor },
          "/api/facets",
        ),
      )
    ).status,
  ).toBe(400);
});
it("rate limits event writes with Retry-After", async () => {
  const saturated = new RateLimiter();
  for (let i = 0; i < 1200; i++) saturated.consume("ingest", 1200, 60000);
  handler = createApi({
    database: () => db,

    limiter: saturated,
  });
  const limited = await post(event());
  expect(limited.status).toBe(429);
  expect((await limited.json()).error.code).toBe("RATE_LIMITED");
});
it("reports sequence exhaustion without inserting an unsafe integer", async () => {
  insertEvent(db, event());
  db.sqlite
    .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='events'")
    .run(Number.MAX_SAFE_INTEGER);
  const response = await post(event());
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("SEQUENCE_EXHAUSTED");
  expect((await get("/api/events")).items).toHaveLength(1);
});
it("does not leak unexpected errors or storage details", async () => {
  handler = createApi({
    database: () => {
      throw new Error("private path /var/secret SQLITE secret-password");
    },
  });
  const response = await call("/api/events");
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret-password");
});

it("reports exact detail membership using the same snapshot predicate including FTS and watermark", async () => {
  const first = {
    ...event(),
    source: "Membership",
    status: "error",
    message: "Ошибка синхронизации",
    id: "outside/кириллица?",
  };
  await post(first);
  const matching = await get(
    url({ status: "error", q: "синхр" }, "/api/overview"),
  );
  const detailPath = `/api/events/${eventSlug(first.id)}`;
  expect(
    (await get(url({ snapshot: matching.snapshot.token }, detailPath)))
      .matches_snapshot,
  ).toBe(true);
  const outside = await get(url({ status: "success" }, "/api/overview"));
  expect(
    (await get(url({ snapshot: outside.snapshot.token }, detailPath)))
      .matches_snapshot,
  ).toBe(false);
  const noSearch = await get(url({ q: "несуществующий" }, "/api/overview"));
  expect(
    (await get(url({ snapshot: noSearch.snapshot.token }, detailPath)))
      .matches_snapshot,
  ).toBe(false);
  const late = { ...first, id: "after-watermark" };
  await post(late);
  expect(
    (
      await get(
        url(
          { snapshot: matching.snapshot.token },
          `/api/events/${eventSlug(late.id)}`,
        ),
      )
    ).matches_snapshot,
  ).toBe(false);
  expect((await get(detailPath)).matches_snapshot).toBeUndefined();
  const invalidQueries: Record<string, string>[] = [
    { snapshot: "bad" },
    { status: "error" },
    { snapshot: matching.snapshot.token, q: "ошибка" },
  ];
  for (const query of invalidQueries) {
    expect((await call(url(query, detailPath))).status).toBe(400);
  }
  db.sqlite
    .prepare("UPDATE app_meta SET value=? WHERE key='history_id'")
    .run(randomUUID());
  expect(
    (await call(url({ snapshot: matching.snapshot.token }, detailPath))).status,
  ).toBe(409);
});

it("keeps a single-point overview frozen and updates the historical bucket after late delivery", async () => {
  const input = {
    ...event(),
    status: "error",
    created_at: "2020-01-01T00:00:00.123Z",
  };
  await post(input);
  const single = await get("/api/overview");
  expect(single.timeline.buckets).toEqual([
    {
      from: input.created_at,
      to: "2020-01-01T00:00:00.124Z",
      success: 0,
      error: 1,
    },
  ]);
  const range = {
    from: "2020-01-01T00:00:00.123Z",
    to: "2020-01-01T03:00:00.123Z",
  };
  const before = await get(url(range, "/api/overview"));
  expect(
    before.timeline.buckets.some(
      (b: { success: number; error: number }) => b.success + b.error === 0,
    ),
  ).toBe(true);
  await post({ ...input, id: randomUUID() });
  // A boundary event must be excluded from both overview and drill-down.
  await post({ ...input, id: randomUUID(), created_at: range.to });
  const retained = await get(
    url({ snapshot: before.snapshot.token }, "/api/overview"),
  );
  expect(retained).toEqual(before);
  const fresh = await get(url(range, "/api/overview"));
  expect(fresh.totals).toEqual({
    total: 2,
    success: 0,
    error: 2,
    error_rate: 1,
  });
  expect(fresh.timeline.buckets[0].error).toBe(2);
  const bucket = fresh.timeline.buckets[0];
  const drill = await get(url({ from: bucket.from, to: bucket.to }));
  expect(drill.items).toHaveLength(2);
  const frozenList = await get(url({ snapshot: before.snapshot.token }));
  expect(frozenList.items).toHaveLength(1);
});

it("reads and writes without credentials and defaults to all event dates", async () => {
  for (const [id, created_at] of [
    ["old", "2000-01-01T00:00:00Z"],
    ["future", "2099-01-01T00:00:00Z"],
  ]) {
    expect((await post({ ...event(), id, created_at })).status).toBe(201);
  }
  const list = await get("/api/events?limit=1");
  expect(list.snapshot.from).toBeNull();
  expect(list.snapshot.to).toBeNull();
  const next = await get(url({ cursor: list.page.next_cursor }));
  expect(
    new Set([...list.items, ...next.items].map((e: { id: string }) => e.id)),
  ).toEqual(new Set(["old", "future"]));
  const summary = await get("/api/overview");
  expect(summary.totals.total).toBe(2);
  expect(summary.timeline.buckets.length).toBeLessThanOrEqual(121);
  expect(
    summary.timeline.buckets.reduce(
      (n: number, b: { success: number; error: number }) =>
        n + b.success + b.error,
      0,
    ),
  ).toBe(2);
  expect((await get("/api/events?preset=7d")).items).toEqual([]);
  for (const path of [
    "/api/auth/sign-in/email",
    "/api/auth/get-session",
    "/api/auth/sign-out",
  ])
    expect((await call(path)).status).toBe(404);
});
