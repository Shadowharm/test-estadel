CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`received_at_ms` integer NOT NULL,
	`message` text NOT NULL,
	`error_code` text,
	`payload_json` text,
	`canonical_hash` text NOT NULL,
	`source_sort` text NOT NULL,
	`type_sort` text NOT NULL,
	CONSTRAINT "events_seq_safe" CHECK("events"."seq" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "events_id_length" CHECK(length("events"."id") BETWEEN 1 AND 100 AND instr("events"."id", char(0)) = 0),
	CONSTRAINT "events_source_length" CHECK(length("events"."source") BETWEEN 1 AND 100 AND instr("events"."source", char(0)) = 0),
	CONSTRAINT "events_type_length" CHECK(length("events"."type") BETWEEN 1 AND 150 AND instr("events"."type", char(0)) = 0),
	CONSTRAINT "events_message_length" CHECK(length("events"."message") BETWEEN 1 AND 2000 AND instr("events"."message", char(0)) = 0),
	CONSTRAINT "events_status" CHECK("events"."status" IN ('success', 'error')),
	CONSTRAINT "events_created_time" CHECK("events"."created_at_ms" BETWEEN -62135596800000 AND 253402300799999),
	CONSTRAINT "events_received_time" CHECK("events"."received_at_ms" BETWEEN -62135596800000 AND 253402300799999),
	CONSTRAINT "events_error_code" CHECK("events"."error_code" IS NULL OR ("events"."status" = 'error' AND length("events"."error_code") BETWEEN 1 AND 100 AND instr("events"."error_code", char(0)) = 0)),
	CONSTRAINT "events_payload" CHECK("events"."payload_json" IS NULL OR (json_valid("events"."payload_json") AND json_type("events"."payload_json") = 'object' AND length(CAST("events"."payload_json" AS BLOB)) <= 16384)),
	CONSTRAINT "events_hash" CHECK(length("events"."canonical_hash") = 64 AND "events"."canonical_hash" NOT GLOB '*[^0-9a-f]*')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_created_seq` ON `events` (`created_at_ms`,`seq`);--> statement-breakpoint
CREATE INDEX `events_source_seq` ON `events` (`source_sort`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_seq` ON `events` (`type_sort`,`seq`);--> statement-breakpoint
CREATE INDEX `events_status_seq` ON `events` (`status`,`seq`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
--> statement-breakpoint
CREATE VIRTUAL TABLE events_fts USING fts5(id, source, type, message, content='events', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
 INSERT INTO events_fts(rowid,id,source,type,message) VALUES(new.seq,new.id,new.source,new.type,new.message);
END;
--> statement-breakpoint
CREATE TRIGGER events_au BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER events_ad BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
--> statement-breakpoint
-- REPLACE normally bypasses delete triggers unless recursive_triggers is ON.
-- Reject replacement before it can delete an immutable row, independently of PRAGMA.
CREATE TRIGGER events_bi BEFORE INSERT ON events
WHEN EXISTS(SELECT 1 FROM events WHERE id=new.id OR seq=new.seq)
BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
