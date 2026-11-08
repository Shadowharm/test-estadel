import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("loads native SQLite on Node 24 with the required engine and Unicode FTS5", () => {
  const db = new Database(":memory:");
  try {
    expect(Number(process.versions.node.split(".")[0])).toBe(24);
    const { version } = db
      .prepare("SELECT sqlite_version() AS version")
      .get() as { version: string };
    expect(
      version.localeCompare("3.51.3", undefined, { numeric: true }),
    ).toBeGreaterThanOrEqual(0);
    db.exec(
      "CREATE VIRTUAL TABLE smoke USING fts5(message, tokenize='unicode61 remove_diacritics 2')",
    );
    db.prepare("INSERT INTO smoke(message) VALUES (?)").run(
      "Ошибка передачи заявки",
    );
    expect(
      db
        .prepare("SELECT count(*) AS count FROM smoke WHERE smoke MATCH ?")
        .get("ошиб* перед* "),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
