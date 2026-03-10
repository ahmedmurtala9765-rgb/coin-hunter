// @ts-nocheck
import { sqliteTable, text, integer, numeric } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// === SETTINGS / TOPICS ===
export const groupBindings = sqliteTable("group_bindings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: text("group_id").notNull(),
  topicId: text("topic_id"),
  lane: text("lane").notNull(), // high | med | low | cto
  market: text("market").notNull(), // crypto | forex
  purpose: text("purpose"),
  createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// === USERS ===
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // Telegram ID
  username: text("username"),
  firstName: text("first_name"),
  safetyProfile: text("safety_profile").default("balanced").notNull(),
  priorityFeeTier: text("priority_fee_tier").default("medium"),
  showTokenPreview: integer("show_token_preview", { mode: 'boolean' }).default(true).notNull(),
  unsafeOverride: integer("unsafe_override", { mode: 'boolean' }).default(false).notNull(),
  priceImpactLimit: integer("price_impact_limit").default(500), // 5% BPS
  liquidityMinimum: text("liquidity_minimum").default("1000"), // USD
  tpPercent: integer("tp_percent"),
  slPercent: integer("sl_percent"),
  minBuyAmount: text("min_buy_amount").default("0.01"),
  priorityFeeAmount: text("priority_fee_amount").default("0.0015"),
  mevProtection: integer("mev_protection", { mode: 'boolean' }).default(true).notNull(),
  maxRetries: integer("max_retries").default(3),
  rpcPreference: text("rpc_preference").default("auto"),
  customRpcUrl: text("custom_rpc_url"),
  duplicateProtection: integer("duplicate_protection", { mode: 'boolean' }).default(true).notNull(),
  isMainnet: integer("is_mainnet", { mode: 'boolean' }).default(true).notNull(),
  lastAirdrop: integer("last_airdrop", { mode: 'timestamp' }),
  lastActive: integer("last_active", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`),
  withdrawalAddress: text("withdrawal_address"),
  withdrawalAmount: text("withdrawal_amount"),
});

// User Lane settings
export const userLanes = sqliteTable("user_lanes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  lane: text("lane").notNull(), // unfiltered | low | med | high
  enabled: integer("enabled", { mode: 'boolean' }).default(false).notNull(),
});

// === USER SUBSCRIPTIONS ===
export const userSubscriptions = sqliteTable("user_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  groupId: text("group_id").notNull(),
  topicId: text("topic_id"),
  lane: text("lane").notNull(),
  enabled: integer("enabled", { mode: 'boolean' }).default(true).notNull(),
  createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// === WALLETS ===
export const commandUsage = sqliteTable("command_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  // date stored as YYYYMMDD integer (e.g. 20260227)
  date: integer("date").notNull(),
  count: integer("count").default(0).notNull(),
});

export const insertCommandUsageSchema = createInsertSchema(commandUsage); // no omissions necessary
export type CommandUsage = typeof commandUsage.$inferSelect;
export type InsertCommandUsage = z.infer<typeof insertCommandUsageSchema>;

export const wallets = sqliteTable("wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  label: text("label").notNull(),
  isMainnet: integer("is_mainnet", { mode: 'boolean' }).default(true).notNull(),
  isActive: integer("is_active", { mode: 'boolean' }).default(false).notNull(),
  balance: text("balance").default("0"),
  createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// === SIGNALS ===
export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(),
  bias: text("bias").notNull(),
  reasoning: text("reasoning").notNull(),
  timeframe: text("timeframe").default("1h"),
  status: text("status").default("active"),
  entryPrice: text("entry_price"),
  tp1: text("tp1"),
  tp2: text("tp2"),
  tp3: text("tp3"),
  sl: text("sl"),
  // PnL calculation fields
  capital: numeric("capital").default("50"), // Initial capital (10-100$)
  leverage: numeric("leverage").default("10"), // Leverage multiplier
  positionSize: numeric("position_size"), // Calculated as capital * leverage
  fees: numeric("fees").default("0.001"), // Transaction fees (0.1% per trade)
  lotSize: numeric("lot_size"), // For forex (number of lots)
  pipValue: numeric("pip_value"), // For forex calculations
  exitPrice: numeric("exit_price"), // Price when TP/SL hit
  pnlAmount: numeric("pnl_amount"), // Calculated PnL amount
  pnlPercent: numeric("pnl_percent"), // PnL percentage
  messageId: text("message_id"),
  chatId: text("chat_id"),
  topicId: text("topic_id"),
  lastUpdateAt: integer("last_update_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`),
  nextUpdateAt: integer("next_update_at", { mode: 'timestamp' }),
  data: text("data"), // Store JSON as text in SQLite
  createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// === TRADES ===
export const trades = sqliteTable("trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  walletId: integer("wallet_id").notNull(),
  mint: text("mint").notNull(),
  symbol: text("symbol"),
  amountIn: text("amount_in").notNull(),
  amountOut: text("amount_out"),
  entryPrice: text("entry_price"),
  status: text("status").default("pending"),
  txHash: text("tx_hash"),
  error: text("error"),
  tp1: text("tp1"),
  sl: text("sl"),
  createdAt: integer("created_at", { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertUserSchema = createInsertSchema(users);
export const insertWalletSchema = createInsertSchema(wallets).omit({ id: true, createdAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true, createdAt: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true, createdAt: true });
export const insertUserLaneSchema = createInsertSchema(userLanes).omit({ id: true });
export const insertGroupBindingSchema = createInsertSchema(groupBindings).omit({ id: true, createdAt: true });
export const insertUserSubscriptionSchema = createInsertSchema(userSubscriptions).omit({ id: true, createdAt: true });

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type UserLane = typeof userLanes.$inferSelect;
export type GroupBinding = typeof groupBindings.$inferSelect;
export type UserSubscription = typeof userSubscriptions.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type InsertUserLane = z.infer<typeof insertUserLaneSchema>;
export type InsertGroupBinding = z.infer<typeof insertGroupBindingSchema>;
export type InsertUserSubscription = z.infer<typeof insertUserSubscriptionSchema>;
