import type { AppDatabase } from "../src/server/db/connection.ts";
import { compileSearch } from "../src/server/events/search.ts";

// All sort columns/indexes use SQLite default BINARY collation. Repeating COLLATE
// inside row-value seeks prevents the engine from using the composite range index.
// SQL prototypes for stage 05. These probe the physical schema; they aren't HTTP contracts.
export const sortColumns = {
  seq: "e.seq",
  created_at: "e.created_at_ms",
  source: "e.source_sort",
  type: "e.type_sort",
  status: "e.status",
} as const;

export function queryPlanReport(db: AppDatabase) {
  const period = [Date.parse("2026-11-01"), Date.parse("2026-11-08")];
  const filters: [string, string, (string | number)[]][] = [
    ["all", "1", []],
    ["period", "e.created_at_ms>=? AND e.created_at_ms<?", period],
    [
      "source_period",
      "e.source=? AND e.created_at_ms>=? AND e.created_at_ms<?",
      ["amoCRM", ...period],
    ],
    [
      "type_period",
      "e.type=? AND e.created_at_ms>=? AND e.created_at_ms<?",
      ["lead.created", ...period],
    ],
    [
      "combined",
      "e.source IN (?,?) AND e.type=? AND e.status=? AND e.created_at_ms>=? AND e.created_at_ms<?",
      ["amoCRM", "Битрикс24", "lead.created", "error", ...period],
    ],
    [
      "fts_combined",
      "e.seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?) AND e.status=? AND e.created_at_ms>=? AND e.created_at_ms<?",
      [compileSearch("ошиб тестов"), "error", ...period],
    ],
  ];
  const result = [];
  for (const [sort, column] of Object.entries(sortColumns)) {
    for (const direction of ["ASC", "DESC"] as const) {
      for (const [filter, where, params] of filters) {
        const order = `${column} ${direction}${sort === "seq" ? "" : `, e.seq ${direction}`}`;
        const sql = `SELECT e.seq, ${column} AS sort_value FROM events e WHERE ${where} ORDER BY ${order} LIMIT 50`;
        const statement = db.sqlite.prepare(sql);
        const times = Array.from({ length: 5 }, () => {
          const started = performance.now();
          statement.all(...params);
          return performance.now() - started;
        });
        const plan = (
          db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
            detail: string;
          }[]
        ).map((row) => row.detail);
        const firstPage = statement.all(...params) as {
          seq: number;
          sort_value: number | string;
        }[];
        const boundary = firstPage.at(-1);
        const seeks = [];
        if (boundary) {
          for (const movement of ["next", "previous"]) {
            const comparison =
              (direction === "ASC") === (movement === "next") ? ">" : "<";
            const seekDirection =
              movement === "next"
                ? direction
                : direction === "ASC"
                  ? "DESC"
                  : "ASC";
            const predicate =
              sort === "seq"
                ? `e.seq ${comparison} ?`
                : `(${column}, e.seq) ${comparison} (?, ?)`;
            const seekParams = [
              ...params,
              ...(sort === "seq"
                ? [boundary.seq]
                : [boundary.sort_value, boundary.seq]),
            ];
            const seekSql = `SELECT e.seq FROM events e WHERE ${where} AND ${predicate} ORDER BY ${column} ${seekDirection}${sort === "seq" ? "" : `,e.seq ${seekDirection}`} LIMIT 50`;
            seeks.push({
              movement,
              plan: (
                db.sqlite
                  .prepare(`EXPLAIN QUERY PLAN ${seekSql}`)
                  .all(...seekParams) as { detail: string }[]
              ).map((r) => r.detail),
            });
          }
        }
        result.push({
          sort,
          direction,
          filter,
          plan,
          seeks,
          warm_max_ms: Number(Math.max(...times).toFixed(3)),
        });
      }
    }
  }
  return result;
}
