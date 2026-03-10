// @ts-nocheck
// @ts-nocheck
import { users, wallets, signals, trades, userLanes, groupBindings, userSubscriptions, commandUsage } from "../shared/schema";
import type { 
  User, InsertUser, 
  Wallet, InsertWallet, 
  Signal, InsertSignal, 
  Trade, InsertTrade, 
  UserLane, InsertUserLane,
  GroupBinding, InsertGroupBinding
  , InsertUserSubscription, UserSubscription
} from "../shared/schema";
import { db } from "./db";
import { eq, desc, and, or } from "drizzle-orm";
import crypto from "crypto";
import { backupToSupabase } from './restore';
// @ts-nocheck
import { log } from "./index";

const MASTER_KEY = process.env.SESSION_SECRET;
if (!MASTER_KEY) {
  console.error("[security] CRITICAL: SESSION_SECRET is not set. Wallet encryption will fail.");
}
const ALGORITHM = "aes-256-cbc";

function encrypt(text: string): string {
  if (!MASTER_KEY) throw new Error("Encryption failed: SESSION_SECRET missing");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text: string): string {
  if (!MASTER_KEY) return text;
  try {
    const textParts = text.split(":");
    if (textParts.length < 2) return text;
    const iv = Buffer.from(textParts.shift()!, "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return text;
  }
}

// In-memory storage for signals to reduce SQLite load
let memorySignals: Signal[] = [];
const MAX_MEMORY_SIGNALS = 100;

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User>;
  getUserLanes(userId: string): Promise<UserLane[]>;
  upsertUserLane(lane: InsertUserLane): Promise<UserLane>;
  getGroupBinding(groupId: string, topicId?: string): Promise<GroupBinding | undefined>;
  getGroupBindings(groupId: string): Promise<GroupBinding[]>;
  upsertGroupBinding(binding: InsertGroupBinding): Promise<GroupBinding>;
  getUserSubscriptions(userId: string): Promise<UserSubscription[]>;
  upsertUserSubscription(sub: InsertUserSubscription): Promise<UserSubscription>;
  deleteUserSubscription(userId: string, groupId: string, topicId?: string, lane?: string): Promise<void>;
  getSubscribersForBinding(groupId: string, topicId: string | undefined, lane: string): Promise<User[]>;
  getWallets(userId: string): Promise<Wallet[]>;
  getWallet(id: number): Promise<Wallet | undefined>;
  updateWalletBalance(id: number, balance: string): Promise<Wallet>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  deleteWallet(id: number): Promise<void>;
  setActiveWallet(userId: string, walletId: number): Promise<void>;
  getActiveWallet(userId: string): Promise<Wallet | undefined>;
  getSignals(): Promise<Signal[]>;
  getSignal(id: number): Promise<Signal | undefined>;
  createSignal(signal: any): Promise<Signal>;
  updateSignal(id: number, data: Partial<Signal>): Promise<void>;
  getTrades(userId: string): Promise<Trade[]>;
  createTrade(insertTrade: InsertTrade): Promise<Trade>;
  updateTrade(id: number, data: Partial<Trade>): Promise<Trade>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(insertUser: any): Promise<User> {
    const { lastActive, ...dataToInsert } = insertUser;
    const [user] = await db.insert(users).values(dataToInsert).onConflictDoUpdate({
      target: users.id,
      set: { ...dataToInsert, lastActive: new Date() }
    }).returning();
    backupToSupabase().catch((err: any) => log(`Async backup failed: ${err.message}`, "backup"));
    return user as User;
  }

  async updateUser(id: string, data: Partial<User>): Promise<User> {
    const updateData = { ...data } as any;
    delete updateData.lastActive;
    const [user] = await db.update(users).set({ ...updateData, lastActive: new Date() }).where(eq(users.id, id)).returning();
    if (!user) return this.upsertUser({ id, ...data });
    return user as User;
  }

  // track daily command usage (3 per day for non-premium)
  // Date is stored as UTC day number (days since epoch) so it resets at 00:00 UTC.
  private getUtcDayKey(): number {
    return Math.floor(Date.now() / 86400000);
  }

  async getCommandCountToday(userId: string): Promise<number> {
    const today = this.getUtcDayKey();
    const [rec] = await db.select().from(commandUsage).where(
      and(eq(commandUsage.userId, userId), eq(commandUsage.date, today))
    );
    return rec ? (rec.count as number) : 0;
  }

  async recordCommandUse(userId: string): Promise<number> {
    const today = this.getUtcDayKey();
    const [rec] = await db.select().from(commandUsage).where(
      and(eq(commandUsage.userId, userId), eq(commandUsage.date, today))
    );
    if (rec) {
      const newCount = (rec.count as number) + 1;
      await db.update(commandUsage).set({ count: newCount }).where(eq(commandUsage.id, rec.id));
      return newCount;
    } else {
      const [created] = await db.insert(commandUsage).values({ userId, date: today, count: 1 }).returning();
      return 1;
    }
  }

  async getUserLanes(userId: string): Promise<UserLane[]> {
    return db.select().from(userLanes).where(eq(userLanes.userId, userId)) as any;
  }

  async upsertUserLane(insertLane: InsertUserLane): Promise<UserLane> {
    try {
      // @ts-ignore - Type inference issue with Drizzle ORM
      const laneData = { userId: insertLane.userId, lane: insertLane.lane, enabled: insertLane.enabled } as any;
      const [lane] = await db.insert(userLanes).values(laneData).onConflictDoUpdate({
        target: [userLanes.userId, userLanes.lane],
        set: laneData
      }).returning();
      return lane as UserLane;
    } catch (error: any) {
      // @ts-ignore - Type inference issue with Drizzle ORM
      const [existing] = await db.select().from(userLanes).where(
        and(eq(userLanes.userId, (insertLane as any).userId), eq(userLanes.lane, (insertLane as any).lane))
      );
      if (existing) {
        // @ts-ignore - Drizzle ORM type issue with set()
        const [updated] = await db.update(userLanes).set({ enabled: (insertLane as any).enabled }).where(eq(userLanes.id, existing.id)).returning();
        return updated as UserLane;
      }
      const laneData = { userId: (insertLane as any).userId, lane: (insertLane as any).lane, enabled: (insertLane as any).enabled } as any;
      const [created] = await db.insert(userLanes).values(laneData).returning();
      return created as UserLane;
    }
  }

  async getGroupBinding(groupId: string, topicId?: string): Promise<GroupBinding | undefined> {
    const conditions = [eq(groupBindings.groupId, groupId)];
    if (topicId) conditions.push(eq(groupBindings.topicId, topicId));
    const [binding] = await db.select().from(groupBindings).where(and(...conditions));
    return binding as GroupBinding | undefined;
  }

  async getGroupBindings(groupId: string): Promise<GroupBinding[]> {
    return db.select().from(groupBindings).where(eq(groupBindings.groupId, groupId)) as any;
  }

  async getUserSubscriptions(userId: string): Promise<UserSubscription[]> {
    return db.select().from(userSubscriptions).where(eq(userSubscriptions.userId, userId)) as any;
  }

  async upsertUserSubscription(sub: InsertUserSubscription): Promise<UserSubscription> {
    // @ts-ignore - Type inference issue with Drizzle ORM
    const conditions: any[] = [eq(userSubscriptions.userId, sub.userId), eq(userSubscriptions.groupId, sub.groupId), eq(userSubscriptions.lane, sub.lane)];
    // @ts-ignore - subtype may lack topicId
    if ((sub as any).topicId) conditions.push(eq(userSubscriptions.topicId, (sub as any).topicId));
    const [existing] = await db.select().from(userSubscriptions).where(and(...conditions));
    if (existing) {
      // @ts-ignore - Drizzle ORM type issue with set()
      const [updated] = await db.update(userSubscriptions).set({ enabled: sub.enabled }).where(eq(userSubscriptions.id, existing.id)).returning();
      return updated as UserSubscription;
    }
    // @ts-ignore - Drizzle typing issue with generated insert type
    const [created] = await db.insert(userSubscriptions).values(sub as any).returning();
    return created as UserSubscription;
  }

  async deleteUserSubscription(userId: string, groupId: string, topicId?: string, lane?: string): Promise<void> {
    const conditions: any[] = [eq(userSubscriptions.userId, userId), eq(userSubscriptions.groupId, groupId)];
    if (topicId) conditions.push(eq(userSubscriptions.topicId, topicId));
    if (lane) conditions.push(eq(userSubscriptions.lane, lane));
    await db.delete(userSubscriptions).where(and(...conditions));
  }

  async getSubscribersForBinding(groupId: string, topicId: string | undefined, lane: string): Promise<User[]> {
    const conditions: any[] = [eq(userSubscriptions.groupId, groupId), eq(userSubscriptions.lane, lane), eq(userSubscriptions.enabled, true)];
    if (topicId) conditions.push(eq(userSubscriptions.topicId, topicId));
    const results = await db.select().from(userSubscriptions).innerJoin(users, eq(userSubscriptions.userId, users.id)).where(and(...conditions));
    return results.map((r: any) => r.users) as any;
  }

  async upsertGroupBinding(insertBinding: InsertGroupBinding): Promise<GroupBinding> {
    // @ts-ignore - insertBinding typing
    const conditions = [eq(groupBindings.groupId, (insertBinding as any).groupId)];
    // @ts-ignore - insertBinding typing
    if ((insertBinding as any).topicId) conditions.push(eq(groupBindings.topicId, (insertBinding as any).topicId));
    const [existing] = await db.select().from(groupBindings).where(and(...conditions));
    if (existing) {
      const [updated] = await db.update(groupBindings).set({ lane: insertBinding.lane }).where(eq(groupBindings.id, existing.id)).returning();
      return updated as GroupBinding;
    }
    // @ts-ignore - Drizzle typing issue for insertBinding
    const [created] = await db.insert(groupBindings).values(insertBinding as any).returning();
    return created as GroupBinding;
  }

  async getWallets(userId: string): Promise<Wallet[]> {
    const results = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.isActive), desc(wallets.createdAt));
    return results.map((w: any) => ({ ...w, privateKey: decrypt(w.privateKey) })) as any;
  }

  async setActiveWallet(userId: string, walletId: number): Promise<void> {
    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
    if (!wallet) throw new Error("Wallet not found");
    await db.update(wallets).set({ isActive: false }).where(eq(wallets.userId, userId));
    await db.update(wallets).set({ isActive: true }).where(eq(wallets.id, walletId));
  }

  async getActiveWallet(userId: string): Promise<Wallet | undefined> {
    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.userId, userId), eq(wallets.isActive, true)));
    if (wallet) return { ...wallet, privateKey: decrypt(wallet.privateKey) } as Wallet;
    const [firstWallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.createdAt)).limit(1);
    if (firstWallet) return { ...firstWallet, privateKey: decrypt(firstWallet.privateKey) } as Wallet;
    return undefined;
  }

  async getWallet(id: number): Promise<Wallet | undefined> {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, id));
    if (wallet) return { ...wallet, privateKey: decrypt(wallet.privateKey) } as Wallet;
    return undefined;
  }

  async updateWalletBalance(id: number, balance: string): Promise<Wallet> {
    const [wallet] = await db.update(wallets).set({ balance }).where(eq(wallets.id, id)).returning();
    if (!wallet) throw new Error("Wallet not found");
    return { ...wallet, privateKey: decrypt(wallet.privateKey) } as Wallet;
  }

  async createWallet(insertWallet: InsertWallet): Promise<Wallet> {
    const [wallet] = await db.insert(wallets).values({ ...insertWallet, privateKey: encrypt(insertWallet.privateKey) }).returning();
    backupToSupabase().catch((err: any) => log(`Async backup failed: ${err.message}`, "backup"));
    return { ...wallet, privateKey: decrypt(wallet.privateKey) } as Wallet;
  }

  async deleteWallet(id: number): Promise<void> {
    await db.delete(wallets).where(eq(wallets.id, id));
  }

  async getSignals(): Promise<Signal[]> {
    return [...memorySignals].sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }

  async getSignal(id: number): Promise<Signal | undefined> {
    return memorySignals.find(s => s.id === id);
  }

  async createSignal(insertSignal: any): Promise<Signal> {
    const newSignal: Signal = {
      ...insertSignal,
      id: Date.now(),
      createdAt: new Date(),
      lastUpdateAt: new Date(),
      data: insertSignal.data || {}
    };
    memorySignals.push(newSignal);
    if (memorySignals.length > MAX_MEMORY_SIGNALS) memorySignals.shift();
    return newSignal;
  }

  async updateSignal(id: number, data: Partial<Signal>): Promise<void> {
    const idx = memorySignals.findIndex(s => s.id === id);
    if (idx !== -1) {
      memorySignals[idx] = { ...memorySignals[idx], ...data, lastUpdateAt: new Date() };
    }
  }

  async getTrades(userId: string): Promise<Trade[]> {
    return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.createdAt)) as any;
  }

  async createTrade(insertTrade: InsertTrade): Promise<Trade> {
    const [trade] = await db.insert(trades).values(insertTrade).returning();
    return trade as Trade;
  }

  async updateTrade(id: number, data: Partial<Trade>): Promise<Trade> {
    const [trade] = await db.update(trades).set(data).where(eq(trades.id, id)).returning();
    if (!trade) throw new Error("Trade not found");
    return trade as Trade;
  }
}

export const storage = new DatabaseStorage();
