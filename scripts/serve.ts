import "./check-runtime.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import nextEnv from "@next/env";
import { parseServerEnv } from "../src/server/config/schema.ts";

const command = process.argv[2];
if (command !== "dev" && command !== "start")
  throw new Error("Допустимые команды: dev, start");
nextEnv.loadEnvConfig(process.cwd(), command === "dev");
let config;
try {
  config = parseServerEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ошибка конфигурации");
  process.exit(1);
}
const require = createRequire(import.meta.url);
const args =
  command === "dev"
    ? [
        require.resolve("next/dist/bin/next"),
        "dev",
        "--webpack",
        "--hostname",
        config.host,
        "--port",
        String(config.port),
      ]
    : [".next/standalone/server.js"];
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: config.host,
    PORT: String(config.port),
    DATABASE_PATH: config.databasePath,
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Не удалось запустить Next.js");
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === "SIGINT" ? 130 : 143));
});
