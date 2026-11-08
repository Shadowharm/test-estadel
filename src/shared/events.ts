export type EventSummary = {
  id: string;
  source: string;
  type: string;
  status: "success" | "error";
  created_at: string;
  message: string;
  seq: number;
  received_at: string;
  error_code?: string;
};
export type EventDetail = EventSummary & { payload?: Record<string, unknown> };

// Browser-safe: no Buffer, server imports or secrets.
export function eventSlug(id: string): string {
  const bytes = new TextEncoder().encode(id);
  return (
    "~" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
  );
}

export type Snapshot = {
  history_id: string;
  max_seq: number;
  as_of: string;
  from: string | null;
  to: string | null;
  token: string;
};
export type EventsResponse = {
  items: EventSummary[];
  page: {
    next_cursor: string | null;
    previous_cursor: string | null;
    has_more: boolean;
    has_previous: boolean;
  };
  snapshot: Snapshot;
};
export type Counts = { total: number; success: number; error: number };
export type OverviewResponse = {
  totals: Counts & { error_rate: number | null };
  timeline: {
    step_seconds: number;
    buckets: { from: string; to: string; success: number; error: number }[];
  };
  sources: { items: (Counts & { source: string })[]; other: Counts };
  recent_errors: EventSummary[];
  snapshot: Snapshot;
};
export type FacetsResponse = {
  field: "source" | "type";
  items: { value: string; count: number }[];
  selected: { value: string; count: number }[];
  page: { next_cursor: string | null; has_more: boolean };
  snapshot: Snapshot;
};
export type EventResult = { event: EventDetail; replayed: boolean };
export type ApiError = {
  error: {
    code: string;
    message: string;
    request_id: string;
    fields?: { path: string; code: string; message: string }[];
  };
};
