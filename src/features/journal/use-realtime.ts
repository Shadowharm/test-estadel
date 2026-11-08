"use client";

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/shared/events";
import { watchEvents, type Watermark } from "./realtime";

export function useRealtime({
  snapshot,
  eligible,
  busy,
  refresh,
  resync,
}: {
  snapshot: Snapshot | undefined;
  eligible: boolean;
  busy: boolean;
  refresh: (canPublish: () => boolean) => Promise<void>;
  resync: () => void;
}) {
  const [errorSnapshot, setErrorSnapshot] = useState<string | null>(null);
  const watermark = useRef<Watermark | undefined>(undefined);
  const current = useRef({ snapshot, eligible, busy, refresh, resync });
  useEffect(() => {
    current.current = { snapshot, eligible, busy, refresh, resync };
  });
  const history = snapshot?.history_id;
  useEffect(() => {
    const initial = current.current.snapshot;
    if (!initial) return;
    return watchEvents(
      initial,
      (next) => {
        watermark.current = next;
      },
      () => {},
      () => current.current.resync(),
    );
  }, [history]);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let retryAt = 0;
    const update = async () => {
      const c = current.current;
      const next = watermark.current;
      if (
        running ||
        !c.eligible ||
        c.busy ||
        Date.now() < retryAt ||
        !c.snapshot ||
        next?.history_id !== c.snapshot.history_id ||
        next.max_seq <= c.snapshot.max_seq
      )
        return;
      running = true;
      try {
        await c.refresh(
          () =>
            !disposed &&
            current.current.eligible &&
            !current.current.busy &&
            current.current.snapshot?.token === c.snapshot?.token,
        );
        if (!disposed) setErrorSnapshot(null);
      } catch (error) {
        // Filter changes and navigation deliberately cancel the old request.
        if (error instanceof Error && error.name === "AbortError") return;
        retryAt = Date.now() + 5_000;
        if (!disposed) setErrorSnapshot(c.snapshot.token);
      } finally {
        running = false;
      }
    };
    // A fixed tick coalesces bursts without postponing updates during a steady stream.
    const timer = setInterval(() => {
      void update();
    }, 200);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [history]);
  return {
    updateError: !!snapshot && errorSnapshot === snapshot.token,
  };
}
