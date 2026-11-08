import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    status: text("status", { enum: ["success", "error"] }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
    message: text("message").notNull(),
    errorCode: text("error_code"),
    payloadJson: text("payload_json"),
    canonicalHash: text("canonical_hash").notNull(),
    sourceSort: text("source_sort").notNull(),
    typeSort: text("type_sort").notNull(),
  },
  (t) => [
    check("events_seq_safe", sql`${t.seq} BETWEEN 1 AND 9007199254740991`),
    check(
      "events_id_length",
      sql`length(${t.id}) BETWEEN 1 AND 100 AND instr(${t.id}, char(0)) = 0`,
    ),
    check(
      "events_source_length",
      sql`length(${t.source}) BETWEEN 1 AND 100 AND instr(${t.source}, char(0)) = 0`,
    ),
    check(
      "events_type_length",
      sql`length(${t.type}) BETWEEN 1 AND 150 AND instr(${t.type}, char(0)) = 0`,
    ),
    check(
      "events_message_length",
      sql`length(${t.message}) BETWEEN 1 AND 2000 AND instr(${t.message}, char(0)) = 0`,
    ),
    check("events_status", sql`${t.status} IN ('success', 'error')`),
    check(
      "events_created_time",
      sql`${t.createdAtMs} BETWEEN -62135596800000 AND 253402300799999`,
    ),
    check(
      "events_received_time",
      sql`${t.receivedAtMs} BETWEEN -62135596800000 AND 253402300799999`,
    ),
    check(
      "events_error_code",
      sql`${t.errorCode} IS NULL OR (${t.status} = 'error' AND length(${t.errorCode}) BETWEEN 1 AND 100 AND instr(${t.errorCode}, char(0)) = 0)`,
    ),
    check(
      "events_payload",
      sql`${t.payloadJson} IS NULL OR (json_valid(${t.payloadJson}) AND json_type(${t.payloadJson}) = 'object' AND length(CAST(${t.payloadJson} AS BLOB)) <= 16384)`,
    ),
    check(
      "events_hash",
      sql`length(${t.canonicalHash}) = 64 AND ${t.canonicalHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    index("events_created_seq").on(t.createdAtMs, t.seq),
    index("events_source_created_seq").on(t.source, t.createdAtMs, t.seq),
    index("events_type_created_seq").on(t.type, t.createdAtMs, t.seq),
    index("events_source_seq").on(t.sourceSort, t.seq),
    index("events_type_seq").on(t.typeSort, t.seq),
    index("events_status_seq").on(t.status, t.seq),
  ],
);
