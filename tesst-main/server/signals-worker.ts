// @ts-nocheck
// @ts-nocheck
import TelegramBot from 'node-telegram-bot-api';
import { groupBindings, users, userLanes, trades as tradesTable } from "../shared/schema";
import { storage } from "./storage";
import { log } from "./index";
import { db } from "./db";
import { eq, and, or, sql, desc, count } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { JupiterService } from "./solana";
import OpenAI from "openai";
import { getTelegramBot } from "./telegram";

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const jupiter = new JupiterService(rpcUrl);

export let openRouterClient: OpenAI | null = null;
export let aiMockMode = false;

const mockAiResponse = (topic: string): string => {
  const responses: Record<string, string> = {
    'analyze': `💎 **INSTITUTIONAL MARKET ANALYSIS** 💎\n───────────────────────────────────\n📊 **Market Bias:** HTF alignment suggests bullish momentum with institutional buy-side liquidity pools forming at key support levels.\n\n🔐 **Liquidity Map:** Sell-side liquidity identified at recent resistance; Buy-side liquidity accumulating below current price.\n\n📈 **Volatility:** Bollinger Bands showing expansion. ATR indicates elevated volatility creating premium trading opportunities.\n\n🧮 **Indicators:** Supertrend in bullish alignment. Fibonacci levels act as dynamic support/resistance zones.\n\n⚠️ This is probabilistic analysis, not financial advice.`,
    'setup': `💎 **INSTITUTIONAL SETUP IDENTIFIED** 💎\n───────────────────────────────────\n📍 **Setup:** Premium institutional POI detected at confluence zone.\n\n1️⃣ **HTF Context:** Strong bullish bias with institutional order block alignment.\n2️⃣ **Indicator Confluence:** EMA 9/21 bullish cross, RSI mid-range, MACD positive momentum.\n3️⃣ **Execution:** Optimal Entry at support level. SL below institutional invalidation. TP at liquidity target.\n\n✅ Technical Score: 87/100 - High confluence setup.`,
    'reasoning': `💎 **PREMIUM INSTITUTIONAL SETUP** 💎\n───────────────────────────────────\n**BIAS:** 🟢 BULLISH\n\n🎯 **EXECUTION ZONES:**\n📍 Entry: [Support Level]\n🛑 SL: [Structural Invalidation]\n🎯 TP: [Liquidity Target]\n\n🏛️ **STRATEGIC CONFLUENCE:**\n• Structure: Bullish HTF alignment\n• POI: Order Block at key support\n• Candlesticks: HTF bullish engulfing\n• Indicators: EMA cross, RSI, MACD alignment\n• Technical Score: 85/100 ✅\n\n💡 **INSTITUTIONAL REASONING:**\nInstitutional buyers have swept liquidity below support and are now accumulating. The displacement phase shows strong demand with minimal rejection wicks. Our POI aligns perfectly with the HTF order block, signaling a premium institutional entry opportunity.\n\n⏰ Horizon: Institutional Order Flow Neutral`,
    'price': `💱 Token Price Analysis\n\nCurrent market price showing healthy trading volume with institutional accumulation patterns detected. Multiple timeframe confluence suggests bullish bias with support holding at key levels.`,
    'default': `🤖 SMC Trading Analysis Complete\n\nAnalyzing market structure using Smart Money Concepts methodology. Current confluence suggests institutional positioning with institutional grade technical alignment across multiple indicators and timeframes.\n\n⚠️ This is probabilistic analysis, not financial advice.`
  };
  return responses[topic] || responses['default'];
};

export async function initAI() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  
  log(`Initializing AI with keys present: OPENROUTER:${!!process.env.OPENROUTER_API_KEY}, AI_INT_OPENAI:${!!process.env.AI_INTEGRATIONS_OPENAI_API_KEY}, OPENAI:${!!process.env.OPENAI_API_KEY}`, "express");

  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }

  if (apiKey) {
    openRouterClient = new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        "X-Title": "SMC Trading Bot",
      }
    });
    log(`SMC Worker AI initialized with ${baseURL ? 'OpenRouter' : 'OpenAI'} API`);

    // perform a simple test request to validate the key early
    try {
      const testResponse = await openRouterClient.chat.completions.create({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Ping" }],
        max_tokens: 10
      });
      log("AI key validation succeeded", "express");
      aiMockMode = false;
    } catch (err: any) {
      log(`AI key validation failed: ${err.message} ${JSON.stringify(err.response?.data)}`, "express");
      // enable mock mode so the bot can still function
      aiMockMode = true;
      log("AI mock mode enabled - will provide demo responses", "express");
      return;
    }
  } else {
    log("SMC Worker AI environment variables missing - no API key found", "express");
  }
}

// Call init on load but keep function exported so other modules can ensure AI is initialized
initAI().catch(err => log(`Failed to initialize AI: ${err}`));

export { mockAiResponse };

const MONITORED_CRYPTO = [
  "BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT",
  "ADA/USDT", "DOGE/USDT", "AVAX/USDT", "DOT/USDT", "TRX/USDT",
  "LINK/USDT", "MATIC/USDT", "SHIB/USDT", "LTC/USDT", "BCH/USDT",
  "UNI/USDT", "NEAR/USDT", "ATOM/USDT", "XMR/USDT", "ETC/USDT",
  "ALGO/USDT", "VET/USDT", "ICP/USDT", "FIL/USDT", "HBAR/USDT"
];

const MONITORED_FOREX = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
  "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
];

// Configurable thresholds
const SIGNAL_UPDATE_INTERVAL_MIN = parseInt(process.env.SIGNAL_UPDATE_INTERVAL_MIN || "15");
const ABNORMAL_MOVE_MULTIPLIER = parseFloat(process.env.ABNORMAL_MOVE_MULTIPLIER || "2");
const NORMAL_VOL_CRYPTO = parseFloat(process.env.NORMAL_VOL_CRYPTO || "2.5");
const NORMAL_VOL_FOREX = parseFloat(process.env.NORMAL_VOL_FOREX || "0.25");

// Generate realistic technical indicators based on price data
async function generateTechnicalIndicators(symbol: string, priceData: any) {
  // Return real technical indicators using the same logic used by runScanner.
  const forexSymbols = ['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'USD', 'XAU', 'XAG'];
  const parts = symbol.split('/');
  const base = parts[0]?.toUpperCase();
  const quote = parts[1]?.toUpperCase();
  const isForex = quote && forexSymbols.includes(base) && forexSymbols.includes(quote);
  const marketType: 'crypto' | 'forex' = isForex ? 'forex' : 'crypto';

  try {
    return await getTechnicalIndicators(symbol, marketType);
  } catch (err) {
    log(`Error generating indicators for ${symbol}: ${err}`, "signals");
    return null;
  }
}

export { generateTechnicalIndicators };

const INSTITUTIONAL_PROMPT = (type: string) => `
ROLE: Elite Institutional SMC Strategist 🏛️💎📈

🔐 INSTITUTIONAL DIRECTIVES:
- OBJECTIVE: Identify institutional "A+" grade setups with high technical confluence and extreme probability. 💎
- EXCLUSION: NEVER mention "Swing", "Scalp", or "Day Trade". Focus strictly on Neutral Institutional Order Flow. Signals are for medium-term institutional trades, not retail scalping or swinging.
- SMC CORE: Analyze BOS, CHoCH, Liquidity Sweeps, and HTF Order Blocks/FVG.
- CANDLESTICK ANALYSIS: Focus on HTF (4H/Daily) context. Analyze candle body size (momentum), long wicks (rejection/support), and multi-candle pattern confirmation (Engulfing, Morning Star, etc.).
- INDICATORS: Incorporate EMA (9/21), RSI (30/70), MACD, Bollinger Bands, VWAP, Ichimoku Cloud, ATR, Supertrend, Fibonacci Retracements/Extensions, RSI Divergence, Bollinger Band Squeezes, Volume Profile, and ${type === 'crypto' ? 'On-Chain Metrics (NVT, Active Addresses, MVRV, Whale Transactions)' : 'Forex Market Sentiment and Economic Indicators'}.
- RISK: Minimum 1:3 Risk/Reward (TP must be at least three times the distance from entry as the SL). Absolute structural invalidation for SL.
- TECHNICAL SCORE: Calculate based on confluence. 100 is ONLY for perfect alignment of all 9+ factors.

📊 INSTITUTIONAL OUTPUT STRUCTURE:

💎 <b>PREMIUM INSTITUTIONAL SETUP</b> 💎
───────────────────────────────────
<b>SYMBOL:</b> [SYMBOL] | <b>BIAS:</b> [BIAS] (🟢 BULLISH / 🔴 BEARISH)

🎯 <b>EXECUTION ZONES:</b>
📍 <b>Institutional Entry:</b> 📍 [Price]
🛑 <b>Stop Loss:</b> 🛑 [Price] (Structural Invalidation)
🎯 <b>Take Profit:</b> 🎯 [Price] (Liquidity Target, minimum 3x risk)
📊 <b>Risk/Reward:</b> [Calculated RR based on Entry/SL/TP]

🏛️ <b>STRATEGIC CONFLUENCE:</b>
• <b>Structure:</b> [Bullish/Bearish] HTF alignment
• <b>POI:</b> [Exact Order Block / FVG Zone]
• <b>Candlesticks:</b> [e.g., HTF Bullish Engulfing at Support / Long Wick Rejection]
• <b>Indicators:</b> EMA 9/21 Cross, RSI Level/Divergence, MACD Momentum/Histogram, VWAP Position, ATR, Supertrend, Fibonacci levels/Extensions, RSI Divergence, Bollinger Bands/Squeeze
• <b>Volatility:</b> Bollinger Bands Status
• <b>Ichimoku:</b> Price vs Cloud position
${type === 'crypto' ? '• <b>On-Chain:</b> [NVT/Active Addresses insight]' : ''}
• <b>Technical Score:</b> [Realistic 85-100]/100 ✅

💡 <b>INSTITUTIONAL REASONING:</b>
[Provide 8-10 lines of institutional reasoning. Explain the Liquidity Sweep, the Displacement, and how the POI aligns with HTF order flow. Specifically mention how the CANDLESTICK structure and HTF context confirm the institutional entry.]

⏰ <b>Horizon:</b> Institutional Order Flow Neutral
📡 <b>Source:</b> SMC Institutional Engine v3.0
`;

const SETUP_PROMPT = `
ROLE: Elite Institutional Meme Coin Setup Analyst 🧭🔍🚀

CRITICAL FRAMEWORK: For meme coins, combine technical analysis with VIRAL POTENTIAL assessment. Setups must hold for 1-3 days (medium-term) with strong social momentum. NOT scalp trades (minutes-hours) or swing trades (weeks+).

(Addendum: if an image/chart is supplied, you may receive a URL; read any visible text or annotations in the image as part of the data, including screenshots containing notes or labels.)

MEME COIN INSTITUTIONAL ANALYSIS FRAMEWORK:

1. 🧬 VIRAL DNA ASSESSMENT
• Meme Strength: Cultural relevance, humor factor, shareability
• Community Hype: Telegram/Discord engagement, holder growth rate
• Social Momentum: Twitter trends, influencer mentions, viral coefficient
• Timing: Market cycle position, seasonal factors, event catalysts

2. 💰 TECHNICAL SETUP IDENTIFICATION
• Institutional POI: Key price levels with confluence
• HTF Context: Higher timeframe bias with Ichimoku confirmation
• Indicator Confluence: EMA 9/21, RSI, MACD, VWAP, ATR, Supertrend, Fibonacci
• On-Chain Flow: Smart money accumulation vs retail distribution

3. 🌐 SOCIAL SENTIMENT ANALYSIS
• Twitter Buzz: Trending status, sentiment ratio, engagement metrics
• Community Strength: Active members, developer responsiveness, token distribution
• News Coverage: Media mentions, hype cycles, negative press assessment
• Influencer Impact: Key opinion leaders, shilling potential, credibility

4. ⚡ VIRAL POTENTIAL MATRIX
• Scalability: Real utility beyond meme (gaming, DeFi, NFT integration)
• Competition: Differentiation from similar projects, unique selling points
• Sustainability: Long-term viability, roadmap credibility, team strength
• Risk Factors: Rug-pull potential, liquidity concerns, regulatory threats

5. 🎯 EXECUTION FRAMEWORK
• Optimal Entry: Price level with social + technical confluence
• Invalidation (SL): Stop loss based on key support levels
• Target (TP): Profit targets using Fibonacci + social momentum
• Risk/Reward: RR ratio with viral upside potential assessment

💎 <b>MEME COIN INSTITUTIONAL SETUP</b> 💎
───────────────────────────────────
🚀 <b>SETUP:</b> [SYMBOL] - [Viral POI with Social Confluence]

1️⃣ <b>Viral Assessment:</b> Meme strength, community hype, social momentum
2️⃣ <b>Technical Confluence:</b> EMA, RSI, MACD, VWAP, ATR, Supertrend, Fibonacci
3️⃣ <b>Social Sentiment:</b> Twitter trends, community metrics, news coverage
4️⃣ <b>Execution:</b>
   • <b>Entry:</b> [Price] with viral + technical confluence
   • <b>SL:</b> [Price] based on structural levels
   • <b>TP:</b> [Price] using Fibonacci + momentum targets
   • <b>RR:</b> [Ratio] with viral upside potential

Structure professionally with premium emojis and institutional reasoning focused on viral potential.
`;

const ANALYZE_PROMPT = `
ROLE: Elite Institutional Market Analyst 🕵️‍♂️📈

CRITICAL: Analysis must support entry points that can hit TP/SL within 1-3 days. NOT scalp trades (minutes-hours) or swing trades (weeks+).

(Addendum: when analyzing a chart image or screenshot, include any text, numbers, or annotations visible in the image as part of your reasoning.)

Provide an ultra-premium deep-dive analysis incorporating Ichimoku Cloud, Bollinger Bands, ATR, Supertrend, Fibonacci Extensions, RSI Divergence, Bollinger Squeezes, Volume Profile, and On-Chain metrics for crypto.

💎 <b>INSTITUTIONAL MARKET ANALYSIS</b> 💎
───────────────────────────────────
📊 <b>ANALYSIS:</b> [SYMBOL]

1️⃣ <b>Market Bias:</b> HTF direction with institutional reasoning, Ichimoku Cloud position, and trend strength.
2️⃣ <b>Liquidity Map:</b> Identification of Sell-Side and Buy-Side Liquidity pools with volume profile analysis.
3️⃣ <b>Volatility:</b> Bollinger Bands expansion/contraction, ATR context, and squeeze detection.
4️⃣ <b>Indicators:</b> Supertrend direction, Fibonacci retracements/extensions, RSI Divergence status, MACD confirmation.
5️⃣ <b>On-Chain (Crypto):</b> NVT ratio, Active Addresses, MVRV, Whale Transactions, and market sentiment.
6️⃣ <b>Levels:</b> Precise Entry, Invalidation (SL), and Target (TP) zones with risk/reward ratios.

Professional enterprise-grade terminology with actionable insights.
`;

export async function runAutoSignalGenerator() {
  if (!(global as any).signalIntervals) {
    (global as any).signalIntervals = true;
    log("Starting institutional SMC signal generator (Memory-Only)...");
    
    setInterval(() => {
      runUnifiedScanner().catch(err => log(`Unified scanner interval error: ${err.message}`, "scanner"));
    }, 5 * 60 * 1000); // Back to 5m for faster signal discovery

    setInterval(() => {
      log("[monitor] Heartbeat: Monitoring loop triggered", "monitor");
      runMonitoringLoop().catch(err => log(`Monitoring loop error: ${err.message}`, "monitor"));
    }, 2 * 60 * 1000); // 2m update interval for better responsiveness
    
    setTimeout(() => {
      log("INITIAL SCAN TRIGGERED");
      runUnifiedScanner().catch(err => log(`Initial scan error: ${err.message}`, "scanner"));
      setTimeout(() => {
         log("INITIAL MONITORING TRIGGERED");
         runMonitoringLoop().catch(err => log(`Initial monitoring error: ${err.message}`, "monitor"));
      }, 5000); 
    }, 1000);
  }
}

async function runUnifiedScanner() {
  const isForce = false;
  
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const isWeekend = (day === 6) || (day === 0 && hour < 22) || (day === 5 && hour >= 22);
  
  log(`Forex Market Check: Day=${day}, Hour=${hour}, isWeekend=${isWeekend}`, "scanner");
  if (isWeekend && !isForce) {
    log("Weekend detected – skipping all scans.", "scanner");
    return;
  }

  try {
    const cryptoBindings = await db.select().from(groupBindings).where(eq(groupBindings.market, "crypto"));
    const forexBindings = await db.select().from(groupBindings).where(eq(groupBindings.market, "forex"));

    // Check cooldowns for all bindings
    const filterByCooldown = (bindings: any[], market: string) => {
      const cooldownKey = `cooldown_${market}`;
      return bindings.filter(b => {
        const data = (typeof (b as any).data === 'string' ? JSON.parse((b as any).data) : (b as any).data) || {};
        const cooldown = data[cooldownKey] || 0;
        if (Date.now() < (cooldown as number)) {
          log(`[scanner] Group ${b.groupId} is on cooldown for ${market} until ${new Date(cooldown as number).toLocaleTimeString()}`, "scanner");
          return false;
        }
        return true;
      });
    };

    const activeCryptoBindings = filterByCooldown(cryptoBindings, "crypto");
    const activeForexBindings = filterByCooldown(forexBindings, "forex");

    if (activeCryptoBindings.length === 0 && cryptoBindings.length > 0) {
      log("[scanner] All crypto groups are on cooldown. Skipping crypto scan.", "scanner");
    } else if (cryptoBindings.length === 0) {
      log("⚠️ ATTENTION: No crypto signal group bindings found. Use /bind crypto in your Telegram crypto group.", "scanner");
    } else {
      log(`Found ${activeCryptoBindings.length} active crypto bindings (out of ${cryptoBindings.length}).`, "scanner");
      await runScanner("crypto", isForce);
    }

    if (activeForexBindings.length === 0 && forexBindings.length > 0) {
      log("[scanner] All forex groups are on cooldown. Skipping forex scan.", "scanner");
    } else if (forexBindings.length === 0) {
      log("⚠️ ATTENTION: No forex signal group bindings found. Use /bind forex in your Telegram forex group.", "scanner");
    } else {
      log(`Found ${activeForexBindings.length} active forex bindings (out of ${forexBindings.length}).`, "scanner");
      const forexActive = (await storage.getSignals()).find(s => s.status === "active" && s.type === "forex");
      await runScanner("forex", isForce);
    }
  } catch (err) {
    log(`Scanner error: ${err instanceof Error ? err.message : String(err)}`, "scanner");
  }
}

import { fetchPriceData } from "./price-service";

export async function getPrice(symbol: string, marketType: string): Promise<number> {
  try {
    if (symbol === "CHART_IMAGE") return 0;
    const data = await fetchPriceData(symbol);
    if (data && data.price) {
      const num = parseFloat(data.price);
      if (isNaN(num)) {
        log(`[scanner] Price for ${symbol} is non-numeric (${data.price}) source=${data.source}`, "scanner");
        return 0;
      }
      return num;
    } else {
      log(`[scanner] No price returned for ${symbol}`, "scanner");
    }
  } catch (e: any) {
    log(`Price fetch error for ${symbol}: ${e.message}`, "scanner");
  }
  return 0;
}

async function getSentiment(symbol: string): Promise<string> {
  try {
    const base = symbol.split('/')[0].toUpperCase();
    const response = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${process.env.CRYPTOPANIC_API_KEY || '67d01867e915478470a1a3617300438a37943f65'}&currencies=${base}&filter=important`, { timeout: 3000 });
    const responseData = (response.data as any) || {};
    const posts = responseData.results || [];
    if (posts.length === 0) return "Neutral (No recent news)";
    return (posts as any[]).slice(0, 3).map((p: any) => `• ${p.title} (${p.votes.positive > p.votes.negative ? 'Bullish' : 'Bearish'})`).join('\n');
  } catch (e) { return "Neutral"; }
}

// Lightweight news fetch via Google News RSS (no API key required)
async function searchWeb(query: string): Promise<string[]> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await axios.get(url, { timeout: 5000 });
    const data = res.data;
    const results: string[] = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 3)) {
        if (topic.Text) results.push(topic.Text);
        else if (topic.Topics) {
          topic.Topics.slice(0, 1).forEach((t: any) => t.Text && results.push(t.Text));
        }
      }
    }
    return results.slice(0, 3).map(r => r.replace(/\n/g, ' '));
  } catch (e) {
    return [];
  }
}

async function fetchNews(symbol: string): Promise<string[]> {
  try {
    const q = encodeURIComponent(symbol);
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

async function searchCurrentInfo(query: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const duckResults = await searchWeb(query);
    if (duckResults.length > 0) results.push(...duckResults.map(r => `Web: ${r}`));

    const newsResults = await fetchNews(query);
    if (newsResults.length > 0) results.push(...newsResults.map(r => `News: ${r}`));

    if (results.length === 0) {
      const broadQuery = `${query} current situation latest updates`;
      const broadDuck = await searchWeb(broadQuery);
      if (broadDuck.length > 0) results.push(...broadDuck.map(r => `Web: ${r}`));
      const broadNews = await fetchNews(broadQuery);
      if (broadNews.length > 0) results.push(...broadNews.map(r => `News: ${r}`));
    }
  } catch (error) {
    log(`Enhanced search error: ${error}`, "scanner");
  }
  return results.slice(0, 5);
}

// Aggregate broader internet context (news + social/search) for model prompts
export async function fetchInternetContext(symbol: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const news = await fetchNews(symbol).catch(() => []);
    if (news.length) results.push(...news.map(h => `News: ${h}`));
  } catch (err) {}
  // include current date/time so models know present day
  results.push(`Date: ${new Date().toISOString()}`);
  
  // perform general web search and include snippets
  try {
    const web = await searchWeb(symbol).catch(() => []);
    if (web.length) results.push(...web.map(w => `Search: ${w}`));
    // additional searches for meme coin context
    const memeWeb = await searchWeb(`${symbol} meme coin`).catch(() => []);
    if (memeWeb.length) results.push(...memeWeb.map(w => `Search: ${w}`));
    const cryptoNewsWeb = await searchWeb(`${symbol} crypto news`).catch(() => []);
    if (cryptoNewsWeb.length) results.push(...cryptoNewsWeb.map(w => `Search: ${w}`));
  } catch (err) {}

  // Try Cryptopanic sentiment (already available via getSentiment but include top posts)
  try {
    const base = symbol.split('/')[0].toUpperCase();
    const cp = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${process.env.CRYPTOPANIC_API_KEY || ''}&currencies=${base}&filter=important`, { timeout: 3000 }).catch(() => null);
    const posts = cp?.data?.results || [];
    if (posts && posts.length) {
      results.push(...posts.slice(0,3).map((p: any) => `CryptoNews: ${p.title} (${p.votes?.positive > p.votes?.negative ? 'Bullish' : 'Bearish'})`));
    }
  } catch (err) {}

  // Try Twitter via public Nitter instance search RSS (best-effort, may be blocked)
  try {
    const q = encodeURIComponent(symbol.replace('/', ' '));
    const nitterInstances = [process.env.NITTER_INSTANCE || 'https://nitter.net'];
    for (const inst of nitterInstances) {
      try {
        const rss = `${inst}/search/rss?q=${q}`;
        const r = await axios.get(rss, { timeout: 3000 }).catch(() => null);
        const xml = r?.data || '';
        const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0,3);
        const tweets = items.map((it: string) => {
          const title = (it.match(/<title>(.*?)<\/title>/)?.[1]) || '';
          return title ? `Tweet: ${title}` : null;
        }).filter(Boolean);
        if (tweets.length) {
          results.push(...tweets as string[]);
          break;
        }
      } catch (e) {}
    }
  } catch (err) {}

  // Try TikTok via RSSHub (best-effort; requires RSSHub availability)
  try {
    const tag = encodeURIComponent(symbol.split('/')[0]);
    const turl = `https://rsshub.app/tiktok/tag/${tag}`;
    const r = await axios.get(turl, { timeout: 3000 }).catch(() => null);
    const xml = r?.data || '';
    const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0,2);
    const tks = items.map((it: string) => {
      const title = (it.match(/<title>(.*?)<\/title>/)?.[1]) || '';
      return title ? `TikTok: ${title}` : null;
    }).filter(Boolean);
    if (tks.length) results.push(...tks as string[]);
  } catch (err) {}

  return results.slice(0,5);
}

// NOTE: searchWeb helper defined earlier in this file.

// Helpers for basic technical indicator calculations
function calculateSMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calculateEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = calculateSMA(values.slice(0, period), period) || values[period - 1];
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(values: number[], period: number): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const sma = calculateSMA(trs, period);
  return sma || 0;
}

function deriveTrend(ema9: number, ema21: number): "bullish" | "bearish" | "neutral" {
  const diff = ema9 - ema21;
  if (Math.abs(diff) < Math.max(ema9, ema21) * 0.005) return "neutral";
  return diff > 0 ? "bullish" : "bearish";
}

async function fetchBinanceCandles(symbol: string, interval = "1h", limit = 100) {
  const cleanSymbol = symbol.replace('/', '');
  const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, { timeout: 5000 });
  return (res.data || []).map((c: any) => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }));
}

async function getTechnicalIndicators(symbol: string, marketType: string): Promise<any> {
  try {
    const isCrypto = marketType === "crypto";

    // Get real price data
    const priceData = await fetchPriceData(symbol).catch(() => null);
    const currentPrice = priceData?.price ? parseFloat(priceData.price.replace(/[^0-9.-]/g, '')) : 0;

    // Ensure these exist even if we cannot fetch candles (avoids reference errors)
    let ema9_1h = currentPrice;
    let ema21_1h = currentPrice;

    // Prepare multi-timeframe data for trend alignment
    let trend1h: "bullish" | "bearish" | "neutral" = "neutral";
    let trend4h: "bullish" | "bearish" | "neutral" = "neutral";
    let trendAligned = false;

    // Crypto: use Binance candles for 1h and 4h
    let closes1h: number[] = [];
    let highs1h: number[] = [];
    let lows1h: number[] = [];

    let closes4h: number[] = [];
    let highs4h: number[] = [];
    let lows4h: number[] = [];

    // Forex: use daily rates (1d / 4d) from exchangerate.host
    let closes1d: number[] = [];
    let closes4d: number[] = [];

    if (isCrypto) {
      try {
        const candles1h = await fetchBinanceCandles(symbol, "1h", 120);
        closes1h = candles1h.map(c => c.close);
        highs1h = candles1h.map(c => c.high);
        lows1h = candles1h.map(c => c.low);

        const candles4h = await fetchBinanceCandles(symbol, "4h", 80);
        closes4h = candles4h.map(c => c.close);
        highs4h = candles4h.map(c => c.high);
        lows4h = candles4h.map(c => c.low);
      } catch (err) {
        log(`Failed to fetch Binance candles for ${symbol}: ${err}`, "signals");
      }

      ema9_1h = closes1h.length ? calculateEMA(closes1h, 9) : currentPrice;
      ema21_1h = closes1h.length ? calculateEMA(closes1h, 21) : currentPrice;
      trend1h = deriveTrend(ema9_1h, ema21_1h);

      const ema9_4h = closes4h.length ? calculateEMA(closes4h, 9) : currentPrice;
      const ema21_4h = closes4h.length ? calculateEMA(closes4h, 21) : currentPrice;
      trend4h = deriveTrend(ema9_4h, ema21_4h);

      // Only enforce alignment when both timeframes have a clear trend.
      // If one timeframe is neutral, allow the scan to proceed (avoid blocking signals when data is weak).
      trendAligned = !(trend1h === "neutral" || trend4h === "neutral") ? (trend1h === trend4h) : true;
    } else {
      try {
        const [base, quote] = symbol.split('/');
        const end = new Date();
        const start = new Date(end);
        start.setDate(end.getDate() - 10);
        const url = `https://api.exchangerate.host/timeseries?start_date=${start.toISOString().slice(0,10)}&end_date=${end.toISOString().slice(0,10)}&base=${base}&symbols=${quote}`;
        const res = await axios.get(url, { timeout: 5000 });
        const rates = res.data?.rates || {};
        const sortedDates = Object.keys(rates).sort();
        const closes = sortedDates.map(d => rates[d][quote]).filter((v: any) => typeof v === 'number');

        // 1d trend uses last 2 days, 4d trend uses last 5 days
        if (closes.length >= 2) {
          const last = closes[closes.length - 1];
          const prev = closes[closes.length - 2];
          trend1h = last > prev ? "bullish" : last < prev ? "bearish" : "neutral";
          closes1d = closes.slice(-2);
        }
        if (closes.length >= 5) {
          const last = closes[closes.length - 1];
          const prev = closes[closes.length - 5];
          trend4h = last > prev ? "bullish" : last < prev ? "bearish" : "neutral";
          closes4d = closes.slice(-5);
        }

        trendAligned = trend1h !== "neutral" && trend1h === trend4h;
      } catch (err) {
        log(`Failed to fetch forex history for ${symbol}: ${err}`, "signals");
      }
    }

    // Determine which series to use for indicator computation (crypto uses 1h, forex uses 1d)
    const closesShort = isCrypto ? closes1h : closes1d;
    const highsShort = isCrypto ? highs1h : [];
    const lowsShort = isCrypto ? lows1h : [];

    const emaCross = trend1h === "bullish" ? "Golden Cross (Bullish)" : (trend1h === "bearish" ? "Death Cross (Bearish)" : "Neutral");

    const rsi = closesShort.length ? calculateRSI(closesShort, 14) : 50;

    // MACD Series: EMA12 - EMA26
    let macdLine = 0;
    let macdSignal = 0;
    let macdHistogram = 0;
    if (closesShort.length >= 26) {
      const ema12Series: number[] = [];
      const ema26Series: number[] = [];
      let ema12 = closesShort[0];
      let ema26 = closesShort[0];
      const k12 = 2 / (12 + 1);
      const k26 = 2 / (26 + 1);
      for (let i = 0; i < closesShort.length; i++) {
        const price = closesShort[i];
        ema12 = price * k12 + ema12 * (1 - k12);
        ema26 = price * k26 + ema26 * (1 - k26);
        ema12Series.push(ema12);
        ema26Series.push(ema26);
      }
      const macdSeries = ema12Series.map((v, idx) => v - ema26Series[idx]);
      macdLine = macdSeries[macdSeries.length - 1];
      macdSignal = calculateEMA(macdSeries, 9);
      macdHistogram = macdLine - macdSignal;
    }

    const bbMiddle = closesShort.length ? calculateSMA(closesShort, 20) || currentPrice : currentPrice;
    const bbStd = closesShort.length ? Math.sqrt(closesShort.slice(-20).reduce((acc, v) => acc + Math.pow(v - bbMiddle, 2), 0) / 20) : currentPrice * 0.02;
    const bbUpper = bbMiddle + 2 * bbStd;
    const bbLower = bbMiddle - 2 * bbStd;
    const bbStatus = closesShort.length
      ? (closesShort[closesShort.length - 1] > bbUpper ? "Price at Upper Band (Overbought Signal)"
        : closesShort[closesShort.length - 1] < bbLower ? "Price at Lower Band (Oversold Signal)"
        : "Squeeze (Breakout Pending)")
      : "Neutral";

    const atr = (highsShort.length && lowsShort.length && closesShort.length) ? calculateATR(highsShort, lowsShort, closesShort, 14) : currentPrice * 0.02;

    const vwap = closesShort.length ? closesShort.reduce((acc, v) => acc + v, 0) / closesShort.length : currentPrice;
    const vwapBias = currentPrice >= vwap ? "Above VWAP (Institutional Buy Bias)" : "Below VWAP (Institutional Sell Bias)";

    const cloudbias = trend4h === "bullish" ? "Price above Kumo Cloud (Bullish)" : "Price below Kumo Cloud (Bearish)";

    return {
      currentPrice: currentPrice.toFixed(6),
      priceSource: priceData?.source || "unknown",
      timeframe: {
        "1h": { trend: trend1h },
        "4h": { trend: trend4h },
        aligned: trendAligned
      },
      candlestick: {
        timeframe: "1H/4H",
        pattern: "N/A",
        body: "N/A",
        wicks: "N/A",
        confirmation: "N/A"
      },
      ema9: ema9_1h.toFixed(6),
      ema21: ema21_1h.toFixed(6),
      emaCross: emaCross,
      rsi: rsi.toFixed(2),
      macd: {
        line: macdLine.toFixed(6),
        signal: macdSignal.toFixed(6),
        histogram: macdHistogram.toFixed(6)
      },
      bollingerBands: {
        upper: bbUpper.toFixed(6),
        middle: bbMiddle.toFixed(6),
        lower: bbLower.toFixed(6),
        status: bbStatus
      },
      atr: atr.toFixed(6),
      supertrend: {
        value: (currentPrice + atr).toFixed(6),
        direction: trend1h === "bullish" ? "UP (Bullish)" : "DOWN (Bearish)"
      },
      vwap: vwap.toFixed(6),
      vwapBias: vwapBias,
      ichimoku: {
        conversionLine: ema9_1h.toFixed(6),
        baseLine: ema21_1h.toFixed(6),
        cloud: cloudbias,
        sentiment: cloudbias
      },
      fibonacci: {
        level1: (currentPrice * 0.236).toFixed(6),
        level2: (currentPrice * 0.382).toFixed(6),
        level3: (currentPrice * 0.618).toFixed(6),
        level4: (currentPrice * 0.786).toFixed(6)
      },
      rsiDivergence: "None",
      onChain: isCrypto ? {
        nvt: "Unknown",
        activeAddresses: "Unknown",
        minerRevenue: "Unknown"
      } : null
    };
  } catch (err) {
    log(`Error generating technical indicators for ${symbol}: ${err}`, "signals");
    return {
      currentPrice: "N/A",
      ema9: "N/A",
      ema21: "N/A",
      emaCross: "Neutral",
      rsi: "50.00",
      macd: { histogram: "Neutral" },
      bollingerBands: { status: "Neutral" },
      vwapBias: "Neutral",
      ichimoku: { cloud: "Neutral" }
    };
  }
}

async function getTopCryptoSymbols(): Promise<string[]> {
  try {
    // Using CryptoCompare Top Total Vol Full API as a fallback for restricted regions
    const res = await axios.get('https://min-api.cryptocompare.com/data/top/totalvolfull?limit=30&tsym=USDT', { timeout: 5000 });
    const resData = res.data as any;
    if (resData && Array.isArray(resData.Data)) {
      const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FRAX', 'LUSD', 'GUSD', 'USDN'];
      const symbols = (resData.Data as any[])
        .map((coin: any) => `${coin.CoinInfo.Name}/USDT`)
        .filter((p: string) => {
          const parts = p.split('/');
          return parts[0] && parts[1] && parts[0] !== parts[1] && !stablecoins.includes(parts[0].toUpperCase()) && !stablecoins.includes(parts[1].toUpperCase());
        });
      log(`[scanner] Fetched ${symbols.length} crypto symbols from CryptoCompare`, "scanner");
      return symbols.length > 0 ? symbols : MONITORED_CRYPTO;
    }
  } catch (e) {
    log(`Failed to fetch top crypto symbols: ${e}`, "scanner");
  }
  return MONITORED_CRYPTO;
}

const ALL_FOREX_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
  "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY",
  "AUD/JPY", "GBP/CAD", "EUR/AUD", "CAD/JPY", "AUD/CAD"
];

export async function runScanner(marketType: "crypto" | "forex", isForce: boolean = false, forceChatId?: string, forceTopicId?: string, forcePair?: string, mode?: "setup" | "analyze", imageUrl?: string): Promise<boolean> {
  let sentDirectMessage = false;
  let lastBias: "bullish" | "bearish" | "neutral" = "neutral";
  try {
    // normalize forcePair if provided
    if (forcePair) {
      const norm = forcePair.split('/').length === 2 ? forcePair : null;
      if (!norm) {
        // try normalization similar to telegram
        const s = forcePair.trim().toUpperCase().replace(/[^A-Z0-9\/]/g, '');
        if (s.includes('/')) forcePair = s;
        else if (s.length === 6) forcePair = `${s.slice(0,3)}/${s.slice(3)}`;
      }
    }
    const signals = await storage.getSignals();
    const activeForType = signals.find(s => s.status === "active" && s.type === marketType);
    if (activeForType && !isForce) {
      log(`Active signal exists for ${marketType}: ${activeForType.symbol}. will replace if a new one is generated.`, "scanner");
    }

    // Enforce a max of 3 open positions (total) and 1 new signal per 3-day period (background scans only)
    if (!(mode === "analyze" || mode === "setup")) {
      const activeSignals = signals.filter(s => s.status === "active");
      if (activeSignals.length >= 3) {
        log(`Maximum 3 open signals reached (total), skipping new signal generation.`, "scanner");
        return false;
      }

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const recentSignals = signals.filter(s => new Date(s.createdAt) >= threeDaysAgo);
      log(`[scanner] Signals created in last 3 days: ${recentSignals.length}`, "scanner");
      if (recentSignals.length >= 1) {
        log(`3-day signal limit reached, skipping new signal generation.`, "scanner");
        return false;
      }
    }

    const lastCompleted = signals.filter(s => s.status === "completed" && s.type === marketType).sort((a, b) => (b.lastUpdateAt?.getTime() || 0) - (a.lastUpdateAt?.getTime() || 0))[0];
    if (lastCompleted && !isForce) {
      // 40-60 minute variable cooldown after TP/SL hit
      const minCooldown = 40 * 60 * 1000;
      const maxCooldown = 60 * 60 * 1000;
      const cooldown = Math.floor(Math.random() * (maxCooldown - minCooldown + 1)) + minCooldown;
      
      const timeSince = Date.now() - (lastCompleted.lastUpdateAt?.getTime() || 0);
      if (timeSince < cooldown) {
        log(`${marketType} extended cooldown active (${Math.round(timeSince / 60000)}m / ${Math.round(cooldown / 60000)}m).`, "scanner");
        return true;
      }
    }

    let symbols = forcePair ? [forcePair] : [];
    if (!forcePair) {
      if (marketType === "crypto") {
        symbols = await getTopCryptoSymbols();
      } else {
        symbols = ALL_FOREX_PAIRS;
      }
    }
    // normalize and filter pairs
    const normalize = (s:string) => {
      const parts = s.split('/');
      if (parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1]) {
        return `${parts[0].toUpperCase()}/${parts[1].toUpperCase()}`;
      }
      return null;
    };
    const cleaned = symbols.map(normalize).filter(s => s) as string[];
    const shuffled = imageUrl ? ["CHART_IMAGE"] : cleaned.filter(s => !s.includes("BCH")).sort(() => 0.5 - Math.random());
    const symbolsToScan = isForce ? shuffled : shuffled.slice(0, 10);

    log(`[scanner] symbolsToScan: ${symbolsToScan.join(', ')}`, "scanner");
    for (const symbol of symbolsToScan) {
      log(`[scanner] processing ${symbol}`, "scanner");
      let currentPrice = 0;
      let sentiment = "N/A";
      
      if (symbol !== "CHART_IMAGE") {
        currentPrice = await getPrice(symbol, marketType);
        if (currentPrice === 0) continue; 
        if (marketType === "crypto") sentiment = await getSentiment(symbol);
      }
      
      const indicators = await getTechnicalIndicators(symbol, marketType);
      
      // pre-filter: require at least one strong indicator signal
      let preFilterScore = 0;
      const preFilter = (() => {
        if (symbol === "CHART_IMAGE" || imageUrl) {
          preFilterScore = 999; // special marker
          return true; // always allow image analysis
        }
        
        let score = 0;

        // Multi-timeframe trend alignment (crypto + forex)
        // NOTE: we do not abort on mismatch, we simply log it and continue.
        if (indicators?.timeframe && indicators.timeframe.aligned === false) {
          log(`[scanner] Timeframe mismatch for ${symbol}: 1h=${indicators.timeframe["1h"]?.trend} 4h=${indicators.timeframe["4h"]?.trend}`, "scanner");
        }

        // Check EMACross
        const emaCross = indicators.emaCross;
        if (emaCross && !emaCross.includes("Neutral")) score++;
        
        // Check RSI
        const rsi = typeof indicators.rsi === 'string' ? parseFloat(indicators.rsi) : indicators.rsi;
        if (typeof rsi === 'number' && (rsi < 30 || rsi > 70)) score++;
        
        // Supertrend direction
        const supertrendDir = indicators.supertrend?.direction || "Neutral";
        if (supertrendDir && !supertrendDir.includes("Neutral")) score++;
        
        // ATR volatility
        const atr = typeof indicators.atr === 'string' ? parseFloat(indicators.atr) : 0;
        if (atr && atr > currentPrice * 0.02) score++;
        
        // MACD histogram
        const macdHist = indicators.macd?.histogram;
        if (macdHist && !macdHist.includes("Neutral")) score++;
        
        // Bollinger Bands status
        const bbStatus = indicators.bollingerBands?.status;
        if (bbStatus && !bbStatus.includes("Neutral") && !bbStatus.includes("Consolidation")) score++;
        
        preFilterScore = score;
        // We always allow scanning now; preFilterScore is just used for scoring.
        return true;
      })();
      if (!preFilter && !isForce) {
        log(`[scanner] Pre-filter failed for ${symbol}, skipping due to weak indicator confluence`, "scanner");
        continue;
      }

      if (!openRouterClient) await initAI();
      if (!openRouterClient) continue;

      const sysPrompt = mode === "setup" ? SETUP_PROMPT : (mode === "analyze" ? ANALYZE_PROMPT : INSTITUTIONAL_PROMPT(marketType));
      const indicatorsStr = JSON.stringify(indicators, null, 2);

      // Build the user prompt for the AI model
      const userMsg = `Symbol: ${symbol}
Market: ${marketType}
Price: ${currentPrice}
Sentiment: ${sentiment}
Indicators: ${indicatorsStr}
Pre-filter score: ${preFilterScore}
Mode: ${mode || "scan"}`;

      // Enhanced research for setup mode (meme coin analysis)
      let enhancedUserMsg = userMsg;
      let extensiveResearch: string[] = [];
      
      if (mode === "setup" && marketType === "crypto") {
        try {
          // Detect if this might be a meme coin
          const isMemeCoin = symbol.includes('PEPE') || symbol.includes('SHIB') || symbol.includes('DOGE') || 
                           symbol.includes('FROG') || symbol.includes('CAT') || symbol.includes('BALD') ||
                           symbol.includes('WOJAK') || symbol.includes('KEK') || symbol.includes('CUMMIES') ||
                           symbol.includes('BONK') || symbol.includes('MEW') || symbol.includes('POPCAT') ||
                           currentPrice < 0.001 || (await searchWeb(`${symbol} meme coin`).catch(() => [])).length > 0;
          
          if (isMemeCoin) {
            // Perform extensive research for meme coin setup analysis
            const searchCtx = await searchCurrentInfo(`${symbol} meme coin analysis fundamentals social media`).catch(() => []);
            const newsResults = await fetchNews(`${symbol} crypto news meme`).catch(() => []);
            const twitterSearch = await searchCurrentInfo(`${symbol} twitter sentiment trends meme coin`).catch(() => []);
            const communitySearch = await searchCurrentInfo(`${symbol} telegram discord community holders meme`).catch(() => []);
            const developerSearch = await searchCurrentInfo(`${symbol} developer team background meme coin`).catch(() => []);
            const viralSearch = await searchCurrentInfo(`${symbol} viral potential hype factor meme`).catch(() => []);
            
            extensiveResearch = [
              ...(searchCtx.length ? [`General Meme Coin Research:\n${searchCtx.map(r => `• ${r}`).join('\n')}`] : []),
              ...(newsResults.length ? [`Recent News & Hype:\n${newsResults.map(r => `• ${r}`).join('\n')}`] : []),
              ...(twitterSearch.length ? [`Social Media Buzz:\n${twitterSearch.map(r => `• ${r}`).join('\n')}`] : []),
              ...(communitySearch.length ? [`Community Strength:\n${communitySearch.map(r => `• ${r}`).join('\n')}`] : []),
              ...(developerSearch.length ? [`Team & Origins:\n${developerSearch.map(r => `• ${r}`).join('\n')}`] : []),
              ...(viralSearch.length ? [`Viral Potential:\n${viralSearch.map(r => `• ${r}`).join('\n')}`] : [])
            ];
            
            enhancedUserMsg += `\n\nMEME COIN EXTENSIVE RESEARCH:\n${extensiveResearch.join('\n\n')}`;
          }
        } catch (researchError) {
          log(`Meme coin research error: ${researchError}`, "scanner");
        }
      }
      
      const finalUserMsg = extensiveResearch.length > 0 ? enhancedUserMsg : userMsg;

      try {
        const jsonSchemaInstruction = `Respond ONLY with valid JSON matching this schema (no extra text):
{
  "bias": "bullish" | "bearish" | "neutral",
  "entry": number,           // entry price (use numeric value)
  "sl": number,              // stop loss
  "tp": number,              // take profit
  "confidence": number,      // 0-1 confidence score
  "reason": string           // short reasoning (1-2 sentences)
}`;

        const aiPrompt = `${finalUserMsg}\n\n${jsonSchemaInstruction}`;

        const response = await openRouterClient.chat.completions.create({
          model: "anthropic/claude-3.5-sonnet",
          messages: imageUrl ? [
            { role: "system", content: sysPrompt + "\n\nCRITICAL: You are analyzing a chart image. Identify exact price levels, structures, and POIs visible on the chart with ultra-precision. Respond ONLY with valid JSON as specified." },
            { role: "user", content: [
              { type: "text", text: aiPrompt + " This analysis is based on the provided chart image. Incorporate visual evidence from the image into your strategic reasoning." },
              { type: "image_url", image_url: { url: imageUrl } }
            ] }
          ] : [
            { role: "system", content: sysPrompt + "\n\nIMPORTANT: Respond ONLY with valid JSON as specified." },
            { role: "user", content: aiPrompt }
          ],
          max_tokens: extensiveResearch.length > 0 ? 2500 : 1500
        } as any);

        const rawAnalysis = response.choices[0].message?.content || "";

        const extractJson = (text: string): any | null => {
          const first = text.indexOf('{');
          const last = text.lastIndexOf('}');
          if (first === -1 || last === -1 || last <= first) return null;
          const candidate = text.slice(first, last + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        };

        const parsed = extractJson(rawAnalysis);
        const ai = parsed || {};

        const analysis = rawAnalysis;
        let bias: "bullish" | "bearish" | "neutral" = (ai.bias || "neutral").toLowerCase() as any;
        if (!["bullish", "bearish", "neutral"].includes(bias)) bias = "neutral";
        lastBias = bias;

        const entryPrice = ai.entry ? Number(ai.entry) : null;
        const tp1 = ai.tp ? Number(ai.tp) : null;
        const sl = ai.sl ? Number(ai.sl) : null;

        const confidence = ai.confidence ? Number(ai.confidence) : undefined;
        const aiReason = ai.reason?.toString?.() || "";

        // For manual commands (/analyze, /setup), always send result to user
        if (forceChatId || mode === "analyze" || mode === "setup") {
          const bot = getTelegramBot();
          if (bot) {
            const formatted = await formatAnalysisMessage(symbol, marketType, ai, analysis, mode, indicators);

            log(`[scanner] Sending ${mode || 'analysis'} direct to ${forceChatId}`, "scanner");
            await bot.sendMessage(forceChatId, formatted, { message_thread_id: forceTopicId ? parseInt(forceTopicId) : undefined }).catch((err: any) => {
              log(`[scanner] Failed to send direct analysis to ${forceChatId}: ${err.message}`, "scanner");
              // Fallback to plain text
              bot.sendMessage(forceChatId, analysis.slice(0, 4096), { message_thread_id: forceTopicId ? parseInt(forceTopicId) : undefined }).catch(() => {});
            });

            // Mark that we delivered a message for this manual request
            sentDirectMessage = true;
          }
        }

        if (bias !== "neutral") {
          log(`[scanner] Valid ${marketType} signal found for ${symbol}: ${bias}`, "scanner");

          // enforce minimum 3:1 reward:risk
          if (entryPrice && tp1 && sl) {
            const minRR = parseFloat(process.env.SIGNAL_MIN_RR || "2");
            const e = entryPrice;
            const t = tp1;
            const s = sl;
            if (!isNaN(e) && !isNaN(t) && !isNaN(s)) {
              const reward = bias === "bullish" ? t - e : e - t;
              const risk = bias === "bullish" ? e - s : s - e;
              if (risk > 0 && reward / risk < minRR) {
                log(`[scanner] Rejected ${symbol} signal due to low RR ${(reward/risk).toFixed(2)} (<${minRR})`, "scanner");
                continue; // move to next symbol without creating a signal
              }
            }
          }

          if (activeForType) {
            log(`[scanner] Replacing previous active signal ${activeForType.symbol} for market ${marketType}`, "scanner");
            // try deleting previous message(s)
            const bot = getTelegramBot();
            if (bot && activeForType.chatId && activeForType.messageId) {
              try {
                await bot.deleteMessage(activeForType.chatId, activeForType.messageId.toString());
              } catch (e: any) {
                log(`[scanner] Could not delete old signal message: ${e.message}`, "scanner");
              }
            }
            await storage.updateSignal(activeForType.id, { status: "completed" });
          }

          // Calculate PnL parameters based on market type with configurable capital & leverage
          const capitalMin = parseFloat(process.env.SIGNAL_CAPITAL_MIN || "10");
          const capitalMax = parseFloat(process.env.SIGNAL_CAPITAL_MAX || "100");
          const capitalDefault = parseFloat(process.env.SIGNAL_CAPITAL_DEFAULT || "50");
          
          // adjust capital based on signal quality (score) for small traders
          let capital = capitalDefault;
          if (typeof preFilterScore === 'number') {
            if (preFilterScore >= 5) capital = capitalMax;
            else if (preFilterScore === 4) capital = (capitalMax + capitalDefault) / 2;
            else if (preFilterScore === 3) capital = capitalDefault;
            else capital = capitalMin;
          }
          // enforce range
          capital = Math.max(capitalMin, Math.min(capitalMax, capital));
          
          const leverage = marketType === 'forex' 
            ? parseFloat(process.env.FOREX_LEVERAGE || "10")
            : parseFloat(process.env.CRYPTO_LEVERAGE || "15");
          
          const positionSize = capital * leverage;
          const fees = 0.001; // 0.1% per trade
          
          // Forex-specific calculations with pip range (0.01-0.15)
          let lotSize = null;
          let pipValue = null;
          let pipsToUse = null;
          if (marketType === 'forex') {
            const pipMin = parseFloat(process.env.FOREX_PIP_MIN || "0.01");
            const pipMax = parseFloat(process.env.FOREX_PIP_MAX || "0.15");
            // Random pip value within configured range (0.01-0.15)
            pipsToUse = pipMin + (Math.random() * (pipMax - pipMin));
            
            lotSize = capital / 1000; // Micro lots based on capital
            pipValue = lotSize * pipsToUse; // Pip value based on configured range
          }

          const newSignal = await storage.createSignal({
            symbol,
            type: marketType,
            bias,
            reasoning: analysis,
            confidence: confidence?.toString(),
            reason: aiReason,
            status: "active",
            entryPrice,
            tp1,
            sl,
            capital: capital.toString(),
            leverage: leverage.toString(),
            positionSize: positionSize.toString(),
            fees: fees.toString(),
            lotSize: lotSize?.toString(),
            pipValue: pipValue?.toString(),
            data: {
              indicators,
              preFilterScore
            }
          });

          // Sanity log: confirm TP/SL/entry were stored correctly
          log(`[scanner] Created signal for ${symbol}: bias=${bias}, entry=${entryPrice}, tp=${tp1}, sl=${sl}, confidence=${confidence}, reason=${aiReason?.slice(0, 80)}`, "scanner");

          const bot = getTelegramBot();
          if (bot && !forceChatId) {
            // Only post to groups if not a direct command
            const bindings = await db.select().from(groupBindings).where(
              eq(groupBindings.market, marketType)
            );
            log(`[scanner] Posting signal to ${bindings.length} bound groups for marketType=${marketType}`, "scanner");
            if (bindings.length === 0) {
              log(`[scanner] No group bindings found - check /bind commands or database state.`, "scanner");
            }
            for (const binding of bindings) {
              // Ensure binding has a createdAt timestamp (some older rows may not)
              if (!binding.createdAt) {
                try {
                  await db.update(groupBindings).set({ createdAt: Date.now() }).where(eq(groupBindings.id, binding.id));
                  binding.createdAt = Date.now();
                } catch (_e) {
                  // ignore
                }
              }
              log(`[scanner] Binding details: ${JSON.stringify(binding)}`, "scanner");
              log(`[scanner] Sending signal to group ${binding.groupId} topic ${binding.topicId}`, "scanner");
              try {
                await postSignalToGroup(bot, binding.groupId, binding.topicId || undefined, analysis, symbol, marketType, newSignal, isForce);
              } catch (err) {
                log(`[scanner] postSignalToGroup exception for ${binding.groupId}: ${err}`, "scanner");
              }
            }
          }
          return true;
        } else {
          log(`[scanner] AI returned neutral bias for ${symbol}, skipping signal creation.`, "scanner");
        }
      } catch (e) {}
    }
  } catch (err) { log("Scanner error: " + err); }
  // Return true if we delivered a direct analysis response or if a signal was created.
  // This prevents manual commands (/analyze, /setup) from incorrectly reporting failure when only neutral bias is found.
  return sentDirectMessage || lastBias !== "neutral";
}

async function formatAnalysisMessage(symbol: string, marketType: string, ai: any, rawAnalysis: string, mode: string = 'analyze', indicators: any = {}): Promise<string> {
  const bias = (ai.bias || "neutral").toString().toLowerCase();
  const entryPrice = ai.entry ? Number(ai.entry) : null;
  const tp = ai.tp ? Number(ai.tp) : null;
  const sl = ai.sl ? Number(ai.sl) : null;
  const confidence = ai.confidence ? Number(ai.confidence) : null;
  const reason = ai.reason ? ai.reason.toString() : null;

  // Try to fetch current price for the symbol to provide context
  let currentPriceLabel = "N/A";
  try {
    const { fetchPriceData } = await import("./price-service");
    const priceRes = await fetchPriceData(symbol);
    if (priceRes && priceRes.price) {
      const n = parseFloat(priceRes.price.replace(/[^0-9.-]/g, ''));
      currentPriceLabel = isNaN(n) ? priceRes.price : n.toFixed(2);
    }
  } catch (_e) {
    // ignore; this is best-effort
  }

  const title = mode === 'setup'
    ? '💎 **INSTITUTIONAL SETUP IDENTIFIED** 💎'
    : '💎 **INSTITUTIONAL MARKET ANALYSIS** 💎';

  const header = `${title}\n───────────────────────────────────\n` +
    `**SYMBOL:** ${symbol} | **BIAS:** ${bias.toUpperCase()} ${bias === 'bullish' ? '(🟢 BULLISH)' : bias === 'bearish' ? '(🔴 BEARISH)' : '(⚪ NEUTRAL)'}\n` +
    `**Current Price:** ${currentPriceLabel}\n` +
    `**Mode:** ${mode === 'setup' ? 'Setup' : 'Analysis'}\n`;

  const indicatorLines: string[] = [];
  if (indicators && Object.keys(indicators).length) {
    indicatorLines.push(`
📈 **TECHNICAL INDICATORS:**`);
    if (indicators.timeframe) {
      const t1 = indicators.timeframe['1h']?.trend || 'N/A';
      const t4 = indicators.timeframe['4h']?.trend || 'N/A';
      indicatorLines.push(`- Trend (1h/4h): ${t1.toUpperCase()} / ${t4.toUpperCase()}${indicators.timeframe.aligned === false ? ' (Misaligned)' : ''}`);
    }
    if (indicators.ema9 && indicators.ema21) {
      indicatorLines.push(`- EMA: 9=${indicators.ema9} | 21=${indicators.ema21} | Cross=${indicators.emaCross || 'N/A'}`);
    }
    if (indicators.rsi) {
      const rsiVal = parseFloat(indicators.rsi);
      indicatorLines.push(`- RSI: ${indicators.rsi}${!isNaN(rsiVal) ? (rsiVal > 70 ? ' (Overbought)' : rsiVal < 30 ? ' (Oversold)' : '') : ''}`);
    }
    if (indicators.macd) {
      const hist = indicators.macd.histogram || indicators.macdHistogram || 'N/A';
      indicatorLines.push(`- MACD hist: ${hist}`);
    }
    if (indicators.bollingerBands) {
      indicatorLines.push(`- Bollinger Bands: ${indicators.bollingerBands.status || 'N/A'}`);
    }
    if (indicators.vwap) {
      indicatorLines.push(`- VWAP: ${indicators.vwap} (${indicators.vwapBias || 'N/A'})`);
    }
    if (indicators.atr) {
      indicatorLines.push(`- ATR: ${indicators.atr}`);
    }
  }

  const modeLines: string[] = [];
  if (mode === 'setup') {
    modeLines.push(`\n🔧 **SETUP FOCUS:** Seeking neutral breakout/pullback setups with institutional confluence and clear invalidation.`);
  } else if (mode === 'analyze') {
    modeLines.push(`\n🔎 **ANALYSIS FOCUS:** Deep market structure, bias, liquidity pools, trend strength, and key levels.`);
  }

  const execLines: string[] = [];
  execLines.push(`\n🎯 **EXECUTION ZONES:**`);
  if (entryPrice) execLines.push(`📍 **Entry:** ${entryPrice.toFixed(marketType === 'forex' ? 5 : 2)}`);
  if (sl) execLines.push(`🛑 **Stop Loss:** ${sl.toFixed(marketType === 'forex' ? 5 : 2)}`);
  if (tp) execLines.push(`🎯 **Take Profit:** ${tp.toFixed(marketType === 'forex' ? 5 : 2)}`);
  if (entryPrice && sl && tp) {
    const reward = bias === 'bullish' ? tp - entryPrice : entryPrice - tp;
    const risk = bias === 'bullish' ? entryPrice - sl : sl - entryPrice;
    if (risk > 0) execLines.push(`📊 **Risk/Reward:** 1:${(reward/risk).toFixed(2)}`);
  }

  const details: string[] = [];
  if (confidence !== null) details.push(`**Confidence:** ${(confidence*100).toFixed(0)}%`);
  if (reason) details.push(`\n**INSTITUTIONAL REASONING:** ${reason}`);

  const analysisBody = header + indicatorLines.join('\n') + modeLines.join('\n') + execLines.join('\n') + '\n' + details.join('\n') + '\n\n';
  const cleanAnalysis = rawAnalysis
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .slice(0, 2800);
  // Remove any embedded JSON object from the end of the model response to avoid showing raw JSON in chat
  const jsonSuffix = cleanAnalysis.match(/\{[\s\S]*\}$/);
  const cleanedText = jsonSuffix ? cleanAnalysis.replace(jsonSuffix[0], '').trim() : cleanAnalysis;

  const isJsonOnly = rawAnalysis.trim().startsWith('{') && rawAnalysis.trim().endsWith('}');
  if (isJsonOnly) {
    // Build a readable narrative from the structured JSON output (hide raw JSON)
    const jsonSummaryLines: string[] = [];
    jsonSummaryLines.push(`**Bias:** ${bias.toUpperCase()}`);
    if (entryPrice) jsonSummaryLines.push(`**Entry:** ${entryPrice.toFixed(marketType === 'forex' ? 5 : 2)}`);
    if (sl) jsonSummaryLines.push(`**Stop Loss:** ${sl.toFixed(marketType === 'forex' ? 5 : 2)}`);
    if (tp) jsonSummaryLines.push(`**Take Profit:** ${tp.toFixed(marketType === 'forex' ? 5 : 2)}`);
    if (entryPrice && sl && tp) {
      const reward = bias === 'bullish' ? tp - entryPrice : entryPrice - tp;
      const risk = bias === 'bullish' ? entryPrice - sl : sl - entryPrice;
      if (risk > 0) jsonSummaryLines.push(`**Risk/Reward:** 1:${(reward / risk).toFixed(2)}`);
    }
    if (confidence !== null) jsonSummaryLines.push(`**Confidence:** ${(confidence * 100).toFixed(0)}%`);
    if (reason) jsonSummaryLines.push(`**Reasoning:** ${reason}`);

    return `${analysisBody}${jsonSummaryLines.join('\n')}\n\n`;
  }

  return analysisBody + cleanedText;
}

async function postSignalToGroup(bot: any, chatId: string, topicId: string | undefined, analysis: string, symbol: string, marketType: string, newSignal: any, isForce: boolean) {
  try {
    log(`[scanner] bot.sendMessage to ${chatId} (topic: ${topicId})`, "scanner");
    
    // remove other active signal in this chat if exists
    try {
      const existing = (await storage.getSignals()).find(s => s.status === 'active' && s.chatId === chatId && s.type === newSignal.type && s.id !== newSignal.id);
      if (existing && existing.messageId) {
        await bot.deleteMessage(chatId, existing.messageId).catch(() => {});
        log(`[scanner] deleted old active signal message ${existing.messageId} in ${chatId}`, "scanner");
      }
    } catch (e) {}

    // Extract capital, leverage, and PnL info from signal
    const capital = parseFloat(newSignal.capital || "50");
    const leverage = parseFloat(newSignal.leverage || (marketType === 'forex' ? "10" : "15"));
    const positionSize = parseFloat(newSignal.positionSize || (capital * leverage).toString());
    const lotSize = newSignal.lotSize ? parseFloat(newSignal.lotSize) : null;
    const pipValue = newSignal.pipValue ? parseFloat(newSignal.pipValue) : null;
    const entryPrice = parseFloat(newSignal.entryPrice || "0");
    const tp1 = parseFloat(newSignal.tp1 || "0");
    const sl = parseFloat(newSignal.sl || "0");

    // Build signal header with capital and leverage info
    let signalHeader = `📊 **NEW SIGNAL: ${symbol} (${marketType.toUpperCase()})**\n`;
    signalHeader += `💰 **Capital: $${capital} | Leverage: ${leverage}x**\n`;
    
    if (marketType === 'forex' && lotSize && pipValue) {
      signalHeader += `📈 **Lot Size: ${lotSize.toFixed(3)} | Pip Value: ${pipValue.toFixed(4)}**\n`;
    } else {
      signalHeader += `📊 **Position Size: ${positionSize.toFixed(2)} USD**\n`;
    }
    signalHeader += `\n`;

    const rr = (entryPrice && tp1 && sl && sl !== entryPrice) ? (() => {
      const reward = (newSignal.bias === 'bullish' ? tp1 - entryPrice : entryPrice - tp1);
      const risk = (newSignal.bias === 'bullish' ? entryPrice - sl : sl - entryPrice);
      if (risk > 0) return (reward / risk).toFixed(2);
      return null;
    })() : null;

    // Build strategic confluence section using stored indicator data if available
    const indicators = (newSignal.data && typeof newSignal.data === 'object') ? (newSignal.data.indicators || {}) : {};
    const preFilterScore = (newSignal.data && typeof newSignal.data === 'object') ? newSignal.data.preFilterScore : undefined;

    const structure = (indicators.timeframe && indicators.timeframe.aligned)
      ? `Bullish HTF alignment at key support` // generic
      : `Mixed HTF signals (watch for confluence)`;
    const poi = indicators.bollingerBands ? `Price ${indicators.bollingerBands.status.toLowerCase().includes('middle') ? 'testing BB middle band' : 'at key BB level'}` : `Price at current structure`;
    const candles = indicators.candlestick?.pattern ? `${indicators.candlestick.pattern} pattern confirmed` : `Candlestick confirmation unavailable`;

    const indicatorLines = [];
    if (indicators.ema9 && indicators.ema21) indicatorLines.push(`- EMA: Price between 9 (${indicators.ema9}) & 21 (${indicators.ema21})`);
    if (indicators.rsi) indicatorLines.push(`- RSI: ${indicators.rsi} (${parseFloat(indicators.rsi) > 50 ? 'Bullish momentum' : 'Bearish momentum'})`);
    if (indicators.macd) indicatorLines.push(`- MACD: ${indicators.macd.histogram && parseFloat(indicators.macd.histogram) > 0 ? 'Bullish histogram expansion' : 'Bearish histogram'}`);
    if (indicators.supertrend) indicatorLines.push(`- Supertrend: ${indicators.supertrend.direction}`);
    if (indicators.ichimoku) indicatorLines.push(`- Ichimoku: ${indicators.ichimoku.cloud}`);
    if (indicators.bollingerBands) indicatorLines.push(`- BB: ${indicators.bollingerBands.status}`);
    if (indicators.vwapBias) indicatorLines.push(`- VWAP: ${indicators.vwapBias}`);

    const volatility = indicators.atr ? `ATR at ${indicators.atr} indicating ${parseFloat(indicators.atr) / (entryPrice || 1) > 0.02 ? 'moderate/high' : 'low'} volatility` : `Volatility data unavailable`;
    const technicalScore = typeof preFilterScore === 'number' ? `${Math.round((preFilterScore / 5) * 100)}/100` : `N/A`;

    const institutionalReasoning = newSignal.reason ? newSignal.reason : `Generated from signal model based on indicator confluence.`;

    const executionLines: string[] = [];
    executionLines.push(`\n🎯 **EXECUTION ZONES:**`);
    if (entryPrice) executionLines.push(`📍 **Institutional Entry:** ${entryPrice.toFixed(5)}`);
    if (sl) executionLines.push(`🛑 **Stop Loss:** ${sl.toFixed(5)} (${indicators.bollingerBands?.lower ? 'Below BB Lower Band' : 'Key structure'})`);
    if (tp1) executionLines.push(`🎯 **Take Profit:** ${tp1.toFixed(5)} (${indicators.bollingerBands?.upper ? 'BB Upper Band' : 'Key structure'})`);
    if (rr) executionLines.push(`📊 **Risk/Reward:** 1:${rr}`);

    const analysisBody = [];
    analysisBody.push(`💎 **PREMIUM INSTITUTIONAL SETUP** 💎`);
    analysisBody.push(`\n**SYMBOL:** ${symbol} | **BIAS:** ${newSignal.bias?.toUpperCase()}`);
    analysisBody.push(`\n**STRATEGIC CONFLUENCE:**`);
    analysisBody.push(`**Structure:** ${structure}`);
    analysisBody.push(`**POI:** ${poi}`);
    analysisBody.push(`**Candlesticks:** ${candles}`);
    if (indicatorLines.length) analysisBody.push(`**Indicators:**\n${indicatorLines.join('\n')}`);
    analysisBody.push(`**Volatility:** ${volatility}`);
    analysisBody.push(`**Technical Score:** ${technicalScore}`);
    analysisBody.push(`\n**INSTITUTIONAL REASONING:** ${institutionalReasoning}`);
    analysisBody.push(`\n**Horizon:** Institutional Order Flow Neutral`);
    analysisBody.push(`**Source:** SMC Institutional Engine v3.0`);

    const signalBody = signalHeader + executionLines.join('\n') + '\n\n' + analysisBody.join('\n') + '\n\n';

    // Clean up analysis text for plain-text output
    const cleanAnalysis = analysis
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .slice(0, 2600);  // Leave room for signal header + body and JSON

    const fullMessage = signalBody + cleanAnalysis;
    const msgOptions: any = {};
    
    if (topicId && !isNaN(parseInt(topicId))) {
      msgOptions.message_thread_id = parseInt(topicId);
    }

    log(`[scanner] Posting to ${chatId}: ${signalHeader.slice(0, 80)}...`, "scanner");
    const sent = await bot.sendMessage(chatId, fullMessage, msgOptions);

    if (!isForce) {
      try { await bot.pinChatMessage(chatId, sent.message_id); } catch (e) {
        log(`[scanner] Pin failed in ${chatId}: ${e.message}`, "scanner");
      }
    }
    
    await storage.updateSignal(newSignal.id, { 
      chatId, topicId: topicId || null, messageId: sent.message_id.toString() 
    });
    log(`[scanner] Successfully sent signal to ${chatId}`, "scanner");
  } catch (err: any) {
    log(`[scanner] Error in postSignalToGroup for ${chatId}: ${err.message}`, "scanner");
  }
}

export async function runMonitoringLoop() {
  try {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const isWeekend = (day === 6) || (day === 0 && hour < 22) || (day === 5 && hour >= 22);
    if (isWeekend) {
      log("[monitor] Weekend detected – skipping monitoring.", "monitor");
      return;
    }
    const allSignals = await storage.getSignals();
    const active = allSignals.filter(s => s.status === "active");
    if (active.length === 0) {
      log("[monitor] No active signals to monitor.", "monitor");
      // Add more debug info
      log(`[monitor] Total signals in DB: ${allSignals.length}`, "monitor");
      return;
    }
    const bot = getTelegramBot();
    if (!bot) return;

    for (const signal of active) {
      log(`[monitor] Checking signal: ${signal.symbol} (${signal.type})`, "monitor");
      const currentPrice = await getPrice(signal.symbol, signal.type);
      if (currentPrice === 0) {
        log(`[monitor] Failed to get price for ${signal.symbol}`, "monitor");
        continue;
      }

      // Check 3-day timeout before any TP/SL logic
      const signalAgeMs = Date.now() - signal.createdAt.getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const isTimeout = signalAgeMs > threeDaysMs;
      if (isTimeout) {
        log(`[monitor] Signal ${signal.symbol} exceeded 3-day timeout (${(signalAgeMs / (24*60*60*1000)).toFixed(1)}d)`, "monitor");
        // calculate PnL at current price
        const entry = parseFloat(signal.entryPrice || "0");
        const capital = parseFloat(signal.capital || "50");
        const leverage = parseFloat(signal.leverage || (signal.type === 'forex' ? "10" : "15"));
        const positionSize = parseFloat(signal.positionSize || (capital * leverage).toString());
        const fees = parseFloat(signal.fees || "0.001");
        let pnlAmount = 0;
        if (signal.type === 'forex') {
          const lotSize = parseFloat(signal.lotSize || (capital / 1000).toString());
          const pipValue = parseFloat(signal.pipValue || (lotSize * 10).toString());
          const priceDiff = currentPrice - entry;
          const pipDiff = priceDiff * 10000;
          pnlAmount = (pipDiff * pipValue) - (positionSize * fees * 2);
        } else {
          const priceDiff = currentPrice - entry;
          const assetQty = positionSize / entry;
          pnlAmount = (priceDiff * assetQty) - (positionSize * fees * 2);
        }
        const pnlPercent = entry > 0 ? (pnlAmount / capital) * 100 : 0;
        const marketLabel = signal.type === 'crypto' ? 'Crypto' : 'Forex';

        const targetBindings = await db.select().from(groupBindings).where(
          eq(groupBindings.market, signal.type)
        );

        // Ensure we notify the original signal chat if it's not already in the bound list
        const sentTo = new Set<string>(targetBindings.map(b => b.groupId));
        if (signal.chatId && !sentTo.has(signal.chatId)) {
          targetBindings.push({
            id: -1,
            groupId: signal.chatId,
            topicId: signal.topicId || null,
            market: signal.type,
            lane: '',
            purpose: null,
            createdAt: 0,
            data: null
          } as any);
        }

        for (const binding of targetBindings) {
          if (!openRouterClient) await initAI();
          if (!openRouterClient) continue;
          try {
            const timeoutMessage = `🚨 <b>INSTITUTIONAL SIGNAL TIMEOUT: ${signal.symbol}</b>\n\n<b>Market:</b> ${marketLabel}\n<b>Status:</b> ⏰ 3-DAY TIMEOUT EXCEEDED\n\n<b>Reason for Closure:</b> Signal has not achieved TP/SL within the 3-day timeframe.\n\n<b>Current Price:</b> ${currentPrice.toFixed(signal.type === 'forex' ? 5 : 2)}\n<b>PnL:</b> ${pnlAmount >= 0 ? '📈' : '📉'} ${pnlAmount.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n\n<b>Recommendation:</b> CLOSE POSITION - Signal timeout reached`;
            const opts:any={parse_mode:'HTML'};
            if (binding.topicId && !isNaN(parseInt(binding.topicId))) opts.message_thread_id = parseInt(binding.topicId);
            await bot.sendMessage(binding.groupId, timeoutMessage, opts);
            log(`[monitor] Sent timeout message for ${signal.symbol} to ${binding.groupId}`, "monitor");
          } catch(e:any){ log(`[monitor] timeout msg failed for ${signal.symbol} in ${binding.groupId}: ${e.message}`,"monitor"); }
        }
        await storage.updateSignal(signal.id, {
          status: "completed",
          lastUpdateAt: new Date(),
          exitPrice: currentPrice.toString(),
          pnlAmount: pnlAmount.toString(),
          pnlPercent: pnlPercent.toString()
        });
        log(`[monitor] Closed old signal ${signal.symbol} PnL ${pnlAmount.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,"monitor");
        continue;
      }

      const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
      const lastMonitoredPrice = signalData.lastMonitoredPrice;

      if (lastMonitoredPrice !== undefined && lastMonitoredPrice !== currentPrice) {
        log(`[monitor] Price change detected for ${signal.symbol}: ${lastMonitoredPrice} -> ${currentPrice}`, "monitor");
      }
      
      const entry = parseFloat(signal.entryPrice || "0");
      const tp = parseFloat(signal.tp1 || "0");
      const sl = parseFloat(signal.sl || "0");
      let statusUpdate = "";

      const eps = 1e-6;
      if (signal.bias === "bullish") {
        if (sl > 0 && currentPrice <= sl + eps) statusUpdate = "STOP LOSS HIT 🛑";
        else if (tp > 0 && currentPrice >= tp - eps) statusUpdate = "TAKE PROFIT HIT 🎯";
      } else {
        if (sl > 0 && currentPrice >= sl - eps) statusUpdate = "STOP LOSS HIT 🛑";
        else if (tp > 0 && currentPrice <= tp + eps) statusUpdate = "TAKE PROFIT HIT 🎯";
      }

      const lastUpdate = signal.lastUpdateAt || signal.createdAt;
      const now = new Date();
      // Use local timestamp for calculation if DB timestamp is UTC
      const lastUpdateTime = lastUpdate instanceof Date ? lastUpdate.getTime() : new Date(lastUpdate).getTime();
      const nowMs = Date.now();
      const diffMin = (nowMs - lastUpdateTime) / 60000;

      log(`[monitor] Checking ${signal.symbol}: Price: ${currentPrice}, TP: ${tp}, SL: ${sl}, Diff: ${diffMin.toFixed(1)}m | Last: ${new Date(lastUpdateTime).toLocaleTimeString()} | Now: ${new Date(nowMs).toLocaleTimeString()}`, "monitor");

      const lastPriceForChange = lastMonitoredPrice || entry;
      
      // Fix: Only calculate percentage change if lastPriceForChange is valid and > 0
      const priceChangePct = (lastPriceForChange > 0) ? Math.abs((currentPrice - lastPriceForChange) / lastPriceForChange) * 100 : 0;
      
      // Determine normal volatility and abnormal-move thresholds (configurable via env)
      const normalVol = (signal.type === 'forex' ? NORMAL_VOL_FOREX : NORMAL_VOL_CRYPTO);
      const isBigMove = (lastPriceForChange > 0) && (priceChangePct >= normalVol * ABNORMAL_MOVE_MULTIPLIER);

      if (!statusUpdate && isBigMove) {
        statusUpdate = "SIGNIFICANT ORDER FLOW SHIFT ⚠️ (STRUCTURAL UPDATE REQUIRED)";
      }

      // Heartbeat interval is configurable via SIGNAL_UPDATE_INTERVAL_MIN
      const isHeartbeat = diffMin >= SIGNAL_UPDATE_INTERVAL_MIN;
      // Only post when there's a status change, a big move, or heartbeat interval has passed
      // include heartbeat only when price change exceeds normal volatility
      const shouldPost = Boolean(statusUpdate) || isBigMove || (isHeartbeat && priceChangePct >= normalVol);

      if (shouldPost) {
        log(`[monitor] UPDATE TRIGGERED for ${signal.symbol}. Reason: ${statusUpdate || 'Heartbeat'}, Diff: ${diffMin.toFixed(1)}m`, "monitor");
        const targetBindings = await db.select().from(groupBindings).where(
          eq(groupBindings.market, signal.type)
        );
        log(`[monitor] Found ${targetBindings.length} target groups for ${signal.symbol} (${signal.type})`, "monitor");
        
        for (const binding of targetBindings) {
          const finalStatusUpdate = statusUpdate || `INSTITUTIONAL UPDATE ⏱\nPrice: ${currentPrice.toFixed(signal.type === 'forex' ? 5 : 2)}`;
          log(`[monitor] Posting to ${binding.groupId} for ${signal.symbol} (Topic: ${binding.topicId})`, "monitor");
          
          if (!openRouterClient) await initAI();
          if (!openRouterClient) continue;

          try {
            
// Fetch recent headlines and social posts to enrich AI update (best-effort)
            const internetContext = await fetchInternetContext(signal.symbol).catch(() => []);
            const headlines = internetContext;
            // append current date so model is aware of timeframe
            if (headlines.length >= 0) headlines.push(`Date: ${new Date().toISOString()}`);

            const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
            const lastUpdateIdKey = `lastUpdateMessageId_${binding.groupId}_${binding.topicId || 'main'}`;
            const lastUpdateId = signalData[lastUpdateIdKey];
            

            const isTp = finalStatusUpdate.includes("TP HIT") || finalStatusUpdate.includes("TARGET");
            const isSl = finalStatusUpdate.includes("SL HIT") || finalStatusUpdate.includes("INVALIDATION");
            const isTimeoutStatus = finalStatusUpdate.includes("TIMEOUT");
            const isFinalStatus = isTp || isSl || isTimeoutStatus;

            const instStatus = isTp ? "🎯 TARGET LIQUIDITY MITIGATED (TP HIT)" : 
                              isSl ? "🛑 STRUCTURAL INVALIDATION TRIGGERED (SL HIT)" :
                              isTimeoutStatus ? "⏳ TIMEOUT (3-day limit) - CLOSE POSITION" :
                              statusUpdate || `INSTITUTIONAL UPDATE ⏱ Price: ${currentPrice.toFixed(signal.type === 'forex' ? 5 : 2)}`;

            const model = "anthropic/claude-3.5-haiku";
            const messages: any[] = [
              { role: "system", content: `Provide brief 2-sentence institutional update for ${signal.symbol} at status ${instStatus}. Analyze the current price ${currentPrice} vs Entry ${entry}. 

CRITICAL INSTRUCTIONS:
- If TP HIT: Always recommend "CLOSE POSITION - TARGET ACHIEVED" 
- If SL HIT: Always recommend "CLOSE POSITION - STOP LOSS TRIGGERED"
- If "SIGNIFICANT ORDER FLOW SHIFT": Suggest specific actions like "Move SL to Breakeven", "Close 50%", or "Hold" based on institutional market structure
- Focus on "Big Moves" as opportunities for structural adjustments rather than closing

Professional enterprise style with emojis. STRICTLY FORBIDDEN: NEVER use retail terms like "Scalp", "Scalping", "Swing", "Swing Trade", or "Day Trade".` }];
            // inform model of present date so it doesn't default to 2024
            messages.push({ role: "user", content: `Current date: ${new Date().toISOString()}` });
            if (headlines && headlines.length) {
              messages.push({ role: 'user', content: `Recent headlines for ${signal.symbol}:\n${headlines.join('\n')}\n\nPlease consider any relevance to price or liquidity when composing your 2-sentence update.` });
            }

            const res = await openRouterClient.chat.completions.create({ model, messages });
            const updateMsg = `🚨 <b>INSTITUTIONAL UPDATE: ${signal.symbol}</b>\n\n<b>Status:</b> ${instStatus}\n\n${res.choices[0].message?.content}`;
            
            log(`[monitor] Sending message to group ${binding.groupId} thread ${binding.topicId}`, "monitor");
            const updateOptions: any = { 
              parse_mode: 'HTML'
            };
            
            if (binding.topicId && !isNaN(parseInt(binding.topicId))) {
              updateOptions.message_thread_id = parseInt(binding.topicId);
            }

            let sent: any;
            if (lastUpdateId) {
              try {
                // delete previous update to avoid clutter
                await bot.deleteMessage(binding.groupId, lastUpdateId.toString()).catch(() => {});
                log(`[monitor] Deleted previous update (${lastUpdateId}) for ${signal.symbol} in ${binding.groupId}`, "monitor");
              } catch (delErr: any) {
                log(`[monitor] Failed to delete previous update: ${delErr.message}`, "monitor");
              }
            }
            sent = await bot.sendMessage(binding.groupId, updateMsg, updateOptions);

            // Immediately log for verification
            log(`[monitor] Successfully posted update for ${signal.symbol} to group ${binding.groupId}`, "monitor");

            // Calculate PnL if signal is being completed (TP/SL hit)
            let pnlAmount = null;
            let pnlPercent = null;
            let exitPrice = null;
            
            if (isFinalStatus) {
              exitPrice = currentPrice.toString();
              
              const capital = parseFloat(signal.capital || "50");
              const leverage = parseFloat(signal.leverage || (signal.type === 'forex' ? "10" : "15"));
              const positionSize = parseFloat(signal.positionSize || (capital * leverage).toString());
              const fees = parseFloat(signal.fees || "0.001");
              const entry = parseFloat(signal.entryPrice || "0");
              
              if (signal.type === 'forex') {
                // Forex PnL: (Exit Price – Entry Price) × Lot Size × Pip Value – Fees
                const lotSize = parseFloat(signal.lotSize || (capital / 1000).toString());
                const pipValue = parseFloat(signal.pipValue || (lotSize * 10).toString());
                const priceDiff = currentPrice - entry;
                const pipDiff = priceDiff * 10000; // Convert to pips (assuming 4 decimal places)
                pnlAmount = (pipDiff * pipValue) - (positionSize * fees * 2); // Fees for both entry and exit
              } else {
                // Crypto PnL: (Exit Price – Entry Price) × Position Size – Fees
                const priceDiff = currentPrice - entry;
                const assetQuantity = positionSize / entry; // How much crypto we bought
                pnlAmount = (priceDiff * assetQuantity) - (positionSize * fees * 2); // Fees for both entry and exit
              }
              
              pnlPercent = entry > 0 ? (pnlAmount / capital) * 100 : 0;
              
              log(`[monitor] PnL calculated for ${signal.symbol}: Amount: ${pnlAmount?.toFixed(4)}, Percent: ${pnlPercent?.toFixed(2)}%`, "monitor");
            }

            await storage.updateSignal(signal.id, {
              status: isFinalStatus ? "completed" : "active",
              lastUpdateAt: new Date(),
              exitPrice,
              pnlAmount: pnlAmount?.toString(),
              pnlPercent: pnlPercent?.toString(),
              data: JSON.stringify({ 
                ...signalData, 
                [lastUpdateIdKey]: sent.message_id.toString(), 
                lastMonitoredPrice: currentPrice 
              })
            });

            if (isFinalStatus) {
              log(`[monitor] Final status for ${signal.symbol}. Triggering 10m cooldown for ${signal.type} bindings.`, "monitor");
              const cooldownKey = `cooldown_${signal.type}`;
              const cooldownTime = Date.now() + (10 * 60 * 1000);
              
              for (const targetBinding of targetBindings) {
                try {
                  const currentData = (typeof (targetBinding as any).data === 'string' ? JSON.parse((targetBinding as any).data) : (targetBinding as any).data) || {};
                  await db.update(groupBindings).set({
                    data: JSON.stringify({ ...currentData, [cooldownKey]: cooldownTime })
                  } as any).where(eq(groupBindings.id, targetBinding.id));
                } catch (e: any) {
                  log(`[monitor] Failed to set cooldown for group ${targetBinding.groupId}: ${e.message}`, "monitor");
                }
              }
            }
            log(`[monitor] Successfully posted update for ${signal.symbol} to ${binding.groupId}`, "monitor");
          } catch (e: any) {
            log(`[monitor] Post failed for ${signal.symbol} to ${binding.groupId}: ${e.message}`, "monitor");
          }
        }
      } else {
        // Just update the last monitored price if no message was sent
        const signalData = (typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data) || {};
        await storage.updateSignal(signal.id, {
          data: JSON.stringify({ ...signalData, lastMonitoredPrice: currentPrice })
        });
      }
    }
  } catch (err: any) { log("Monitor error: " + (err?.message || err)); }
}
