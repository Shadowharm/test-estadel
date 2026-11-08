DROP TABLE `account`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
DROP TABLE `verification`;
--> statement-breakpoint
DELETE FROM app_meta WHERE key = 'demo_token_secret';
