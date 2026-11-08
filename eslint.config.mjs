import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    "docs/design/**",
  ]),
  {
    files: ["src/shared/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "better-sqlite3",
            "drizzle-orm",
            "better-auth",
            "server-only",
          ],
          patterns: [
            {
              group: [
                "@/server/**",
                "**/server/**",
                "node:*",
                "drizzle-orm/*",
                "better-auth/*",
                "@better-auth/*",
              ],
              message:
                "Серверный модуль нельзя импортировать в клиентский/shared слой.",
            },
          ],
        },
      ],
    },
  },
]);
