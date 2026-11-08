import "./check-runtime.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openDatabase } from "../src/server/db/connection.ts";
import { migrateDatabase } from "../src/server/db/migrations.ts";
import { seedEvents, smallFixtures } from "../src/server/db/fixtures.ts";

// Every browser run owns a fresh directory; never inherit a working DATABASE_PATH.
const directory = mkdtempSync(join(tmpdir(), "monitor-e2e-"));
const databasePath = join(directory, "events.db");
try {
  const db = openDatabase(databasePath, { create: true });
  try {
    migrateDatabase(db);
    seedEvents(db, smallFixtures(), Date.now());
  } finally {
    db.close();
  }
  const child = spawn(
    process.execPath,
    ["scripts/serve.ts", process.env.E2E_DEV === "true" ? "dev" : "start"],
    { stdio: "inherit", env: { ...process.env, DATABASE_PATH: databasePath } },
  );
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      child.kill(signal);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    });
  const cleanup = () => {
    clearTimeout(killTimer);
    rmSync(directory, { recursive: true, force: true });
  };
  child.on("error", () => {
    cleanup();
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(code ?? (signal === "SIGINT" ? 130 : 143));
  });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
