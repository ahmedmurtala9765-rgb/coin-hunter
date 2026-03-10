import OpenAI from "openai";
export declare let openRouterClient: OpenAI | null;
export declare let aiMockMode: boolean;
declare const mockAiResponse: (topic: string) => string;
export declare function initAI(): Promise<void>;
export { mockAiResponse };
declare function generateTechnicalIndicators(symbol: string, priceData: any): Promise<{
    ema9: string;
    ema21: string;
    rsi: string;
    macd: string;
    macdSignal: string;
    bbUpper: string;
    bbMiddle: string;
    bbLower: string;
    atr: string;
    supertrend: string;
    supertrendDirection: string;
    fibLevels: {
        level236: number;
        level382: number;
        level500: number;
        level618: number;
        level786: number;
    };
    vwap: string;
    ichimokuConversion: string;
    ichimokuBase: string;
    priceSource: any;
}>;
export { generateTechnicalIndicators };
export declare function runAutoSignalGenerator(): Promise<void>;
export declare function runScanner(marketType: "crypto" | "forex", isForce?: boolean, forceChatId?: string, forceTopicId?: string, forcePair?: string, mode?: "setup" | "analyze", imageUrl?: string): Promise<boolean>;
export declare function runMonitoringLoop(): Promise<void>;
//# sourceMappingURL=signals-worker.d.ts.map