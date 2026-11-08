import "./check-runtime.mjs";
import { parseServerEnv } from "../src/server/config/schema.ts";

try {
  const config = parseServerEnv(process.env);
  process.env.HOSTNAME = config.host;
  process.env.PORT = String(config.port);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ошибка конфигурации");
  process.exit(1);
}
// The generated standalone server is loaded only after validation, before binding.
await import(new URL("../server.js", import.meta.url).href);
