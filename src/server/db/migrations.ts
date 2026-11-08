import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AppDatabase } from "./connection.ts";

export const migrationsFolder = () => resolve(process.cwd(), "drizzle");

// Drizzle applies migrations but doesn't verify already-applied checksums.
export function verifyMigrations(db: AppDatabase, requireCurrent = true) {
  const expected = readMigrationFiles({ migrationsFolder: migrationsFolder() });
  const exists = db.sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'")
    .get();
  const applied = exists
    ? (db.sqlite
        .prepare(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
        )
        .all() as { hash: string; created_at: number }[])
    : [];
  if (
    applied.length > expected.length ||
    (requireCurrent && applied.length !== expected.length)
  )
    throw new Error(
      "Схема БД не соответствует приложению; выполните db:migrate совместимой версией",
    );
  for (let i = 0; i < applied.length; i++) {
    if (
      applied[i]!.hash !== expected[i]!.hash ||
      Number(applied[i]!.created_at) !== expected[i]!.folderMillis
    )
      throw new Error("История миграций отличается от поставляемых SQL-файлов");
  }
}

export function migrateDatabase(db: AppDatabase) {
  verifyMigrations(db, false);
  migrate(db.orm, { migrationsFolder: migrationsFolder() });
  db.sqlite
    .transaction(() => {
      const put = db.sqlite.prepare(
        "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
      );
      put.run("history_id", randomUUID());
      put.run("normalization_version", "1");
      put.run("search_version", "unicode61-v1");
    })
    .immediate();
  assertCurrentSchema(db);
}

export function assertCurrentSchema(db: AppDatabase) {
  verifyMigrations(db);
  const meta = Object.fromEntries(
    db.sqlite
      .prepare("SELECT key,value FROM app_meta")
      .all()
      .map((row) => {
        const value = row as { key: string; value: string };
        return [value.key, value.value];
      }),
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      meta.history_id ?? "",
    ) ||
    meta.normalization_version !== "1" ||
    meta.search_version !== "unicode61-v1"
  )
    throw new Error("Некорректные метаданные истории/нормализации/поиска");
  const sequence = db.sqlite
    .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
    .get() as { seq: number } | undefined;
  if (
    sequence &&
    (!Number.isSafeInteger(sequence.seq) ||
      sequence.seq >= Number.MAX_SAFE_INTEGER)
  )
    throw new Error("SEQUENCE_EXHAUSTED");
  for (const name of [
    "events_fts",
    "events_ai",
    "events_au",
    "events_ad",
    "events_bi",
  ]) {
    if (
      !db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)
    )
      throw new Error(`Отсутствует объект схемы: ${name}`);
  }
}
