import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseServerEnv } from "../../src/server/config/schema";

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("server configuration", () => {
  it("starts without profiles or credentials", () => {
    expect(parseServerEnv({}, "/tmp/monitor-config-test")).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databasePath: "/tmp/monitor-config-test/data/events.db",
      sse: {
        maxConnections: 32,
        pollMs: 500,
        heartbeatMs: 15000,
        batchSize: 100,
        maxBacklog: 10000,
      },
    });
    expect(parseServerEnv({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(parseServerEnv({ HOST: "::1" }).host).toBe("::1");
  });
  it.each([
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "1.2" },
    { PORT: "3000abc" },
    { SSE_MAX_CONNECTIONS: "0" },
    { SSE_POLL_MS: "-1" },
    { SSE_HEARTBEAT_MS: "NaN" },
    { SSE_BATCH_SIZE: "1001" },
    { SSE_MAX_BACKLOG: "100001" },
    { DATABASE_PATH: "data/events.db" },
    { DATABASE_PATH: "/tmp/events.txt" },
  ])("rejects invalid settings %j", (override) => {
    expect(() => parseServerEnv({ ...override })).toThrow(
      "Ошибка конфигурации",
    );
  });
  it.each(["public", ".next/static", "out"])("rejects DB under %s", (dir) => {
    expect(() =>
      parseServerEnv({
        DATABASE_PATH: join(process.cwd(), dir, "events.db"),
      }),
    ).toThrow("база не может");
  });
  it("rejects hidden subdirectories whose name starts with two dots", () => {
    expect(() =>
      parseServerEnv({
        DATABASE_PATH: join(process.cwd(), "public", "..private", "events.db"),
      }),
    ).toThrow("база не может");
  });
  it("rejects external symlink pointing into public", () => {
    const root = mkdtempSync(join(tmpdir(), "monitor-config-"));
    temporaryDirs.push(root);
    mkdirSync(join(root, "public"));
    symlinkSync(join(root, "public"), join(root, "alias"));
    expect(() =>
      parseServerEnv(
        { DATABASE_PATH: join(root, "alias", "nested", "events.db") },
        root,
      ),
    ).toThrow("база не может");
  });
  it("rejects dangling symlink into a future public directory", () => {
    const root = mkdtempSync(join(tmpdir(), "monitor-config-"));
    temporaryDirs.push(root);
    mkdirSync(join(root, "public"));
    symlinkSync(join(root, "public", "future"), join(root, "alias"));
    expect(() =>
      parseServerEnv({ DATABASE_PATH: join(root, "alias", "events.db") }, root),
    ).toThrow("база не может");
  });
  it("rejects invalid startup before starting Next, with a nonzero exit", () => {
    const result = spawnSync(process.execPath, ["scripts/serve.ts", "dev"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PORT: "invalid",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PORT");
    expect(result.stdout).not.toContain("Ready");
  });
});
