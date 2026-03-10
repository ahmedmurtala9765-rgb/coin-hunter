// @ts-nocheck
// @ts-nocheck
import { Connection, PublicKey, Transaction, SystemProgram, Keypair, VersionedTransaction } from "@solana/web3.js";
import axios from "axios";

// This is a simplified Jupiter execution wrapper
// In a real bot, you'd use @jup-ag/api properly with versioned transactions
export class JupiterService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, { 
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60000 
    });
  }

  private JUPITER_ENDPOINTS = [
    "https://quote-api.jup.ag/v6",
    "https://jupiter-quote-api.jup.ag/v6",
    "https://quote.jup.ag/v6",
    "https://api.jup.ag/swap/v6",
    "https://jup.nodes.bitflow.live/v6",
    "https://public.jupiterapi.com",
    "https://jupiter.api.dex.guru/v6",
    "https://solana-gateway.hellomoon.io/v1/jupiter/quote"
  ];

  private quoteCache = new Map<string, { data: any, timestamp: number }>();

  async getQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number = 100) {
    const cacheKey = `${inputMint}-${outputMint}-${amount}-${slippageBps}`;
    const cached = this.quoteCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 20000) {
      console.log(`[jupiter] Using cached quote for ${inputMint}/${outputMint}`);
      return cached.data;
    }

    let lastError;
    // Try each endpoint with retry logic
    for (const endpoint of this.JUPITER_ENDPOINTS) {
      for (let i = 0; i < 2; i++) { // Reduced retries for faster fallback
        try {
          const url = `${endpoint}/quote`;
          console.log(`[jupiter] Requesting ${url} with params:`, { inputMint, outputMint, amount: amount.toString(), slippageBps });
          const response = await axios.get(url, {
            params: {
              inputMint,
              outputMint,
              amount: amount.toString(),
              slippageBps,
              onlyDirectRoutes: false,
              asLegacyTransaction: false,
            },
            timeout: 10000,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'SolanaSMCBot/1.0',
            }
          });
          const respData = response.data as any;
          if (respData && respData.outAmount) {
            this.quoteCache.set(cacheKey, { data: respData, timestamp: Date.now() });
            return respData;
          }
        } catch (error: any) {
          lastError = error;
          const status = error.response?.status;
          console.error(`[jupiter] Error on ${endpoint}:`, error.message);
          
          if (status === 401 || status === 403 || status === 400 || status === 429) {
            if (status === 401 || status === 403) break; // Auth errors, try next endpoint
          }
          if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    
    // Emergency Public Proxy Bridge with robust parsing and multiple proxies
    const proxyServices = [
      (target: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`,
      (target: string) => `https://corsproxy.io/?${encodeURIComponent(target)}`,
      (target: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
    ];

    console.log(`[jupiter] Attempting emergency proxy fallback with ${proxyServices.length} options...`);
    const targetUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

    for (const getProxyUrl of proxyServices) {
      try {
        const proxyUrl = getProxyUrl(targetUrl);
        console.log(`[jupiter] Trying proxy: ${proxyUrl}`);
        const res = await axios.get(proxyUrl, { timeout: 15000 });
        let data = res.data;
        if (data && (data as any).contents) {
          data = typeof (data as any).contents === 'string' ? JSON.parse((data as any).contents) : (data as any).contents;
        }
        const jsonData = data as any;
        if (jsonData && jsonData.outAmount) {
          console.log(`[jupiter] Proxy fallback success!`);
          return jsonData;
        }
      } catch (e: any) {
        console.error(`[jupiter] Proxy fallback failed:`, e.message);
      }
    }

    throw new Error(`Execution failed: Trade routes are currently unreachable. This is often due to network restrictions. Please try again in 1 minute.`);
  }

  async swap(userKeypair: Keypair, quoteResponse: any, mevProtection: boolean = true, priorityFee: string = "0.0015", isAuto: boolean = false) {
    let lastError;
    const priorityFeeLamports = Math.floor(parseFloat(priorityFee) * 1e9).toString();
    
    // Additional RPC fallbacks for maximum efficiency
    const extraRpcs = [
      process.env.SOLANA_RPC_URL,
      "https://api.mainnet-beta.solana.com",
      "https://rpc.ankr.com/solana",
      "https://solana.publicnode.com",
      "https://solana-mainnet.rpc.extrnode.com",
    ].filter(Boolean) as string[];

    const swapParams = {
      quoteResponse,
      userPublicKey: userKeypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports,
    };

    if (isAuto) {
      (swapParams as any).computeUnitPriceMicroLamports = "auto";
    }

    for (const endpoint of this.JUPITER_ENDPOINTS) {
      try {
        const url = `${endpoint}/swap`;
        console.log(`[jupiter] Generating swap TX via ${url}`);
        const response = await axios.post(url, swapParams, { 
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' }
        });
        const { swapTransaction } = response.data as any;

        if (!swapTransaction) continue;

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([userKeypair]);

        for (const rpc of extraRpcs) {
          try {
            const currentConn = new Connection(rpc, "confirmed");
            const signature = await currentConn.sendRawTransaction(transaction.serialize(), {
              skipPreflight: true,
              maxRetries: 2,
              preflightCommitment: 'confirmed'
            });

            const latestBlockHash = await currentConn.getLatestBlockhash('confirmed');
            await currentConn.confirmTransaction({
              blockhash: latestBlockHash.blockhash,
              lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
              signature: signature,
            }, 'confirmed');

            return signature;
          } catch (rpcErr: any) {
            console.error(`[rpc] Send failed via ${rpc}: ${rpcErr.message}`);
            lastError = rpcErr;
          }
        }
      } catch (swapErr: any) {
        console.error(`[jupiter] Swap generation failed via ${endpoint}: ${swapErr.message}`);
        lastError = swapErr;
      }
    }
    throw new Error(`Failed to execute swap: ${lastError?.message}`);
  }
}
