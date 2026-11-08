import Database from "better-sqlite3";
import type { AppDatabase } from "../db/connection.ts";

export class InvalidSearchError extends Error {
  constructor() {
    super("INVALID_SEARCH: нужны 1–10 токенов, не более 200 символов");
  }
}
// Tokenize with the same SQLite Unicode61 engine as the persistent index.
export function compileSearch(query: string): string {
  if (!query.isWellFormed() || [...query].length > 200 || /\p{Cc}/u.test(query))
    throw new InvalidSearchError();
  const tokenizer = new Database(":memory:");
  try {
    tokenizer.exec(
      "CREATE VIRTUAL TABLE tokens USING fts5(value, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE vocab USING fts5vocab(tokens, 'instance')",
    );
    tokenizer
      .prepare("INSERT INTO tokens(value) VALUES(?)")
      .run(query.normalize("NFC"));
    const instances = tokenizer
      .prepare("SELECT term FROM vocab ORDER BY offset")
      .all() as { term: string }[];
    if (instances.length === 0 || instances.length > 10)
      throw new InvalidSearchError();
    return [...new Set(instances.map(({ term }) => term))]
      .sort()
      .map((term) => `"${term.replaceAll('"', '""')}"*`)
      .join(" AND ");
  } finally {
    tokenizer.close();
  }
}
export function searchEvents(db: AppDatabase, query: string, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Limit должен быть 1–100");
  return db.sqlite
    .prepare(
      "SELECT e.* FROM events e JOIN events_fts f ON f.rowid=e.seq WHERE events_fts MATCH ? ORDER BY e.seq DESC LIMIT ?",
    )
    .all(compileSearch(query), limit);
}
