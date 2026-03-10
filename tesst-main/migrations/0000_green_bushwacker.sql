CREATE TABLE `command_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`date` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`topic_id` text,
	`lane` text NOT NULL,
	`market` text NOT NULL,
	`purpose` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`type` text NOT NULL,
	`bias` text NOT NULL,
	`reasoning` text NOT NULL,
	`timeframe` text DEFAULT '1h',
	`status` text DEFAULT 'active',
	`entry_price` text,
	`tp1` text,
	`tp2` text,
	`tp3` text,
	`sl` text,
	`capital` numeric DEFAULT '50',
	`leverage` numeric DEFAULT '10',
	`position_size` numeric,
	`fees` numeric DEFAULT '0.001',
	`lot_size` numeric,
	`pip_value` numeric,
	`exit_price` numeric,
	`pnl_amount` numeric,
	`pnl_percent` numeric,
	`message_id` text,
	`chat_id` text,
	`topic_id` text,
	`last_update_at` integer DEFAULT CURRENT_TIMESTAMP,
	`next_update_at` integer,
	`data` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`wallet_id` integer NOT NULL,
	`mint` text NOT NULL,
	`symbol` text,
	`amount_in` text NOT NULL,
	`amount_out` text,
	`entry_price` text,
	`status` text DEFAULT 'pending',
	`tx_hash` text,
	`error` text,
	`tp1` text,
	`sl` text,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_lanes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`lane` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`group_id` text NOT NULL,
	`topic_id` text,
	`lane` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`first_name` text,
	`safety_profile` text DEFAULT 'balanced' NOT NULL,
	`priority_fee_tier` text DEFAULT 'medium',
	`show_token_preview` integer DEFAULT true NOT NULL,
	`unsafe_override` integer DEFAULT false NOT NULL,
	`price_impact_limit` integer DEFAULT 500,
	`liquidity_minimum` text DEFAULT '1000',
	`tp_percent` integer,
	`sl_percent` integer,
	`min_buy_amount` text DEFAULT '0.01',
	`priority_fee_amount` text DEFAULT '0.0015',
	`mev_protection` integer DEFAULT true NOT NULL,
	`max_retries` integer DEFAULT 3,
	`rpc_preference` text DEFAULT 'auto',
	`custom_rpc_url` text,
	`duplicate_protection` integer DEFAULT true NOT NULL,
	`is_mainnet` integer DEFAULT true NOT NULL,
	`last_airdrop` integer,
	`last_active` integer DEFAULT CURRENT_TIMESTAMP,
	`withdrawal_address` text,
	`withdrawal_amount` text
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`label` text NOT NULL,
	`is_mainnet` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`balance` text DEFAULT '0',
	`created_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
