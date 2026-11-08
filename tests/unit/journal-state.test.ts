import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  conditionParams,
  defaults,
  eventHref,
  readConditions,
  validateConditions,
} from "../../src/features/journal/state";
import { CACHE_LIMITS, trimCache } from "../../src/features/journal/cache";

describe("journal URL", () => {
  it("round trips combined filters, unicode IDs and canonical UTC boundaries", () => {
    const state = {
      ...defaults,
      q: "Ошибка CRM",
      source: ["amoCRM", "Битрикс24"],
      type: ["lead.created"],
      status: "error" as const,
      preset: "custom" as const,
      from: "2026-11-07T15:00:00+03:00",
      to: "2026-11-07T16:00:00+03:00",
      sort: "source" as const,
      direction: "asc" as const,
    };
    const url = new URL(
      eventHref(state, "id/кириллица?x=1"),
      "https://local.invalid",
    );
    expect(url.searchParams.get("event")).toBe("id/кириллица?x=1");
    const restored = readConditions(url.searchParams);
    expect(restored).toEqual({
      ...state,
      from: "2026-11-07T12:00:00.000Z",
      to: "2026-11-07T13:00:00.000Z",
    });
    expect(conditionParams(restored).has("event")).toBe(false);
    expect(conditionParams(restored).has("sort")).toBe(false);
  });
  it.each([
    "sort=__proto__",
    "direction=up",
    "status=all",
    "preset=year",
    "from=bad&to=bad",
    "from=2026-11-08&to=2026-11-07",
    "q=" + "я".repeat(201),
  ])("rejects invalid link %s", (query) => {
    expect(() => readConditions(new URLSearchParams(query))).toThrow();
  });
  it("validates bounded custom ranges and OR categories", () => {
    expect(
      validateConditions({
        ...defaults,
        source: Array.from({ length: 21 }, (_, i) => String(i)),
      }),
    ).toBeTruthy();
    expect(
      validateConditions({
        ...defaults,
        preset: "custom",
        from: "2020-01-01Z",
        to: "2022-01-01Z",
      }),
    ).toBeTruthy();
  });
  it("defaults to all time without sending a date filter", () => {
    expect(readConditions(new URLSearchParams())).toEqual(defaults);
    expect(defaults.preset).toBe("all");
    expect(conditionParams(defaults).toString()).toBe("");
  });
});

it("bounds all inactive filter combinations, facets and detail cache, preserving active queries", () => {
  const client = new QueryClient();
  for (const family of Object.keys(CACHE_LIMITS))
    for (let i = 0; i < 30; i++)
      client.setQueryData([family, i], { i }, { updatedAt: i + 1 });
  trimCache(client);
  for (const [family, limit] of Object.entries(CACHE_LIMITS)) {
    expect(client.getQueryCache().findAll({ queryKey: [family] })).toHaveLength(
      limit,
    );
    expect(client.getQueryData([family, 29])).toEqual({ i: 29 });
    expect(client.getQueryData([family, 0])).toBeUndefined();
  }
  client.clear();
});
