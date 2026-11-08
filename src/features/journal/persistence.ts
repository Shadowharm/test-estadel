import { hashKey, type QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import type { JournalData } from "./use-journal";

const STORAGE_KEY = "monitor-journal-v1";
export const PERSIST_MAX_AGE = 10 * 60_000;
const MAX_CHARS = 200_000;

function clearPersistedJournal() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage can be disabled. */
  }
}

function serialize(persisted: PersistedClient, client: QueryClient) {
  const activeHash = client
    .getQueryCache()
    .findAll({ queryKey: ["journal"], type: "active" })[0]?.queryHash;
  const queries = persisted.clientState.queries
    .filter((q) => q.queryKey[0] === "journal" && q.state.status === "success")
    .sort(
      (a, b) =>
        Number(b.queryHash === activeHash) -
          Number(a.queryHash === activeHash) ||
        b.state.dataUpdatedAt - a.state.dataUpdatedAt,
    )
    .slice(0, 1)
    .map((query) => {
      const queryKey = [
        "journal",
        String(query.queryKey[1]).replace(/:\d+$/, ":0"),
      ];
      const data = query.state.data as JournalData;
      const viewKey = String(queryKey[1]);
      return {
        ...query,
        queryKey,
        queryHash: hashKey(queryKey),
        state: {
          ...query.state,
          fetchStatus: "idle",
          data: {
            pages: data.pages.slice(0, 2).map((page) => ({ ...page, viewKey })),
            pageParams: data.pageParams.slice(0, 2),
          },
        },
      };
    });
  return JSON.stringify({
    ...persisted,
    clientState: { mutations: [], queries },
  });
}

function readCached(value: string): PersistedClient {
  if (value.length > MAX_CHARS) throw new Error("Cache exceeds budget");
  const cached = JSON.parse(value) as PersistedClient;
  if (
    !Number.isFinite(cached.timestamp) ||
    !Array.isArray(cached.clientState?.queries) ||
    cached.clientState.queries.length > 1
  )
    throw new Error("Invalid cache");
  for (const query of cached.clientState.queries) {
    const data = query.state?.data as JournalData | undefined;
    if (
      query.queryKey?.[0] !== "journal" ||
      !data?.pages.length ||
      data.pages.length > 2 ||
      data.pageParams.length !== data.pages.length
    )
      throw new Error("Invalid journal");
    for (const page of data.pages) {
      if (
        !page.conditions ||
        typeof page.viewKey !== "string" ||
        !Number.isInteger(page.index) ||
        !page.list?.snapshot?.token ||
        !page.overview?.snapshot?.token ||
        ![
          page.overview.totals?.total,
          page.overview.totals?.success,
          page.overview.totals?.error,
        ].every(Number.isFinite) ||
        !Array.isArray(page.list.items) ||
        page.list.items.length > 50
      )
        throw new Error("Invalid page");
      for (const item of page.list.items) {
        if (
          ![
            item.id,
            item.source,
            item.type,
            item.message,
            item.created_at,
            item.received_at,
          ].every((v) => typeof v === "string") ||
          !["success", "error"].includes(item.status) ||
          !Number.isSafeInteger(item.seq)
        )
          throw new Error("Invalid event");
      }
    }
  }
  return cached;
}

function deserialize(value: string): PersistedClient {
  try {
    return readCached(value);
  } catch {
    clearPersistedJournal();
    return {
      timestamp: 0,
      buster: "",
      clientState: { mutations: [], queries: [] },
    };
  }
}

export function makeJournalPersister(client: QueryClient) {
  return createAsyncStoragePersister({
    key: STORAGE_KEY,
    throttleTime: 150,
    serialize: (value) => serialize(value, client),
    deserialize,
    storage: {
      getItem: (key) => {
        try {
          return window.sessionStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        try {
          // A pending throttled save must not revive an already cleared cache.
          if (
            value.length > MAX_CHARS ||
            !client
              .getQueryCache()
              .findAll({ queryKey: ["journal"] })
              .some((q) => q.state.status === "success")
          )
            window.sessionStorage.removeItem(key);
          else window.sessionStorage.setItem(key, value);
        } catch {
          /* Persistence is optional; network/cache still work. */
        }
      },
      removeItem: () => clearPersistedJournal(),
    },
  });
}
