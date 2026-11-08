import type { AppDatabase } from "../db/connection.ts";
import { HttpError } from "./errors.ts";
import { metadata } from "./read-models.ts";

export type StreamOptions = {
  maxConnections: number;
  pollMs: number;
  heartbeatMs: number;
  batchSize: number;
  maxBacklog: number;
};
export const streamDefaults: StreamOptions = {
  maxConnections: 32,
  pollMs: 500,
  heartbeatMs: 15_000,
  batchSize: 100,
  maxBacklog: 10_000,
};

function cursor(value: string) {
  const match =
    /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):(0|[1-9]\d{0,15})$/.exec(
      value,
    );
  if (!match || !Number.isSafeInteger(Number(match[2])))
    throw new HttpError(400, "INVALID_STREAM_CURSOR");
  return { history: match[1]!, seq: Number(match[2]) };
}

// The append-only database is the change log. No transaction survives a poll.
export class EventStreams {
  private active = 0;
  private connections = new Set<() => void>();
  private draining = false;
  private shutdown = () => {
    this.draining = true;
    for (const close of [...this.connections]) close();
  };
  constructor(
    private database: () => AppDatabase,
    private options: () => StreamOptions = () => streamDefaults,
  ) {}

  open(request: Request, url: URL): Response {
    if (
      [...url.searchParams.keys()].some((key) => key !== "after") ||
      url.searchParams.getAll("after").length !== 1
    )
      throw new HttpError(400, "INVALID_QUERY");
    const initial = cursor(url.searchParams.get("after")!);
    const last = request.headers.get("Last-Event-ID");
    const after = last === null ? initial : cursor(last);
    const config = this.options();
    const headers = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    };
    if (request.method === "HEAD") return new Response(null, { headers });
    if (this.draining)
      throw new HttpError(
        503,
        "STREAM_DRAINING",
        "Сервис перезапускается",
        undefined,
        { "Retry-After": "2" },
      );
    if (this.active >= config.maxConnections)
      throw new HttpError(
        503,
        "STREAM_LIMIT",
        "Слишком много потоков",
        undefined,
        { "Retry-After": "5" },
      );

    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let finish: () => void = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      request.signal.removeEventListener("abort", finish);
      this.connections.delete(finish);
      this.active--;
      if (!this.active) {
        process.removeListener("SIGTERM", this.shutdown);
        process.removeListener("SIGINT", this.shutdown);
      }
    };
    this.active++;
    if (this.active === 1) {
      process.once("SIGTERM", this.shutdown);
      process.once("SIGINT", this.shutdown);
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          finish = () => {
            cleanup();
            controller.close();
          };
          this.connections.add(finish);
          request.signal.addEventListener("abort", finish, { once: true });
          if (request.signal.aborted) {
            finish();
            return;
          }
          let lastSent = Date.now();
          let blockedAt: number | undefined;
          let ready = false;
          const send = (event: string, data: unknown, id?: string) => {
            controller.enqueue(
              encoder.encode(
                `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
            lastSent = Date.now();
          };
          const poll = () => {
            if (closed) return;
            // At most one bounded frame waits for a slow reader.
            if ((controller.desiredSize ?? 0) <= 0) {
              blockedAt ??= Date.now();
              if (Date.now() - blockedAt >= config.heartbeatMs * 2) {
                cleanup();
                controller.error(new Error("SLOW_STREAM_READER"));
              }
              return;
            }
            blockedAt = undefined;
            try {
              const db = this.database();
              const batch = db.sqlite.transaction(() => {
                const meta = metadata(db);
                if (meta.history !== after.history || after.seq > meta.max)
                  return { meta, resync: "history_changed" };
                const backlog = db.sqlite
                  .prepare(
                    "SELECT COUNT(*) AS count FROM (SELECT seq FROM events WHERE seq > ? ORDER BY seq LIMIT ?)",
                  )
                  .get(after.seq, config.maxBacklog + 1) as { count: number };
                if (backlog.count > config.maxBacklog)
                  return { meta, resync: "backlog_limit" };
                const rows = db.sqlite
                  .prepare(
                    "SELECT seq FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
                  )
                  .all(after.seq, config.batchSize) as { seq: number }[];
                return { meta, rows };
              })();
              if (batch.resync) {
                send("resync", {
                  reason: batch.resync,
                  history_id: batch.meta.history,
                  max_seq: batch.meta.max,
                });
                finish();
              } else if (batch.rows?.length) {
                after.seq = batch.rows.at(-1)!.seq;
                send(
                  "events.changed",
                  {
                    history_id: after.history,
                    max_seq: after.seq,
                    count: batch.rows.length,
                  },
                  `${after.history}:${after.seq}`,
                );
              } else if (
                !ready ||
                Date.now() - lastSent >= config.heartbeatMs
              ) {
                send(ready ? "heartbeat" : "ready", {
                  history_id: batch.meta.history,
                  max_seq: batch.meta.max,
                  heartbeat_ms: config.heartbeatMs,
                });
                ready = true;
              }
            } catch {
              cleanup();
              controller.error(new Error("STREAM_UNAVAILABLE"));
            }
          };
          controller.enqueue(encoder.encode("retry: 2000\n\n"));
          timer = setInterval(poll, config.pollMs);
        },
        cancel: cleanup,
      },
      { highWaterMark: 1 },
    );
    return new Response(body, { headers });
  }
}
