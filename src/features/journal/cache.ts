import type { QueryClient } from "@tanstack/react-query";
import type { VirtualItem } from "@tanstack/react-virtual";

// A page limit alone does not bound all previous filter combinations.
export const CACHE_LIMITS = { journal: 2, facet: 4, detail: 8 } as const;
export function trimCache(client: QueryClient) {
  for (const [family, limit] of Object.entries(CACHE_LIMITS)) {
    const inactive = client
      .getQueryCache()
      .findAll({ queryKey: [family], type: "inactive" })
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    inactive
      .slice(limit)
      .forEach((q) =>
        client.removeQueries({ queryKey: q.queryKey, exact: true }),
      );
  }
}
export type Anchor = {
  seq: number;
  offset: number;
  measurements?: VirtualItem[];
};
const anchors = new Map<string, Anchor>();
export function saveAnchor(key: string, anchor: Anchor) {
  anchors.delete(key);
  anchors.set(key, anchor);
  while (anchors.size > 8) anchors.delete(anchors.keys().next().value!);
}
export const getAnchor = (key: string) => anchors.get(key);
export const clearAnchors = () => anchors.clear();
