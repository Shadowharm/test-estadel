"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ApiError, Snapshot } from "@/shared/events";
import { Modal } from "@/shared/ui/modal";
import { errorMessage, RequestError, isStale } from "./http";
import { formatTime, sorts, type Conditions } from "./state";

type Selection = {
  snapshot: Snapshot;
  count: number;
  sort: Conditions["sort"];
  direction: Conditions["direction"];
};

export function ExportButton({
  selection,
  disabled,
  refresh,
}: {
  selection?: Selection;
  disabled: boolean;
  refresh: () => void;
}) {
  const [opened, setOpened] = useState<Selection>();
  return (
    <>
      <button
        disabled={disabled || !selection}
        onClick={() => setOpened(selection)}
      >
        Экспорт
      </button>
      {opened && (
        <ExportDialog
          selection={opened}
          close={() => setOpened(undefined)}
          refresh={refresh}
        />
      )}
    </>
  );
}

function ExportDialog({
  selection,
  close,
  refresh,
}: {
  selection: Selection;
  close: () => void;
  refresh: () => void;
}) {
  const [format, setFormat] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [started, setStarted] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  useEffect(() => () => request.current?.abort(), []);
  const tooMany = selection.count > 100_000;
  const download = async () => {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    setStarted(false);
    const params = new URLSearchParams({
      snapshot: selection.snapshot.token,
      sort: selection.sort,
      direction: selection.direction,
      format,
    });
    const url = `/api/events/export?${params}`;
    try {
      // Validate before starting a native download. The browser streams to disk;
      // React never holds the complete file or an array of all matching events.
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new RequestError(
          response.status,
          response.headers.get("x-error-code") ?? "HTTP_ERROR",
          response.status === 413
            ? "В выборке больше 100 000 событий. Уточните фильтры."
            : "Не удалось начать выгрузку. Повторите или обновите выборку.",
          response.headers.get("x-request-id") ?? undefined,
          response.headers.get("retry-after"),
        );
      if (frame.current) frame.current.src = url;
      setStarted(true);
    } catch (problem) {
      if (!controller.signal.aborted) setError(problem);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Modal title="Экспорт событий" onClose={close}>
      <p>
        В файл попадёт вся выборка:{" "}
        <strong>{selection.count.toLocaleString("ru-RU")} событий</strong>,
        включая ещё не загруженные строки.
      </p>
      <p className="muted small">
        Срез на {formatTime(selection.snapshot.as_of)} UTC.{" "}
        {sorts[selection.sort]},{" "}
        {selection.direction === "asc" ? "по возрастанию" : "по убыванию"}.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <label>
          Формат файла
          <select
            value={format}
            disabled={busy}
            onChange={(event) => {
              setFormat(event.target.value);
              setStarted(false);
            }}
          >
            <option value="csv">CSV — для таблиц</option>
            <option value="json">JSON — с метаданными среза</option>
          </select>
        </label>
        {tooMany && (
          <p className="error-text" role="alert">
            Лимит — 100 000 событий за файл. Закройте окно и уточните период или
            фильтры.
          </p>
        )}
        {error != null && (
          <p className="error-text" role="alert">
            {errorMessage(error)}
            {isStale(error) && (
              <button
                type="button"
                onClick={() => {
                  close();
                  refresh();
                }}
              >
                Обновить выборку
              </button>
            )}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Закрыть
          </button>
          <button
            className="primary-button"
            disabled={busy || tooMany}
            type="submit"
          >
            {busy
              ? "Проверяем выборку…"
              : error
                ? "Повторить скачивание"
                : `Скачать ${format.toUpperCase()}`}
          </button>
        </div>
      </form>
      <iframe
        hidden
        ref={frame}
        name={`export-${id}`}
        title="Скачивание событий"
        onLoad={() => {
          // Attachments do not navigate the frame; a JSON error response does.
          const text = frame.current?.contentDocument?.body.textContent;
          if (!text) return;
          try {
            const body = JSON.parse(text) as ApiError;
            if (body.error) {
              setStarted(false);
              setError(
                new RequestError(
                  400,
                  body.error.code,
                  body.error.message,
                  body.error.request_id,
                ),
              );
            }
          } catch {
            /* The initial empty frame has no response to display. */
          }
        }}
      />
    </Modal>
  );
}
