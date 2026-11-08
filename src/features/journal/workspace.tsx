"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useLayoutEffect,
  useRef,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { ThemeSelect } from "@/shared/ui/theme-select";
import { Details } from "./details";
import { Filters, Search } from "./filters";
import { useJournal } from "./use-journal";
import { VirtualLog } from "./virtual-log";
import {
  conditionParams,
  defaults,
  eventHref,
  workspaceHref,
  formatTime,
  readConditions,
  type Conditions,
} from "./state";
import { errorMessage, RequestError } from "./http";
import { getAnchor } from "./cache";
import { Icon } from "@/shared/ui/icons";
import { sorts } from "./state";
import { WorkspaceLink } from "./workspace-link";
import { useRealtime } from "./use-realtime";
import { ExportButton } from "./export";

const Dashboard = dynamic(
  () => import("@/features/overview/dashboard").then((m) => m.Dashboard),
  {
    loading: () => (
      <div className="state-panel" role="status">
        Загружаем диаграммы…
      </div>
    ),
  },
);

function navigate(next: Conditions, replace = false, id?: string | null) {
  const current = new URLSearchParams(window.location.search);
  const selected = id === undefined ? current.get("event") : id;
  window.history[replace ? "replaceState" : "pushState"](
    { monitorDetail: !!selected && selected !== current.get("event") },
    "",
    workspaceHref(
      next,
      window.location.pathname === "/overview" ? "overview" : "events",
      selected ?? undefined,
    ),
  );
}

export function Workspace() {
  const params = useSearchParams();
  const overview = usePathname() === "/overview";
  const state = useMemo(() => {
    try {
      return {
        conditions: readConditions(new URLSearchParams(params.toString())),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Некорректная ссылка",
      };
    }
  }, [params]);
  const apply = useCallback(
    (next: Conditions, replace = false) => navigate(next, replace),
    [],
  );
  const selected = params.get("event");
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <header className="app-header">
        <div className="identity">
          <span className="brand-mark" aria-hidden="true">
            MI
          </span>
          <span>
            Мониторинг
            <br />
            интеграций
          </span>
        </div>
        <div className="header-actions">
          <ThemeSelect />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="workspace-main">
        <nav className="workspace-nav" aria-label="Представления мониторинга">
          <WorkspaceLink
            href={workspaceHref(state.conditions ?? defaults, "overview")}
            aria-current={overview ? "page" : undefined}
          >
            Обзор
          </WorkspaceLink>
          <WorkspaceLink
            href={eventHref(state.conditions ?? defaults)}
            aria-current={!overview ? "page" : undefined}
          >
            События
          </WorkspaceLink>
        </nav>
        <div className="workspace-heading">
          <h1>{overview ? "Обзор интеграций" : "Журнал событий"}</h1>
          <span
            className="live-state"
            role="status"
            title="Новые данные поступают автоматически"
          >
            <span className="success-dot" aria-hidden="true">
              ●
            </span>{" "}
            Live
          </span>
        </div>
        {state.conditions ? (
          <JournalSurface
            state={state.conditions}
            selected={selected}
            apply={apply}
            overview={overview}
          />
        ) : (
          <div className="state-panel">
            <h2>Не удалось прочитать условия ссылки</h2>
            <p role="alert">{state.error}</p>
            <button onClick={() => apply({ ...defaults })}>
              Сбросить условия
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function JournalSurface({
  state,
  selected,
  apply,
  overview,
}: {
  state: Conditions;
  selected: string | null;
  apply: (s: Conditions, replace?: boolean) => void;
  overview: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const [atHead, setAtHead] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const viewKey = `${conditionParams(state, true)}:${revision}`;
  const reset = useCallback((message: string) => {
    setNotice(message);
    setRevision((v) => v + 1);
  }, []);
  const query = useJournal(state, viewKey, reset);
  const first = query.data?.pages[0];
  const snapshot = first?.overview.snapshot;
  const totals = first?.overview.totals;
  const displayedState = first?.conditions ?? state;
  const displayedKey = first?.viewKey ?? viewKey;
  const replacing =
    query.isFetching &&
    !query.isFetchingNextPage &&
    !query.isFetchingPreviousPage;
  const resync = useCallback(
    () => reset("История данных изменилась. Открыт новый срез."),
    [reset],
  );
  const realtime = useRealtime({
    snapshot,
    eligible:
      (overview || atHead || totals?.total === 0) &&
      !rowFocused &&
      !selected &&
      !query.showingPrevious,
    busy: query.isFetching,
    refresh: query.refreshLive,
    resync,
  });
  const invalidSearch =
    query.error instanceof RequestError && query.error.code === "INVALID_SEARCH"
      ? errorMessage(query.error)
      : undefined;
  useLayoutEffect(() => {
    const update = () => {
      const height = toolbar.current?.getBoundingClientRect().height ?? 0;
      setToolbarHeight(height);
      document.documentElement.style.setProperty(
        "--journal-toolbar-height",
        `${height}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(toolbar.current!);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--journal-toolbar-height");
    };
  }, []);
  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const focus = (event: FocusEvent) => {
      const target =
        event.type === "focusout" ? event.relatedTarget : event.target;
      setRowFocused(
        target instanceof Element && !!target.closest("[data-seq]"),
      );
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    return () => {
      window.history.scrollRestoration = previous;
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
    };
  }, []);
  const refresh = () => {
    window.scrollTo({ top: 0, behavior: "auto" });
    reset("Выборка обновлена.");
  };
  const closeDetails = () => {
    if (window.history.state?.monitorDetail) window.history.back();
    else navigate(state, true, null);
  };
  return (
    <section
      className="conditions-panel"
      aria-label={overview ? "Аналитика интеграций" : "Журнал интеграций"}
    >
      <div className="journal-sticky" ref={toolbar} id="journal-toolbar">
        <div className="toolbar-controls">
          <Search state={state} apply={apply} serverError={invalidSearch} />
          <div className="filter-controls">
            <Filters state={state} apply={apply} snapshot={snapshot} />
          </div>
          <ExportButton
            disabled={query.showingPrevious || query.isFetching}
            selection={
              snapshot && totals
                ? {
                    snapshot,
                    count: totals.total,
                    sort: displayedState.sort,
                    direction: displayedState.direction,
                  }
                : undefined
            }
            refresh={refresh}
          />
        </div>
        {!overview && (
          <div className="toolbar-summary">
            {!overview && (
              <dl
                className="totals-strip"
                aria-label="Статистика текущей выборки"
              >
                <div>
                  <dt>Всего</dt>
                  <dd>{totals?.total.toLocaleString("ru-RU") ?? "…"}</dd>
                </div>
                <div>
                  <dt>
                    <span aria-hidden="true" className="success-dot">
                      ●
                    </span>{" "}
                    Успешно
                  </dt>
                  <dd>{totals?.success.toLocaleString("ru-RU") ?? "…"}</dd>
                </div>
                <div>
                  <dt>
                    <span aria-hidden="true" className="error-dot">
                      ●
                    </span>{" "}
                    Ошибки
                  </dt>
                  <dd>{totals?.error.toLocaleString("ru-RU") ?? "…"}</dd>
                </div>
              </dl>
            )}
            <div className="sort-controls">
              {!overview && (
                <>
                  <label>
                    <span className="sr-only">Сортировка</span>
                    <select
                      aria-label="Сортировка"
                      value={state.sort}
                      onChange={(e) =>
                        apply({
                          ...state,
                          sort: e.target.value as Conditions["sort"],
                        })
                      }
                    >
                      {Object.entries(sorts).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="icon-button"
                    aria-label={
                      state.direction === "desc"
                        ? "По убыванию. Сортировать по возрастанию"
                        : "По возрастанию. Сортировать по убыванию"
                    }
                    title={
                      state.direction === "desc"
                        ? "По убыванию"
                        : "По возрастанию"
                    }
                    onClick={() =>
                      apply({
                        ...state,
                        direction: state.direction === "desc" ? "asc" : "desc",
                      })
                    }
                  >
                    <Icon name={state.direction === "desc" ? "down" : "up"} />
                  </button>
                </>
              )}
              {!overview && (
                <button
                  className="text-button back-to-top"
                  onClick={() => window.scrollTo({ top: 0, behavior: "auto" })}
                >
                  Наверх <Icon name="up" size={14} />
                </button>
              )}
            </div>
          </div>
        )}
        <div
          className={`query-progress ${replacing ? "is-loading" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">
            {replacing ? "Обновляем события…" : ""}
          </span>
        </div>
      </div>
      {overview && query.showingPrevious && query.isFetching && (
        <p className="notice" role="status">
          Применяем условия. Пока показана предыдущая выборка.
        </p>
      )}
      {notice && (
        <p
          role="status"
          className={notice.includes("История") ? "notice" : "sr-only"}
        >
          {notice}
        </p>
      )}
      {getAnchor(viewKey) && !first && !query.isPending && (
        <p className="notice">Предыдущий срез недоступен. Обновите события.</p>
      )}
      {offline && (
        <p role="status" className="notice">
          Нет связи.
          {snapshot ? ` Данные на ${formatTime(snapshot.as_of)} UTC.` : ""}
        </p>
      )}
      {realtime.updateError && (
        <p role="alert" className="notice">
          Не удалось получить новые данные. Показаны последние загруженные;
          повторяем автоматически.{" "}
          <button onClick={refresh}>Повторить сейчас</button>
        </p>
      )}
      {query.validationError != null && snapshot && (
        <p role="alert" className="notice">
          Не удалось проверить обновления. {errorMessage(query.validationError)}{" "}
          <button onClick={refresh}>Повторить</button>
        </p>
      )}
      {query.showingPrevious && query.isError && (
        <p role="alert" className="notice">
          Не удалось применить условия. Показана предыдущая выборка.{" "}
          {errorMessage(query.error)}{" "}
          <button onClick={() => query.refetch()}>Повторить</button>
        </p>
      )}
      {query.isPending && !first && (
        <div className="state-panel skeleton" role="status">
          <p>{overview ? "Загружаем статистику…" : "Загружаем события…"}</p>
          <div />
          <div />
          <div />
        </div>
      )}
      {query.isError && !first && (
        <div className="state-panel" role="alert">
          <h2>
            {overview
              ? "Не удалось загрузить обзор"
              : "Не удалось загрузить журнал"}
          </h2>
          <p className="error-text">{errorMessage(query.error)}</p>
          <button onClick={() => query.refetch()}>Повторить</button>
        </div>
      )}
      {overview && first && (
        <div
          aria-busy={query.showingPrevious && query.isFetching}
          inert={query.showingPrevious}
          className={query.showingPrevious ? "is-updating" : undefined}
        >
          <Dashboard
            data={first.overview}
            state={displayedState}
            apply={apply}
            open={(id) => navigate(state, false, id)}
          />
        </div>
      )}
      {!overview && first && !totals?.total && (
        <div className="state-panel">
          <h2>Событий не найдено</h2>
          <button onClick={() => apply({ ...defaults })}>
            Сбросить условия
          </button>
        </div>
      )}
      {!overview && first && !!totals?.total && (
        <div
          className={`journal-results ${query.showingPrevious ? "is-updating" : ""}`}
          aria-busy={query.showingPrevious && query.isFetching}
          inert={query.showingPrevious && query.isFetching}
        >
          <VirtualLog
            key={displayedKey}
            pages={query.data!.pages}
            viewKey={displayedKey}
            state={displayedState}
            toolbarHeight={toolbarHeight}
            onHeadChange={setAtHead}
            open={(id) => navigate(state, false, id)}
            sort={(s) =>
              apply({ ...state, sort: s.sort, direction: s.direction })
            }
            next={() => query.fetchNextPage({ cancelRefetch: false })}
            previous={() => query.fetchPreviousPage({ cancelRefetch: false })}
            fetching={query.isFetching || query.showingPrevious}
            error={query.error}
            nextError={query.isFetchNextPageError}
            previousError={query.isFetchPreviousPageError}
          />
        </div>
      )}
      {selected && (
        <Details
          key={selected}
          id={selected}
          snapshot={snapshot}
          state={displayedState}
          close={closeDetails}
          apply={(s) => navigate(s, false, null)}
        />
      )}
    </section>
  );
}
