"use client";

import { isServer, QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, useEffect } from "react";
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import {
  makeJournalPersister,
  PERSIST_MAX_AGE,
} from "@/features/journal/persistence";
import { trimCache } from "@/features/journal/cache";

function makeQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 60_000, retry: false },
    },
  });
  client
    .getQueryCache()
    .subscribe(() => queueMicrotask(() => trimCache(client)));
  return client;
}
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
  if (isServer) return makeQueryClient();
  return (browserQueryClient ??= makeQueryClient());
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(getQueryClient);
  const [persister] = useState(() => makeJournalPersister(client));
  const [persistOptions] = useState(() => ({
    persister,
    maxAge: PERSIST_MAX_AGE,
    buster: "journal-v2",
    dehydrateOptions: {
      shouldDehydrateQuery: (query: import("@tanstack/react-query").Query) =>
        query.queryKey[0] === "journal" && query.state.status === "success",
      shouldDehydrateMutation: () => false,
    },
  }));
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        // A cached filter switch has no data update for the normal save subscriber.
        if (
          event.type === "observerAdded" &&
          event.query.queryKey[0] === "journal" &&
          event.query.state.status === "success"
        )
          void persistQueryClientSave({
            ...persistOptions,
            queryClient: client,
          });
      }),
    [client, persistOptions],
  );
  return (
    <ThemeProvider
      attribute="data-theme"
      storageKey="integration-monitor-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <PersistQueryClientProvider
        client={client}
        persistOptions={persistOptions}
      >
        {children}
      </PersistQueryClientProvider>
    </ThemeProvider>
  );
}
