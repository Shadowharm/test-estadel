import { describe, expect, it } from "vitest";
import {
  defaults,
  readConditions,
  workspaceHref,
} from "../../src/features/journal/state";
import {
  intervalConditions,
  percent,
  sourceRows,
  boundaryTime,
} from "../../src/features/overview/model";

describe("overview drill-down", () => {
  it("shows distinct boundaries for a one-millisecond bucket", () => {
    expect(boundaryTime("2026-11-07T00:00:00.123Z")).toContain("00:00:00,123");
    expect(boundaryTime("2026-11-07T00:00:00.124Z")).toContain("00:00:00,124");
  });
  it("keeps search, status, OR filters and exact half-open millisecond boundaries", () => {
    const state = {
      ...defaults,
      q: "синхр",
      source: ["CRM", "Сайт"],
      type: ["lead.created"],
      status: "error" as const,
    };
    const bucket = {
      from: "2026-11-07T09:00:00.123Z",
      to: "2026-11-07T10:00:00.456Z",
      success: 0,
      error: 3,
    };
    const narrowed = intervalConditions(state, bucket);
    for (const view of ["overview", "events"] as const) {
      const url = new URL(
        workspaceHref(narrowed, view),
        "https://local.invalid",
      );
      expect(url.pathname).toBe(`/${view}`);
      expect(readConditions(url.searchParams)).toEqual(narrowed);
    }
  });
  it("does not invent an error rate for an empty selection", () => {
    expect(percent(null)).toBe("—");
    expect(percent(0)).toBe("0 %");
  });
  it("counts remaining sources once and distinguishes a source literally named Остальные", () => {
    const data = {
      items: [{ source: "Остальные (сумма)", total: 5, success: 3, error: 2 }],
      other: { total: 3, success: 1, error: 2 },
    };
    const rows = sourceRows(data);
    expect(rows.map((r) => r.other)).toEqual([false, true]);
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(8);
    expect(
      sourceRows({ ...data, other: { total: 0, success: 0, error: 0 } }),
    ).toHaveLength(1);
  });
});
