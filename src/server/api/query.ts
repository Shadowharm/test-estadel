import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, textField, validDate } from "../events/normalize.ts";
import { compileSearch } from "../events/search.ts";
import { HttpError, invalidQuery } from "./errors.ts";
import { Tokens } from "./tokens.ts";

export const sortSchema = z.enum([
  "seq",
  "created_at",
  "source",
  "type",
  "status",
]);
const directionSchema = z.enum(["asc", "desc"]);
const iso = z
  .string()
  .refine(validDate)
  .refine((s) => new Date(s).toISOString() === s);
const filtersSchema = z.strictObject({
  status: z.enum(["success", "error"]).nullable(),
  source: z.array(z.string()).max(20),
  type: z.array(z.string()).max(20),
  q: z.string().nullable(),
  terms: z.string().nullable(),
  from: iso.nullable(),
  to: iso.nullable(),
});
const snapshotSchema = z.strictObject({
  v: z.literal(1),
  history_id: z.uuid(),
  max_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  as_of: iso,
  from: iso.nullable(),
  to: iso.nullable(),
  filters: filtersSchema,
  filter_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Filters = z.infer<typeof filtersSchema>;
export type SnapshotData = z.infer<typeof snapshotSchema>;
export const cursorSchema = z.strictObject({
  v: z.literal(1),
  snapshot: z.string().max(8192),
  sort: sortSchema,
  direction: directionSchema,
  limit: z.number().int().min(1).max(100),
  edge: z.enum(["next", "previous"]),
  key: z
    .array(
      z.union([
        z.string(),
        z.number().int().min(-62135596800000).max(Number.MAX_SAFE_INTEGER),
      ]),
    )
    .min(1)
    .max(2),
});
export type Cursor = z.infer<typeof cursorSchema>;
export const facetCursorSchema = z.strictObject({
  v: z.literal(1),
  snapshot: z.string().max(8192),
  field: z.enum(["source", "type"]),
  q: z.string(),
  limit: z.number().int().min(1).max(200),
  key: z.tuple([z.string(), z.string()]),
});
export type FacetCursor = z.infer<typeof facetCursorSchema>;
export type Query = ReturnType<typeof parseQuery>;
export function filterHash(filters: Filters) {
  const { status, source, type, terms, from, to } = filters;
  const effective = { status, source, type, terms, from, to };
  return createHash("sha256").update(canonicalJson(effective)).digest("hex");
}
function values(params: URLSearchParams, key: "source" | "type") {
  const result = params
    .getAll(key)
    .map((s) => textField(key === "source" ? 100 : 150).safeParse(s));
  if (result.some((v) => !v.success)) invalidQuery();
  const normalized = [...new Set(result.map((v) => v.data!))].sort();
  if (normalized.length > 20) invalidQuery();
  return normalized;
}
function integer(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > max)
    invalidQuery();
  return Number(value);
}
export function parseQuery(
  url: URL,
  kind: "events" | "overview" | "facets" | "export",
) {
  const params = url.searchParams;
  if (Buffer.byteLength(url.search.slice(1)) > 16384) invalidQuery();
  const allowed = new Set([
    "status",
    "source",
    "type",
    "q",
    "preset",
    "from",
    "to",
    "snapshot",
    ...(kind === "export"
      ? ["sort", "direction", "format"]
      : kind === "events"
        ? ["sort", "direction", "limit", "cursor"]
        : kind === "facets"
          ? ["field", "facet-q", "limit", "cursor"]
          : []),
  ]);
  for (const [key, value] of params) {
    if (
      !allowed.has(key) ||
      !value ||
      Buffer.byteLength(value) > 8192 ||
      (!["source", "type"].includes(key) && params.getAll(key).length > 1)
    )
      invalidQuery();
  }
  const status = params.get("status");
  if (status !== null && status !== "success" && status !== "error")
    invalidQuery();
  const preset = params.get("preset");
  if (preset !== null && !["all", "24h", "7d", "30d"].includes(preset))
    invalidQuery();
  if (params.has("from") !== params.has("to") || (preset && params.has("from")))
    invalidQuery();
  const from = params.get("from"),
    to = params.get("to");
  if (from !== null && (!validDate(from) || !validDate(to!))) invalidQuery();
  const q = params.get("q")?.trim().normalize("NFC") ?? null;
  const terms = q === null ? null : compileSearch(q);
  const sort = sortSchema.safeParse(params.get("sort") ?? "seq");
  const direction = directionSchema.safeParse(
    params.get("direction") ?? "desc",
  );
  if (!sort.success || !direction.success) invalidQuery();
  const field = params.get("field");
  if (kind === "facets" && field !== "source" && field !== "type")
    invalidQuery();
  const facetQ =
    params.get("facet-q")?.trim().normalize("NFKC").toLowerCase() ?? "";
  if (
    (params.has("facet-q") && !facetQ) ||
    [...facetQ].length > 100 ||
    !facetQ.isWellFormed() ||
    /\p{Cc}/u.test(facetQ)
  )
    invalidQuery();
  return {
    params,
    status: status as Filters["status"],
    source: values(params, "source"),
    type: values(params, "type"),
    q,
    terms,
    preset: preset ?? "all",
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    sort: sort.data,
    direction: direction.data,
    limit: integer(
      params.get("limit"),
      kind === "facets" ? 100 : 50,
      kind === "facets" ? 200 : 100,
    ),
    field: field as "source" | "type",
    facetQ,
    snapshot: params.get("snapshot"),
    cursor: params.get("cursor"),
  };
}
function validateFilters(f: Filters) {
  const p = new URL("http://local/api");
  if (f.status) p.searchParams.set("status", f.status);
  f.source.forEach((v) => p.searchParams.append("source", v));
  f.type.forEach((v) => p.searchParams.append("type", v));
  if (f.q !== null) p.searchParams.set("q", f.q);
  if (f.from !== null) p.searchParams.set("from", f.from);
  if (f.to !== null) p.searchParams.set("to", f.to);
  const q = parseQuery(p, "overview");
  const normalized = {
    status: q.status,
    source: q.source,
    type: q.type,
    q: q.q,
    terms: q.terms,
    from: q.from,
    to: q.to,
  };
  if (canonicalJson(normalized) !== canonicalJson(f))
    throw new Error("filters");
  checkRange(f);
  return f;
}
function checkRange(f: Filters) {
  if (Buffer.byteLength(canonicalJson(f)) > 2048) invalidQuery();
  if (f.from === null && f.to === null) return;
  if (f.from === null || f.to === null) return invalidQuery();
  const duration = Date.parse(f.to) - Date.parse(f.from);
  if (
    duration <= 0 ||
    duration > 366 * 86400000 ||
    Buffer.byteLength(canonicalJson(f)) > 2048
  )
    invalidQuery();
}
export function readSnapshot(tokens: Tokens, token: string): SnapshotData {
  try {
    const data = snapshotSchema.parse(tokens.read("snapshot", token));
    validateFilters(data.filters);
    if (
      data.from !== data.filters.from ||
      data.to !== data.filters.to ||
      data.filter_hash !== filterHash(data.filters)
    )
      throw new Error("snapshot");
    return data;
  } catch {
    throw new HttpError(400, "INVALID_SNAPSHOT");
  }
}
export function resolveSnapshot(
  q: Query,
  tokens: Tokens,
  history_id: string,
  max_seq: number,
  now = Date.now(),
) {
  if (q.snapshot) {
    const data = readSnapshot(tokens, q.snapshot);
    if (data.history_id !== history_id)
      throw new HttpError(409, "SNAPSHOT_STALE");
    if (data.max_seq > max_seq) throw new HttpError(409, "SNAPSHOT_AHEAD");
    const f = data.filters;
    if (q.params.has("preset")) throw new HttpError(400, "CURSOR_MISMATCH");
    for (const key of [
      "status",
      "source",
      "type",
      "terms",
      "from",
      "to",
    ] as const) {
      const parameter = key === "terms" ? "q" : key;
      if (
        q.params.has(parameter) &&
        canonicalJson(q[key]) !== canonicalJson(f[key])
      )
        throw new HttpError(400, "CURSOR_MISMATCH");
    }
    return { data, token: q.snapshot };
  }
  const as_of = new Date(now).toISOString();
  const days = q.preset === "24h" ? 1 : q.preset === "30d" ? 30 : 7;
  const filters: Filters = {
    status: q.status,
    source: q.source,
    type: q.type,
    q: q.q,
    terms: q.terms,
    from:
      q.from ??
      (q.preset === "all"
        ? null
        : new Date(now - days * 86400000).toISOString()),
    to: q.to ?? (q.preset === "all" ? null : as_of),
  };
  checkRange(filters);
  const data: SnapshotData = {
    v: 1,
    history_id,
    max_seq,
    as_of,
    from: filters.from,
    to: filters.to,
    filters,
    filter_hash: filterHash(filters),
  };
  return { data, token: tokens.sign("snapshot", data) };
}
export function publicSnapshot(s: { data: SnapshotData; token: string }) {
  const { history_id, max_seq, as_of, from, to } = s.data;
  return { history_id, max_seq, as_of, from, to, token: s.token };
}
export function readCursor(q: Query, tokens: Tokens): Cursor | undefined {
  if (!q.cursor) return;
  const parsed = cursorSchema.safeParse(tokens.read("cursor", q.cursor));
  if (!parsed.success) throw new HttpError(400, "INVALID_CURSOR");
  const c = parsed.data;
  const numeric = c.sort === "seq" || c.sort === "created_at";
  if (
    c.key.length !== (c.sort === "seq" ? 1 : 2) ||
    typeof c.key[0] !== (numeric ? "number" : "string") ||
    typeof c.key.at(-1) !== "number" ||
    Number(c.key.at(-1)) < 1 ||
    (c.sort === "created_at" && Number(c.key[0]) > 253402300799999) ||
    (typeof c.key[0] === "string" && Buffer.byteLength(c.key[0]) > 2048) ||
    (c.sort === "status" && !["success", "error"].includes(String(c.key[0])))
  )
    throw new HttpError(400, "INVALID_CURSOR");
  for (const key of ["sort", "direction", "limit", "snapshot"] as const) {
    if (q.params.has(key) && q[key] !== c[key])
      throw new HttpError(400, "CURSOR_MISMATCH");
  }
  q.snapshot = c.snapshot;
  q.sort = c.sort;
  q.direction = c.direction;
  q.limit = c.limit;
  return c;
}
