import { Injectable, Logger } from '@nestjs/common';

export interface TokenPriceResult {
  priceUsd: number;
  source: 'dexscreener' | 'coingecko' | 'fallback';
  fetchedAt: string;
  confidence: 'high' | 'low';
}

interface DexScreenerPair {
  chainId?: string;
  priceUsd?: string;
  liquidity?: {
    usd?: number;
  };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

interface CoinGeckoPriceData {
  usd?: number;
}

@Injectable()
export class LitePricingService {
  private readonly logger = new Logger(LitePricingService.name);
  private readonly priceCache = new Map<
    string,
    { result: TokenPriceResult; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  async getTokenPrice(
    contractAddress: string,
    chain: string,
  ): Promise<TokenPriceResult> {
    const normalizedChain = chain.toLowerCase();
    const normalizedAddress = contractAddress.toLowerCase();
    const key = `${normalizedChain}:${normalizedAddress}`;
    const cached = this.priceCache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    let result = await this.tryDexScreener(normalizedAddress, normalizedChain);
    if (!result) {
      result = await this.tryCoinGecko(normalizedAddress, normalizedChain);
    }

    if (!result) {
      result = {
        priceUsd: 0,
        source: 'fallback',
        fetchedAt: new Date().toISOString(),
        confidence: 'low',
      };
      this.logger.warn(`No price found for ${contractAddress} on ${chain}`);
    }

    this.priceCache.set(key, {
      result,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return result;
  }

  async getBatchPrices(
    tokens: Array<{ contractAddress: string; chain: string }>,
  ): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    const byChain = new Map<string, Set<string>>();

    for (const token of tokens) {
      const chain = token.chain.toLowerCase();
      const address = token.contractAddress.toLowerCase();
      const cacheKey = `${chain}:${address}`;
      const cached = this.priceCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        priceMap.set(cacheKey, cached.result.priceUsd);
        continue;
      }

      if (!byChain.has(chain)) {
        byChain.set(chain, new Set<string>());
      }
      byChain.get(chain)?.add(address);
    }

    const platformMap: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon-pos',
      bsc: 'binance-smart-chain',
      base: 'base',
    };

    for (const [chain, addressSet] of byChain.entries()) {
      const platform = platformMap[chain];
      if (!platform) {
        continue;
      }

      const addresses = [...addressSet];
      const chunks: string[][] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        chunks.push(addresses.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        try {
          const url =
            `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
            `?contract_addresses=${chunk.join(',')}` +
            '&vs_currencies=usd';
          const response = await fetch(url);

          if (!response.ok) {
            continue;
          }

          const data = (await response.json()) as Record<string, CoinGeckoPriceData>;
          for (const [address, priceData] of Object.entries(data)) {
            if (typeof priceData.usd !== 'number') {
              continue;
            }

            const key = `${chain}:${address.toLowerCase()}`;
            priceMap.set(key, priceData.usd);
            this.priceCache.set(key, {
              result: {
                priceUsd: priceData.usd,
                source: 'coingecko',
                fetchedAt: new Date().toISOString(),
                confidence: 'high',
              },
              expiresAt: Date.now() + this.CACHE_TTL_MS,
            });
          }

          if (chunks.length > 1) {
            await this.sleep(2000);
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Batch price fetch failed for ${chain}: ${this.getErrorMessage(err)}`,
          );
        }
      }
    }

    return priceMap;
  }

  private async tryDexScreener(
    contractAddress: string,
    chain: string,
  ): Promise<TokenPriceResult | null> {
    try {
      const chainMap: Record<string, string> = {
        ethereum: 'ethereum',
        polygon: 'polygon',
        bsc: 'bsc',
        base: 'base',
      };
      const dexChain = chainMap[chain];
      if (!dexChain) {
        return null;
      }

      const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as DexScreenerResponse;
      const pairs = data.pairs?.filter(
        (pair) => pair.chainId === dexChain && pair.priceUsd,
      );

      if (!pairs || pairs.length === 0) {
        return null;
      }

      pairs.sort(
        (left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0),
      );

      const priceUsd = Number.parseFloat(pairs[0].priceUsd ?? '0');
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        return null;
      }

      return {
        priceUsd,
        source: 'dexscreener',
        fetchedAt: new Date().toISOString(),
        confidence: 'high',
      };
    } catch (err: unknown) {
      this.logger.warn(
        `DexScreener failed for ${contractAddress}: ${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private async tryCoinGecko(
    contractAddress: string,
    chain: string,
  ): Promise<TokenPriceResult | null> {
    try {
      const platformMap: Record<string, string> = {
        ethereum: 'ethereum',
        polygon: 'polygon-pos',
        bsc: 'binance-smart-chain',
        base: 'base',
      };
      const platform = platformMap[chain];
      if (!platform) {
        return null;
      }

      const url =
        `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${contractAddress}` +
        '&vs_currencies=usd';
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as Record<string, CoinGeckoPriceData>;
      const priceUsd = data[contractAddress.toLowerCase()]?.usd;
      if (typeof priceUsd !== 'number' || priceUsd <= 0) {
        return null;
      }

      return {
        priceUsd,
        source: 'coingecko',
        fetchedAt: new Date().toISOString(),
        confidence: 'high',
      };
    } catch (err: unknown) {
      this.logger.warn(
        `CoinGecko failed for ${contractAddress}: ${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}