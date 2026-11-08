"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { OverviewResponse } from "@/shared/events";
import {
  number,
  percent,
  sourceRows,
  timeTick,
  boundaryTime,
  type Bucket,
  type SourceRow,
} from "./model";

const colors = { success: "var(--chart-success)", error: "var(--chart-error)" };
const names = { success: "Успешно", error: "Ошибка" };

function CountTooltip({
  active,
  payload,
  kind,
}: Pick<TooltipContentProps, "active" | "payload"> & {
  kind: "time" | "source" | "status";
}) {
  if (!active || !payload.length) return null;
  const row = payload[0]?.payload as
    | (Bucket & SourceRow & { name: string; value: number; share: number })
    | undefined;
  if (!row) return null;
  return (
    <div className="chart-tooltip">
      <strong>
        {kind === "time"
          ? `${boundaryTime(row.from)} — ${boundaryTime(row.to)} UTC (конец не включается)`
          : kind === "source"
            ? row.source
            : row.name}
      </strong>
      {kind === "status" ? (
        <p>
          {number(row.value)} событий · {percent(row.share)}
        </p>
      ) : (
        <>
          <p>Успешно: {number(row.success)}</p>
          <p>Ошибка: {number(row.error)}</p>
          <p>
            Всего: {number(row.success + row.error)} · Доля ошибок:{" "}
            {percent(
              row.success + row.error
                ? row.error / (row.success + row.error)
                : null,
            )}
          </p>
        </>
      )}
      {kind === "source" && row.other && (
        <p>Сумма источников за пределами top 10</p>
      )}
    </div>
  );
}

export function ChartLegend() {
  return (
    <div className="chart-legend" aria-label="Серии графика">
      <span>
        <i className="series-success" />
        Успешно
      </span>
      <span>
        <i className="series-error" />
        Ошибка
      </span>
    </div>
  );
}

export function TimelineChart({
  data,
  select,
}: {
  data: OverviewResponse["timeline"];
  select: (bucket: Bucket) => void;
}) {
  return (
    <div
      className="chart-frame timeline-chart"
      role="group"
      aria-label="События по UTC-интервалам. Выберите столбец для фильтрации по интервалу."
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 600, height: 230 }}
      >
        <BarChart
          data={data.buckets}
          margin={{ top: 10, right: 8, bottom: 8, left: -16 }}
          accessibilityLayer
        >
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="from"
            tickFormatter={timeTick}
            minTickGap={50}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={(props) => <CountTooltip {...props} kind="time" />}
            cursor={{ fill: "var(--accent-subtle)" }}
            isAnimationActive={false}
          />
          {(["success", "error"] as const).map((status) => (
            <Bar
              key={status}
              dataKey={status}
              name={names[status]}
              stackId="events"
              fill={colors[status]}
              maxBarSize={64}
              isAnimationActive={false}
              onClick={(_, index) => select(data.buckets[index]!)}
              className="chart-selectable"
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SourcesChart({
  data,
  select,
}: {
  data: OverviewResponse["sources"];
  select: (row: SourceRow) => void;
}) {
  const rows = sourceRows(data);
  return (
    <div
      className="chart-frame source-chart"
      data-has-other={data.other.total > 0}
      style={{ height: Math.max(180, rows.length * 38 + 32) }}
      role="group"
      aria-label="Успешные события и ошибки по источникам. Полные названия, доли и выбор источника доступны в таблице ниже."
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 500, height: 220 }}
      >
        <BarChart
          layout="vertical"
          data={rows}
          margin={{ left: 0, right: 8, bottom: 0, top: 0 }}
          accessibilityLayer
        >
          <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
          <XAxis
            type="number"
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          />
          <YAxis
            type="category"
            dataKey="source"
            width={112}
            tickFormatter={(value: string) =>
              value.length > 14 ? `${value.slice(0, 13)}…` : value
            }
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--text)", fontSize: 12 }}
          />
          <Tooltip
            content={(props) => <CountTooltip {...props} kind="source" />}
            cursor={{ fill: "var(--accent-subtle)" }}
            isAnimationActive={false}
          />
          {(["success", "error"] as const).map((status) => (
            <Bar
              key={status}
              dataKey={status}
              name={names[status]}
              stackId="sources"
              fill={colors[status]}
              maxBarSize={18}
              isAnimationActive={false}
              onClick={(_, index) => select(rows[index]!)}
              className="chart-selectable"
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusChart({
  totals,
  select,
}: {
  totals: OverviewResponse["totals"];
  select: (status: "success" | "error") => void;
}) {
  const rows = (["success", "error"] as const).map((status) => ({
    status,
    name: names[status],
    value: totals[status],
    share: totals[status] / totals.total,
    fill: colors[status],
  }));
  return (
    <div className="status-visual">
      <div
        className="donut-frame"
        role="group"
        aria-label={`Всего ${number(totals.total)} событий. Успешно ${number(totals.success)}, ошибок ${number(totals.error)}.`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={{ width: 190, height: 190 }}
        >
          <PieChart accessibilityLayer>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="70%"
              outerRadius="92%"
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive={false}
              onClick={(_, index) => select(rows[index]!.status)}
              className="chart-selectable"
            />
            <Tooltip
              content={(props) => <CountTooltip {...props} kind="status" />}
              isAnimationActive={false}
              wrapperStyle={{ zIndex: 1 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-label" aria-hidden="true">
          <strong>{number(totals.total)}</strong>
          <span>событий</span>
        </div>
      </div>
      <div className="status-breakdown">
        {rows.map((row) => (
          <button
            key={row.status}
            className="status-legend-button"
            onClick={() => select(row.status)}
          >
            <span
              className={row.status === "error" ? "error-text" : "success-dot"}
            >
              {row.status === "error" ? "!" : "✓"} {row.name}
            </span>
            <strong>
              {number(row.value)}{" "}
              <span className="muted">
                · {percent(row.value / totals.total)}
              </span>
            </strong>
          </button>
        ))}
      </div>
    </div>
  );
}
