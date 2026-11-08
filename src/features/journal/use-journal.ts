"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  keepPreviousData,
} from "@tanstack/react-query";
import type { EventsResponse, OverviewResponse } from "@/shared/events";
import { requestJson, isStale } from "./http";
import { conditionParams, type Conditions } from "./state";
import { PERSIST_MAX_AGE } from "./persistence";

export type JournalPage = {
  list: EventsResponse;
  overview: OverviewResponse;
  index: number;
  conditions: Conditions;
  viewKey: string;
};
export type PageParam = { cursor: string | null; index: number };
export type JournalData = InfiniteData<JournalPage, PageParam>;
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

export function useJournal(
  state: Conditions,
  viewKey: string,
  onReset: (message: string) => void,
) {
  // A persisted query can restore before this Suspense boundary hydrates.
  // Keep its first client render identical to the server's loading state.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  const client = useQueryClient();
  const [validationError, setValidationError] = useState<unknown>(null);
  const queryKey = ["journal", viewKey];
  const liveRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      liveRequest.current?.abort();
    },
    [viewKey],
  );
  const refreshLive = useCallback(
    async (canPublish: () => boolean) => {
      if (liveRequest.current) return;
      const controller = new AbortController();
      liveRequest.current = controller;
      try {
        const overview = await requestJson<OverviewResponse>(
          `/api/overview?${conditionParams(state)}`,
          controller.signal,
        );
        const list = await requestJson<EventsResponse>(
          `/api/events?${new URLSearchParams({ snapshot: overview.snapshot.token, sort: state.sort, direction: state.direction, limit: "50" })}`,
          controller.signal,
        );
        if (!controller.signal.aborted && canPublish()) {
          // Publish the list and analytics atomically; never refetch old cursor pages.
          client.setQueryData<JournalData>(["journal", viewKey], {
            pages: [{ list, overview, index: 0, conditions: state, viewKey }],
            pageParams: [{ cursor: null, index: 0 }],
          });
        }
      } finally {
        if (liveRequest.current === controller) liveRequest.current = null;
      }
    },
    [client, state, viewKey],
  );
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: { cursor: null, index: 0 } as PageParam,
    queryFn: async ({ pageParam, signal }): Promise<JournalPage> => {
      const cached = client.getQueryData<JournalData>(["journal", viewKey]);
      const overview =
        pageParam.cursor && cached?.pages[0]
          ? cached.pages[0].overview
          : await requestJson<OverviewResponse>(
              `/api/overview?${conditionParams(state)}`,
              signal,
            );
      const p = pageParam.cursor
        ? new URLSearchParams({ cursor: pageParam.cursor })
        : new URLSearchParams({
            snapshot: overview.snapshot.token,
            sort: state.sort,
            direction: state.direction,
            limit: "50",
          });
      const list = await requestJson<EventsResponse>(
        `/api/events?${p}`,
        signal,
      );
      return {
        list,
        overview,
        index: pageParam.index,
        conditions: state,
        viewKey,
      };
    },
    getNextPageParam: (last) =>
      last.list.page.next_cursor
        ? { cursor: last.list.page.next_cursor, index: last.index + 1 }
        : undefined,
    getPreviousPageParam: (first) =>
      first.list.page.previous_cursor
        ? { cursor: first.list.page.previous_cursor, index: first.index - 1 }
        : undefined,
    maxPages: 20,
    gcTime: PERSIST_MAX_AGE,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [lastSuccessful, setLastSuccessful] =
    useState<InfiniteData<JournalPage>>();
  if (query.data && !query.isPlaceholderData && query.data !== lastSuccessful)
    setLastSuccessful(query.data);
  const data = hydrated ? (query.data ?? lastSuccessful) : undefined;
  const token = !query.isPlaceholderData
    ? query.data?.pages[0]?.overview.snapshot.token
    : undefined;
  // Validate a retained snapshot on return/focus without refetching 20 pages.
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const validate = () =>
      requestJson(
        `/api/overview?${new URLSearchParams({ snapshot: token })}`,
        controller.signal,
      )
        .then(() => setValidationError(null))
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (isStale(err))
            onReset("История данных изменилась. Открыт новый срез.");
          else setValidationError(err);
        });
    void validate();
    window.addEventListener("focus", validate);
    return () => {
      controller.abort();
      window.removeEventListener("focus", validate);
    };
  }, [token, onReset]);
  useEffect(() => {
    if (isStale(query.error))
      onReset("История данных изменилась. Открыт новый срез.");
  }, [query.error, onReset]);
  return {
    ...query,
    refreshLive,
    data,
    isPending: !hydrated || query.isPending,
    validationError,
    showingPrevious:
      !!data &&
      (query.isPlaceholderData || (query.isError && query.data !== data)),
  };
}
