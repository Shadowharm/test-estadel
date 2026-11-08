import type { EventsResponse } from "../../shared/events";
import { requestJson } from "./http";

export type Watermark = { history_id: string; max_seq: number };
export type TransportStatus =
  "connecting" | "live" | "reconnecting" | "polling";

// One transport per workspace; native EventSource retains Last-Event-ID on retries.
export function watchEvents(
  initial: Watermark,
  changed: (watermark: Watermark) => void,
  status: (value: TransportStatus) => void,
  resync: () => void,
) {
  let watermark = initial;
  let source: EventSource | undefined;
  let failureAt = 0;
  let lastActivity = Date.now();
  let polling = false;
  let stopped = false;
  let request: AbortController | undefined;
  let silenceMs = 35_000;
  const accept = (next: Watermark) => {
    if (next.history_id !== watermark.history_id) {
      watermark = next;
      resync();
    } else if (next.max_seq > watermark.max_seq) {
      watermark = next;
      changed(next);
    }
  };
  const fail = () => {
    failureAt ||= Date.now();
    status(polling ? "polling" : "reconnecting");
  };
  const connect = () => {
    source?.close();
    lastActivity = Date.now();
    try {
      source = new EventSource(
        `/api/events/stream?${new URLSearchParams({ after: `${watermark.history_id}:${watermark.max_seq}` })}`,
      );
      for (const event of ["ready", "heartbeat", "events.changed", "resync"]) {
        source.addEventListener(event, (message) => {
          if (stopped) return;
          try {
            const data = JSON.parse(
              (message as MessageEvent<string>).data,
            ) as Watermark;
            if (
              typeof data.history_id !== "string" ||
              !Number.isSafeInteger(data.max_seq) ||
              data.max_seq < 0
            )
              throw new Error("stream payload");
            lastActivity = Date.now();
            const heartbeat = (data as Watermark & { heartbeat_ms?: number })
              .heartbeat_ms;
            if (typeof heartbeat === "number" && heartbeat > 0)
              silenceMs = Math.max(35_000, heartbeat * 2 + 5_000);
            failureAt = 0;
            polling = false;
            request?.abort();
            status("live");
            if (event === "resync") {
              watermark = data;
              resync();
              connect();
            } else accept(data);
          } catch {
            fail();
          }
        });
      }
      source.onerror = fail;
    } catch {
      fail();
    }
  };
  status("connecting");
  connect();
  const timer = setInterval(() => {
    // A silently buffered/stalled stream must also activate fallback.
    if (Date.now() - lastActivity > silenceMs) {
      fail();
      connect();
    }
    if (!failureAt || Date.now() - failureAt < 10_000 || request) return;
    polling = true;
    status("polling");
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    void requestJson<EventsResponse>("/api/events?limit=1", controller.signal)
      .then((data) => {
        if (!stopped && !controller.signal.aborted) accept(data.snapshot);
      })
      .catch(() => {
        /* Keep the visible snapshot and retry. */
      })
      .finally(() => {
        clearTimeout(timeout);
        if (request === controller) request = undefined;
      });
  }, 10_000);
  return () => {
    stopped = true;
    source?.close();
    clearInterval(timer);
    request?.abort();
  };
}
