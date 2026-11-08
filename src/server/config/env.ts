import "server-only";
import { parseServerEnv, type ServerEnv } from "./schema";

let config: ServerEnv | undefined;

// No DB, filesystem mutation or environment validation during module evaluation/build.
export function getServerEnv(): ServerEnv {
  return (config ??= parseServerEnv(process.env));
}
