interface PriceData {
    price: string;
    change24h: number;
    high24h: string;
    low24h: string;
    volume24h: number;
    quote: string;
    source: string;
}
export declare function fetchPriceData(symbol: string): Promise<PriceData | null>;
export {};
//# sourceMappingURL=price-service.d.ts.map