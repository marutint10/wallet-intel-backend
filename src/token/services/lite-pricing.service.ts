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

interface DefiLlamaHistoricalPriceResponse {
  coins?: Record<
    string,
    {
      price?: number;
    }
  >;
}

interface CoinGeckoRangeResponse {
  prices?: Array<[number, number]>;
}

@Injectable()
export class LitePricingService {
  private readonly logger = new Logger(LitePricingService.name);
  private readonly priceCache = new Map<
    string,
    { result: TokenPriceResult; expiresAt: number }
  >();
  private readonly historicalPriceCache = new Map<
    string,
    { priceUsd: number; source: string }
  >();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly DEFILLAMA_MIN_INTERVAL_MS = 150;
  private lastDefiLlamaCallAt = 0;

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

  async getHistoricalPrice(
    contractAddress: string,
    chain: string,
    timestamp: number,
  ): Promise<{ priceUsd: number; source: string; confidence: 'high' | 'low' }> {
    const normalizedChain = chain.toLowerCase();
    const normalizedAddress = contractAddress.toLowerCase();
    const roundedTs = this.roundTimestampToHour(timestamp);
    const cacheKey = `hist:${normalizedChain}:${normalizedAddress}:${roundedTs}`;
    const cached = this.historicalPriceCache.get(cacheKey);

    if (cached) {
      return {
        priceUsd: cached.priceUsd,
        source: cached.source,
        confidence: cached.priceUsd > 0 ? 'high' : 'low',
      };
    }

    const llamaPrefix = this.getDefiLlamaChainPrefix(normalizedChain);
    if (llamaPrefix) {
      const coinKey = `${llamaPrefix}:${normalizedAddress}`;
      const url = `https://coins.llama.fi/prices/historical/${roundedTs}/${coinKey}`;

      try {
        await this.waitForDefiLlamaSlot();
        const response = await fetch(url);

        if (response.ok) {
          const payload =
            (await response.json()) as DefiLlamaHistoricalPriceResponse;
          const price = payload.coins?.[coinKey]?.price;

          if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
            this.historicalPriceCache.set(cacheKey, {
              priceUsd: price,
              source: 'defillama',
            });
            return { priceUsd: price, source: 'defillama', confidence: 'high' };
          }
        }
      } catch (err: unknown) {
        this.logger.warn(
          `DefiLlama historical price failed for ${contractAddress} on ${chain}: ${this.getErrorMessage(err)}`,
        );
      }
    }

    const platform = this.getCoinGeckoPlatform(normalizedChain);
    if (platform) {
      const from = roundedTs - 3600;
      const to = roundedTs + 3600;
      const url =
        `https://api.coingecko.com/api/v3/coins/${platform}/contract/${normalizedAddress}` +
        `/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;

      try {
        const response = await fetch(url);

        if (response.ok) {
          const payload = (await response.json()) as CoinGeckoRangeResponse;
          const nearest = this.findNearestCoinGeckoPrice(payload.prices ?? [], roundedTs);

          if (nearest !== null && nearest > 0) {
            this.historicalPriceCache.set(cacheKey, {
              priceUsd: nearest,
              source: 'coingecko',
            });
            return { priceUsd: nearest, source: 'coingecko', confidence: 'high' };
          }
        }
      } catch (err: unknown) {
        this.logger.warn(
          `CoinGecko historical price failed for ${contractAddress} on ${chain}: ${this.getErrorMessage(err)}`,
        );
      }
    }

    this.historicalPriceCache.set(cacheKey, {
      priceUsd: 0,
      source: 'none',
    });
    return { priceUsd: 0, source: 'none', confidence: 'low' };
  }

  async getHistoricalPrices(
    requests: Array<{ contractAddress: string; chain: string; timestamp: number }>,
  ): Promise<Map<string, { priceUsd: number; source: string }>> {
    const result = new Map<string, { priceUsd: number; source: string }>();
    const seen = new Set<string>();

    for (const request of requests) {
      const normalizedChain = request.chain.toLowerCase();
      const normalizedAddress = request.contractAddress.toLowerCase();
      const roundedTs = this.roundTimestampToHour(request.timestamp);
      const historicalCacheKey =
        `hist:${normalizedChain}:${normalizedAddress}:${roundedTs}`;
      const resultKey = `${normalizedChain}:${normalizedAddress}:${roundedTs}`;

      if (seen.has(resultKey)) {
        continue;
      }
      seen.add(resultKey);

      const cached = this.historicalPriceCache.get(historicalCacheKey);
      if (cached) {
        result.set(resultKey, {
          priceUsd: cached.priceUsd,
          source: cached.source,
        });
        continue;
      }

      const fetched = await this.getHistoricalPrice(
        normalizedAddress,
        normalizedChain,
        roundedTs,
      );
      result.set(resultKey, {
        priceUsd: fetched.priceUsd,
        source: fetched.source,
      });
    }

    return result;
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
      const platform = this.getCoinGeckoPlatform(chain);
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

  private roundTimestampToHour(timestamp: number): number {
    return Math.floor(timestamp / 3600) * 3600;
  }

  private getDefiLlamaChainPrefix(chain: string): string | null {
    const map: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon',
      bsc: 'bsc',
      base: 'base',
    };

    return map[chain] ?? null;
  }

  private getCoinGeckoPlatform(chain: string): string | null {
    const map: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon-pos',
      bsc: 'binance-smart-chain',
      base: 'base',
    };

    return map[chain] ?? null;
  }

  private findNearestCoinGeckoPrice(
    prices: Array<[number, number]>,
    targetTimestamp: number,
  ): number | null {
    if (prices.length === 0) {
      return null;
    }

    let bestPrice: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [timestampMs, price] of prices) {
      if (!Number.isFinite(price) || price <= 0) {
        continue;
      }

      const distance = Math.abs(timestampMs / 1000 - targetTimestamp);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPrice = price;
      }
    }

    return bestPrice;
  }

  private async waitForDefiLlamaSlot(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastDefiLlamaCallAt;
    const waitMs = Math.max(0, this.DEFILLAMA_MIN_INTERVAL_MS - elapsed);

    if (waitMs > 0) {
      await this.sleep(waitMs);
    }

    this.lastDefiLlamaCallAt = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}