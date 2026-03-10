// @ts-nocheck
// @ts-nocheck
import axios from "axios";
import { log } from "./index.js";

interface PriceData {
  price: string;
  change24h: number;
  high24h: string;
  low24h: string;
  volume24h: number;
  quote: string;
  source: string;
}

export async function fetchPriceData(symbol: string): Promise<PriceData | null> {
  const parts = symbol.split('/');
  const base = parts[0].toLowerCase();
  const quote = parts[1]?.toUpperCase() || 'USDT';
  const pair = `${base.toUpperCase()}/${quote}`;

  // Special handling for Solana mint addresses - try to get token info first
  let tokenSymbol = base;
  let tokenName = base;
  if (base.length === 44 || base.length === 43) { // Solana mint address length
    try {
      log(`Detected Solana mint address: ${base}, trying to get token info`, "price-service");
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${base}`, { timeout: 5000 });
      const dexData = dexRes.data as any;
      if (dexData?.pairs?.[0]) {
        const pair = dexData.pairs[0];
        tokenSymbol = pair.baseToken?.symbol?.toLowerCase() || base;
        tokenName = pair.baseToken?.name?.toLowerCase() || base;
        log(`Resolved mint ${base} to symbol: ${tokenSymbol}, name: ${tokenName}`, "price-service");
      }
    } catch (e) {
      log(`Failed to resolve mint address ${base}: ${e}`, "price-service");
    }
  }

  // 1. Binance (High rate limit) - try resolved symbol first
  for (const symbolToTry of [tokenSymbol, base]) {
    try {
      const binanceSymbol = `${symbolToTry}${quote}`.toUpperCase();
      const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`, { timeout: 5000 });
      const binanceData = res.data as any;
      if (binanceData && binanceData.price) {
        const price = parseFloat(binanceData.price);
        return {
          price: price.toString(),
          change24h: 0,
          high24h: price.toString(),
          low24h: price.toString(),
          volume24h: 0,
          quote: quote,
          source: 'Binance'
        };
      }
    } catch (e) { /* silent fail for fallback */ }
  }

  // 2. CryptoCompare (Alternative reliable source) - try resolved symbol first
  for (const symbolToTry of [tokenSymbol, base]) {
    try {
      const res = await axios.get(`https://min-api.cryptocompare.com/data/price?fsym=${symbolToTry.toUpperCase()}&tsyms=${quote.toUpperCase()}`, { timeout: 5000 });
      if (res.data && res.data[quote.toUpperCase()]) {
        const price = res.data[quote.toUpperCase()];
        return {
          price: price.toString(),
          change24h: 0,
          high24h: price.toString(),
          low24h: price.toString(),
          volume24h: 0,
          quote: quote,
          source: 'CryptoCompare'
        };
      }
    } catch (e) { /* silent fail for fallback */ }
  }

  // 3. Yahoo Finance (Reliable for Forex and Crypto)
  try {
    let yahooSymbol = `${base.toUpperCase()}-${quote.toUpperCase()}`;
    if (['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'].includes(base.toUpperCase())) {
      yahooSymbol = `${base.toUpperCase()}${quote.toUpperCase()}=X`;
    }
    
    const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`, { 
      timeout: 8000, 
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    
    const yahooData = res.data as any;
    if (yahooData?.chart?.result?.[0]) {
      const meta = yahooData.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      return {
        price: price.toString(),
        change24h: 0,
        high24h: price.toString(),
        low24h: price.toString(),
        volume24h: 0,
        quote: quote,
        source: 'Yahoo Finance'
      };
    }
  } catch (e) { /* silent fail */ }

// 4. DexScreener (For Solana/PUMP.fun tokens) - prioritize original mint address
  const dexSymbolsToTry = base.length >= 43 ? [base, tokenSymbol] : [tokenSymbol, base]; // Mint address first for Solana
  for (const symbolToTry of dexSymbolsToTry) {
    try {
      log(`Trying DexScreener for ${symbolToTry}`, "price-service");
      // Try direct token lookup first
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${symbolToTry}`, { timeout: 5000 });
      const dexData = dexRes.data as any;
      log(`DexScreener direct lookup result: ${dexData?.pairs?.length || 0} pairs`, "price-service");

      if (dexData?.pairs?.[0]) {
        const pair = dexData.pairs[0];
        const price = parseFloat(pair.priceUsd || "0");
        if (price > 0) {
          log(`DexScreener found price: ${price} for ${symbolToTry}`, "price-service");
          return {
            price: price.toString(),
            change24h: parseFloat(pair.priceChange?.h24 || "0"),
            high24h: pair.priceMax24h || price.toString(),
            low24h: pair.priceMin24h || price.toString(),
            volume24h: parseFloat(pair.volume?.h24 || "0"),
            quote: 'USD',
            source: 'DexScreener'
          };
        }
      }

      // Try search if direct lookup fails
      log(`Trying DexScreener search for ${symbolToTry}`, "price-service");
      const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbolToTry)}`, { timeout: 5000 });
      const searchData = searchRes.data as any;
      log(`DexScreener search result: ${searchData?.pairs?.length || 0} pairs`, "price-service");

      if (searchData?.pairs?.[0]) {
        const pair = searchData.pairs[0];
        const price = parseFloat(pair.priceUsd || "0");
        if (price > 0) {
          log(`DexScreener search found price: ${price} for ${symbolToTry}`, "price-service");
          return {
            price: price.toString(),
            change24h: parseFloat(pair.priceChange?.h24 || "0"),
            high24h: pair.priceMax24h || price.toString(),
            low24h: pair.priceMin24h || price.toString(),
            volume24h: parseFloat(pair.volume?.h24 || "0"),
            quote: 'USD',
            source: 'DexScreener'
          };
        }
      }
    } catch (e) { log(`DexScreener failed for ${symbolToTry}: ${e}`, "price-service"); }
  }

  // 5. CoinGecko (Fallback) - try resolved symbol first
  for (const symbolToTry of [tokenSymbol, base]) {
    try {
      const cgRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${symbolToTry}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, { timeout: 5000 });
      const cgData = cgRes.data as any;
      let data = cgData[symbolToTry];

      if (!data) {
        const searchRes = await axios.get(`https://api.coingecko.com/api/v3/search?query=${symbolToTry}`, { timeout: 5000 });
        const searchData = searchRes.data as any;
        const coinId = searchData?.coins?.[0]?.id;
        if (coinId) {
          const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`, { timeout: 5000 });
          const priceData = priceRes.data as any;
          data = priceData[coinId];
        }
      }

      if (data) {
        return {
          price: data.usd.toString(),
          change24h: data.usd_24h_change || 0,
          high24h: (data.usd * 1.02).toString(),
          low24h: (data.usd * 0.98).toString(),
          volume24h: data.usd_24h_vol || 0,
          quote: quote,
          source: 'CoinGecko'
        };
      }
    } catch (e) { log(`CoinGecko failed for ${symbolToTry}: ${e}`, "price-service"); }
  }

  // 6. PUMP.fun API (For PUMP.fun tokens)
  try {
    if (quote === 'PUMP' || base.length >= 43) { // PUMP.fun tokens have 43-44 char mint addresses
      log(`Trying PUMP.fun API for ${base}`, "price-service");
      const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${base}`, { timeout: 5000 });
      const pumpData = pumpRes.data as any;
      log(`PUMP.fun API response: ${JSON.stringify(pumpData).substring(0, 200)}`, "price-service");

      if (pumpData && pumpData.price) {
        const price = parseFloat(pumpData.price);
        log(`PUMP.fun found price: ${price} for ${base}`, "price-service");
        return {
          price: price.toString(),
          change24h: 0, // PUMP.fun might not provide this
          high24h: price.toString(),
          low24h: price.toString(),
          volume24h: parseFloat(pumpData.market_cap || "0") / 100, // Estimate volume
          quote: 'USD',
          source: 'PUMP.fun'
        };
      }
    }
  } catch (e) { log(`PUMP.fun failed for ${base}: ${e}`, "price-service"); }

  // 7. Jupiter API (For Solana tokens)
  try {
    if (base.length >= 43) { // Solana mint address
      log(`Trying Jupiter API for ${base}`, "price-service");
      const jupiterRes = await axios.get(`https://price.jup.ag/v4/price?ids=${base}`, { timeout: 5000 });
      const jupiterData = jupiterRes.data as any;
      log(`Jupiter API response: ${JSON.stringify(jupiterData).substring(0, 200)}`, "price-service");

      if (jupiterData?.data?.[base]) {
        const tokenData = jupiterData.data[base];
        const price = parseFloat(tokenData.price || "0");
        if (price > 0) {
          log(`Jupiter found price: ${price} for ${base}`, "price-service");
          return {
            price: price.toString(),
            change24h: 0,
            high24h: price.toString(),
            low24h: price.toString(),
            volume24h: 0,
            quote: 'USD',
            source: 'Jupiter'
          };
        }
      }
    }
  } catch (e) { log(`Jupiter failed for ${base}: ${e}`, "price-service"); }

  // 8. DIA (Final Fallback)
  try {
    const symUpper = base.toUpperCase();
    const res = await axios.get(`https://api.diadata.org/v1/quotation/${symUpper}`, { timeout: 5000 });
    const diaData = res.data as any;
    if (diaData && diaData.Price) {
      return {
        price: diaData.Price.toString(),
        change24h: diaData.PricePercentageChange24h || 0,
        high24h: (diaData.Price * 1.02).toString(),
        low24h: (diaData.Price * 0.98).toString(),
        volume24h: diaData.Volume24h || 0,
        quote: quote,
        source: 'DIA'
      };
    }
  } catch (e) { log(`DIA failed for ${base}: ${e}`, "price-service"); }

  return null;
}
