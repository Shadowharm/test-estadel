"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  useWindowVirtualizer,
} from "@tanstack/react-virtual";
import type { JournalPage } from "./use-journal";
import { getAnchor, saveAnchor, type Anchor } from "./cache";
import { eventHref, formatTime, type Conditions } from "./state";
import { Status } from "./details";
import { errorMessage } from "./http";
import { useMobile } from "@/shared/ui/use-mobile";
import { Icon } from "@/shared/ui/icons";

type Props = {
  pages: JournalPage[];
  viewKey: string;
  state: Conditions;
  toolbarHeight: number;
  onHeadChange: (atHead: boolean) => void;
  open: (id: string) => void;
  sort: (s: Conditions) => void;
  next: () => Promise<unknown>;
  previous: () => Promise<unknown>;
  fetching: boolean;
  error: unknown;
  nextError: boolean;
  previousError: boolean;
};

export function VirtualLog({
  pages,
  viewKey,
  state,
  toolbarHeight,
  onHeadChange,
  open,
  sort,
  next,
  previous,
  fetching,
  error,
  nextError,
  previousError,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const mobile = useMobile();
  const items = useMemo(() => pages.flatMap((p) => p.list.items), [pages]);
  const firstPage = pages[0]!;
  const lastPage = pages.at(-1)!;
  const total = firstPage.overview.totals.total;
  const hasPrevious = !!firstPage.list.page.previous_cursor;
  const hasNext = !!lastPage.list.page.next_cursor;
  const [listTop, setListTop] = useState(0);
  const [saved] = useState(() => getAnchor(viewKey));
  const [focusedSeq, setFocusedSeq] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<Anchor | undefined>(undefined);
  const busy = useRef(false);
  const previousTop = useRef(0);
  const restored = useRef(false);
  const previousLayout = useRef({ listTop: 0, covered: 0 });
  const focusedIndex = items.findIndex((i) => i.seq === focusedSeq);
  const covered = toolbarHeight + (mobile ? 0 : 40);

  useLayoutEffect(() => {
    const update = () => {
      if (listRef.current)
        setListTop(
          listRef.current.getBoundingClientRect().top + window.scrollY,
        );
    };
    update();
    const observer = new ResizeObserver(update);
    const toolbar = document.getElementById("journal-toolbar");
    if (toolbar) observer.observe(toolbar);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const virtual = useWindowVirtualizer<HTMLDivElement>({
    count: items.length,
    estimateSize: () => (mobile ? 152 : 72),
    getItemKey: (i) => items[i]!.seq,
    scrollMargin: listTop,
    scrollPaddingStart: covered,
    initialMeasurementsCache: saved?.measurements,
    overscan: 5,
    paddingStart: hasPrevious ? 48 : 0,
    paddingEnd: hasNext ? 64 : 0,
    rangeExtractor: (range) => {
      const result = defaultRangeExtractor(range);
      return focusedIndex < 0
        ? result
        : [...new Set([...result, focusedIndex])].sort((a, b) => a - b);
    },
  });
  const capture = useCallback((): Anchor | undefined => {
    const row = virtual
      .getVirtualItems()
      .find((v) => v.end > window.scrollY + covered);
    return row && items[row.index]
      ? {
          seq: items[row.index]!.seq,
          offset: row.start - window.scrollY,
          measurements: virtual.takeSnapshot(),
        }
      : undefined;
  }, [items, virtual, covered]);

  useLayoutEffect(() => {
    if (!listTop) return;
    const initial = !restored.current;
    const layoutChanged =
      previousLayout.current.listTop !== listTop ||
      previousLayout.current.covered !== covered;
    previousLayout.current = { listTop, covered };
    const anchor =
      pending.current ??
      (initial
        ? saved
        : layoutChanged && window.scrollY > 0
          ? getAnchor(viewKey)
          : undefined);
    restored.current = true;
    if (!anchor) {
      if (initial) window.scrollTo(0, 0);
      return;
    }
    const index = items.findIndex((i) => i.seq === anchor.seq);
    if (index < 0) {
      pending.current = undefined;
      busy.current = false;
      if (initial) window.scrollTo(0, 0);
      return;
    }
    if (pending.current && pages.length === 20) virtual.measure();
    const restore = () => {
      const position = virtual.getOffsetForIndex(index, "start")?.[0];
      if (position !== undefined) {
        virtual.scrollToOffset(Math.max(0, position + covered - anchor.offset));
        previousTop.current = window.scrollY;
      }
    };
    restore();
    const frame = requestAnimationFrame(() => {
      const element = listRef.current?.querySelector<HTMLElement>(
        `[data-seq="${anchor.seq}"]`,
      );
      if (element)
        window.scrollBy(0, element.getBoundingClientRect().top - anchor.offset);
      else restore();
      previousTop.current = window.scrollY;
      pending.current = undefined;
      busy.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [items, virtual, listTop, covered, viewKey, pages.length, saved]);

  const load = useCallback(
    async (edge: "next" | "previous") => {
      if (busy.current || fetching || pending.current) return;
      const focused =
        document.activeElement?.closest<HTMLElement>("[data-seq]")?.dataset.seq;
      const evicted =
        pages.length === 20
          ? edge === "next"
            ? firstPage.list
            : lastPage.list
          : undefined;
      if (focused && evicted?.items.some((i) => String(i.seq) === focused))
        return;
      busy.current = true;
      pending.current = capture();
      try {
        const result = await (edge === "next" ? next() : previous());
        if (
          result &&
          typeof result === "object" &&
          "isError" in result &&
          result.isError
        ) {
          pending.current = undefined;
          setAnnouncement("Не удалось загрузить события.");
        } else setAnnouncement("События загружены.");
      } catch {
        pending.current = undefined;
      } finally {
        if (!pending.current) busy.current = false;
      }
    },
    [
      fetching,
      pages.length,
      firstPage.list,
      lastPage.list,
      capture,
      next,
      previous,
    ],
  );

  useEffect(() => {
    const reportHead = () => {
      if (listTop)
        onHeadChange(!hasPrevious && window.scrollY + covered <= listTop + 36);
    };
    reportHead();
    const scrolled = () => {
      if (document.querySelector("dialog[open]")) return;
      reportHead();
      const diff = window.scrollY - previousTop.current;
      previousTop.current = window.scrollY;
      const anchor = capture();
      if (anchor) saveAnchor(viewKey, anchor);
      if (busy.current || pending.current) return;
      if (
        diff > 0 &&
        hasNext &&
        !nextError &&
        window.scrollY + window.innerHeight >
          listTop + virtual.getTotalSize() - 300
      )
        void load("next");
      if (
        diff < 0 &&
        hasPrevious &&
        !previousError &&
        window.scrollY + covered < listTop + 260
      )
        void load("previous");
    };
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => window.removeEventListener("scroll", scrolled);
  }, [
    capture,
    viewKey,
    hasNext,
    hasPrevious,
    nextError,
    previousError,
    listTop,
    virtual,
    load,
    covered,
    onHeadChange,
  ]);

  const changeSort = (key: Conditions["sort"]) =>
    sort({
      ...state,
      sort: key,
      direction:
        state.sort === key && state.direction === "desc" ? "asc" : "desc",
    });
  return (
    <section className="journal-panel" aria-label="Журнал событий">
      <div
        role={mobile ? undefined : "table"}
        aria-label="События интеграций"
        aria-rowcount={mobile ? undefined : total + 1}
      >
        {!mobile && (
          <div role="rowgroup" className="table-head">
            <div role="row" className="event-grid">
              {(
                [
                  ["created_at", "Время · UTC"],
                  ["source", "Источник"],
                  ["type", "Тип"],
                  ["status", "Статус"],
                ] as const
              ).map(([key, label]) => (
                <div
                  role="columnheader"
                  key={key}
                  aria-sort={
                    state.sort === key
                      ? state.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button onClick={() => changeSort(key)}>
                    {label}{" "}
                    {state.sort === key && (
                      <Icon
                        name={state.direction === "asc" ? "up" : "down"}
                        size={13}
                      />
                    )}
                  </button>
                </div>
              ))}
              <div role="columnheader">Описание</div>
              <div role="columnheader">
                <span className="sr-only">Просмотр</span>
              </div>
            </div>
          </div>
        )}
        <div
          ref={listRef}
          className="log-list"
          role={mobile ? "list" : "rowgroup"}
          aria-label="События"
          data-testid="log-list"
        >
          <div
            className="virtual-space"
            style={{ height: virtual.getTotalSize() }}
          >
            {hasPrevious && (
              <div className="log-edge top-edge">
                <button
                  aria-disabled={fetching}
                  onClick={() => load("previous")}
                >
                  {previousError ? "Повторить загрузку" : "Предыдущие события"}
                </button>
              </div>
            )}
            {virtual.getVirtualItems().map((row) => {
              const item = items[row.index]!;
              return (
                <div
                  key={item.seq}
                  data-index={row.index}
                  data-seq={item.seq}
                  ref={virtual.measureElement}
                  className="event-grid event-row"
                  role={mobile ? "listitem" : "row"}
                  aria-rowindex={
                    mobile ? undefined : firstPage.index * 50 + row.index + 2
                  }
                  aria-posinset={
                    mobile ? firstPage.index * 50 + row.index + 1 : undefined
                  }
                  aria-setsize={mobile ? total : undefined}
                  style={{ transform: `translateY(${row.start - listTop}px)` }}
                >
                  <div
                    role={mobile ? undefined : "cell"}
                    className="event-time"
                  >
                    <time dateTime={item.created_at}>
                      {formatTime(item.created_at)}
                    </time>
                    <span className="mobile-only small"> UTC</span>
                  </div>
                  <div
                    role={mobile ? undefined : "cell"}
                    className="event-source"
                  >
                    <span className="source-mark" aria-hidden="true">
                      {item.source.slice(0, 1)}
                    </span>
                    <span className="truncate">{item.source}</span>
                  </div>
                  <div
                    role={mobile ? undefined : "cell"}
                    className="mono event-type truncate"
                  >
                    {item.type}
                  </div>
                  <div
                    role={mobile ? undefined : "cell"}
                    className="event-status-cell"
                  >
                    <Status value={item.status} />
                  </div>
                  <div
                    role={mobile ? undefined : "cell"}
                    className="event-description"
                  >
                    <span className="message-preview">{item.message}</span>
                    <span className="muted small mono truncate">{item.id}</span>
                  </div>
                  <div
                    role={mobile ? undefined : "cell"}
                    className="event-action"
                  >
                    <a
                      className="icon-button view-event"
                      href={eventHref(state, item.id)}
                      aria-label={`Открыть событие ${item.id}`}
                      title="Подробности"
                      onFocus={() => setFocusedSeq(item.seq)}
                      onClick={(e) => {
                        if (
                          e.button === 0 &&
                          !e.metaKey &&
                          !e.ctrlKey &&
                          !e.shiftKey &&
                          !e.altKey
                        ) {
                          e.preventDefault();
                          open(item.id);
                        }
                      }}
                    >
                      <Icon name="eye" />
                    </a>
                  </div>
                </div>
              );
            })}
            {hasNext && (
              <div className="log-edge bottom-edge">
                <button aria-disabled={fetching} onClick={() => load("next")}>
                  {fetching
                    ? "Загружаем…"
                    : nextError
                      ? "Повторить загрузку"
                      : "Загрузить ещё"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {(nextError || previousError) && (
        <p role="alert" className="edge-error">
          {errorMessage(error)}{" "}
          <button onClick={() => load(previousError ? "previous" : "next")}>
            Повторить
          </button>
        </p>
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
