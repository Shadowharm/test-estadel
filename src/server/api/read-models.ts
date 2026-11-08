import type { AppDatabase } from "../db/connection.ts";
import type { events } from "../db/schema.ts";
import type {
  EventSummary,
  EventDetail,
  EventsResponse,
  OverviewResponse,
  FacetsResponse,
} from "../../shared/events.ts";
import { HttpError } from "./errors.ts";
import {
  facetCursorSchema,
  parseQuery,
  publicSnapshot,
  readCursor,
  resolveSnapshot,
  type Filters,
  type Query,
  type SnapshotData,
} from "./query.ts";
import { Tokens } from "./tokens.ts";

type Row = Omit<typeof events.$inferSelect, "canonicalHash">;
const projection = `e.seq,e.id,e.source,e.type,e.status,e.message,e.created_at_ms AS createdAtMs,e.received_at_ms AS receivedAtMs,e.error_code AS errorCode,e.payload_json AS payloadJson,e.source_sort AS sourceSort,e.type_sort AS typeSort`;
export function eventDto(row: Row, detail = false): EventDetail {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    status: row.status,
    message: row.message,
    created_at: new Date(row.createdAtMs).toISOString(),
    received_at: new Date(row.receivedAtMs).toISOString(),
    seq: row.seq,
    ...(row.errorCode === null ? {} : { error_code: row.errorCode }),
    ...(detail && row.payloadJson !== null
      ? { payload: JSON.parse(row.payloadJson) as Record<string, unknown> }
      : {}),
  };
}
export const columns = {
  seq: "e.seq",
  created_at: "e.created_at_ms",
  source: "e.source_sort",
  type: "e.type_sort",
  status: "e.status",
} as const;
export function predicate(
  filters: Filters,
  maxSeq: number,
  exclude?: "source" | "type",
) {
  const clauses = ["e.seq <= ?"];
  const params: (string | number)[] = [maxSeq];
  if (filters.from !== null) {
    clauses.push("e.created_at_ms >= ?");
    params.push(Date.parse(filters.from));
  }
  if (filters.to !== null) {
    clauses.push("e.created_at_ms < ?");
    params.push(Date.parse(filters.to));
  }
  if (filters.status) {
    clauses.push("e.status = ?");
    params.push(filters.status);
  }
  for (const field of ["source", "type"] as const) {
    if (field !== exclude && filters[field].length) {
      clauses.push(
        `e.${field} IN (${filters[field].map(() => "?").join(",")})`,
      );
      params.push(...filters[field]);
    }
  }
  if (filters.terms) {
    clauses.push(
      "e.seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)",
    );
    params.push(filters.terms);
  }
  return { sql: clauses.join(" AND "), params };
}
export function metadata(db: AppDatabase) {
  const meta = db.sqlite
    .prepare("SELECT value FROM app_meta WHERE key='history_id'")
    .get() as { value: string } | undefined;
  if (!meta) throw new HttpError(503, "NOT_READY");
  const { max } = db.sqlite
    .prepare("SELECT COALESCE(MAX(seq),0) AS max FROM events")
    .get() as { max: number };
  return { history: meta.value, max };
}
function key(row: Row, sort: Query["sort"]): (string | number)[] {
  if (sort === "seq") return [row.seq];
  return [
    sort === "created_at"
      ? row.createdAtMs
      : sort === "source"
        ? row.sourceSort
        : sort === "type"
          ? row.typeSort
          : row.status,
    row.seq,
  ];
}
function boundary(sort: Query["sort"], op: "<" | ">") {
  return sort === "seq"
    ? `e.seq ${op} ?`
    : `(${columns[sort]},e.seq) ${op} (?,?)`;
}
export function listEvents(
  db: AppDatabase,
  tokens: Tokens,
  url: URL,
  detail = false,
): EventsResponse {
  const q = parseQuery(url, "events"),
    cursor = readCursor(q, tokens);
  return db.sqlite.transaction(() => {
    const meta = metadata(db),
      snapshot = resolveSnapshot(q, tokens, meta.history, meta.max);
    const p = predicate(snapshot.data.filters, snapshot.data.max_seq);
    const nextOp = q.direction === "asc" ? ">" : "<";
    const previous = cursor?.edge === "previous";
    const op = previous ? (nextOp === ">" ? "<" : ">") : nextOp;
    const order = previous
      ? q.direction === "asc"
        ? "desc"
        : "asc"
      : q.direction;
    const orderSql =
      q.sort === "seq"
        ? `e.seq ${order}`
        : `${columns[q.sort]} ${order},e.seq ${order}`;
    const rows = db.sqlite
      .prepare(
        `SELECT ${projection} FROM events e WHERE ${p.sql}${cursor ? ` AND ${boundary(q.sort, op)}` : ""} ORDER BY ${orderSql} LIMIT ?`,
      )
      .all(...p.params, ...(cursor?.key ?? []), q.limit) as Row[];
    if (previous) rows.reverse();
    const exists = (row: Row | undefined, operator: "<" | ">") =>
      !!row &&
      !!db.sqlite
        .prepare(
          `SELECT 1 FROM events e WHERE ${p.sql} AND ${boundary(q.sort, operator)} LIMIT 1`,
        )
        .get(...p.params, ...key(row, q.sort));
    const has_more = exists(rows.at(-1), nextOp),
      has_previous = exists(rows[0], nextOp === ">" ? "<" : ">");
    const makeCursor = (edge: "next" | "previous", row: Row) =>
      tokens.sign("cursor", {
        v: 1,
        snapshot: snapshot.token,
        sort: q.sort,
        direction: q.direction,
        limit: q.limit,
        edge,
        key: key(row, q.sort),
      });
    return {
      items: rows.map((r): EventSummary => eventDto(r, detail)),
      page: {
        next_cursor: has_more ? makeCursor("next", rows.at(-1)!) : null,
        previous_cursor: has_previous ? makeCursor("previous", rows[0]!) : null,
        has_more,
        has_previous,
      },
      snapshot: publicSnapshot(snapshot),
    };
  })();
}
export function detailEvent(
  db: AppDatabase,
  id: string,
  context?: { tokens: Tokens; url: URL },
) {
  return db.sqlite.transaction(() => {
    const row = db.sqlite
      .prepare(`SELECT ${projection} FROM events e WHERE e.id=?`)
      .get(id) as Row | undefined;
    if (!row) throw new HttpError(404, "EVENT_NOT_FOUND");
    if (!context?.url.search) return { event: eventDto(row, true) };
    const q = parseQuery(context.url, "overview");
    if ([...q.params.keys()].some((key) => key !== "snapshot") || !q.snapshot)
      throw new HttpError(400, "INVALID_QUERY");
    const meta = metadata(db);
    const snapshot = resolveSnapshot(q, context.tokens, meta.history, meta.max);
    const p = predicate(snapshot.data.filters, snapshot.data.max_seq);
    const matches = db.sqlite
      .prepare(`SELECT 1 FROM events e WHERE e.id=? AND ${p.sql}`)
      .get(id, ...p.params);
    return { event: eventDto(row, true), matches_snapshot: !!matches };
  })();
}
type Counts = { total: number; success: number; error: number };
const counts =
  "COUNT(*) AS total,COALESCE(SUM(e.status='success'),0) AS success,COALESCE(SUM(e.status='error'),0) AS error";
function timeline(
  db: AppDatabase,
  data: SnapshotData,
  p: ReturnType<typeof predicate>,
) {
  // Without a date filter, only chart bounds come from the matching events.
  // The list and totals retain the complete snapshot, including future dates.
  const extent =
    data.from === null
      ? (db.sqlite
          .prepare(
            `SELECT MIN(e.created_at_ms) AS first, MAX(e.created_at_ms) AS last FROM events e WHERE ${p.sql}`,
          )
          .get(...p.params) as { first: number | null; last: number | null })
      : undefined;
  if (extent && extent.first === null) return { step_seconds: 60, buckets: [] };
  const from = data.from === null ? extent!.first! : Date.parse(data.from);
  const to = data.to === null ? extent!.last! + 1 : Date.parse(data.to);
  const step =
    [60, 300, 900, 3600, 21600, 86400, 604800].find(
      (s) => Math.ceil(to / (s * 1000)) - Math.floor(from / (s * 1000)) <= 120,
    ) ?? Math.ceil((to - from) / 119000);
  const stepMs = step * 1000;
  const rows = db.sqlite
    .prepare(
      `SELECT CAST(floor(e.created_at_ms * 1.0 / ?) AS INTEGER) AS bucket,${counts} FROM events e WHERE ${p.sql} GROUP BY bucket`,
    )
    .all(stepMs, ...p.params) as (Counts & { bucket: number })[];
  const grouped = new Map(rows.map((r) => [r.bucket, r]));
  const buckets = [];
  for (
    let start = Math.floor(from / stepMs) * stepMs;
    start < to;
    start += stepMs
  ) {
    const r = grouped.get(start / stepMs);
    buckets.push({
      from: new Date(Math.max(from, start)).toISOString(),
      to: new Date(Math.min(to, start + stepMs)).toISOString(),
      success: r?.success ?? 0,
      error: r?.error ?? 0,
    });
  }
  return { step_seconds: step, buckets };
}
export function overview(
  db: AppDatabase,
  tokens: Tokens,
  url: URL,
): OverviewResponse {
  const q = parseQuery(url, "overview");
  return db.sqlite.transaction(() => {
    const meta = metadata(db),
      snapshot = resolveSnapshot(q, tokens, meta.history, meta.max);
    const p = predicate(snapshot.data.filters, snapshot.data.max_seq);
    const totals = db.sqlite
      .prepare(`SELECT ${counts} FROM events e WHERE ${p.sql}`)
      .get(...p.params) as Counts;
    const items = db.sqlite
      .prepare(
        `SELECT e.source,${counts} FROM events e WHERE ${p.sql} GROUP BY e.source ORDER BY total DESC,e.source COLLATE BINARY ASC LIMIT 10`,
      )
      .all(...p.params) as (Counts & { source: string })[];
    const other = items.reduce(
      (r, item) => ({
        total: r.total - item.total,
        success: r.success - item.success,
        error: r.error - item.error,
      }),
      { ...totals },
    );
    const errors = db.sqlite
      .prepare(
        `SELECT ${projection} FROM events e WHERE ${p.sql} AND e.status='error' ORDER BY e.seq DESC LIMIT 5`,
      )
      .all(...p.params) as Row[];
    return {
      totals: {
        ...totals,
        error_rate: totals.total ? totals.error / totals.total : null,
      },
      timeline: timeline(db, snapshot.data, p),
      sources: { items, other },
      recent_errors: errors.map((r) => eventDto(r)),
      snapshot: publicSnapshot(snapshot),
    };
  })();
}
export function facets(
  db: AppDatabase,
  tokens: Tokens,
  url: URL,
): FacetsResponse {
  const q = parseQuery(url, "facets");
  let edge: [string, string] | undefined;
  if (q.cursor) {
    const parsed = facetCursorSchema.safeParse(tokens.read("facets", q.cursor));
    if (!parsed.success) throw new HttpError(400, "INVALID_CURSOR");
    const c = parsed.data;
    if (
      c.field !== q.field ||
      (q.params.has("facet-q") && c.q !== q.facetQ) ||
      (q.params.has("limit") && c.limit !== q.limit) ||
      (q.snapshot && c.snapshot !== q.snapshot)
    )
      throw new HttpError(400, "CURSOR_MISMATCH");
    q.snapshot = c.snapshot;
    q.limit = c.limit;
    q.facetQ = c.q;
    edge = c.key;
  }
  return db.sqlite.transaction(() => {
    const meta = metadata(db),
      snapshot = resolveSnapshot(q, tokens, meta.history, meta.max);
    const p = predicate(snapshot.data.filters, snapshot.data.max_seq, q.field);
    const field = `e.${q.field}`,
      sort = `e.${q.field}_sort`;
    const escaped =
      q.facetQ
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_") + "%";
    const rows = db.sqlite
      .prepare(
        `SELECT ${field} AS value,${sort} AS sort_key,COUNT(*) AS count FROM events e WHERE ${p.sql}${q.facetQ ? ` AND ${sort} LIKE ? ESCAPE '\\'` : ""}${edge ? ` AND (${sort},${field}) > (?,?)` : ""} GROUP BY ${sort},${field} ORDER BY ${sort} ASC,${field} COLLATE BINARY ASC LIMIT ?`,
      )
      .all(
        ...p.params,
        ...(q.facetQ ? [escaped] : []),
        ...(edge ?? []),
        q.limit + 1,
      ) as { value: string; sort_key: string; count: number }[];
    const has_more = rows.length > q.limit;
    if (has_more) rows.pop();
    const selectedValues = snapshot.data.filters[q.field];
    const selected = selectedValues.map((value) => ({
      value,
      count: (
        db.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM events e WHERE ${p.sql} AND ${field}=?`,
          )
          .get(...p.params, value) as { count: number }
      ).count,
    }));
    const last = rows.at(-1);
    return {
      field: q.field,
      items: rows.map(({ value, count }) => ({ value, count })),
      selected,
      page: {
        has_more,
        next_cursor: has_more
          ? tokens.sign("facets", {
              v: 1,
              snapshot: snapshot.token,
              field: q.field,
              q: q.facetQ,
              limit: q.limit,
              key: [last!.sort_key, last!.value],
            })
          : null,
      },
      snapshot: publicSnapshot(snapshot),
    };
  })();
}
