// @ts-nocheck
// Run with: npx tsx test-price.js
import { fetchPriceData } from './server/price-service.ts';

async function testPriceService() {
  console.log('Testing price service with PUMP.fun token...');

  const testTokens = [
    'GYL9U313FUNLMMWRMWXQ9EAXMH481NEH9HQDBRQ8/PUMP',
    'GYL9U313FUNLMMWRMWXQ9EAXMH481NEH9HQDBRQ8',
    'SOL/USDT',
    'BTC/USDT'
  ];

  for (const token of testTokens) {
    console.log(`\n--- Testing ${token} ---`);
    try {
      const result = await fetchPriceData(token);
      if (result) {
        console.log(`✅ Success: ${JSON.stringify(result, null, 2)}`);
      } else {
        console.log(`❌ No data found for ${token}`);
      }
    } catch (error) {
      console.log(`❌ Error for ${token}: ${error.message}`);
    }
  }
}

testPriceService().catch(console.error);