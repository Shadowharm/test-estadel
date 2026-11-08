import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type AppDatabase } from "../../src/server/db/connection";
import { migrateDatabase } from "../../src/server/db/migrations";
import { seedBenchmark } from "../../src/server/db/fixtures";
import {
  queryPlanReport,
  sortColumns,
} from "../../scripts/storage-query-plans";

let db: AppDatabase;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "monitor-plans-"));
  db = openDatabase(join(dir, "events.db"), { create: true });
  migrateDatabase(db);
  seedBenchmark(db, 2000);
});
afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

it("checks 60 sort/direction/filter plans, next/previous seeks and exact-filter indexes", () => {
  const plans = queryPlanReport(db);
  expect(plans).toHaveLength(60);
  for (const plan of plans) {
    expect(plan.plan.length).toBeGreaterThan(0);
    if (plan.filter === "all") {
      expect(plan.plan.join(" ")).not.toContain("TEMP B-TREE");
      expect(plan.seeks).toHaveLength(2);
      for (const seek of plan.seeks) {
        expect(seek.plan.join(" ")).toContain("SEARCH");
        expect(seek.plan.join(" ")).not.toContain("TEMP B-TREE");
      }
    }
    if (plan.sort === "created_at" && plan.filter === "source_period")
      expect(plan.plan.join(" ")).toContain("events_source_created_seq");
    if (plan.sort === "created_at" && plan.filter === "type_period")
      expect(plan.plan.join(" ")).toContain("events_type_created_seq");
  }
});

it.each(
  Object.entries(sortColumns).flatMap(([sort, column]) =>
    ["ASC", "DESC"].map((direction) => ({ sort, column, direction })),
  ),
)(
  "walks both keyset directions for $sort $direction with equal values",
  ({ sort, column, direction }) => {
    const order = `${column} ${direction}${sort === "seq" ? "" : `,e.seq ${direction}`}`;
    const expected = db.sqlite
      .prepare(`SELECT e.seq, ${column} AS key FROM events e ORDER BY ${order}`)
      .all() as { seq: number; key: number | string }[];
    let boundary: { seq: number; key: number | string } | undefined;
    const actual: number[] = [];
    while (true) {
      const comparison = direction === "ASC" ? ">" : "<";
      const predicate =
        sort === "seq"
          ? `e.seq ${comparison} ?`
          : `(${column},e.seq) ${comparison} (?,?)`;
      const args = boundary
        ? sort === "seq"
          ? [boundary.seq]
          : [boundary.key, boundary.seq]
        : [];
      const page = db.sqlite
        .prepare(
          `SELECT e.seq, ${column} AS key FROM events e ${boundary ? `WHERE ${predicate}` : ""} ORDER BY ${order} LIMIT 73`,
        )
        .all(...args) as typeof expected;
      if (!page.length) break;
      if (boundary) {
        const previousComparison = direction === "ASC" ? "<" : ">";
        const previousDirection = direction === "ASC" ? "DESC" : "ASC";
        const first = page[0]!;
        const prevPredicate =
          sort === "seq"
            ? `e.seq ${previousComparison} ?`
            : `(${column},e.seq) ${previousComparison} (?,?)`;
        const previous = db.sqlite
          .prepare(
            `SELECT e.seq FROM events e WHERE ${prevPredicate} ORDER BY ${column} ${previousDirection}${sort === "seq" ? "" : `,e.seq ${previousDirection}`} LIMIT 73`,
          )
          .all(...(sort === "seq" ? [first.seq] : [first.key, first.seq])) as {
          seq: number;
        }[];
        expect(previous.map((r) => r.seq).reverse()).toEqual(actual.slice(-73));
      }
      actual.push(...page.map((row) => row.seq));
      expect(actual.length).toBeLessThanOrEqual(expected.length);
      boundary = page.at(-1);
    }
    expect(actual).toEqual(expected.map((row) => row.seq));
  },
);
