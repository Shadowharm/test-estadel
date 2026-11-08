import type { Counts, OverviewResponse } from "@/shared/events";
import { formatTime, type Conditions } from "../journal/state";

export type Bucket = OverviewResponse["timeline"]["buckets"][number];
export type SourceRow = Counts & { source: string; other: boolean };
export const number = (value: number) => value.toLocaleString("ru-RU");
export const percent = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);

export function sourceRows(sources: OverviewResponse["sources"]): SourceRow[] {
  const rows = sources.items.map((item) => ({ ...item, other: false }));
  if (sources.other.total)
    rows.push({ ...sources.other, source: "Остальные (сумма)", other: true });
  return rows;
}

export function intervalConditions(
  state: Conditions,
  bucket: Bucket,
): Conditions {
  return { ...state, preset: "custom", from: bucket.from, to: bucket.to };
}

export function stepLabel(seconds: number) {
  if (seconds % 86400 === 0) return `${number(seconds / 86400)} дн.`;
  if (seconds % 3600 === 0) return `${number(seconds / 3600)} ч.`;
  if (seconds % 60 === 0) return `${number(seconds / 60)} мин.`;
  return `${number(seconds)} с.`;
}

const tickFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export const timeTick = (value: string) => tickFormat.format(new Date(value));

// All-time extents may clip a bucket just one millisecond after its event.
export function boundaryTime(value: string) {
  const ms = new Date(value).getUTCMilliseconds();
  return formatTime(value) + (ms ? `,${String(ms).padStart(3, "0")}` : "");
}
