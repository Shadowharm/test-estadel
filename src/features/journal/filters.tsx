"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { FacetsResponse, Snapshot } from "@/shared/events";
import { Modal } from "@/shared/ui/modal";
import { Icon } from "@/shared/ui/icons";
import { requestJson, errorMessage } from "./http";
import {
  type Conditions,
  defaults,
  validateConditions,
  formatTime,
} from "./state";

type Apply = (next: Conditions, replace?: boolean) => void;

export function Search({
  state,
  apply,
  serverError,
}: {
  state: Conditions;
  apply: Apply;
  serverError?: string;
}) {
  const [draft, setDraft] = useState(state.q);
  const [applied, setApplied] = useState(state.q);
  if (applied !== state.q) {
    setApplied(state.q);
    setDraft(state.q);
  }
  const [composing, setComposing] = useState(false);
  const error =
    validateConditions({ ...state, q: draft }) ??
    (draft === state.q ? serverError : undefined);
  useEffect(() => {
    if (error || composing || draft === state.q) return;
    const timer = setTimeout(() => apply({ ...state, q: draft }, true), 300);
    return () => clearTimeout(timer);
  }, [draft, state, error, composing, apply]);
  return (
    <form
      className="search-form"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) apply({ ...state, q: draft }, true);
      }}
    >
      <label htmlFor="event-search" className="sr-only">
        Поиск событий
      </label>
      <div className="search-input">
        <Icon name="search" />
        <input
          id="event-search"
          placeholder="ID, источник, тип или описание"
          value={draft}
          aria-invalid={!!error}
          aria-describedby={error ? "search-hint" : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
        {draft && (
          <button
            type="button"
            className="icon-button"
            aria-label="Очистить поиск"
            onClick={() => {
              setDraft("");
              apply({ ...state, q: "" }, true);
            }}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      {(error || draft.length >= 180) && (
        <p
          id="search-hint"
          className={error ? "error-text small" : "muted small"}
        >
          {error}
          {draft.length >= 180 ? ` · ${[...draft].length}/200` : ""}
        </p>
      )}
    </form>
  );
}

function FacetPicker({
  field,
  selected,
  snapshot,
  onChange,
}: {
  field: "source" | "type";
  selected: string[];
  snapshot: Snapshot;
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useInfiniteQuery({
    queryKey: ["facet", snapshot.token, field, term],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const p = pageParam
        ? new URLSearchParams({ cursor: pageParam, field })
        : new URLSearchParams({ snapshot: snapshot.token, field, limit: "50" });
      if (!pageParam && term) p.set("facet-q", term);
      return requestJson<FacetsResponse>(`/api/facets?${p}`, signal);
    },
    getNextPageParam: (last) => last.page.next_cursor,
    maxPages: 4,
    refetchOnWindowFocus: false,
  });
  const items = new Map(
    query.data?.pages.flatMap((p) => p.items).map((i) => [i.value, i.count]),
  );
  query.data?.pages[0]?.selected.forEach((i) => {
    if (selected.includes(i.value)) items.set(i.value, i.count);
  });
  selected.forEach((v) => {
    if (!items.has(v)) items.set(v, 0);
  });
  const toggle = (value: string, checked: boolean) => {
    if (!checked) {
      setError("");
      onChange(selected.filter((v) => v !== value));
      return;
    }
    if (selected.length >= 20) {
      setError("Можно выбрать до 20 значений.");
      return;
    }
    setError("");
    onChange([...selected, value]);
  };
  return (
    <div className="facet-picker">
      <div className="facet-toolbar">
        <input
          className="facet-search"
          value={search}
          maxLength={100}
          placeholder={field === "source" ? "Найти источник…" : "Найти тип…"}
          aria-label={field === "source" ? "Поиск источников" : "Поиск типов"}
          onChange={(e) => setSearch(e.target.value)}
        />
        {selected.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setError("");
              onChange([]);
            }}
          >
            Очистить ({selected.length})
          </button>
        )}
      </div>
      <div
        className="facet-options"
        role="group"
        aria-label={field === "source" ? "Источники" : "Типы событий"}
      >
        {query.isPending && <p role="status">Загружаем варианты…</p>}
        {query.isError && (
          <div role="alert">
            <p className="error-text">{errorMessage(query.error)}</p>
            <button type="button" onClick={() => query.refetch()}>
              Повторить
            </button>
          </div>
        )}
        {!query.isPending && !query.isError && !items.size && (
          <p className="muted">Нет вариантов</p>
        )}
        {[...items].map(([value, count]) => (
          <label key={value} className="checkbox-option">
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={(e) => toggle(value, e.target.checked)}
            />
            <span>{value}</span>
            <span className="muted">{count}</span>
          </label>
        ))}
      </div>
      {query.hasNextPage && (
        <button
          type="button"
          className="text-button"
          disabled={query.isFetching}
          onClick={() => query.fetchNextPage()}
        >
          Ещё варианты
        </button>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}

export function Filters({
  state,
  apply,
  snapshot,
}: {
  state: Conditions;
  apply: Apply;
  snapshot?: Snapshot;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(state);
  const [error, setError] = useState("");
  const count =
    Number(!!state.status) +
    Number(!!state.source.length) +
    Number(!!state.type.length) +
    Number(state.preset !== "all");
  const periodLabel =
    state.preset === "custom"
      ? new Intl.DateTimeFormat("ru-RU", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).formatRange(new Date(state.from), new Date(state.to))
      : {
          all: "За всё время",
          "24h": "24 часа",
          "7d": "7 дней",
          "30d": "30 дней",
        }[state.preset];
  const chips = [
    ...(state.preset !== "all"
      ? [
          {
            key: "period",
            category: "Период",
            value: periodLabel,
            title:
              state.preset === "custom"
                ? `${formatTime(state.from)} — ${formatTime(state.to)} UTC`
                : periodLabel,
            next: { ...state, preset: "all" as const, from: "", to: "" },
          },
        ]
      : []),
    ...(state.status
      ? [
          {
            key: "status",
            category: "Статус",
            value: state.status === "success" ? "Успешно" : "Ошибка",
            title: "",
            next: { ...state, status: "" as const },
          },
        ]
      : []),
    ...(["source", "type"] as const).flatMap((field) =>
      state[field].map((value) => ({
        key: `${field}:${value}`,
        category: field === "source" ? "Источник" : "Тип",
        value,
        title: value,
        next: {
          ...state,
          [field]: state[field].filter((item) => item !== value),
        },
      })),
    ),
  ];
  const previewTo = snapshot?.as_of;
  const previewFrom = previewTo
    ? new Date(
        Date.parse(previewTo) -
          (draft.preset === "30d" ? 30 : draft.preset === "7d" ? 7 : 1) *
            86400000,
      ).toISOString()
    : "";
  const periods = (
    <label>
      <span>
        Период <span className="muted">· UTC</span>
      </span>
      <select
        value={draft.preset}
        onChange={(e) =>
          setDraft({
            ...draft,
            preset: e.target.value as Conditions["preset"],
            from: e.target.value === "custom" ? previewFrom : "",
            to: e.target.value === "custom" ? previewTo || "" : "",
          })
        }
      >
        <option value="all">За всё время</option>
        <option value="24h">24 часа</option>
        <option value="7d">7 дней</option>
        <option value="30d">30 дней</option>
        <option value="custom">Свой диапазон</option>
      </select>
    </label>
  );
  return (
    <>
      <div className="filter-line">
        <button
          className={`open-filters${count ? " has-filters" : ""}`}
          aria-label={
            count ? `Фильтры: активно ${count}. Изменить фильтры` : "Фильтры"
          }
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            setDraft(state);
            setError("");
            setOpen(true);
          }}
        >
          Фильтры
          {count > 0 && (
            <span className="filter-count" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      </div>
      {chips.length > 0 && (
        <div
          className="applied-filters"
          role="group"
          aria-label="Применённые фильтры"
        >
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="applied-filter"
              title={chip.title || chip.value}
              aria-label={`Убрать фильтр «${chip.category}: ${chip.title || chip.value}»`}
              onClick={() => apply(chip.next)}
            >
              <span className="applied-filter-category">{chip.category}</span>
              <span className="applied-filter-value">{chip.value}</span>
              <Icon name="close" size={13} />
            </button>
          ))}
          <button
            type="button"
            className="clear-applied-filters"
            onClick={() =>
              apply({
                ...state,
                status: "",
                source: [],
                type: [],
                preset: "all",
                from: "",
                to: "",
              })
            }
          >
            Сбросить все
          </button>
        </div>
      )}
      {open && (
        <Modal
          title="Фильтры событий"
          className="filter-modal"
          onClose={() => setOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const next =
                draft.preset === "custom"
                  ? {
                      ...draft,
                      from: `${form.get("from") || ""}Z`,
                      to: `${form.get("to") || ""}Z`,
                    }
                  : draft;
              const problem = validateConditions(next);
              if (problem) {
                setError(problem);
                return;
              }
              apply(next);
              setOpen(false);
            }}
          >
            <div className="filter-modal-body">
              {periods}
              {previewTo &&
                draft.preset !== "custom" &&
                draft.preset !== "all" && (
                  <p className="muted small">
                    {formatTime(previewFrom)} — {formatTime(previewTo)} UTC
                  </p>
                )}
              {draft.preset === "custom" && (
                <div className="date-fields">
                  <label>
                    Начало · UTC
                    <input
                      name="from"
                      type="datetime-local"
                      step="0.001"
                      value={
                        draft.from
                          ? draft.from.replace(/Z$/, "").slice(0, 23)
                          : ""
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          from: e.target.value ? `${e.target.value}Z` : "",
                        })
                      }
                    />
                  </label>
                  <label>
                    Конец · UTC (не включается)
                    <input
                      name="to"
                      type="datetime-local"
                      step="0.001"
                      value={
                        draft.to ? draft.to.replace(/Z$/, "").slice(0, 23) : ""
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          to: e.target.value ? `${e.target.value}Z` : "",
                        })
                      }
                    />
                  </label>
                </div>
              )}
              <label>
                Статус
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      status: e.target.value as Conditions["status"],
                    })
                  }
                >
                  <option value="">Все</option>
                  <option value="success">Успешно</option>
                  <option value="error">Ошибка</option>
                </select>
              </label>
              {(["source", "type"] as const).map((f) => (
                <section
                  key={f}
                  className="filter-section"
                  aria-label={f === "source" ? "Источники" : "Типы событий"}
                >
                  <div className="filter-section-head">
                    <h3>{f === "source" ? "Источники" : "Типы событий"}</h3>
                    <span className="muted small">
                      {draft[f].length ? `Выбрано: ${draft[f].length}` : "Все"}
                    </span>
                  </div>
                  {snapshot ? (
                    <FacetPicker
                      field={f}
                      selected={draft[f]}
                      snapshot={snapshot}
                      onChange={(values) => setDraft({ ...draft, [f]: values })}
                    />
                  ) : (
                    <p className="muted small">
                      Доступно после загрузки среза.
                    </p>
                  )}
                </section>
              ))}
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-actions filter-modal-actions">
              <button
                type="button"
                className="text-button clear-filter-draft"
                onClick={() => {
                  setDraft({
                    ...draft,
                    status: defaults.status,
                    source: [],
                    type: [],
                    preset: "all",
                    from: "",
                    to: "",
                  });
                  setError("");
                }}
              >
                Сбросить
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Отмена
              </button>
              <button className="primary-button">Применить фильтры</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
