CREATE TABLE `tier_product_prices` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))) NOT NULL,
	`tier_id` text NOT NULL,
	`product_id` text NOT NULL,
	`custom_price_amount` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()*1000) NOT NULL,
	FOREIGN KEY (`tier_id`) REFERENCES `user_tiers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tier_product_unique` ON `tier_product_prices` (`tier_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `user_tiers` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))) NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`discount_percent` integer DEFAULT 0 NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()*1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()*1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tiers_code_unique` ON `user_tiers` (`code`);--> statement-breakpoint
ALTER TABLE `users` ADD `tier_id` text REFERENCES user_tiers(id);