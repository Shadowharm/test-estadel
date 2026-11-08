"use client";

import type { OverviewResponse } from "@/shared/events";
import {
  eventHref,
  formatTime,
  validateConditions,
  type Conditions,
} from "@/features/journal/state";
import { WorkspaceLink } from "@/features/journal/workspace-link";
import {
  ChartLegend,
  SourcesChart,
  StatusChart,
  TimelineChart,
} from "./charts";
import {
  intervalConditions,
  number,
  percent,
  sourceRows,
  stepLabel,
  type Bucket,
} from "./model";

export function Dashboard({
  data,
  state,
  apply,
  open,
}: {
  data: OverviewResponse;
  state: Conditions;
  apply: (state: Conditions) => void;
  open: (id: string) => void;
}) {
  const { totals, timeline, sources, recent_errors: errors } = data;
  const selectInterval = (bucket: Bucket) => {
    const next = intervalConditions(state, bucket);
    if (!validateConditions(next)) apply(next);
  };
  const selectStatus = (status: "success" | "error") =>
    apply({ ...state, status });
  const rows = sourceRows(sources);
  return (
    <div className="dashboard">
      <dl className="kpi-grid" aria-label="Статистика текущей выборки">
        {[
          {
            label: "Всего событий",
            value: number(totals.total),
            hint: "Все совпадения",
          },
          {
            label: "Успешно",
            value: number(totals.success),
            hint: "✓ success",
            className: "success-dot",
          },
          {
            label: "С ошибкой",
            value: number(totals.error),
            hint: "! error",
            className: "error-text",
          },
          {
            label: "Доля ошибок",
            value: percent(totals.error_rate),
            hint: totals.total
              ? `От ${number(totals.total)} событий выборки`
              : "Нет событий для расчёта",
            className: "error-text",
          },
        ].map((item) => (
          <div className="kpi-card" key={item.label}>
            <dt>{item.label}</dt>
            <dd className={item.className}>{item.value}</dd>
            <span className="muted small">{item.hint}</span>
          </div>
        ))}
      </dl>
      {!totals.total ? (
        <div className="state-panel dashboard-empty">
          <h2>Событий не найдено</h2>
          <p className="muted">Измените период, поиск или фильтры.</p>
          <p>Графики появятся, когда в выборке будут события.</p>
        </div>
      ) : (
        <>
          <section className="chart-panel" aria-labelledby="timeline-heading">
            <div className="panel-heading">
              <div>
                <h2 id="timeline-heading">События во времени</h2>
                <p className="muted small">
                  Шаг {stepLabel(timeline.step_seconds)} · UTC ·{" "}
                  {number(totals.total)} событий
                </p>
              </div>
              <span className="muted small">Выберите интервал для разбора</span>
            </div>
            <ChartLegend />
            <TimelineChart data={timeline} select={selectInterval} />
          </section>
          <div className="dashboard-charts-row">
            <section className="chart-panel" aria-labelledby="sources-heading">
              <div className="panel-heading">
                <div>
                  <h2 id="sources-heading">Источники</h2>
                  <p className="muted small">
                    Объём и ошибки в текущей выборке · top 10
                  </p>
                </div>
              </div>
              <ChartLegend />
              <SourcesChart
                data={sources}
                select={(row) => {
                  if (!row.other) apply({ ...state, source: [row.source] });
                }}
              />
              {sources.other.total > 0 && (
                <p className="muted small">
                  «Остальные» — сумма источников вне top 10. Конкретный источник
                  можно выбрать в фильтрах.
                </p>
              )}
              <details className="chart-data">
                <summary>Таблица источников и долей</summary>
                <div
                  className="chart-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Таблица источников"
                >
                  <table>
                    <caption className="sr-only">
                      Источники в текущей выборке
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Источник</th>
                        <th scope="col">Успешно</th>
                        <th scope="col">Ошибка</th>
                        <th scope="col">Всего</th>
                        <th scope="col">Доля ошибок</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index}>
                          <th scope="row">
                            {row.other ? (
                              row.source
                            ) : (
                              <button
                                className="text-button wrap"
                                onClick={() =>
                                  apply({ ...state, source: [row.source] })
                                }
                              >
                                {row.source}
                              </button>
                            )}
                          </th>
                          <td>{number(row.success)}</td>
                          <td>{number(row.error)}</td>
                          <td>{number(row.total)}</td>
                          <td>
                            {percent(row.total ? row.error / row.total : null)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
            <section className="chart-panel" aria-labelledby="status-heading">
              <div className="panel-heading">
                <div>
                  <h2 id="status-heading">Соотношение статусов</h2>
                  <p className="muted small">
                    От всех {number(totals.total)} событий текущей выборки
                  </p>
                </div>
              </div>
              <StatusChart totals={totals} select={selectStatus} />
              <details className="chart-data">
                <summary>Таблица статусов</summary>
                <div className="chart-table-scroll">
                  <table>
                    <caption className="sr-only">Соотношение статусов</caption>
                    <thead>
                      <tr>
                        <th scope="col">Статус</th>
                        <th scope="col">Событий</th>
                        <th scope="col">Доля</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["success", "error"] as const).map((status) => (
                        <tr key={status}>
                          <th scope="row">
                            <button
                              className="text-button"
                              onClick={() => selectStatus(status)}
                            >
                              {status === "success" ? "Успешно" : "Ошибка"}
                            </button>
                          </th>
                          <td>{number(totals[status])}</td>
                          <td>{percent(totals[status] / totals.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          </div>
        </>
      )}
      <section
        className="chart-panel recent-errors"
        aria-labelledby="errors-heading"
      >
        <div className="panel-heading">
          <div>
            <h2 id="errors-heading">Последние ошибки</h2>
            <p className="muted small">
              До 5 последних по поступлению в текущей выборке
            </p>
          </div>
          <WorkspaceLink href={eventHref(state)}>
            Открыть события →
          </WorkspaceLink>
        </div>
        {errors.length ? (
          <ul>
            {errors.map((event) => (
              <li key={event.id}>
                <div>
                  <strong className="wrap">{event.source}</strong>
                  <span className="mono wrap">
                    {event.type}
                    {event.error_code ? ` · ${event.error_code}` : ""}
                  </span>
                  <p className="wrap">{event.message}</p>
                  <time className="muted small" dateTime={event.created_at}>
                    {formatTime(event.created_at)} UTC
                  </time>
                </div>
                <a
                  className="recent-error-link"
                  href={eventHref(state, event.id)}
                  onClick={(e) => {
                    if (
                      e.button === 0 &&
                      !e.metaKey &&
                      !e.ctrlKey &&
                      !e.shiftKey &&
                      !e.altKey
                    ) {
                      e.preventDefault();
                      open(event.id);
                    }
                  }}
                >
                  Открыть <span className="sr-only">событие {event.id}</span>→
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">В текущей выборке нет ошибок.</p>
        )}
      </section>
    </div>
  );
}
