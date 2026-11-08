import { cpSync, existsSync } from "node:fs";

// Next standalone intentionally omits static/public assets. Ship the same output locally and in Docker.
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
if (existsSync("public"))
  cpSync("public", ".next/standalone/public", { recursive: true });

// Maintenance commands use Node 24 native TypeScript, including in the production image.
// These aren't page imports, so Next's page tracer cannot discover them.
for (const path of [
  "drizzle",
  "scripts/db.ts",
  "scripts/demo.ts",
  "scripts/storage-query-plans.ts",
  "scripts/check-runtime.mjs",
  "scripts/render-start.sh",
  "src/server/db",
  "src/server/events",
  "src/server/config/schema.ts",
]) {
  cpSync(path, `.next/standalone/${path}`, { recursive: true });
}

for (const dependency of [
  "better-sqlite3",
  "drizzle-orm",
  "@next/env",
  "zod",
]) {
  cpSync(
    `node_modules/${dependency}`,
    `.next/standalone/node_modules/${dependency}`,
    { recursive: true },
  );
}
