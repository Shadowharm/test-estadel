import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  watchEvents,
  type Watermark,
} from "../../src/features/journal/realtime";

class Source extends EventTarget {
  static instances: Source[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    super();
    Source.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}
const initial: Watermark = { history_id: "a", max_seq: 5 };
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Source.instances = [];
  vi.stubGlobal("EventSource", Source);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("deduplicates repeated/out-of-order delivery while native reconnection keeps the same subscription", () => {
  const changed = vi.fn(),
    status = vi.fn();
  stop = watchEvents(initial, changed, status, vi.fn());
  const source = Source.instances[0]!;
  expect(source.url).toContain("after=a%3A5");
  source.emit("ready", initial);
  source.emit("events.changed", { ...initial, max_seq: 7 });
  source.emit("events.changed", { ...initial, max_seq: 7 });
  source.emit("events.changed", { ...initial, max_seq: 6 });
  expect(changed).toHaveBeenCalledTimes(1);
  source.onerror!();
  expect(status).toHaveBeenLastCalledWith("reconnecting");
  expect(Source.instances).toHaveLength(1);
  source.emit("heartbeat", { ...initial, max_seq: 8 });
  expect(changed).toHaveBeenLastCalledWith({ ...initial, max_seq: 8 });
  expect(status).toHaveBeenLastCalledWith("live");
  stop();
  expect(source.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses explicitly labelled fallback polling, retries network errors and stops it when SSE recovers", async () => {
  const changed = vi.fn(),
    status = vi.fn();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(Response.json({ snapshot: { ...initial, max_seq: 9 } }));
  vi.stubGlobal("fetch", fetcher);
  stop = watchEvents(initial, changed, status, vi.fn());
  const source = Source.instances[0]!;
  source.onerror!();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(status).toHaveBeenLastCalledWith("polling");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(changed).toHaveBeenLastCalledWith({ ...initial, max_seq: 9 });
  source.emit("ready", { ...initial, max_seq: 9 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(status).toHaveBeenLastCalledWith("live");
});

it("resyncs a changed history or excessive backlog once and reconnects from the new watermark", () => {
  const reset = vi.fn();
  stop = watchEvents(initial, vi.fn(), vi.fn(), reset);
  const source = Source.instances[0]!;
  source.emit("resync", {
    history_id: "b",
    max_seq: 2,
    reason: "history_changed",
  });
  expect(reset).toHaveBeenCalledTimes(1);
  expect(source.closed).toBe(true);
  expect(Source.instances[1]!.url).toContain("after=b%3A2");
  Source.instances[1]!.emit("ready", { history_id: "b", max_seq: 2 });
  expect(reset).toHaveBeenCalledTimes(1);
});

it("detects a silent SSE stall and respects the server heartbeat interval", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ snapshot: initial })),
  );
  const status = vi.fn();
  stop = watchEvents(initial, vi.fn(), status, vi.fn());
  Source.instances[0]!.emit("ready", { ...initial, heartbeat_ms: 60_000 });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(Source.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Source.instances[0]!.closed).toBe(true);
  expect(Source.instances).toHaveLength(2);
  expect(status).toHaveBeenLastCalledWith("polling");
});

it("cancels an outstanding fallback request when leaving the workspace", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("abort"))),
      );
    }),
  );
  stop = watchEvents(initial, vi.fn(), vi.fn(), vi.fn());
  Source.instances[0]!.onerror!();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal?.aborted).toBe(false);
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
