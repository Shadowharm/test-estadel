import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

const positiveEnv = (fallback: string, max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

const envSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .default("3000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  DATABASE_PATH: z.string().min(1).optional(),
  SSE_MAX_CONNECTIONS: positiveEnv("32", 1000),
  SSE_POLL_MS: positiveEnv("500", 60_000),
  SSE_HEARTBEAT_MS: positiveEnv("15000", 60_000),
  SSE_BATCH_SIZE: positiveEnv("100", 1000),
  SSE_MAX_BACKLOG: positiveEnv("10000", 100_000),
});

// Resolve existing ancestors too: an external symlink must not hide a public path.
function physicalPath(path: string, depth = 0): string {
  if (depth > 64)
    throw new Error(
      "DATABASE_PATH: слишком глубокая цепочка каталогов или symlink",
    );
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      return physicalPath(
        resolve(dirname(path), readlinkSync(path)),
        depth + 1,
      );
    return realpathSync(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const parent = dirname(path);
    return parent === path
      ? path
      : join(physicalPath(parent, depth + 1), basename(path));
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export function validateDatabasePath(
  databasePath: string,
  projectRoot = process.cwd(),
): string {
  if (databasePath !== databasePath.trim())
    throw new Error("Путь БД не должен содержать пробелы по краям");
  if (
    !isAbsolute(databasePath) ||
    ![".db", ".sqlite", ".sqlite3"].includes(extname(databasePath))
  ) {
    throw new Error(
      "DATABASE_PATH: нужен абсолютный путь к файлу .db/.sqlite/.sqlite3",
    );
  }
  const actualPath = physicalPath(resolve(databasePath));
  if (
    ["public", ".next", "out"].some((dir) =>
      isWithin(physicalPath(resolve(projectRoot, dir)), actualPath),
    )
  ) {
    throw new Error(
      "DATABASE_PATH: база не может находиться в public, .next или out",
    );
  }
  return resolve(databasePath);
}

export function parseServerEnv(
  input: Record<string, string | undefined>,
  projectRoot = process.cwd(),
) {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Ошибка конфигурации: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const env = parsed.data;
  const errors: string[] = [];
  const databasePath =
    env.DATABASE_PATH ?? resolve(projectRoot, "data/events.db");
  try {
    validateDatabasePath(databasePath, projectRoot);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Некорректный путь БД",
    );
  }
  if (errors.length)
    throw new Error(`Ошибка конфигурации: ${errors.join("; ")}`);
  return Object.freeze({
    host: env.HOST,
    port: env.PORT,
    databasePath: resolve(databasePath),
    sse: {
      maxConnections: env.SSE_MAX_CONNECTIONS,
      pollMs: env.SSE_POLL_MS,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
      batchSize: env.SSE_BATCH_SIZE,
      maxBacklog: env.SSE_MAX_BACKLOG,
    },
  });
}

export type ServerEnv = ReturnType<typeof parseServerEnv>;
