"use client";

import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Icon } from "@/shared/ui/icons";
import { eventSlug, type EventDetail, type Snapshot } from "@/shared/events";
import { Modal } from "@/shared/ui/modal";
import { requestJson, errorMessage, RequestError } from "./http";
import { eventHref, formatTime, type Conditions } from "./state";

export function Status({ value }: { value: "success" | "error" }) {
  return (
    <span className={`event-status ${value}`}>
      <Icon name={value === "error" ? "error" : "success"} size={16} />
      {value === "error" ? "Ошибка" : "Успешно"}
    </span>
  );
}

export function Details({
  id,
  snapshot,
  state,
  close,
  apply,
}: {
  id: string;
  snapshot?: Snapshot;
  state: Conditions;
  close: () => void;
  apply: (s: Conditions) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const query = useQuery({
    queryKey: ["detail", id, snapshot?.token],
    queryFn: ({ signal }) =>
      requestJson<{ event: EventDetail; matches_snapshot?: boolean }>(
        `/api/events/${eventSlug(id)}${snapshot ? `?${new URLSearchParams({ snapshot: snapshot.token })}` : ""}`,
        signal,
      ),
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const event = query.data?.event;
  async function copy(value: string, name: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`${name} скопирован${name === "Ссылка" ? "а" : ""}`);
    } catch {
      setFeedback(
        "Не удалось скопировать. Выделите текст и скопируйте вручную.",
      );
    }
  }
  return (
    <Modal title="Подробности события" onClose={close} className="detail-modal">
      {query.isPending && <p role="status">Загружаем событие…</p>}
      {query.isError && (
        <div role="alert">
          <h3>
            {query.error instanceof RequestError && query.error.status === 404
              ? "Событие не найдено"
              : "Не удалось открыть событие"}
          </h3>
          <p className="error-text">{errorMessage(query.error)}</p>
          <button onClick={() => query.refetch()}>Повторить</button>
        </div>
      )}
      {event && (
        <>
          <div className="detail-status">
            <Status value={event.status} />
          </div>
          {query.data?.matches_snapshot === false && (
            <p className="notice">
              Событие вне текущей выборки. Условия журнала сохранены.
            </p>
          )}
          <dl className="detail-fields">
            <div>
              <dt>ID</dt>
              <dd className="mono wrap" tabIndex={0}>
                {event.id}
              </dd>
            </div>
            <div>
              <dt>Источник</dt>
              <dd>
                <button
                  className="text-button wrap"
                  onClick={() => apply({ ...state, source: [event.source] })}
                >
                  {event.source} <Icon name="external" size={14} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Тип события</dt>
              <dd>
                <button
                  className="text-button mono wrap"
                  onClick={() => apply({ ...state, type: [event.type] })}
                >
                  {event.type} <Icon name="external" size={14} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Время события · UTC</dt>
              <dd>
                <time dateTime={event.created_at}>
                  {formatTime(event.created_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Получено сервером · UTC</dt>
              <dd>
                <time dateTime={event.received_at}>
                  {formatTime(event.received_at)}
                </time>
              </dd>
            </div>
            {event.error_code && (
              <div>
                <dt>Код ошибки</dt>
                <dd className="mono wrap">{event.error_code}</dd>
              </div>
            )}
          </dl>
          <section className={`full-message ${event.status}`}>
            <h3>{event.status === "error" ? "Причина ошибки" : "Описание"}</h3>
            <p>{event.message}</p>
          </section>
          <section>
            <h3>Payload</h3>
            {event.payload ? (
              <pre className="payload" tabIndex={0} aria-label="JSON payload">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            ) : (
              <p className="muted">Дополнительные данные не переданы.</p>
            )}
          </section>
          <div className="button-row">
            <button onClick={() => copy(event.id, "ID")}>Копировать ID</button>
            <button
              onClick={() => copy(JSON.stringify(event, null, 2), "JSON")}
            >
              Копировать JSON
            </button>
            <button
              onClick={() =>
                copy(
                  new URL(eventHref(state, id), location.origin).href,
                  "Ссылка",
                )
              }
            >
              Копировать ссылку
            </button>
          </div>
          <p className="copy-feedback small" role="status">
            {feedback}
          </p>
        </>
      )}
    </Modal>
  );
}
