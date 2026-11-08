import { setImmediate } from "node:timers/promises";
import type { AppDatabase } from "../db/connection.ts";
import type { EventDetail } from "../../shared/events.ts";
import { HttpError } from "./errors.ts";
import { parseQuery, publicSnapshot, resolveSnapshot } from "./query.ts";
import { listEvents, metadata, predicate } from "./read-models.ts";
import type { Tokens } from "./tokens.ts";

export const EXPORT_LIMIT = 100_000;
const fields = [
  "id",
  "source",
  "type",
  "status",
  "created_at",
  "message",
  "seq",
  "received_at",
  "error_code",
  "payload",
] as const;

// Quote every cell; an apostrophe neutralizes spreadsheet formulas, including
// prefixes hidden behind whitespace/control characters. JSON remains lossless.
function csvCell(value: unknown) {
  let text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^[\s\p{Cc}]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

export class EventExports {
  private active = 0;

  open(db: AppDatabase, tokens: Tokens, request: Request, url: URL) {
    const q = parseQuery(url, "export");
    const format = q.params.get("format");
    if (format !== "csv" && format !== "json")
      throw new HttpError(400, "INVALID_QUERY", "Выберите формат csv или json");
    const { snapshot, count } = db.sqlite.transaction(() => {
      const meta = metadata(db);
      const snapshot = resolveSnapshot(q, tokens, meta.history, meta.max);
      const p = predicate(snapshot.data.filters, snapshot.data.max_seq);
      const { count } = db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM events e WHERE ${p.sql}`)
        .get(...p.params) as { count: number };
      if (count > EXPORT_LIMIT)
        throw new HttpError(
          413,
          "EXPORT_LIMIT",
          "В выборке больше 100 000 событий. Уточните период или фильтры.",
        );
      return { snapshot, count };
    })();
    const filename = `events-${snapshot.data.as_of.replaceAll(/[:.]/g, "-")}.${format}`;
    const headers = {
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-transform",
      "X-Export-Count": String(count),
      "X-Accel-Buffering": "no",
    };
    if (request.method === "HEAD") return new Response(null, { headers });
    if (this.active >= 2)
      throw new HttpError(
        429,
        "EXPORT_BUSY",
        "Уже выполняются две выгрузки. Повторите позже.",
        undefined,
        { "Retry-After": "5" },
      );
    request.signal.throwIfAborted();

    async function* chunks() {
      yield format === "csv"
        ? "\uFEFF" + fields.join(",") + "\r\n"
        : JSON.stringify({
            snapshot: publicSnapshot(snapshot),
            filters: snapshot.data.filters,
            sort: q.sort,
            direction: q.direction,
            count,
          }).slice(0, -1) + ',"items":[';
      let cursor: string | null = null;
      let emitted = 0;
      do {
        // Release the event loop between short reads; no transaction spans IO.
        await setImmediate();
        if (closed) return;
        request.signal.throwIfAborted();
        const params = cursor
          ? new URLSearchParams({ cursor })
          : new URLSearchParams({
              snapshot: snapshot.token,
              sort: q.sort,
              direction: q.direction,
              limit: "100",
            });
        const page = listEvents(
          db,
          tokens,
          new URL(`http://local/api/events?${params}`),
          true,
        );
        const rows: EventDetail[] = page.items;
        yield format === "csv"
          ? rows
              .map(
                (row) =>
                  fields.map((field) => csvCell(row[field])).join(",") + "\r\n",
              )
              .join("")
          : rows
              .map(
                (row, index) =>
                  (emitted || index ? "," : "") + JSON.stringify(row),
              )
              .join("");
        emitted += rows.length;
        cursor = page.page.next_cursor;
      } while (cursor);
      if (emitted !== count) throw new Error("Incomplete export");
      if (format === "json") yield "]}";
    }

    this.active++;
    const iterator = chunks();
    const encoder = new TextEncoder();
    let closed = false;
    let abort: () => void;
    let timeout: ReturnType<typeof setTimeout>;
    const release = () => {
      if (closed) return;
      closed = true;
      this.active--;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      void iterator.return(undefined);
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          abort = () => {
            if (closed) return;
            controller.error(new Error("Export cancelled or timed out"));
            release();
          };
          request.signal.addEventListener("abort", abort, { once: true });
          timeout = setTimeout(abort, 5 * 60_000);
          timeout.unref();
        },
        async pull(controller) {
          try {
            const chunk = await iterator.next();
            if (closed) return;
            if (chunk.done) {
              controller.close();
              release();
            } else controller.enqueue(encoder.encode(chunk.value));
          } catch (error) {
            if (!closed) {
              controller.error(error);
              release();
            }
          }
        },
        cancel: release,
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { headers });
  }
}
