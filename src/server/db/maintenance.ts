import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateDatabasePath } from "../config/schema.ts";
import { openDatabase, type AppDatabase } from "./connection.ts";
import { assertCurrentSchema } from "./migrations.ts";

export function checkDatabase(db: AppDatabase) {
  assertCurrentSchema(db);
  const integrity = db.sqlite.pragma("integrity_check") as {
    integrity_check: string;
  }[];
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok")
    throw new Error("SQLite integrity_check failed");
  if ((db.sqlite.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("Foreign key check failed");
  // rank=1 checks the external content against the index (COUNT(*) alone cannot).
  db.sqlite
    .prepare(
      "INSERT INTO events_fts(events_fts,rank) VALUES('integrity-check',1)",
    )
    .run();
  return {
    history_id: (
      db.sqlite
        .prepare("SELECT value FROM app_meta WHERE key='history_id'")
        .get() as { value: string }
    ).value,
    ...(db.sqlite
      .prepare(
        "SELECT count(*) AS count, coalesce(max(seq),0) AS max_seq FROM events",
      )
      .get() as { count: number; max_seq: number }),
    sqlite_version: (
      db.sqlite.prepare("SELECT sqlite_version() AS value").get() as {
        value: string;
      }
    ).value,
  };
}
export function rebuildSearch(db: AppDatabase) {
  db.sqlite
    .transaction(() => {
      db.sqlite
        .prepare("INSERT INTO events_fts(events_fts) VALUES('rebuild')")
        .run();
      checkDatabase(db);
    })
    .immediate();
}
function requireUnused(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      lstatSync(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "Файл назначения или его sidecar уже существует; выберите новый путь",
    );
  }
}
// Publish only a checked, closed and checkpointed file. link is exclusive: no overwrite race.
async function createCopy(
  source: AppDatabase,
  destination: string,
  restore: boolean,
) {
  validateDatabasePath(destination);
  requireUnused(destination);
  assertCurrentSchema(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(destination), ".sqlite-copy-"));
  const stagedPath = join(stage, "copy.db");
  try {
    await source.sqlite.backup(stagedPath);
    const copy = openDatabase(stagedPath);
    let report;
    try {
      report = checkDatabase(copy);
      if (restore) {
        copy.sqlite
          .transaction(() => {
            copy.sqlite
              .prepare("UPDATE app_meta SET value=? WHERE key='history_id'")
              .run(randomUUID());
          })
          .immediate();
        report = checkDatabase(copy);
      }
      const checkpoint = copy.sqlite.pragma("wal_checkpoint(TRUNCATE)") as {
        busy: number;
      }[];
      if (checkpoint[0]?.busy !== 0)
        throw new Error("Не удалось checkpoint копии");
    } finally {
      copy.close();
    }
    requireUnused(destination);
    chmodSync(stagedPath, 0o600);
    linkSync(stagedPath, destination);
    return report;
  } finally {
    // This is a private directory created by this operation; input files are never removed.
    rmSync(stage, { recursive: true, force: true });
  }
}
export async function backupDatabase(source: AppDatabase, destination: string) {
  return createCopy(source, destination, false);
}
export async function restoreDatabase(sourcePath: string, destination: string) {
  validateDatabasePath(sourcePath);
  const source = openDatabase(sourcePath, { readonly: true });
  try {
    return await createCopy(source, destination, true);
  } finally {
    source.close();
  }
}
