import { Keypair } from "@solana/web3.js";
export declare class JupiterService {
    private connection;
    constructor(rpcUrl: string);
    private JUPITER_ENDPOINTS;
    private quoteCache;
    getQuote(inputMint: string, outputMint: string, amount: string, slippageBps?: number): Promise<any>;
    swap(userKeypair: Keypair, quoteResponse: any, mevProtection?: boolean, priorityFee?: string, isAuto?: boolean): Promise<string>;
}
//# sourceMappingURL=solana.d.ts.map