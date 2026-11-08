import "./check-runtime.mjs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:3000" },
    count: { type: "string", default: "20" },
    "interval-ms": { type: "string", default: "1000" },
    "error-every": { type: "string", default: "5" },
    "late-every": { type: "string", default: "7" },
    "replay-every": { type: "string", default: "0" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "npm run demo -- [--url http://127.0.0.1:3000] [--count 20] [--interval-ms 1000] [--error-every 5] [--late-every 7] [--replay-every 0]\nТолько синтетические POST. count: 1–10000; interval-ms: 100–60000; error/late/replay-every: 0–10000 (0 отключает). Ctrl+C останавливает поток.",
  );
} else {
  const integer = (
    key:
      "count" | "interval-ms" | "error-every" | "late-every" | "replay-every",
    min: number,
    max: number,
  ) => {
    const value = values[key]!;
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < min ||
      parsed > max
    )
      throw new Error(`--${key}: допустимо ${min}–${max}`);
    return parsed;
  };
  const base = new URL(values.url!);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error(
      "--url: нужен http(s) origin без пути, query и учётных данных",
    );
  const count = integer("count", 1, 10_000);
  const interval = integer("interval-ms", 100, 60_000);
  const errorEvery = integer("error-every", 0, 10_000);
  const lateEvery = integer("late-every", 0, 10_000);
  const replayEvery = integer("replay-every", 0, 10_000);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const run = randomUUID();
  const sources = ["Демо · amoCRM", "Демо · Битрикс24", "Демо · Website"];
  const types = ["lead.created", "contact.updated", "order.paid"];
  let confirmed = 0;
  let replayed = 0;
  console.log(
    `Демонстрация ${run}: ${count} событий → ${base.origin}; интервал ${interval} мс. Ctrl+C — остановить.`,
  );
  try {
    for (let i = 1; i <= count && !controller.signal.aborted; i++) {
      const error = errorEvery > 0 && i % errorEvery === 0;
      const late = lateEvery > 0 && i % lateEvery === 0;
      const event = {
        id: `demo-${run}-${i}`,
        source: sources[(i - 1) % sources.length],
        type: types[(i - 1) % types.length],
        status: error ? "error" : "success",
        created_at: new Date(Date.now() - (late ? 86400000 : 0)).toISOString(),
        message: error
          ? "Тестовая система не ответила: синтетический таймаут"
          : "Синтетическое событие успешно передано",
        ...(error ? { error_code: "DEMO_TIMEOUT" } : {}),
        payload: { synthetic: true, run, index: i, late },
      };
      const deliver = async () => {
        const response = await fetch(new URL("/api/events", base), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (response.status !== 201 && response.status !== 200)
          throw new Error(
            `POST вернул HTTP ${response.status}; генератор остановлен`,
          );
        return response.json() as Promise<{ replayed: boolean }>;
      };
      await deliver();
      confirmed++;
      if (replayEvery > 0 && i % replayEvery === 0) {
        if (!(await deliver()).replayed)
          throw new Error("Повтор ID не распознан сервером");
        replayed++;
      }
      console.log(
        `${confirmed}/${count} ${event.id} ${event.status}${late ? " · запоздавшее на сутки" : ""}`,
      );
      if (i < count)
        await delay(interval, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error instanceof Error ? error.message : "Ошибка отправки");
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    console.log(
      `${controller.signal.aborted ? "Остановлено" : "Завершено"}. Подтверждено сервером: ${confirmed}/${count}; повторов ID: ${replayed}. Сохранённые события остаются в БД.`,
    );
  }
}
