// @ts-nocheck
// @ts-nocheck
import OpenAI from "openai";

let client: OpenAI | null = null;

function initClient() {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  
  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }
  
  if (!apiKey) {
    console.error("AI Client: No API key found in environment variables");
    return null;
  }
  
  client = new OpenAI({ 
    apiKey, 
    baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "HTTP-Referer": "https://replit.com",
      "X-Title": "SMC Trading Bot",
    }
  });
  return client;
}

export async function extractPairFromImage(imageUrl: string): Promise<string | null> {
  return extractPairFromMedia(imageUrl, false);
}

export async function extractPairFromMedia(mediaUrl: string, isVideo: boolean = false): Promise<string | null> {
  const c = initClient();
  if (!c) return null;

  try {
    const model = "anthropic/claude-3.5-haiku";
    const messages: any[] = [
      { role: "system", content: `You are a professional trading chart validator and analyst. Your task is to:
1) Determine if the provided media is a TRADING CHART (image or short video).
2) Extract the trading pair (e.g., BTC/USDT) in BASE/QUOTE format.
3) If it is NOT a chart, respond with "NONE".
Strictly respond with ONLY the pair or "NONE".` }
    ];

    if (isVideo) {
      messages.push({ role: 'user', content: `Analyze this video URL and identify the trading pair if visible: ${mediaUrl}. Respond ONLY with the pair (BASE/QUOTE) or NONE.` });
    } else {
      messages.push({ role: 'user', content: [ { type: 'text', text: 'Identify the trading pair from this image if it is a trading chart. Look at symbols, headers, and axes.' }, { type: 'image_url', image_url: { url: mediaUrl } } ] });
    }

    const response: any = await c.chat.completions.create({ model, max_tokens: 300, messages } as any);
    const text = response?.choices?.[0]?.message?.content || "";
    const t = (text || "").trim();
    if (!t || /NONE/i.test(t)) return null;

    const match = t.match(/([A-Z0-9]{2,10})\s*[-\/]?\s*([A-Z0-9]{2,10})/i);
    if (match) {
      const base = match[1].toUpperCase();
      const quote = match[2].toUpperCase();
      const filterWords = ['CHART', 'CANDLE', 'PRICE', 'TRADING', 'SETUP', 'ANALYSIS', 'PAIR', 'SYMBOL'];
      if (filterWords.includes(base) || filterWords.includes(quote)) return null;
      return `${base}/${quote}`;
    }

    if (t.length >= 6 && t.length <= 12 && !t.includes('/')) {
      const base = t.slice(0, t.length - 4).toUpperCase();
      const quote = t.slice(t.length - 4).toUpperCase();
      return `${base}/${quote}`;
    }

    return null;
  } catch (e) {
    return null;
  }
}
