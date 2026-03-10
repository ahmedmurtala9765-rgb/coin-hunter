// @ts-nocheck
// @ts-nocheck
import { users, wallets, trades, userLanes, groupBindings, userSubscriptions, commandUsage } from "../shared/schema";
import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";
import crypto from "crypto";
import { backupToSupabase } from './restore';
// @ts-nocheck
import { log } from "./index";
const MASTER_KEY = process.env.SESSION_SECRET;
if (!MASTER_KEY) {
    console.error("[security] CRITICAL: SESSION_SECRET is not set. Wallet encryption will fail.");
}
const ALGORITHM = "aes-256-cbc";
function encrypt(text) {
    if (!MASTER_KEY)
        throw new Error("Encryption failed: SESSION_SECRET missing");
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
}
function decrypt(text) {
    if (!MASTER_KEY)
        return text;
    try {
        const textParts = text.split(":");
        if (textParts.length < 2)
            return text;
        const iv = Buffer.from(textParts.shift(), "hex");
        const encryptedText = Buffer.from(textParts.join(":"), "hex");
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }
    catch (e) {
        return text;
    }
}
// In-memory storage for signals to reduce SQLite load
let memorySignals = [];
const MAX_MEMORY_SIGNALS = 100;
export class DatabaseStorage {
    async getUser(id) {
        const [user] = await db.select().from(users).where(eq(users.id, id));
        return user;
    }
    async upsertUser(insertUser) {
        const { lastActive, ...dataToInsert } = insertUser;
        const [user] = await db.insert(users).values(dataToInsert).onConflictDoUpdate({
            target: users.id,
            set: { ...dataToInsert, lastActive: new Date() }
        }).returning();
        backupToSupabase().catch((err) => log(`Async backup failed: ${err.message}`, "backup"));
        return user;
    }
    async updateUser(id, data) {
        const updateData = { ...data };
        delete updateData.lastActive;
        const [user] = await db.update(users).set({ ...updateData, lastActive: new Date() }).where(eq(users.id, id)).returning();
        if (!user)
            return this.upsertUser({ id, ...data });
        return user;
    }
    // track daily command usage (3 per day for non-premium)
    async getCommandCountToday(userId) {
        const today = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
        const [rec] = await db.select().from(commandUsage).where(and(eq(commandUsage.userId, userId), eq(commandUsage.date, today)));
        return rec ? rec.count : 0;
    }
    async recordCommandUse(userId) {
        const today = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
        const [rec] = await db.select().from(commandUsage).where(and(eq(commandUsage.userId, userId), eq(commandUsage.date, today)));
        if (rec) {
            const newCount = rec.count + 1;
            await db.update(commandUsage).set({ count: newCount }).where(eq(commandUsage.id, rec.id));
            return newCount;
        }
        else {
            const [created] = await db.insert(commandUsage).values({ userId, date: today, count: 1 }).returning();
            return 1;
        }
    }
    async getUserLanes(userId) {
        return db.select().from(userLanes).where(eq(userLanes.userId, userId));
    }
    async upsertUserLane(insertLane) {
        try {
            // @ts-ignore - Type inference issue with Drizzle ORM
            const laneData = { userId: insertLane.userId, lane: insertLane.lane, enabled: insertLane.enabled };
            const [lane] = await db.insert(userLanes).values(laneData).onConflictDoUpdate({
                target: [userLanes.userId, userLanes.lane],
                set: laneData
            }).returning();
            return lane;
        }
        catch (error) {
            // @ts-ignore - Type inference issue with Drizzle ORM
            const [existing] = await db.select().from(userLanes).where(and(eq(userLanes.userId, insertLane.userId), eq(userLanes.lane, insertLane.lane)));
            if (existing) {
                // @ts-ignore - Drizzle ORM type issue with set()
                const [updated] = await db.update(userLanes).set({ enabled: insertLane.enabled }).where(eq(userLanes.id, existing.id)).returning();
                return updated;
            }
            const laneData = { userId: insertLane.userId, lane: insertLane.lane, enabled: insertLane.enabled };
            const [created] = await db.insert(userLanes).values(laneData).returning();
            return created;
        }
    }
    async getGroupBinding(groupId, topicId) {
        const conditions = [eq(groupBindings.groupId, groupId)];
        if (topicId)
            conditions.push(eq(groupBindings.topicId, topicId));
        const [binding] = await db.select().from(groupBindings).where(and(...conditions));
        return binding;
    }
    async getGroupBindings(groupId) {
        return db.select().from(groupBindings).where(eq(groupBindings.groupId, groupId));
    }
    async getUserSubscriptions(userId) {
        return db.select().from(userSubscriptions).where(eq(userSubscriptions.userId, userId));
    }
    async upsertUserSubscription(sub) {
        // @ts-ignore - Type inference issue with Drizzle ORM
        const conditions = [eq(userSubscriptions.userId, sub.userId), eq(userSubscriptions.groupId, sub.groupId), eq(userSubscriptions.lane, sub.lane)];
        // @ts-ignore - subtype may lack topicId
        if (sub.topicId)
            conditions.push(eq(userSubscriptions.topicId, sub.topicId));
        const [existing] = await db.select().from(userSubscriptions).where(and(...conditions));
        if (existing) {
            // @ts-ignore - Drizzle ORM type issue with set()
            const [updated] = await db.update(userSubscriptions).set({ enabled: sub.enabled }).where(eq(userSubscriptions.id, existing.id)).returning();
            return updated;
        }
        // @ts-ignore - Drizzle typing issue with generated insert type
        const [created] = await db.insert(userSubscriptions).values(sub).returning();
        return created;
    }
    async deleteUserSubscription(userId, groupId, topicId, lane) {
        const conditions = [eq(userSubscriptions.userId, userId), eq(userSubscriptions.groupId, groupId)];
        if (topicId)
            conditions.push(eq(userSubscriptions.topicId, topicId));
        if (lane)
            conditions.push(eq(userSubscriptions.lane, lane));
        await db.delete(userSubscriptions).where(and(...conditions));
    }
    async getSubscribersForBinding(groupId, topicId, lane) {
        const conditions = [eq(userSubscriptions.groupId, groupId), eq(userSubscriptions.lane, lane), eq(userSubscriptions.enabled, true)];
        if (topicId)
            conditions.push(eq(userSubscriptions.topicId, topicId));
        const results = await db.select().from(userSubscriptions).innerJoin(users, eq(userSubscriptions.userId, users.id)).where(and(...conditions));
        return results.map((r) => r.users);
    }
    async upsertGroupBinding(insertBinding) {
        // @ts-ignore - insertBinding typing
        const conditions = [eq(groupBindings.groupId, insertBinding.groupId)];
        // @ts-ignore - insertBinding typing
        if (insertBinding.topicId)
            conditions.push(eq(groupBindings.topicId, insertBinding.topicId));
        const [existing] = await db.select().from(groupBindings).where(and(...conditions));
        if (existing) {
            const [updated] = await db.update(groupBindings).set({ lane: insertBinding.lane }).where(eq(groupBindings.id, existing.id)).returning();
            return updated;
        }
        // @ts-ignore - Drizzle typing issue for insertBinding
        const [created] = await db.insert(groupBindings).values(insertBinding).returning();
        return created;
    }
    async getWallets(userId) {
        const results = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.isActive), desc(wallets.createdAt));
        return results.map((w) => ({ ...w, privateKey: decrypt(w.privateKey) }));
    }
    async setActiveWallet(userId, walletId) {
        const [wallet] = await db.select().from(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
        if (!wallet)
            throw new Error("Wallet not found");
        await db.update(wallets).set({ isActive: false }).where(eq(wallets.userId, userId));
        await db.update(wallets).set({ isActive: true }).where(eq(wallets.id, walletId));
    }
    async getActiveWallet(userId) {
        const [wallet] = await db.select().from(wallets).where(and(eq(wallets.userId, userId), eq(wallets.isActive, true)));
        if (wallet)
            return { ...wallet, privateKey: decrypt(wallet.privateKey) };
        const [firstWallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.createdAt)).limit(1);
        if (firstWallet)
            return { ...firstWallet, privateKey: decrypt(firstWallet.privateKey) };
        return undefined;
    }
    async getWallet(id) {
        const [wallet] = await db.select().from(wallets).where(eq(wallets.id, id));
        if (wallet)
            return { ...wallet, privateKey: decrypt(wallet.privateKey) };
        return undefined;
    }
    async updateWalletBalance(id, balance) {
        const [wallet] = await db.update(wallets).set({ balance }).where(eq(wallets.id, id)).returning();
        if (!wallet)
            throw new Error("Wallet not found");
        return { ...wallet, privateKey: decrypt(wallet.privateKey) };
    }
    async createWallet(insertWallet) {
        const [wallet] = await db.insert(wallets).values({ ...insertWallet, privateKey: encrypt(insertWallet.privateKey) }).returning();
        backupToSupabase().catch((err) => log(`Async backup failed: ${err.message}`, "backup"));
        return { ...wallet, privateKey: decrypt(wallet.privateKey) };
    }
    async deleteWallet(id) {
        await db.delete(wallets).where(eq(wallets.id, id));
    }
    async getSignals() {
        return [...memorySignals].sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
    }
    async getSignal(id) {
        return memorySignals.find(s => s.id === id);
    }
    async createSignal(insertSignal) {
        const newSignal = {
            ...insertSignal,
            id: Date.now(),
            createdAt: new Date(),
            lastUpdateAt: new Date(),
            data: insertSignal.data || {}
        };
        memorySignals.push(newSignal);
        if (memorySignals.length > MAX_MEMORY_SIGNALS)
            memorySignals.shift();
        return newSignal;
    }
    async updateSignal(id, data) {
        const idx = memorySignals.findIndex(s => s.id === id);
        if (idx !== -1) {
            memorySignals[idx] = { ...memorySignals[idx], ...data, lastUpdateAt: new Date() };
        }
    }
    async getTrades(userId) {
        return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.createdAt));
    }
    async createTrade(insertTrade) {
        const [trade] = await db.insert(trades).values(insertTrade).returning();
        return trade;
    }
    async updateTrade(id, data) {
        const [trade] = await db.update(trades).set(data).where(eq(trades.id, id)).returning();
        if (!trade)
            throw new Error("Trade not found");
        return trade;
    }
}
export const storage = new DatabaseStorage();
//# sourceMappingURL=storage.js.map