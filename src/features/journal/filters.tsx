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
  onApply,
}: {
  field: "source" | "type";
  selected: string[];
  snapshot: Snapshot;
  onApply: (v: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [values, setValues] = useState(selected);
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
    if (values.includes(i.value)) items.set(i.value, i.count);
  });
  values.forEach((v) => {
    if (!items.has(v)) items.set(v, 0);
  });
  return (
    <fieldset className="facet-picker">
      <legend>{field === "source" ? "Источники" : "Типы событий"}</legend>
      <label className="small">
        Поиск вариантов
        <input
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="facet-options">
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
              checked={values.includes(value)}
              onChange={(e) => {
                if (e.target.checked && values.length >= 20) {
                  setError("Можно выбрать до 20 значений.");
                  return;
                }
                setError("");
                setValues(
                  e.target.checked
                    ? [...values, value]
                    : values.filter((v) => v !== value),
                );
              }}
            />
            <span>{value}</span>
            <span className="muted">{count}</span>
          </label>
        ))}
      </div>
      {query.hasNextPage && (
        <button
          type="button"
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
      <div className="button-row">
        <button type="button" onClick={() => setValues([])}>
          Очистить
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => onApply(values)}
        >
          Применить выбор
        </button>
      </div>
    </fieldset>
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
  const [picker, setPicker] = useState<"source" | "type" | null>(null);
  const [error, setError] = useState("");
  const count =
    Number(!!state.q) +
    Number(!!state.status) +
    Number(!!state.source.length) +
    Number(!!state.type.length) +
    Number(state.preset !== "all");
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
      Период <span className="muted">· UTC</span>
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
        <div
          className="status-segments"
          role="group"
          aria-label="Статус события"
        >
          {[
            ["", "Все"],
            ["success", "Успешно"],
            ["error", "Ошибка"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state.status === value}
              onClick={() =>
                apply({ ...state, status: value as Conditions["status"] })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="open-filters"
          type="button"
          onClick={() => {
            setDraft(state);
            setPicker(null);
            setError("");
            setOpen(true);
          }}
        >
          Фильтры
          <span className="filter-count" aria-hidden={!count}>
            {count ? ` · ${count}` : ""}
          </span>
        </button>
        <label className="desktop-period sr-only-mobile">
          <span className="sr-only">Период · UTC</span>
          <select
            aria-label="Период"
            value={state.preset}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setDraft({
                  ...state,
                  preset: "custom",
                  from: state.from || snapshot?.from || previewFrom,
                  to: state.to || snapshot?.to || previewTo || "",
                });
                setOpen(true);
              } else
                apply({
                  ...state,
                  preset: e.target.value as Conditions["preset"],
                });
            }}
          >
            <option value="all">За всё время</option>
            <option value="24h">24 часа</option>
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
            <option value="custom">Свой диапазон</option>
          </select>
        </label>
        <button
          className="text-button reset-filters"
          disabled={!count}
          onClick={() => apply({ ...defaults })}
        >
          Сбросить
        </button>
      </div>
      {(state.source.length > 0 || state.type.length > 0) && (
        <div className="filter-chips" aria-label="Активные условия">
          {(["source", "type"] as const).map((f) =>
            state[f].map((v) => (
              <button
                key={`${f}:${v}`}
                className="chip"
                onClick={() =>
                  apply({ ...state, [f]: state[f].filter((x) => x !== v) })
                }
                aria-label={`Убрать ${f === "source" ? "источник" : "тип"} ${v}`}
              >
                {v} <Icon name="close" size={14} />
              </button>
            )),
          )}
        </div>
      )}
      {open && (
        <Modal title="Фильтры событий" onClose={() => setOpen(false)}>
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
              <div key={f} className="filter-category">
                <button
                  type="button"
                  disabled={!snapshot}
                  onClick={() => setPicker(picker === f ? null : f)}
                  aria-expanded={picker === f}
                >
                  {f === "source" ? "Источники" : "Типы событий"} ·{" "}
                  {draft[f].length || "Все"}
                </button>
                <p className="muted small wrap">{draft[f].join(", ")}</p>
                {picker === f && snapshot && (
                  <FacetPicker
                    field={f}
                    selected={draft[f]}
                    snapshot={snapshot}
                    onApply={(values) => {
                      setDraft({ ...draft, [f]: values });
                      setPicker(null);
                    }}
                  />
                )}
              </div>
            ))}
            {!snapshot && (
              <p className="muted small">
                Источники и типы доступны после загрузки среза.
              </p>
            )}
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="modal-actions">
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
