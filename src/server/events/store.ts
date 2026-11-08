import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/connection.ts";
import { events } from "../db/schema.ts";
import { normalizeEvent } from "./normalize.ts";

export class EventConflictError extends Error {
  constructor() {
    super("EVENT_ID_CONFLICT");
  }
}
export function findEvent(db: AppDatabase, id: string) {
  return db.orm.select().from(events).where(eq(events.id, id)).get();
}
// Owns a short synchronous transaction; no HTTP/SSE work occurs inside it.
export function insertEvent(
  db: AppDatabase,
  input: unknown,
  receivedAtMs = Date.now(),
) {
  const { row } = normalizeEvent(input);
  if (!Number.isSafeInteger(receivedAtMs))
    throw new Error("Некорректное время приёма");
  return db.sqlite
    .transaction(() => {
      const existing = findEvent(db, row.id);
      if (existing) {
        if (existing.canonicalHash !== row.canonicalHash)
          throw new EventConflictError();
        return { inserted: false, event: existing };
      }
      const event = db.orm
        .insert(events)
        .values({ ...row, receivedAtMs })
        .returning()
        .get();
      return { inserted: true, event };
    })
    .immediate();
}
