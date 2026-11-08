import type { AppDatabase } from "./connection.ts";
import { insertEvent } from "../events/store.ts";
import type { EventInput } from "../events/normalize.ts";

export const FIXTURE_ANCHOR = "2026-11-07T12:00:00.000Z";
const day = 86400000;
const sources = ["amoCRM", "Битрикс24", "Website", "1С", "Telegram"];
const types = [
  "lead.created",
  "contact.updated",
  "order.paid",
  "invoice.created",
];
const errors = [
  ["AUTH_EXPIRED", "Ошибка передачи заявки: истёк тестовый токен доступа"],
  [
    "TIMEOUT",
    "Ошибка синхронизации: тестовая система не ответила за 30 секунд",
  ],
  [
    "INVALID_FIELD",
    "Ошибка проверки заказа: не заполнено обязательное поле currency",
  ],
] as const;
function fixture(index: number, anchor: number, prefix: string): EventInput {
  const daysAgo = index % 30;
  // Leave full days empty and create a visible error burst.
  const offset = [3, 12, 21].includes(daysAgo) ? daysAgo + 1 : daysAgo;
  const error = index % 7 === 0 || (offset === 2 && index % 3 !== 0);
  const reason = errors[index % errors.length]!;
  return {
    id: `${prefix}-${String(index + 1).padStart(6, "0")}`,
    source: sources[index % sources.length]!,
    type: types[index % types.length]!,
    status: error ? "error" : "success",
    created_at: new Date(
      anchor - offset * day - (index % 12) * 3600000,
    ).toISOString(),
    message: error
      ? reason[1]
      : index % 17 === 0
        ? `Заказ успешно передан.\n${"Синтетическая диагностическая информация; ".repeat(35)}`
        : "Заявка успешно передана в тестовую систему",
    ...(error ? { error_code: reason[0] } : {}),
    payload: {
      synthetic: true,
      order: index + 1,
      currency: "RUB",
      diagnostics: { attempt: 1, tags: ["demo", "без персональных данных"] },
    },
  };
}
export function smallFixtures(): EventInput[] {
  return Array.from({ length: 12 }, (_, index) =>
    fixture(index, Date.parse(FIXTURE_ANCHOR), "test-v1"),
  );
}
export function seedEvents(
  db: AppDatabase,
  inputs: EventInput[],
  receivedAtMs: number,
) {
  // A conflict rolls back the entire batch, including its FTS rows.
  return db.sqlite
    .transaction(() => {
      let inserted = 0;
      for (const event of inputs)
        if (insertEvent(db, event, receivedAtMs).inserted) inserted++;
      return { inserted, existing: inputs.length - inserted };
    })
    .immediate();
}
export function seedDemo(db: AppDatabase, now = Date.now()) {
  return db.sqlite
    .transaction(() => {
      db.sqlite
        .prepare(
          "INSERT INTO app_meta(key,value) VALUES('demo_seed_anchor',?) ON CONFLICT(key) DO NOTHING",
        )
        .run(new Date(now).toISOString());
      const anchor = Date.parse(
        (
          db.sqlite
            .prepare("SELECT value FROM app_meta WHERE key='demo_seed_anchor'")
            .get() as { value: string }
        ).value,
      );
      return seedEvents(
        db,
        Array.from({ length: 360 }, (_, i) => fixture(i, anchor, "demo-v1")),
        anchor,
      );
    })
    .immediate();
}
export function seedBenchmark(db: AppDatabase, count = 100000) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000)
    throw new Error("Count должен быть 1–1000000");
  const anchor = Date.parse(FIXTURE_ANCHOR);
  for (let start = 0; start < count; start += 500) {
    seedEvents(
      db,
      Array.from({ length: Math.min(500, count - start) }, (_, i) =>
        fixture(start + i, anchor, "bench-v1"),
      ),
      anchor,
    );
  }
  db.sqlite.exec("ANALYZE");
}
