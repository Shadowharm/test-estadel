import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import * as schema from "./schema.ts";

export function openDatabase(
  path: string,
  options: { create?: boolean; readonly?: boolean } = {},
) {
  if (!isAbsolute(path)) throw new Error("Нужен абсолютный путь к файловой БД");
  if (options.create)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, {
    fileMustExist: !options.create,
    readonly: options.readonly ?? false,
    timeout: 1000,
  });
  try {
    const version = sqlite
      .prepare("SELECT sqlite_version() AS version")
      .get() as { version: string };
    if (
      version.version.localeCompare("3.51.3", undefined, { numeric: true }) < 0
    )
      throw new Error("SQLite >= 3.51.3 обязателен (исправления WAL)");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 1000");
    if (!options.readonly) {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = FULL");
    }
    if (
      sqlite.pragma("journal_mode", { simple: true }) !== "wal" ||
      sqlite.pragma("foreign_keys", { simple: true }) !== 1 ||
      sqlite.pragma("busy_timeout", { simple: true }) !== 1000 ||
      (!options.readonly &&
        sqlite.pragma("synchronous", { simple: true }) !== 2)
    )
      throw new Error("Не удалось применить безопасные PRAGMA SQLite");
    // Test the actual tokenizer/FTS engine without touching persistent data.
    sqlite.exec(
      "CREATE VIRTUAL TABLE temp.fts_probe USING fts5(value, tokenize='unicode61 remove_diacritics 2'); DROP TABLE temp.fts_probe",
    );
    return {
      sqlite,
      orm: drizzle(sqlite, { schema }),
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
export type AppDatabase = ReturnType<typeof openDatabase>;
