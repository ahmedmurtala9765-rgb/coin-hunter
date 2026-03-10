// @ts-nocheck
// @ts-nocheck
// @ts-nocheck
import { groupBindings, signals as signalsTable, users, wallets as walletsTable, trades as tradesTable, userLanes } from "../shared/schema";
import TelegramBot from 'node-telegram-bot-api';
import { storage } from './storage';
import { log } from "./index";
import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { eq, and, or, count } from "drizzle-orm";
import { db } from "./db";

// Pending actions for admin commands
const pendingClears = new Map<string, boolean>();

// perform a simple web search using DuckDuckGo Instant Answer API (no key required)
export async function searchWeb(query: string): Promise<string[]> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await axios.get(url, { timeout: 5000 });
    const data = res.data;
    const results: string[] = [];
    if (data.AbstractText) {
      results.push(data.AbstractText);
    }
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0,3)) {
        if (topic.Text) results.push(topic.Text);
        else if (topic.Topics) {
          topic.Topics.slice(0,1).forEach((t:any)=> t.Text && results.push(t.Text));
        }
      }
    }
    return results.slice(0,3).map(r => r.replace(/\n/g, ' '));
  } catch (e) {
    return [];
  }
}

// Lightweight news fetch via Google News RSS (no API key required)
export async function fetchNews(query: string): Promise<string[]> {
  try {
    const q = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const r = await axios.get(url, { timeout: 4000 });
    const xml = (r.data || "") as string;
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const headlines = items.slice(0, 5).map(it => {
      const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]) || (it.match(/<title>(.*?)<\/title>/)?.[1]) || '';
      const link = (it.match(/<link>(.*?)<\/link>/)?.[1]) || '';
      return title ? `${title}${link ? ` (${link})` : ''}` : null;
    }).filter(Boolean) as string[];
    return headlines.slice(0, 3);
  } catch (e) {
    return [];
  }
}

// Enhanced search function that tries multiple sources
export async function searchCurrentInfo(query: string): Promise<string[]> {
  const results: string[] = [];
  
  try {
    // Try DuckDuckGo first
    const duckResults = await searchWeb(query);
    if (duckResults.length > 0) {
      results.push(...duckResults.map(r => `Web: ${r}`));
    }
    
    // Try Google News for current events
    const newsResults = await fetchNews(query);
    if (newsResults.length > 0) {
      results.push(...newsResults.map(r => `News: ${r}`));
    }
    
    // If still no results, try broader search terms
    if (results.length === 0) {
      const broadQuery = `${query} current situation latest updates`;
      const broadDuckResults = await searchWeb(broadQuery);
      if (broadDuckResults.length > 0) {
        results.push(...broadDuckResults.map(r => `Web: ${r}`));
      }
      
      const broadNewsResults = await fetchNews(broadQuery);
      if (broadNewsResults.length > 0) {
        results.push(...broadNewsResults.map(r => `News: ${r}`));
      }
    }
    
  } catch (error) {
    log(`Enhanced search error: ${error}`, "telegram");
  }
  
  return results.slice(0, 5); // Limit to 5 results
}

export let telegramBotInstance: TelegramBot | null = null;

// track conversation history per chat to support follow-ups
const conversationHistory = new Map<string, Array<{role:string,content:string}>>();

function addToHistory(chatId: string, role: string, content: string) {
  const key = chatId.toString();
  const hist = conversationHistory.get(key) || [];
  hist.push({ role, content });
  if (hist.length > 12) hist.splice(0, hist.length - 12);
  conversationHistory.set(key, hist);
}

function getHistory(chatId: string) {
  return conversationHistory.get(chatId.toString()) || [];
}

// normalize user-supplied pair formats (BTCUSD, btc/usdt, EURUSD etc)
function normalizePair(input: string): string | null {
  if (!input) return null;
  let s = input.trim().toUpperCase().replace(/[^A-Z0-9\/]/g, '');
  if (s.includes('/')) return s;
  // handle 6+ character pairs by splitting last 3 or 4 letters
  const commonQuotes = ['USDT','USDC','USD','EUR','BTC','ETH','JPY','GBP','AUD','CAD','CHF','NZD'];
  for (const q of commonQuotes) {
    if (s.endsWith(q) && s.length > q.length) {
      const base = s.slice(0, s.length - q.length);
      return `${base}/${q}`;
    }
  }
  if (s.length === 6) {
    return `${s.slice(0,3)}/${s.slice(3)}`;
  }
  return null;
}

/**
 * Determine the best market type for a detected pair (crypto vs forex) and validate it.
 * Falls back to chart-based analysis if the pair cannot be validated.
 */
async function resolveMarketForPair(pair: string | undefined, worker: any) {
  const result: { pair?: string; marketType: 'crypto' | 'forex'; note?: string } = {
    marketType: 'crypto'
  };

  if (!pair) {
    result.note = "No pair detected; using chart-based analysis (crypto default).";
    return result;
  }

  const normalized = normalizePair(pair);
  if (!normalized) {
    result.note = `Unable to normalize '${pair}'. Falling back to chart-based analysis.`;
    return result;
  }

  // Check if this pair exists in crypto prices
  try {
    const cryptoPrice = await worker.getPrice(normalized, 'crypto');
    if (cryptoPrice > 0) {
      result.pair = normalized;
      result.marketType = 'crypto';
      result.note = `Pair recognized as crypto (${normalized}).`;
      return result;
    }
  } catch (e: any) {
    log(`Crypto price check error for ${normalized}: ${e.message}`, 'telegram');
  }

  // Check forex
  try {
    const forexPrice = await worker.getPrice(normalized, 'forex');
    if (forexPrice > 0) {
      result.pair = normalized;
      result.marketType = 'forex';
      result.note = `Pair recognized as forex (${normalized}).`;
      return result;
    }
  } catch (e: any) {
    log(`Forex price check error for ${normalized}: ${e.message}`, 'telegram');
  }

  // Meme coin service check (using web search)
  try {
    const memeMatches = await searchWeb(`${normalized} meme coin`).catch(() => []);
    if (memeMatches.length) {
      result.pair = normalized;
      result.marketType = 'crypto';
      result.note = `Pair treated as meme coin (${normalized}) based on web search.`;
      return result;
    }
  } catch (e: any) {
    log(`Meme coin lookup error for ${normalized}: ${e.message}`, 'telegram');
  }

  // Fallback to chart analysis
  result.note = `Unable to validate ${normalized}; falling back to chart-based analysis (crypto default).`;
  return result;
}

export function getTelegramBot() {
  return telegramBotInstance;
}

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("TELEGRAM_BOT_TOKEN is missing. Bot will not start.", "telegram");
    return;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  // Helper: Parse comma-separated ID list from env
  const parseIdList = (envVar: string | undefined): string[] => {
    if (!envVar) return [];
    return envVar
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
  };

  const adminIds = parseIdList(process.env.ADMIN_USER_IDS);
  const premiumGroupIds = parseIdList(process.env.PREMIUM_GROUP_IDS);
  const nonPremiumGroupIds = parseIdList(process.env.NON_PREMIUM_GROUP_IDS);

  log(`Parsed admin IDs: ${JSON.stringify(adminIds)}`, "telegram");
  log(`Parsed premium group IDs: ${JSON.stringify(premiumGroupIds)}`, "telegram");
  log(`Parsed non-premium group IDs: ${JSON.stringify(nonPremiumGroupIds)}`, "telegram");

  // Helper: Check if user is admin
  const isAdmin = (userId: string): boolean => {
    return adminIds.includes(userId);
  };

  // Helper: Check if group is premium
  const isPremiumGroup = (groupId: string): boolean => {
    return premiumGroupIds.includes(groupId);
  };

  // Helper: Check if group is non-premium
  const isNonPremiumGroup = (groupId: string): boolean => {
    return nonPremiumGroupIds.includes(groupId);
  };

  // Helper: Check if group is authorized (either premium or non-premium)
  const isAuthorizedGroup = (groupId: string): boolean => {
    return isPremiumGroup(groupId) || isNonPremiumGroup(groupId);
  };

  log("Initializing Telegram bot...", "telegram");
  
  if (telegramBotInstance) {
    log("Existing bot instance found, stopping polling...", "telegram");
    telegramBotInstance.stopPolling();
  }

  const bot = new TelegramBot(token, { 
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 10
      }
    } 
  }); 
  
  telegramBotInstance = bot;

  const ensureUser = async (msg: TelegramBot.Message) => {
    const id = msg.from?.id.toString();
    if (!id) return null;
    const existingUser = await storage.getUser(id);
    if (existingUser) return existingUser;

    const user = await storage.upsertUser({
      id,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      isMainnet: true
    });

    // Check if user already has wallets before creating a new one
    const existingWallets = await storage.getWallets(id);
    if (existingWallets.length === 0) {
      const keypair = Keypair.generate();
      await storage.createWallet({
        userId: id,
        publicKey: keypair.publicKey.toString(),
        privateKey: bs58.encode(keypair.secretKey),
        label: "Main Wallet",
        isMainnet: true,
        isActive: true,
        balance: "0"
      });
    }

    return user;
  };



  const sendTokenOverview = async (chatId: number, mint: string, messageId?: number, threadId?: number) => {
    try {
      // search first to allow any network (solana, ethereum, bsc, etc)
      let pair: any = null;
      try {
        const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`);
        const searchData = searchRes.data as any;
        if (searchData.pairs && searchData.pairs.length > 0) {
          pair = searchData.pairs[0];
        }
      } catch {}
      if (!pair) {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        const data = response.data as any;
        pair = data.pairs?.[0];
      }

      if (!pair) {
        bot.sendMessage(chatId, "❌ <b>Token not found on DexScreener.</b>", { parse_mode: 'HTML', message_thread_id: threadId });
        return;
      }

      const name = pair.baseToken?.name || pair.name || 'Unknown';
      const symbol = pair.baseToken?.symbol || pair.symbol || 'N/A';
      const price = pair.priceUsd ? `$${parseFloat(pair.priceUsd).toFixed(6)}` : "N/A";
      const mcap = pair.fdv ? `$${pair.fdv.toLocaleString()}` : "N/A";
      const liq = pair.liquidity?.usd ? `$${pair.liquidity.usd.toLocaleString()}` : "N/A";
      const vol = pair.volume?.h24 ? `$${pair.volume.h24.toLocaleString()}` : "N/A";
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const change = pair.priceChange?.h24 ? `${pair.priceChange.h24 > 0 ? '+' : ''}${pair.priceChange.h24}%` : "0%";
      const chartUrl = pair.url || `https://dexscreener.com/${(pair.chainId||'solana')}/${mint}`;

      const message = `🧪 <b>Token Overview</b>\n\n` +
                    `📛 Name: ${name}\n` +
                    `💊 Symbol: $${symbol}\n` +
                    `🔗 Contract/Mint: <code>${mint}</code>\n` +
                    `🌐 Network: ${(pair.chainId||'unknown').toUpperCase()}\n\n` +
                    `📊 <b>Market</b>\n` +
                    `• Price: ${price}\n` +
                    `• Market Cap: ${mcap}\n` +
                    `• Liquidity: ${liq}\n` +
                    `• Volume (24h): ${vol}\n\n` +
                    `📈 <b>Activity (24h)</b>\n` +
                    `• Buys: ${buys}\n` +
                    `• Sells: ${sells}\n` +
                    `• Change: ${change}\n\n` +
                    `🌐 <b>Chart</b>\n` +
                    `${chartUrl}\n\n` +
                    `⚠️ <i>This is not financial advice.</i>`;

      const keyboard = [
        [{ text: "🤖 AI Analysis", callback_data: `ai_analyze_${mint}` }],
        [{ text: "🔄 Refresh", callback_data: `refresh_overview_${mint}` }]
      ];

      if (messageId) {
        try {
          await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        } catch (e: any) {
          if (!e.message.includes("message is not modified")) throw e;
        }
      } else {
        bot.sendMessage(chatId, message, { parse_mode: 'HTML', message_thread_id: threadId, reply_markup: { inline_keyboard: keyboard } });
      }
    } catch (e: any) {
      log(`Error fetching token overview: ${e.message}`, "telegram");
      bot.sendMessage(chatId, "❌ <b>Error fetching token data.</b>", { parse_mode: 'HTML' });
    }
  };

  const executeAiReasoning = async (chatId: number, mint: string, threadId?: number) => {
    bot.sendMessage(chatId, "🤖 <b>Performing Deep On-Chain Analysis...</b>", { parse_mode: 'HTML', message_thread_id: threadId });
    try {
      // search first to allow any network
      let pair: any = null;
      try {
        const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(mint)}`);
        const searchData = searchRes.data as any;
        if (searchData.pairs && searchData.pairs.length > 0) {
          pair = searchData.pairs[0];
        }
      } catch {}
      if (!pair) {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        const data = response.data as any;
        pair = data.pairs?.[0];
      }

      if (!pair) throw new Error("Token data not found.");

      const name = pair.baseToken?.name || 'Unknown';
      const symbol = pair.baseToken?.symbol || 'N/A';
      const price = parseFloat(pair.priceUsd || "0") || 0;
      const fdv = parseFloat(pair.fdv || "0") || 0;
      const liquidity = parseFloat(pair.liquidity?.usd || "0") || 0;
      const volume24h = parseFloat(pair.volume?.h24 || "0") || 0;
      const buys24h = pair.txns?.h24?.buys || 0;
      const sells24h = pair.txns?.h24?.sells || 0;
      const priceChange24h = pair.priceChange?.h24 || 0;
      const pairCreatedAt = pair.pairCreatedAt || 0;
      const ageHours = pairCreatedAt ? Math.round((Date.now() - pairCreatedAt) / 3600000) : 0;

      // detect holder concentration (risk indicator)
      const holderRisk = liquidity > 0 ? (liquidity / (fdv || 1)) : 0;
      const buyPressure = buys24h + sells24h > 0 ? ((buys24h - sells24h) / (buys24h + sells24h)) * 100 : 0;
      const volatility = Math.abs(priceChange24h);
      const liquidityQuality = volume24h > 0 && liquidity > 0 ? (volume24h / liquidity * 100).toFixed(2) : "N/A";

      // Extensive research with multiple sources and angles
      const searchCtx = await searchCurrentInfo(`${name} ${symbol} token crypto analysis fundamentals`).catch(() => []);
      const newsResults = await fetchNews(`${symbol} crypto news`).catch(() => []);
      const twitterSearch = await searchCurrentInfo(`${symbol} twitter sentiment trends crypto`).catch(() => []);
      const communitySearch = await searchCurrentInfo(`${symbol} telegram discord community holders`).catch(() => []);
      const developerSearch = await searchCurrentInfo(`${symbol} developer team background experience`).catch(() => []);
      const competitorSearch = await searchCurrentInfo(`${symbol} competitors alternatives comparison`).catch(() => []);
      const technicalSearch = await searchCurrentInfo(`${symbol} technical analysis chart patterns`).catch(() => []);
      const adoptionSearch = await searchCurrentInfo(`${symbol} adoption use cases partnerships`).catch(() => []);

      const enrichedData = JSON.stringify({
        name, symbol,
        price: price.toFixed(8),
        marketCap: fdv,
        liquidity,
        volume24h,
        buys24h, sells24h,
        buyPressure: buyPressure.toFixed(2),
        priceChange24h,
        volatility,
        ageHours,
        liquidityQuality,
        holderConcentration: holderRisk.toFixed(4),
        chain: pair.chainId || 'unknown'
      });

const workerModule = await import("./signals-worker");
      const aiModule = workerModule;
      if (!aiModule.openRouterClient && !aiModule.aiMockMode) {
        await aiModule.initAI();
      }
      
      if (aiModule.aiMockMode) {
        const mockResponse = aiModule.mockAiResponse('reasoning');
        bot.sendMessage(chatId, mockResponse, { parse_mode: 'HTML' });
        return;
      }

      if (!aiModule.openRouterClient) throw new Error("AI Client not initialized.");

      const aiMessages: any[] = [
        {
          role: "system",
          content: `You are an expert crypto analyst specializing in deep on-chain research and institutional-grade token analysis. Current date: ${new Date().toISOString()}. Provide an EXTENSIVE, comprehensive analysis covering all aspects of the token with institutional-level reasoning and research-backed insights.

🔍 INSTITUTIONAL TOKEN ANALYSIS FRAMEWORK:

1. FUNDAMENTAL ANALYSIS
• Technology Assessment: Evaluate the underlying technology, innovation, and competitive advantages
• Team & Development: Analyze developer background, experience, and track record
• Tokenomics: Deep dive into supply mechanics, distribution, vesting schedules, and economic incentives
• Adoption & Use Cases: Real-world applications, partnerships, and market penetration

2. TECHNICAL ANALYSIS  
• On-chain Metrics: Transaction volume, active addresses, network health, holder analysis
• Price Action: Historical performance, volatility patterns, support/resistance levels
• Comparative Analysis: Performance vs peers, market positioning, relative strength

3. MARKET SENTIMENT & SOCIAL ANALYSIS
• Community Strength: Size, engagement, quality of discussions, developer responsiveness
• Social Media Presence: Twitter trends, sentiment analysis, influencer mentions
• News & Media Coverage: Recent developments, press coverage, market perception

4. RISK ASSESSMENT & DUE DILIGENCE
• Security Analysis: Smart contract audits, historical exploits, security track record
• Regulatory Risks: Compliance status, legal challenges, regulatory scrutiny
• Market Risks: Competition, market saturation, macroeconomic factors
• Liquidity Risks: Trading volume analysis, slippage concerns, exit liquidity

5. INSTITUTIONAL INVESTMENT THESIS
• Bull Case: Compelling reasons for long-term investment
• Bear Case: Potential downside risks and challenges
• Risk/Reward Ratio: Quantitative assessment of investment opportunity
• Timeline Expectations: Realistic growth projections and milestones

Format your response as a comprehensive institutional research report with clear sections, data-backed conclusions, and actionable insights. Use professional language and provide specific metrics, comparisons, and forward-looking analysis.`
        }
      ];

      // Add extensive research data
      if (searchCtx.length) aiMessages.push({ role: 'user', content: `General Token Research:\n${searchCtx.map(r => `• ${r}`).join('\n')}` });
      if (newsResults.length) aiMessages.push({ role: 'user', content: `Recent News & Developments:\n${newsResults.map(r => `• ${r}`).join('\n')}` });
      if (twitterSearch.length) aiMessages.push({ role: 'user', content: `Social Media Sentiment:\n${twitterSearch.map(r => `• ${r}`).join('\n')}` });
      if (communitySearch.length) aiMessages.push({ role: 'user', content: `Community Analysis:\n${communitySearch.map(r => `• ${r}`).join('\n')}` });
      if (developerSearch.length) aiMessages.push({ role: 'user', content: `Developer & Team Analysis:\n${developerSearch.map(r => `• ${r}`).join('\n')}` });
      if (competitorSearch.length) aiMessages.push({ role: 'user', content: `Competitive Landscape:\n${competitorSearch.map(r => `• ${r}`).join('\n')}` });
      if (technicalSearch.length) aiMessages.push({ role: 'user', content: `Technical Analysis:\n${technicalSearch.map(r => `• ${r}`).join('\n')}` });
      if (adoptionSearch.length) aiMessages.push({ role: 'user', content: `Adoption & Partnerships:\n${adoptionSearch.map(r => `• ${r}`).join('\n')}` });
      
      // Get extensive research context from signals-worker
const extensiveResearch = await workerModule.fetchInternetContext(symbol).catch(() => []);
      if (extensiveResearch.length) aiMessages.push({ role: 'user', content: `Additional Market Research:\n${extensiveResearch.map(r => `• ${r}`).join('\n')}` });
      
      aiMessages.push({ role: 'user', content: `On-chain and Market Data: ${enrichedData}\n\nProvide a comprehensive institutional-grade analysis covering all aspects above. Focus on research-backed insights and provide specific, actionable conclusions.` });

      const aiResponse = await (aiModule.openRouterClient as any).chat.completions.create({
        model: "anthropic/claude-3.5-sonnet",
        messages: aiMessages,
        max_tokens: 2500
      });

      const reasoning = aiResponse.choices[0].message.content;
      
      // Sanitize for Telegram HTML
      const cleanReasoning = reasoning
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/&lt;b&gt;/g, '<b>')
        .replace(/&lt;\/b&gt;/g, '</b>')
        .replace(/&lt;i&gt;/g, '<i>')
        .replace(/&lt;\/i&gt;/g, '</i>')
        .replace(/&lt;code&gt;/g, '<code>')
        .replace(/&lt;\/code&gt;/g, '</code>')
        .replace(/[^\x20-\x7E\n\t<>&;]/g, '')
        .slice(0, 4096);
      
      bot.sendMessage(chatId, cleanReasoning, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e: any) {
      log(`AI reasoning error: ${e.message} ${JSON.stringify(e.response?.data)}`, "telegram");
      const aiModule = await import("./signals-worker");
      if (aiModule.aiMockMode && e.response?.status !== 401) {
        // Already handled above, just log
        return;
      }
      if (e.response?.status === 401) {
        bot.sendMessage(chatId, `❌ <b>AI Authentication Error:</b> please check your API key configuration.`, { parse_mode: 'HTML', message_thread_id: threadId });
      } else {
        bot.sendMessage(chatId, `❌ <b>AI Reasoning Failed:</b> ${e.message}`, { parse_mode: 'HTML', message_thread_id: threadId });
      }
    }
  };

  async function sendMainMenu(chatId: number, userId: string, messageId?: number) {
    const activeWallet = await storage.getActiveWallet(userId);
    let balance = "0.000";
    
    if (activeWallet) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const bal = await connection.getBalance(new PublicKey(activeWallet.publicKey));
        balance = (bal / 1e9).toFixed(3);
        await storage.updateWalletBalance(activeWallet.id, balance);
      } catch (e) {
        log(`Failed to fetch real-time balance for ${activeWallet.publicKey}: ${e}`, "telegram");
        balance = activeWallet.balance || "0.000";
      }
    }

    const header = `🚀 <b>Welcome to Coin Hunter Bot</b>\n\n` +
                   `The most advanced Smart Money Concepts trading terminal on Solana.\n\n` +
                   `Wallet: <code>${activeWallet?.publicKey || 'None'}</code> (Tap to copy)\n` +
                   `Active Balance: <b>${balance} SOL</b>\n\n` +
                   `Quick Commands:\n` +
                   `• /p [pair] - Quick price lookup\n` +
                   `• /ai [query] - Ask the AI specialist\n` +
                   `• /progress - View ongoing trades\n` +
                   `• /settings - Configure Bot\n` +
                   `• /history - View trade history`;

    const keyboard = [
      [{ text: "� Progress", callback_data: "menu_progress" }],
      [{ text: "�🔄 Refresh", callback_data: "main_menu_refresh" }],
      [{ text: "📜 History", callback_data: "menu_history" }, { text: "⚙️ Settings", callback_data: "menu_settings" }]
    ];
    if (messageId) {
      try {
        await bot.editMessageText(header, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      } catch (e: any) {
        if (!e.message.includes("message is not modified")) throw e;
      }
    } else {
      bot.sendMessage(chatId, header, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
  }

  bot.on('message', async (msg) => {
    log(`Received message from ${msg.from?.username} (${msg.from?.id}): ${msg.text}`, "telegram");
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    if (!userId) return;

    const now = Math.floor(Date.now() / 1000);
    if (msg.date && (now - msg.date > 30)) return;

    try {
      await ensureUser(msg);
      const isPrivate = msg.chat.type === 'private';

      // Group authorization check: if not private, group must be in premium or non-premium list
      if (!isPrivate && !isAuthorizedGroup(chatId.toString())) {
        log(`Unauthorized group ${chatId} attempted to use bot`, "telegram");
        bot.sendMessage(chatId, "❌ <b>Bot Not Authorized</b>\n\nThis bot is not authorized to work in this group.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        return;
      }

      // AI command is unrestricted (no lane checks) - answer any question
      const checkAiLane = async () => {
        return true;
      };

      // Check if the user is effectively premium (member of premium group), regardless of where they trigger the command
      const isUserPremiumMember = async (): Promise<boolean> => {
        if (isAdmin(userId)) {
          log(`User ${userId} has premium access (admin)`, "telegram");
          return true;
        }
        // If current context is a premium group, they are premium by definition
        if (isPremiumGroup(chatId.toString())) {
          log(`User ${userId} has premium access (current group is premium)`, "telegram");
          return true;
        }

        // Otherwise, check membership in any configured premium group
        for (const premiumGroupId of premiumGroupIds) {
          try {
            const member = await bot.getChatMember(premiumGroupId, userId);
            if (member && member.status && !['left', 'kicked'].includes(member.status)) {
              log(`User ${userId} has premium access (member of premium group ${premiumGroupId})`, "telegram");
              return true;
            }
          } catch {
            // ignore errors (bot may not be in that group or the group ID may be invalid)
          }
        }
        return false;
      };

      // check command limit unless user is premium
      const checkCommandLimit = async (): Promise<boolean> => {
        if (await isUserPremiumMember()) return true;

        // Non-premium users (whether in non-premium group or private chat) have 2/day limit
        const count = await storage.getCommandCountToday(userId);
        if (count >= 2) {
          log(`Command limit reached for user ${userId}: ${count} commands today`, "telegram");
          bot.sendMessage(chatId, `⚠️ <b>Daily limit reached</b> – you have used 2 commands today. Join a premium group for unlimited access.`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return false;
        }
        await storage.recordCommandUse(userId);
        log(`Command recorded for user ${userId}: ${count + 1}/2 today`, "telegram");
        return true;
      };

      // Define /p or /price command for quick price lookup
      if (msg.text?.match(/^\/(p|price)\s+/)) {
        if (!(await checkCommandLimit())) return;
        const parts = msg.text.trim().split(/\s+/);
        const raw = parts[1];
        const normalized = normalizePair(raw || '');
        if (!normalized) {
          bot.sendMessage(chatId, "❌ Please provide a valid trading pair, e.g. <code>/p BTC/USDT</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        bot.sendMessage(chatId, `🔄 Fetching price for <b>${normalized}</b>...`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const { fetchPriceData } = await import("./price-service");
        try {
          const data = await fetchPriceData(normalized);
          if (!data) {
            bot.sendMessage(chatId, `❌ Could not fetch price for <b>${normalized}</b>.`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          } else {
            const num = parseFloat(data.price);
            const formatted = isNaN(num) ? data.price : num.toLocaleString('en-US', { maximumFractionDigits: 8 });
            bot.sendMessage(chatId, `💱 <b>Price for ${normalized}</b>\n${formatted} ${data.quote} (source: ${data.source})`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          }
        } catch (err: any) {
          bot.sendMessage(chatId, `❌ Error fetching price: ${err.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      // Support photo upload with /ai caption for image analysis (also accept text command or hashtags)
      if (msg.photo && (msg.caption?.startsWith('/ai') || msg.text?.startsWith('/ai'))) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        
        const query = msg.caption.slice(3).trim();
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        bot.sendMessage(chatId, "🤖 <b>Analyzing chart image...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        
        try {
          const aiModule = await import("./ai") as any;
          const ai = aiModule.default || aiModule;
          
          // Extract trading pair from image (optional - will analyze anyway)
          let detected = null;
          try {
            detected = await ai.extractPairFromImage(fileLink);
          } catch (e) {
            log(`Pair extraction failed: ${e}`, "telegram");
          }
          
          let pair = detected || query || "";
          
          if (pair) {
            const norm = normalizePair(pair);
            if (norm) pair = norm;
          }
          
          // Build analysis prompt - proceed with or without detected pair
          let analysisQuery = query || "Analyze this trading chart";
          if (pair) {
            analysisQuery = `Analyze the chart for ${pair}. ${query}`;
          }
          
          // Store in conversation history
          addToHistory(chatId.toString(), 'user', `[Image uploaded] ${analysisQuery}`);
          
          // Get web context for the pair if detected
          let webContext = "";
          if (pair) {
            const searchResults = await searchWeb(`${pair} technical analysis chart`).catch(() => []);
            if (searchResults.length) {
              webContext = `\n\n🌐 Market Context:\n${searchResults.map(r => `• ${r}`).join('\n')}`;
            }
          }
          
          // Include image analysis in enriched query
          const enrichedQuery = analysisQuery + webContext;
          
          const aiModule2 = await import("./signals-worker");
          if (!aiModule2.openRouterClient && !aiModule2.aiMockMode) {
            await aiModule2.initAI();
          }
          
          if (aiModule2.aiMockMode) {
            const mockResponse = aiModule2.mockAiResponse('default');
            bot.sendMessage(chatId, mockResponse, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            addToHistory(chatId.toString(), 'assistant', mockResponse);
            return;
          }
          
          // Include conversation history
          const history = getHistory(chatId.toString());
          const messages: any[] = [
            { role: "system", content: `You are an expert technical analyst specializing in chart pattern recognition. Current date: ${new Date().toISOString()}. Analyze the provided chart image and explain key support/resistance levels, trend direction, entry/exit points, and risk/reward setup. If the image contains any text, annotations, or screenshot‑style notes, read that text and incorporate it into your reasoning. Provide actionable insights.` },
            ...history
          ];
          
          // Add user message with image
          messages.push({ 
            role: 'user', 
            content: [
              { type: 'text', text: enrichedQuery },
              { type: 'image_url', image_url: { url: fileLink } }
            ]
          });
          
          if (!aiModule2.openRouterClient) {
            bot.sendMessage(chatId, "❌ AI service not available.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            return;
          }
          
          const response = await aiModule2.openRouterClient.chat.completions.create({
            model: "anthropic/claude-3.5-sonnet",
            messages,
            max_tokens: 1200
          });
          
          const answer = response.choices[0].message?.content || "No analysis available.";
          bot.sendMessage(chatId, answer, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          addToHistory(chatId.toString(), 'assistant', answer);
        } catch (e: any) {
          log(`Image analysis error: ${e.message}`, "telegram");
          bot.sendMessage(chatId, `❌ Image analysis failed: ${e.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      // Define /ai command
      if (msg.text?.startsWith('/ai ')) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        const query = msg.text.slice(4).trim();
        if (!query) {
          bot.sendMessage(chatId, "❌ Please provide a query, e.g. <code>/ai Analyze BTC sentiment</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        bot.sendMessage(chatId, "🤖 <b>Processing AI Request...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const aiModule = await import("./signals-worker");
        if (!aiModule.openRouterClient && !aiModule.aiMockMode) {
          await aiModule.initAI();
        }
        
        // allow both real API and mock mode
        if (!aiModule.openRouterClient && !aiModule.aiMockMode) {
          bot.sendMessage(chatId, "❌ AI service not initialized.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        // try to enrich query with real price/indicator context and maintain conversation history
        let enrichedQuery = query;
        try {
          // conversation memory tracking
          addToHistory(chatId.toString(), 'user', query);

          // perform web search to let AI 'browse'
          const { searchWeb } = await import("./telegram");
          const webResults = await searchWeb(query).catch(() => []);
          if (webResults.length) {
            enrichedQuery += `\n\n🌐 Web Search Results:\n` + webResults.map(r => `• ${r}`).join("\n");
          }

          const normalized = normalizePair(query);
          if (normalized) {
            const { fetchPriceData } = await import("./price-service");
            const { generateTechnicalIndicators } = await import("./signals-worker");
            
            const priceInfo = await fetchPriceData(normalized).catch(() => null);
            if (priceInfo) {
              const num = parseFloat(priceInfo.price);
              const formatted = isNaN(num) ? priceInfo.price : num.toLocaleString('en-US', { maximumFractionDigits: 8 });
              enrichedQuery += `\n\n💱 Price Data:\n- Current price for ${normalized}: ${formatted} ${priceInfo.quote}\n- Source: ${priceInfo.source}`;
            }
            
            // Add real technical indicators
            const indicators = await generateTechnicalIndicators(normalized, priceInfo).catch(() => null);
            if (indicators) {
              enrichedQuery += `\n\n📊 Technical Indicators:\n` +
                `- EMA(9): ${indicators.ema9}\n` +
                `- EMA(21): ${indicators.ema21}\n` +
                `- RSI(14): ${indicators.rsi}\n` +
                `- MACD: ${indicators.macd}\n` +
                `- Bollinger Bands: Upper=${indicators.bbUpper}, Middle=${indicators.bbMiddle}, Lower=${indicators.bbLower}\n` +
                `- ATR: ${indicators.atr}\n` +
                `- Supertrend: ${indicators.supertrend} (${indicators.supertrendDirection})\n` +
                `- VWAP: ${indicators.vwap}\n` +
                `- Ichimoku: Conversion=${indicators.ichimokuConversion}, Base=${indicators.ichimokuBase}`;
            }
          }
        } catch (e) {
          log(`Error enriching AI query: ${e}`, "telegram");
        }

        // use mock AI only if real API is not available
        if (aiModule.aiMockMode) {
          const mockResponse = aiModule.mockAiResponse('default');
          bot.sendMessage(chatId, mockResponse, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        try {
          // Check if query needs current information (web search)
          const needsWebSearch = /\b(current|now|today|latest|recent|news|update|happening|situation|status)\b/i.test(enrichedQuery) && 
                                !/\b(analyze|chart|technical|indicator|price|crypto|token|trading)\b/i.test(enrichedQuery);
          
          let webSearchResults: string[] = [];
          if (needsWebSearch) {
            try {
              // Perform enhanced web search for current information
              webSearchResults = await searchCurrentInfo(enrichedQuery).catch(() => []);
              if (webSearchResults.length === 0) {
                // Fallback: try a more specific search
                const fallbackQuery = enrichedQuery.replace(/\b(what's|what is|tell me about|give me info on)\b/gi, '').trim();
                webSearchResults = await searchCurrentInfo(`${fallbackQuery} current news latest updates`).catch(() => []);
              }
            } catch (searchError) {
              log(`Web search error: ${searchError}`, "telegram");
            }
          }

          // include conversation history after system prompt
          const history = getHistory(chatId.toString());
          const messages: any[] = [
            { role: "system", content: `You are a knowledgeable assistant that can answer any question on any topic. Provide helpful, accurate, and detailed responses. Current date: ${new Date().toISOString()}. If the user asks about trading, crypto, forex, or meme coins, provide expert analysis using institutional frameworks and on-chain research. You can analyze any token, including new meme coins, by researching their properties and community. Otherwise, simply answer their question directly and comprehensively.` },
            ...history
          ];

          // Add web search results if available
          if (webSearchResults.length > 0) {
            messages.push({ role: 'user', content: `Current web search results for context:\n${webSearchResults.map(r => `• ${r}`).join('\n')}\n\nBased on this current information and your knowledge, please answer: ${enrichedQuery}` });
          } else {
            messages.push({ role: 'user', content: enrichedQuery });
          }

          const response = await aiModule.openRouterClient.chat.completions.create({
            model: "anthropic/claude-3.5-sonnet",
            messages,
            max_tokens: 1000
          });
          const answer = response.choices[0].message?.content || "No response.";
          bot.sendMessage(chatId, answer, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          addToHistory(chatId.toString(), 'assistant', answer);
        } catch (e: any) {
          log(`AI chat error: ${e.message} ${JSON.stringify(e.response?.data)}`, "telegram");
          if (e.response?.status === 401) {
            // fallback to mock mode
            const mockResponse = aiModule.mockAiResponse('default');
            bot.sendMessage(chatId, mockResponse, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          } else {
            bot.sendMessage(chatId, `❌ AI Error: ${e.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          }
        }
        return;
      }

      // Define /news command
      if (msg.text?.startsWith('/news ')) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        const query = msg.text.slice(6).trim();
        if (!query) {
          bot.sendMessage(chatId, "❌ Please provide a search term, e.g. <code>/news BTC price</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        bot.sendMessage(chatId, "📰 <b>Fetching news...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        try {
          const newsResults = await searchWeb(query);
          if (newsResults.length === 0) {
            bot.sendMessage(chatId, "❌ No news found for that query.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          } else {
            const newsMsg = `📰 <b>News for "${query}"</b>\n\n${newsResults.map(r => `• ${r}`).join('\n')}`;
            bot.sendMessage(chatId, newsMsg, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          }
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ Error fetching news: ${e.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text && msg.text.length && !msg.text.includes(' ')) {
        if (!(await checkAiLane())) return;
        const candidate = msg.text.trim();
        let mint: string | null = null;
        // solana base58 (approx 32-44 chars, alphanumeric)
        if (/^[A-Za-z0-9]{32,44}$/.test(candidate)) {
          try {
            new PublicKey(candidate);
            mint = candidate;
          } catch {}        
        }
        // ethereum/bsc style
        if (!mint && /^0x[a-fA-F0-9]{40}$/.test(candidate)) {
          mint = candidate;
        }
        if (mint) {
          await sendTokenOverview(chatId, mint, undefined, msg.message_thread_id);
          return;
        }
      }

      // Handle other unrecognized or unsupported commands silently
      if (msg.text?.startsWith('/buy') || msg.text?.startsWith('/sell') || msg.text === '/wallet' || msg.text === '/withdraw') {
        // These commands are not available in this version
        return;
      }

      if (msg.text === '/bind' || msg.text?.startsWith('/bind ')) {
        // /bind is admin-only
        if (!isAdmin(userId)) {
          bot.sendMessage(chatId, "❌ <code>/bind</code> is restricted to administrators.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        const parts = msg.text.split(' ');
        if (parts.length < 2) {
          bot.sendMessage(chatId, "❌ Usage: <code>/bind [market]</code>\nMarkets: <code>crypto, forex, ai</code>\n\nNote: <code>/ai</code> can be bound multiple times (once per topic/group pair)", { parse_mode: 'HTML' });
          return;
        }
        const lane = parts[1].toLowerCase();
        const market = (lane === 'forex') ? 'forex' : (lane === 'crypto' ? 'crypto' : (lane === 'ai' ? 'ai' : null));
        
        if (!market) {
          bot.sendMessage(chatId, "❌ Invalid market. Use <code>crypto</code>, <code>forex</code>, or <code>ai</code>.", { parse_mode: 'HTML' });
          return;
        }

        try {
          const groupIdStr = chatId.toString().trim();
          log(`Attempting to bind for group ${groupIdStr}, market: ${market}`, "telegram");

          // For AI, allow multiple bindings (in case different topics/groups want separate AI instances)
          // For crypto/forex, restrict to one binding per group
          if (market !== 'ai') {
            const existing = await db.select().from(groupBindings).where(
              and(
                eq(groupBindings.groupId, groupIdStr),
                eq(groupBindings.market, market)
              )
            ).limit(1);

            if (existing.length > 0) {
              await db.update(groupBindings).set({
                topicId: msg.message_thread_id?.toString() || null,
                lane: market
              }).where(eq(groupBindings.id, existing[0].id));
            } else {
              await db.insert(groupBindings).values({
                groupId: groupIdStr,
                topicId: msg.message_thread_id?.toString() || null,
                lane: market,
                market: market,
                createdAt: Date.now()
              });
            }
          } else {
            // For AI: allow multiple bindings in different topics
            const topicId = msg.message_thread_id?.toString() || null;
            const existing = await db.select().from(groupBindings).where(
              and(
                eq(groupBindings.groupId, groupIdStr),
                eq(groupBindings.market, 'ai'),
                eq(groupBindings.topicId, topicId || '')
              )
            ).limit(1);

            if (existing.length > 0) {
              await db.update(groupBindings).set({
                lane: 'ai'
              }).where(eq(groupBindings.id, existing[0].id));
            } else {
              await db.insert(groupBindings).values({
                groupId: groupIdStr,
                topicId: topicId,
                lane: 'ai',
                market: 'ai',
                createdAt: Date.now()
              });
            }
          }

          let response = `✅ <b>Group Bound!</b>\nMarket: <code>${market}</code>\nTopic: <code>${msg.message_thread_id || 'Main'}</code>`;
          if (market !== 'ai') {
            response += `\n\n⏱ <i>Cooldown active: Scanning for new institutional setups in 10m...</i>`;
          }
          if (market === 'ai') {
            response += `\n\nℹ️ The <code>/ai</code> command can be bound in multiple groups/topics. All users in this group can now use the unrestricted AI assistant.`;
          }
          bot.sendMessage(chatId, response, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (dbErr: any) {
          log(`Bind error: ${dbErr.message}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Database error during binding.</b> Please ensure the bot is admin.", { parse_mode: 'HTML' });
        }
        return;
      }

      if (msg.text === '/unbind' || msg.text?.startsWith('/unbind ')) {
        const parts = msg.text.trim().split(/\s+/);
        const market = parts[1]?.toLowerCase();
        
        try {
          const groupIdStr = chatId.toString().trim();
          log(`Attempting to unbind for group ${groupIdStr}, market: ${market || 'ALL'}`, "telegram");
          
          if (market === 'crypto' || market === 'forex' || market === 'ai') {
            const deleted = await db.delete(groupBindings).where(
              and(
                or(
                  eq(groupBindings.groupId, groupIdStr),
                  eq(groupBindings.groupId, groupIdStr.replace("-100", "")),
                  eq(groupBindings.groupId, groupIdStr.includes("-100") ? groupIdStr : `-100${groupIdStr}`)
                ),
                eq(groupBindings.market, market)
              )
            ).returning();
            log(`Successfully unbound market ${market} for group ${groupIdStr}. Deleted rows: ${deleted.length}`, "telegram");
          } else {
            const deleted = await db.delete(groupBindings).where(
              or(
                eq(groupBindings.groupId, groupIdStr),
                eq(groupBindings.groupId, groupIdStr.replace("-100", "")),
                eq(groupBindings.groupId, groupIdStr.includes("-100") ? groupIdStr : `-100${groupIdStr}`)
              )
            ).returning();
            log(`Successfully unbound ALL markets for group ${groupIdStr}. Deleted rows: ${deleted.length}`, "telegram");
          }

          bot.sendMessage(chatId, `✅ <b>Group Unbound!</b>${market && (market === 'crypto' || market === 'forex' || market === 'ai') ? `\nMarket: <code>${market}</code>` : '\nAll markets unbound.'}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (dbErr: any) {
          log(`Unbind error: ${dbErr.message}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Database error during unbinding.</b>", { parse_mode: 'HTML' });
        }
        return;
      }

      if (msg.text?.startsWith('/help') || msg.text?.startsWith('/start') || msg.text === '/menu') {
        const signalInterval = process.env.SIGNAL_UPDATE_INTERVAL_MIN || '15';
        const helpMessage = `🏛️ <b>SMC Trading Bot - Command Guide</b>\n\n` +
          `<b>Core Commands:</b>\n` +
          `• /start - Access the main trading dashboard\n` +
          `• /analyze [pair] - Get a deep-dive institutional analysis\n` +
          `• /setup [pair] - Find a neutral breakout/pullback setup\n` +
          `• /p [pair] - Quick price lookup for crypto or forex\n` +
          `• /ai [query] - Ask the AI specialist any trading question (internet-enabled search with memory)\n` +
          `• Limits: 1 signal/day & max 3 open signals per market (crypto/forex)\n\n` +
          `<b>Advanced Features:</b>\n` +
          `• Institutional signals (min 1:3 reward/risk) generated using enhanced confluence (EMA, RSI, MACD, ATR, Fibonacci, VWAP, Ichimoku, Bollinger, Supertrend, etc.)\n` +
          `• Send/Reply to a <b>Chart Image</b> with <code>/analyze</code> or <code>/setup</code> for visual AI analysis.\n` +
          `• Paste a <b>Token Contract/Mint</b> (Solana, Ethereum, BNB, etc.) for a quick overview and AI credibility research.\n` +
          `• You can benefit from analyzing crypto tokens and trading opportunities shown in screenshots - just paste them or use commands on the pairs!\n` +
          `• Meme-coin signals available via our other bot (60-85% assurance).\n\n` +
          `<b>Usage & Support:</b>\n` +
          `• Free users: 2 command uses per day.\n` +
          `• Want unlimited access? Upgrade here: https://t.me/onlysubsbot?start=mTVmGRKJjehzHMqZCnxkU\n` +
          `• Questions? Ask in our support group: https://t.me/CoinHunterAIBot\n\n` +
          `<i>Note: Signals are posted automatically to bound groups every ${signalInterval}m. AI commands are restricted to the AI topic if bound.</i>`;
        
        if (isPrivate) {
          // always show full help on /start or /help in private chat (supports payloads)
          if (msg.text?.startsWith('/help') || msg.text?.startsWith('/start')) {
            bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
          } else {
            // other private messages show dashboard/menu
            await sendMainMenu(chatId, userId);
          }
        } else if (msg.text?.startsWith('/help') || msg.text?.startsWith('/start')) {
          bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text === '/settings') {
        const keyboard = [
          [{ text: "🔒 Security & MEV", callback_data: "settings_mev" }],
          [{ text: "🎯 Auto TP/SL", callback_data: "settings_tpsl" }],
          [{ text: "🔑 Wallet Export", callback_data: "settings_export" }],
          [{ text: "🔙 Back to Menu", callback_data: "main_menu" }]
        ];
        bot.sendMessage(chatId, "⚙️ <b>Bot Settings</b>\n\nConfigure your trading preferences below:", { 
          parse_mode: 'HTML', 
          reply_markup: { inline_keyboard: keyboard } 
        });
        return;
      }

      if (msg.text?.startsWith('/history')) {
        log(`/history command: userId=${userId}, adminIds=${JSON.stringify(adminIds)}`, "telegram");
        if (!isAdmin(userId)) {
          log(`Access denied for /history: ${userId} not in ${JSON.stringify(adminIds)}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Access Denied</b>\n\nThis command is restricted to administrators.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        const parts = msg.text.trim().split(/\s+/);
        let days = 0;
        if (parts.length > 1) {
          const num = parseInt(parts[1]);
          const unit = parts[2]?.toLowerCase();
          if (!isNaN(num) && unit) {
            if (unit.startsWith('day')) days = num;
            else if (unit.startsWith('week')) days = num * 7;
            else if (unit.startsWith('month')) days = num * 30;
            else if (unit.startsWith('year')) days = num * 365;
          }
        }
        
        // Get both trades and signals (completed ones with TP/SL hits)
        const trades = await db.select().from(tradesTable);
        const allSignals = await storage.getSignals();
        const completedSignals = allSignals.filter(s => s.status === "completed");
        
        let filteredTrades = trades;
        let filteredSignals = completedSignals;
        
        if (days > 0) {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - days);
          filteredTrades = trades.filter(t => new Date(t.createdAt) >= cutoff);
          filteredSignals = completedSignals.filter(s => new Date(s.lastUpdateAt || s.createdAt) >= cutoff);
        }
        
        if (filteredTrades.length === 0 && filteredSignals.length === 0) {
          bot.sendMessage(chatId, `📜 <b>Trade & Signal History</b>\n\nNo trades or completed signals found${days > 0 ? ` in the last ${days} day(s)` : ''}.`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        
        const tradeHistory = filteredTrades.slice(0, 25).map(t => {
          const pnl = t.status === 'completed' ? (parseFloat(t.amountOut || '0') - parseFloat(t.amountIn || '0')).toFixed(4) : 'Pending';
          return `${t.status === 'completed' ? '✅' : '❌'} ${new Date(t.createdAt).toLocaleDateString()} - ${t.mint.slice(0, 8)}... - ${t.amountIn} SOL - P&L: ${pnl} SOL`;
        });
        
        const signalHistory = filteredSignals.slice(0, 25).map(s => {
          const duration = s.lastUpdateAt && s.createdAt ? (() => {
            const diffMs = new Date(s.lastUpdateAt).getTime() - new Date(s.createdAt).getTime();
            const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            if (days > 0) return `${days}d ${hours}h`;
            if (hours > 0) return `${hours}h ${minutes}m`;
            return `${minutes}m`;
          })() : 'N/A';
          
          const hitType = s.reasoning?.includes('TP') ? '🎯 TP' : '🛑 SL';
          const pnlAmount = parseFloat(s.pnlAmount || "0");
          const pnlPercent = parseFloat(s.pnlPercent || "0");
          const capital = parseFloat(s.capital || "50");
          const leverage = parseFloat(s.leverage || (s.type === 'forex' ? "10" : "15"));
          const pnlDisplay = pnlPercent > 0 ? `✅ +${pnlPercent.toFixed(2)}% (+$${pnlAmount.toFixed(4)})` : 
                           pnlPercent < 0 ? `❌ ${pnlPercent.toFixed(2)}% ($${pnlAmount.toFixed(4)})` : 
                           `⚪ 0.00% ($0.0000)`;
          
          return `${hitType} ${s.symbol} (${s.type}) - 💰 $${capital} @ ${leverage}x - ${new Date(s.createdAt).toLocaleDateString()} - Duration: ${duration} - P&L: ${pnlDisplay}`;
        });
        
        const msgHistory = `📜 <b>Trade & Signal History</b>${days > 0 ? ` (Last ${days} day(s))` : ''}\n\n` +
                          (tradeHistory.length > 0 ? `<b>Trades:</b>\n${tradeHistory.join('\n')}\n\n` : '') +
                          (signalHistory.length > 0 ? `<b>Completed Signals (TP/SL Hits):</b>\n${signalHistory.join('\n')}` : '');
        
        bot.sendMessage(chatId, msgHistory, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        return;
      }

      if (msg.text === '/progress' || msg.text?.startsWith('/progress ')) {
        bot.sendMessage(chatId, "📊 <b>Loading Ongoing Signals...</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        try {
          const { fetchPriceData } = await import("./price-service");
          
          // Fetch all active signals
          const allSignals = await storage.getSignals();
          const activeSignals = allSignals.filter(s => s.status === "active");
          
          if (activeSignals.length === 0) {
            bot.sendMessage(chatId, "📊 <b>Ongoing Signals</b>\n\n✅ No active signals. All signals completed or stopped.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
            return;
          }

          let progressMsg = `📊 <b>ONGOING SIGNALS</b>\n`;
          progressMsg += `═══════════════════════════════\n\n`;
          let totalPnL = 0;
          let totalPnLPercent = 0;
          let signalCount = 0;

          for (const signal of activeSignals) {
            try {
              const entryPrice = parseFloat(signal.entryPrice || "0");
              const capital = parseFloat(signal.capital || "50");
              const leverage = parseFloat(signal.leverage || (signal.type === 'forex' ? "10" : "15"));
              const positionSize = parseFloat(signal.positionSize || (capital * leverage).toString());
              const fees = parseFloat(signal.fees || "0.001");
              const tp = parseFloat(signal.tp1 || "0");
              const sl = parseFloat(signal.sl || "0");

              if (entryPrice <= 0 || capital <= 0) continue;

              signalCount++;

              // Get current price
              let currentPrice = 0;
              try {
                const priceData = await fetchPriceData(signal.symbol).catch(() => null);
                if (priceData) {
                  currentPrice = parseFloat(priceData.price);
                }
              } catch (e) {
                log(`Error fetching price for ${signal.symbol}: ${e}`, "telegram");
              }

              // Calculate PNL using proper formulas
              let pnlAmount = 0;
              let pnlPercent = 0;
              let priceStatus = "❓";

              if (currentPrice > 0) {
                if (signal.type === 'forex') {
                  // Forex PnL: (Exit Price – Entry Price) × Lot Size × Pip Value
                  const lotSize = parseFloat(signal.lotSize || (capital / 1000).toString());
                  const pipValue = parseFloat(signal.pipValue || (lotSize * 10).toString());
                  const priceDiff = currentPrice - entryPrice;
                  const pipDiff = priceDiff * 10000; // Convert to pips
                  pnlAmount = pipDiff * pipValue;
                } else {
                  // Crypto PnL: (Exit Price – Entry Price) × Position Size
                  const priceDiff = currentPrice - entryPrice;
                  const assetQuantity = positionSize / entryPrice;
                  pnlAmount = priceDiff * assetQuantity;
                }

                pnlPercent = (pnlAmount / capital) * 100;
                totalPnL += pnlAmount;
                totalPnLPercent += pnlPercent;

                if (currentPrice >= tp && tp > 0) {
                  priceStatus = "🎯 AT/ABOVE TP";
                } else if (currentPrice <= sl && sl > 0) {
                  priceStatus = "🛑 AT/BELOW SL";
                } else if (pnlAmount > 0) {
                  priceStatus = "📈 PROFIT";
                } else {
                  priceStatus = "📉 LOSS";
                }
              } else {
                priceStatus = "⚠️ PRICE UNAVAILABLE";
              }

              // Calculate duration
              const now = Date.now();
              const createdTime = signal.createdAt instanceof Date ? signal.createdAt.getTime() : new Date(signal.createdAt).getTime();
              const diffMs = now - createdTime;
              const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
              const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
              const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
              
              let duration = "";
              if (days > 0) duration = `${days}d ${hours}h`;
              else if (hours > 0) duration = `${hours}h ${minutes}m`;
              else duration = `${minutes}m`;

              const pnlColor = pnlPercent > 0 ? "✅" : pnlPercent < 0 ? "❌" : "⚪";
              const pnlDisplay = pnlPercent.toFixed(2);

              progressMsg += `<b>#${signalCount} ${signal.symbol}</b> (${signal.type.toUpperCase()})\n`;
              progressMsg += `${priceStatus} • Duration: ${duration}\n`;
              progressMsg += `💰 Capital: $${capital.toFixed(2)} | Leverage: ${leverage}x\n`;
              progressMsg += `💱 Entry: ${entryPrice.toFixed(signal.type === 'forex' ? 5 : 8)} → Current: ${currentPrice > 0 ? currentPrice.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'}\n`;
              progressMsg += `${pnlColor} <b>P&L: ${pnlDisplay}% (${pnlAmount > 0 ? '+' : ''}${pnlAmount.toFixed(4)} USD)</b>\n`;
              progressMsg += `🎯 TP: ${tp > 0 ? tp.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'} | 🛑 SL: ${sl > 0 ? sl.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'}\n`;
              progressMsg += `───────────────────────────\n`;
            } catch (signalErr: any) {
              log(`Error processing signal ${signal.id}: ${signalErr.message}`, "telegram");
              continue;
            }
          }

          progressMsg += `\n<b>═════════════════════════════</b>\n`;
          progressMsg += `📊 <b>PORTFOLIO P&L</b>\n`;
          const portfolioColor = totalPnLPercent > 0 ? "✅" : totalPnLPercent < 0 ? "❌" : "⚪";
          progressMsg += `${portfolioColor} <b>Total: ${totalPnLPercent.toFixed(2)}% (${totalPnL > 0 ? '+' : ''}${totalPnL.toFixed(4)} USD)</b>\n`;
          progressMsg += `📈 Active Signals: ${signalCount}`;

          bot.sendMessage(chatId, progressMsg, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        } catch (err: any) {
          log(`Progress command error: ${err.message}`, "telegram");
          bot.sendMessage(chatId, `❌ <b>Error</b>\n\nCould not fetch ongoing signals: ${err.message}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text?.startsWith('/cleardb')) {
        log(`/cleardb command: userId=${userId}, adminIds=${JSON.stringify(adminIds)}`, "telegram");
        if (!isAdmin(userId)) {
          log(`Access denied for /cleardb: ${userId} not in ${JSON.stringify(adminIds)}`, "telegram");
          bot.sendMessage(chatId, "❌ <b>Access Denied</b>\n\nThis command is restricted to administrators.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        const parts = msg.text.split(' ');
        if (parts.length === 1) {
          pendingClears.set(userId.toString(), true);
          bot.sendMessage(chatId, "⚠️ <b>DANGER: Database Clear</b>\n\nThis will permanently delete ALL data including trades, signals, users, wallets, and settings.\n\nReply with <code>/cleardb y</code> to confirm or <code>/cleardb n</code> to cancel.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }
        if (parts[1] === 'y' && pendingClears.get(userId.toString())) {
          // Clear all tables
          await db.delete(tradesTable);
          await db.delete(signalsTable);
          await db.delete(walletsTable);
          await db.delete(userLanes);
          await db.delete(groupBindings);
          await db.delete(users);
          bot.sendMessage(chatId, "✅ <b>Database Cleared</b>\n\nAll data has been permanently deleted.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          pendingClears.delete(userId.toString());
        } else if (parts[1] === 'n') {
          pendingClears.delete(userId.toString());
          bot.sendMessage(chatId, "❌ <b>Database Clear Cancelled</b>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.photo && (msg.caption?.startsWith('/analyze') || msg.caption?.startsWith('/setup') || msg.text?.startsWith('/analyze') || msg.text?.startsWith('/setup'))) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        const parts = msg.caption.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        
        // Handle image analysis
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        
        bot.sendMessage(chatId, `⏳ <b>Analyzing chart image for ${pair || 'detected pair'}...</b>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        
        const workerModule = await import("./signals-worker") as any;
        const aiModule = await import("./ai") as any;
        const worker = workerModule.default || workerModule;
        const ai = aiModule.default || aiModule;
        
        let targetPair: string | undefined = pair;
        if (!targetPair) {
          const detected = await ai.extractPairFromImage(fileLink);
          targetPair = detected || undefined;
        }

        const resolved = await resolveMarketForPair(targetPair, worker);
        if (resolved.note) {
          bot.sendMessage(chatId, `ℹ️ ${resolved.note}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        if (resolved.pair) {
          bot.sendMessage(chatId, `✅ Detected trading pair: <b>${resolved.pair}</b> (using ${resolved.marketType}). Proceeding with analysis...`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }

        const ok = await worker.runScanner(resolved.marketType, true, chatId.toString(), msg.message_thread_id?.toString(), resolved.pair, command as "analyze" | "setup", fileLink);
        if (!ok) {
          bot.sendMessage(chatId, "⚠️ Unable to complete analysis at this time.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      // Support video uploads for /analyze and /setup (uses media URL)
      if (msg.video && (msg.caption?.startsWith('/analyze') || msg.caption?.startsWith('/setup'))) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        const parts = msg.caption.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        const fileLink = await bot.getFileLink(msg.video.file_id);

        bot.sendMessage(chatId, `⏳ <b>Analyzing chart video for ${pair || 'detected pair'}...</b>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });

        const workerModule = await import("./signals-worker") as any;
        const aiModule = await import("./ai") as any;
        const worker = workerModule.default || workerModule;
        const ai = aiModule.default || aiModule;

        let targetPair: string | undefined = pair;
        if (!targetPair) {
          const detected = await ai.extractPairFromMedia(fileLink, true);
          targetPair = detected || undefined;
        }

        const resolved = await resolveMarketForPair(targetPair, worker);
        if (resolved.note) {
          bot.sendMessage(chatId, `ℹ️ ${resolved.note}`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        if (resolved.pair) {
          bot.sendMessage(chatId, `✅ Detected trading pair: <b>${resolved.pair}</b> (using ${resolved.marketType}). Proceeding with analysis...`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }

        if (!resolved.pair) {
          bot.sendMessage(chatId, "❌ <b>Could not detect trading pair from video.</b> Please provide it manually: <code>/analyze BTC/USDT</code>", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        const ok = await worker.runScanner(resolved.marketType, true, chatId.toString(), msg.message_thread_id?.toString(), resolved.pair, command as "analyze" | "setup", fileLink);
        if (!ok) {
          bot.sendMessage(chatId, "⚠️ Unable to complete analysis at this time.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.text?.startsWith('/analyze') || msg.text?.startsWith('/setup')) {
        if (!(await checkAiLane())) return;
        if (!(await checkCommandLimit())) return;
        const parts = msg.text.split(' ');
        const command = parts[0].replace('/', '');
        const pair = parts[1]?.toUpperCase();
        
        if (!pair) {
          bot.sendMessage(chatId, `❌ Please provide a pair, e.g. <code>/${command} BTC/USDT</code>`, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
          return;
        }

        const feedbackMsg = command === 'setup' 
          ? `⏳ <b>Hang on while we generate a NEUTRAL setup for you...</b>`
          : `⏳ <b>Hang on while we perform a NEUTRAL analysis for you...</b>`;
          
        bot.sendMessage(chatId, feedbackMsg, { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        const workerModule = await import("./signals-worker") as any;
        const worker = workerModule.default || workerModule;
        
        // Robust market type detection
        const forexSymbols = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'USD', 'XAU', 'XAG'];
        const symPrefix = pair.slice(0, 3);
        const isForex = forexSymbols.includes(symPrefix) || (pair.includes('/') && (forexSymbols.includes(pair.split('/')[0]) || forexSymbols.includes(pair.split('/')[1])));
        const marketType = isForex ? "forex" : "crypto";
        
        // Ensure pair has a slash for scanner consistency if it doesn't already
        let normalizedPair = pair;
        if (!pair.includes('/') && pair.length >= 6) {
          normalizedPair = `${pair.slice(0, pair.length - 4)}/${pair.slice(pair.length - 4)}`;
        }
        
        log(`Manual command: ${command} for ${normalizedPair} (${marketType})`, "telegram");
        const ok = await worker.runScanner(marketType, true, chatId.toString(), msg.message_thread_id?.toString(), normalizedPair, command as "analyze" | "setup");
        if (!ok) {
          bot.sendMessage(chatId, "⚠️ Unable to complete analysis at this time.", { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
        }
        return;
      }

      if (msg.reply_to_message && msg.text) {
        const replyText = msg.reply_to_message.text || "";
        if (replyText.includes("Please paste the token's Solana contract address (Mint)")) {
          const mint = msg.text.trim();
          try {
            new PublicKey(mint);
            await sendTokenOverview(chatId, mint);
          } catch (e) {
            bot.sendMessage(chatId, "❌ <b>Invalid Solana address.</b> Please try again.", { parse_mode: 'HTML' });
          }
        } else if (replyText.includes("Please enter the token's contract address")) {
          await sendTokenOverview(chatId, msg.text.trim());
        } else if (replyText.includes("Please reply to this message with the Solana destination address")) {
          const address = msg.text.trim();
          try {
            new PublicKey(address);
            bot.sendMessage(chatId, `💰 <b>Withdrawal</b>\nAddress: <code>${address}</code>\n\nPlease reply to this message with the amount of SOL to withdraw:`, { 
              parse_mode: 'HTML', 
              reply_markup: { force_reply: true } 
            });
          } catch (e) {
            bot.sendMessage(chatId, "❌ <b>Invalid Solana Address.</b> Please try again.", { parse_mode: 'HTML' });
          }
        } else if (replyText.includes("Please reply to this message with the amount of SOL to withdraw")) {
          const amount = parseFloat(msg.text);
          const addressMatch = replyText.match(/Address: <code>(.*?)<\/code>/);
          if (!isNaN(amount) && addressMatch) {
            const address = addressMatch[1];
            try {
              const activeWallet = await storage.getActiveWallet(userId);
              if (!activeWallet) throw new Error("No active wallet.");
              
              const connection = new Connection(rpcUrl, "confirmed");
              const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
              const lamports = Math.floor(amount * 1e9);
              
              if (balance < lamports + 5000) throw new Error("Insufficient balance for withdrawal + fees.");
              
              const transaction = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: new PublicKey(activeWallet.publicKey),
                  toPubkey: new PublicKey(address),
                  lamports: lamports,
                })
              );
              
              const keypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
              const signature = await connection.sendTransaction(transaction, [keypair]);
              await connection.confirmTransaction(signature);
              
              // Update balance immediately after withdrawal
              const newBal = await connection.getBalance(new PublicKey(activeWallet.publicKey));
              await storage.updateWalletBalance(activeWallet.id, (newBal / 1e9).toFixed(3));

              bot.sendMessage(chatId, `✅ <b>Withdrawal Successful!</b>\n\nTX: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
            } catch (e: any) {
              bot.sendMessage(chatId, `❌ <b>Withdrawal Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
            }
          }
        }
      }

    } catch (e: any) {
      log(`Message error: ${e.message}`, "telegram");
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    if (!chatId || !data) return;

    try {
      if (data === "main_menu") {
        await sendMainMenu(chatId, userId, query.message?.message_id);
      } else if (data === "main_menu_refresh") {
        await sendMainMenu(chatId, userId, query.message?.message_id);
        bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
      } else if (data === "under_construction") {
        bot.answerCallbackQuery(query.id, { text: "🚧 Under Construction" });
        bot.sendMessage(chatId, "🚧 <b>Under Construction</b>\n\nThis feature is currently under development. Please check back later.", { parse_mode: 'HTML' });
      } else if (data === "menu_settings") {
        const keyboard = [
          [{ text: "🔒 Security & MEV", callback_data: "settings_mev" }],
          [{ text: "🎯 Auto TP/SL", callback_data: "settings_tpsl" }],
          [{ text: "🔑 Wallet Export", callback_data: "settings_export" }],
          [{ text: "🔙 Back to Menu", callback_data: "main_menu" }]
        ];
        try {
          await bot.editMessageText("⚙️ <b>Bot Settings</b>\n\nConfigure your trading preferences below:", { 
            chat_id: chatId, 
            message_id: query.message?.message_id,
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: keyboard } 
          });
        } catch (e: any) {
          if (!e.message.includes("message is not modified")) throw e;
        }
      } else if (data === "menu_history") {
        const trades = await storage.getTrades(userId);
        if (trades.length === 0) {
          bot.sendMessage(chatId, "📜 <b>Trade History</b>\n\nYou have no trade history.", { parse_mode: 'HTML' });
        } else {
          const msgHistory = `📜 <b>Trade History</b>\n\n` +
                     trades.slice(0, 10).map(t => `${t.status === 'completed' ? '✅' : '❌'} ${t.mint.slice(0, 8)}... - ${t.amountIn} SOL`).join('\n');
          bot.sendMessage(chatId, msgHistory, { parse_mode: 'HTML' });
        }
        bot.answerCallbackQuery(query.id);
      } else if (data === "menu_progress") {
        bot.sendMessage(chatId, "📊 <b>Loading Ongoing Signals...</b>", { parse_mode: 'HTML' });
        try {
          const { fetchPriceData } = await import("./price-service");
          const allSignals = await storage.getSignals();
          const activeSignals = allSignals.filter(s => s.status === "active");
          
          if (activeSignals.length === 0) {
            bot.sendMessage(chatId, "📊 <b>Ongoing Signals</b>\n\n✅ No active signals. All signals completed or stopped.", { parse_mode: 'HTML' });
            bot.answerCallbackQuery(query.id);
            return;
          }

          let progressMsg = `📊 <b>ONGOING SIGNALS</b>\n`;
          progressMsg += `═══════════════════════════════\n\n`;
          let totalPnL = 0;
          let totalPnLPercent = 0;
          let signalCount = 0;

          for (const signal of activeSignals) {
            try {
              const entryPrice = parseFloat(signal.entryPrice || "0");
              const capital = parseFloat(signal.capital || "50");
              const leverage = parseFloat(signal.leverage || (signal.type === 'forex' ? "10" : "15"));
              const positionSize = parseFloat(signal.positionSize || (capital * leverage).toString());
              const fees = parseFloat(signal.fees || "0.001");
              const tp = parseFloat(signal.tp1 || "0");
              const sl = parseFloat(signal.sl || "0");

              if (entryPrice <= 0 || capital <= 0) continue;

              signalCount++;

              let currentPrice = 0;
              try {
                const priceData = await fetchPriceData(signal.symbol).catch(() => null);
                if (priceData) {
                  currentPrice = parseFloat(priceData.price);
                }
              } catch (e) {
                log(`Error fetching price for ${signal.symbol}: ${e}`, "telegram");
              }

              let pnlAmount = 0;
              let pnlPercent = 0;
              let priceStatus = "❓";

              if (currentPrice > 0) {
                if (signal.type === 'forex') {
                  // Forex PnL: (Exit Price – Entry Price) × Lot Size × Pip Value
                  const lotSize = parseFloat(signal.lotSize || (capital / 1000).toString());
                  const pipValue = parseFloat(signal.pipValue || (lotSize * 10).toString());
                  const priceDiff = currentPrice - entryPrice;
                  const pipDiff = priceDiff * 10000; // Convert to pips
                  pnlAmount = pipDiff * pipValue;
                } else {
                  // Crypto PnL: (Exit Price – Entry Price) × Position Size
                  const priceDiff = currentPrice - entryPrice;
                  const assetQuantity = positionSize / entryPrice;
                  pnlAmount = priceDiff * assetQuantity;
                }

                pnlPercent = (pnlAmount / capital) * 100;
                totalPnL += pnlAmount;
                totalPnLPercent += pnlPercent;

                if (currentPrice >= tp && tp > 0) {
                  priceStatus = "🎯 AT/ABOVE TP";
                } else if (currentPrice <= sl && sl > 0) {
                  priceStatus = "🛑 AT/BELOW SL";
                } else if (pnlAmount > 0) {
                  priceStatus = "📈 PROFIT";
                } else {
                  priceStatus = "📉 LOSS";
                }
              } else {
                priceStatus = "⚠️ PRICE UNAVAILABLE";
              }

              const now = Date.now();
              const createdTime = signal.createdAt instanceof Date ? signal.createdAt.getTime() : new Date(signal.createdAt).getTime();
              const diffMs = now - createdTime;
              const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
              const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
              const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
              
              let duration = "";
              if (days > 0) duration = `${days}d ${hours}h`;
              else if (hours > 0) duration = `${hours}h ${minutes}m`;
              else duration = `${minutes}m`;

              const pnlColor = pnlPercent > 0 ? "✅" : pnlPercent < 0 ? "❌" : "⚪";
              const pnlDisplay = pnlPercent.toFixed(2);

              progressMsg += `<b>#${signalCount} ${signal.symbol}</b> (${signal.type.toUpperCase()})\n`;
              progressMsg += `${priceStatus} • Duration: ${duration}\n`;
              progressMsg += `💰 Capital: $${capital.toFixed(2)} | Leverage: ${leverage}x\n`;
              progressMsg += `💱 Entry: ${entryPrice.toFixed(signal.type === 'forex' ? 5 : 8)} → Current: ${currentPrice > 0 ? currentPrice.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'}\n`;
              progressMsg += `${pnlColor} <b>P&L: ${pnlDisplay}% (${pnlAmount > 0 ? '+' : ''}${pnlAmount.toFixed(4)} USD)</b>\n`;
              progressMsg += `🎯 TP: ${tp > 0 ? tp.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'} | 🛑 SL: ${sl > 0 ? sl.toFixed(signal.type === 'forex' ? 5 : 8) : 'N/A'}\n`;
              progressMsg += `───────────────────────────\n`;
            } catch (signalErr: any) {
              log(`Error processing signal ${signal.id}: ${signalErr.message}`, "telegram");
              continue;
            }
          }

          progressMsg += `\n<b>═════════════════════════════</b>\n`;
          progressMsg += `📊 <b>PORTFOLIO P&L</b>\n`;
          const portfolioColor = totalPnLPercent > 0 ? "✅" : totalPnLPercent < 0 ? "❌" : "⚪";
          progressMsg += `${portfolioColor} <b>Total: ${totalPnLPercent.toFixed(2)}% (${totalPnL > 0 ? '+' : ''}${totalPnL.toFixed(4)} USD)</b>\n`;
          progressMsg += `📈 Active Signals: ${signalCount}`;

          bot.sendMessage(chatId, progressMsg, { parse_mode: 'HTML' });
        } catch (err: any) {
          log(`Progress callback error: ${err.message}`, "telegram");
          bot.sendMessage(chatId, `❌ <b>Error</b>\n\nCould not fetch ongoing signals: ${err.message}`, { parse_mode: 'HTML' });
        }
        try {
          await bot.answerCallbackQuery(query.id);
        } catch (e:any) {
          // Telegram query may be expired; ignore
        }
      } else if (data.startsWith('refresh_overview_')) {
        const mint = data.replace('refresh_overview_', '');
        await sendTokenOverview(chatId, mint, query.message?.message_id);
        try {
          await bot.answerCallbackQuery(query.id, { text: "Refreshed!" });
        } catch (e:any) {
          // Telegram query may be expired; ignore
        }
      } else if (data.startsWith('ai_analyze_')) {
        const mint = data.replace('ai_analyze_', '');
        const threadId = query.message?.message_thread_id;
        await executeAiReasoning(chatId, mint, threadId);
        try {
          await bot.answerCallbackQuery(query.id);
        } catch (e:any) {
          // Telegram query may be expired; ignore
        }
      } else if (data === "menu_withdraw") {
        bot.sendMessage(chatId, "💰 <b>Withdraw SOL</b>\n\nPlease reply to this message with the Solana destination address:", { 
          parse_mode: 'HTML', 
          reply_markup: { force_reply: true } 
        });
        try {
          await bot.answerCallbackQuery(query.id);
        } catch (e:any) {
          // Telegram query may be expired; ignore
        }
      }
    } catch (e: any) {
      log(`Callback error: ${e.message}`, "telegram");
    }
  });

  log("Telegram bot setup complete.", "telegram");
}
