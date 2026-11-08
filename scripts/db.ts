import "./check-runtime.mjs";
import nextEnv from "@next/env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDatabasePath } from "../src/server/config/schema.ts";
import { openDatabase } from "../src/server/db/connection.ts";
import {
  migrateDatabase,
  assertCurrentSchema,
} from "../src/server/db/migrations.ts";
import {
  backupDatabase,
  checkDatabase,
  rebuildSearch,
  restoreDatabase,
} from "../src/server/db/maintenance.ts";
import { seedBenchmark, seedDemo } from "../src/server/db/fixtures.ts";

import { queryPlanReport } from "./storage-query-plans.ts";

nextEnv.loadEnvConfig(process.cwd());
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "benchmark") {
    if (args.length > 1 || (args[0] !== undefined && !/^\d+$/.test(args[0])))
      throw new Error("benchmark [count]");
    const count = Number(args[0] ?? 100000);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000000)
      throw new Error("Count должен быть 1–1000000");
    const path = join(
      mkdtempSync(join(tmpdir(), "integration-monitor-benchmark-")),
      "events.db",
    );
    const db = openDatabase(path, { create: true });
    try {
      migrateDatabase(db);
      const started = performance.now();
      seedBenchmark(db, count);
      console.log(
        JSON.stringify({
          path,
          duration_ms: Math.round(performance.now() - started),
          ...checkDatabase(db),
          query_plans: queryPlanReport(db),
        }),
      );
    } finally {
      db.close();
    }
  } else if (command === "restore") {
    if (args.length !== 2)
      throw new Error("restore <backup.db> <new-restored.db>");
    console.log(JSON.stringify(await restoreDatabase(args[0]!, args[1]!)));
  } else {
    if (
      !["migrate", "seed", "check", "rebuild-fts", "backup"].includes(
        command ?? "",
      ) ||
      args.length !== (command === "backup" ? 1 : 0)
    )
      throw new Error(
        "Команды: migrate | seed | check | rebuild-fts | backup <new.db> | restore <backup.db> <new.db> | benchmark [count]",
      );
    const path = validateDatabasePath(
      process.env.DATABASE_PATH ?? join(process.cwd(), "data/events.db"),
    );
    const db = openDatabase(path, { create: command === "migrate" });
    try {
      if (command === "migrate") migrateDatabase(db);
      else assertCurrentSchema(db);
      if (command === "seed") console.log(JSON.stringify(seedDemo(db)));
      if (command === "rebuild-fts") rebuildSearch(db);
      if (command === "backup")
        console.log(JSON.stringify(await backupDatabase(db, args[0]!)));
      else console.log(JSON.stringify(checkDatabase(db)));
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ошибка операции БД");
  process.exitCode = 1;
}
