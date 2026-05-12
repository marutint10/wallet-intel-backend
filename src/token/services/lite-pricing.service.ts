import { Injectable, Logger } from '@nestjs/common';

export interface TokenPriceResult {
  priceUsd: number;
  // 'defillama' is added so getBatchPrices can cache its primary-source hits
  // with an accurate provenance label. Existing readers treat source as a
  // free-form string for logging only, so this widening is additive.
  source: 'dexscreener' | 'coingecko' | 'defillama' | 'fallback';
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

interface DefiLlamaCurrentPriceResponse {
  coins?: Record<
    string,
    {
      price?: number;
      symbol?: string;
      decimals?: number;
      timestamp?: number;
      confidence?: number;
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
    const toFetchByChain = new Map<string, Set<string>>();

    // Pass 1: dedupe inputs and serve any in-memory cache hits.
    for (const token of tokens) {
      const chain = token.chain.toLowerCase();
      const address = token.contractAddress.toLowerCase();
      const cacheKey = `${chain}:${address}`;
      const cached = this.priceCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        priceMap.set(cacheKey, cached.result.priceUsd);
        continue;
      }

      if (!toFetchByChain.has(chain)) {
        toFetchByChain.set(chain, new Set<string>());
      }
      toFetchByChain.get(chain)?.add(address);
    }

    // Pass 2 (PRIMARY): DefiLlama batch current prices.
    // DefiLlama accepts a comma-separated list of chain-prefixed token ids in
    // a single request, so we can price across chains in one call. This
    // replaces the per-chain CoinGecko loop that was hitting network errors.
    const llamaFound = await this.fetchBatchFromDefiLlama(
      toFetchByChain,
      priceMap,
    );

    // Pass 3 (FALLBACK): CoinGecko for the addresses DefiLlama did not price.
    // Existing per-chain chunk + platform logic is preserved; the only
    // additions are the 10s AbortController timeout and structured logging.
    await this.fetchBatchFromCoinGeckoFallback(
      toFetchByChain,
      llamaFound,
      priceMap,
    );

    return priceMap;
  }

  // ---- DefiLlama batch primary ----
  // Returns the set of our cache keys (`chain:address`) that DefiLlama priced.
  private async fetchBatchFromDefiLlama(
    toFetchByChain: Map<string, Set<string>>,
    priceMap: Map<string, number>,
  ): Promise<Set<string>> {
    const llamaChainPrefix: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon',
      bsc: 'bsc',
      base: 'base',
    };

    // Build a flat list of "<llamaPrefix>:<address>" entries paired with our
    // canonical cache key so we can map responses back without ambiguity.
    const entries: Array<{ llamaKey: string; ourKey: string }> = [];
    for (const [chain, addresses] of toFetchByChain.entries()) {
      const prefix = llamaChainPrefix[chain];
      if (!prefix) {
        continue;
      }
      for (const address of addresses) {
        entries.push({
          llamaKey: `${prefix}:${address}`,
          ourKey: `${chain}:${address}`,
        });
      }
    }

    const filled = new Set<string>();
    if (entries.length === 0) {
      return filled;
    }

    // Conservative chunk size keeps URL length well under 4 KB even with long
    // ERC-20 addresses on every entry.
    const CHUNK_SIZE = 50;
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
      const chunk = entries.slice(i, i + CHUNK_SIZE);
      const coinsParam = chunk.map((entry) => entry.llamaKey).join(',');
      const url = `https://coins.llama.fi/prices/current/${coinsParam}`;
      const llamaKeyToOurKey = new Map(
        chunk.map((entry) => [entry.llamaKey, entry.ourKey]),
      );

      this.logger.log(
        `[defillama-batch] request requestedCount=${chunk.length} url=${this.truncateForLog(url, 240)}`,
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const startedAt = Date.now();
      let returnedCount = 0;

      try {
        await this.waitForDefiLlamaSlot();

        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } catch (err: unknown) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          const kind = isAbort ? 'timeout' : 'network_error';
          this.logger.warn(
            `[defillama-batch] ${kind} requestedCount=${chunk.length} ` +
              `elapsed_ms=${Date.now() - startedAt} ` +
              `message="${this.getErrorMessage(err)}"`,
          );
          continue;
        }

        if (!response.ok) {
          const bodyPreview = await this.safeReadBodyPreview(response);
          this.logger.warn(
            `[defillama-batch] http_error status=${response.status} ` +
              `statusText="${response.statusText}" ` +
              `requestedCount=${chunk.length} ` +
              `bodyPreview="${bodyPreview}"`,
          );
          continue;
        }

        let data: DefiLlamaCurrentPriceResponse;
        try {
          data = (await response.json()) as DefiLlamaCurrentPriceResponse;
        } catch (err: unknown) {
          this.logger.warn(
            `[defillama-batch] parse_error requestedCount=${chunk.length} ` +
              `message="${this.getErrorMessage(err)}"`,
          );
          continue;
        }

        const coins = data.coins ?? {};
        for (const [llamaKey, info] of Object.entries(coins)) {
          const price = info?.price;
          if (
            typeof price !== 'number' ||
            !Number.isFinite(price) ||
            price <= 0
          ) {
            continue;
          }
          const ourKey = llamaKeyToOurKey.get(llamaKey);
          if (!ourKey) {
            continue;
          }

          priceMap.set(ourKey, price);
          this.priceCache.set(ourKey, {
            result: {
              priceUsd: price,
              source: 'defillama',
              fetchedAt: new Date().toISOString(),
              confidence: 'high',
            },
            expiresAt: Date.now() + this.CACHE_TTL_MS,
          });
          filled.add(ourKey);
          returnedCount += 1;
        }

        this.logger.log(
          `[defillama-batch] response requestedCount=${chunk.length} ` +
            `returnedCount=${returnedCount} ` +
            `elapsed_ms=${Date.now() - startedAt}`,
        );
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return filled;
  }

  // ---- CoinGecko batch fallback (preserves existing logic + adds timeout) ----
  private async fetchBatchFromCoinGeckoFallback(
    toFetchByChain: Map<string, Set<string>>,
    alreadyPriced: Set<string>,
    priceMap: Map<string, number>,
  ): Promise<void> {
    const platformMap: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon-pos',
      bsc: 'binance-smart-chain',
      base: 'base',
    };

    for (const [chain, addressSet] of toFetchByChain.entries()) {
      const platform = platformMap[chain];
      if (!platform) {
        continue;
      }

      const missing = [...addressSet].filter(
        (address) => !alreadyPriced.has(`${chain}:${address}`),
      );
      if (missing.length === 0) {
        continue;
      }

      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += 100) {
        chunks.push(missing.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        const url =
          `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
          `?contract_addresses=${chunk.join(',')}` +
          '&vs_currencies=usd';

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);

        try {
          let response: Response;
          try {
            response = await fetch(url, { signal: controller.signal });
          } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === 'AbortError';
            const kind = isAbort ? 'timeout' : 'network_error';
            this.logger.warn(
              `[coingecko-batch] ${kind} url=${url} ` +
                `message="${this.getErrorMessage(err)}"`,
            );
            continue;
          }

          if (!response.ok) {
            const bodyPreview = await this.safeReadBodyPreview(response);
            this.logger.warn(
              `[coingecko-batch] http_error url=${url} ` +
                `status=${response.status} bodyPreview="${bodyPreview}"`,
            );
            continue;
          }

          const data = (await response.json()) as Record<
            string,
            CoinGeckoPriceData
          >;
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
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }
  }

  // Read up to the first 200 chars of a response body, collapsed onto a single
  // line, never throwing. Used by all batch-error log lines.
  private async safeReadBodyPreview(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, 200).replace(/\s+/g, ' ').trim();
    } catch (err: unknown) {
      return `<failed to read body: ${this.getErrorMessage(err)}>`;
    }
  }

  // Keep log lines bounded so a very long URL does not flood the console.
  private truncateForLog(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...(${value.length - maxLength}more)`;
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

    // 10s timeout via AbortController so we can distinguish slow/hung calls
    // from genuine network failures or HTTP errors. Behaviour on failure is
    // unchanged - we still return null - but every failure path now logs
    // enough context to diagnose the exact cause from the console.
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    this.logger.log(
      `[dexscreener] request url=${url} timeout_ms=${timeoutMs}`,
    );

    try {
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (err: unknown) {
        // fetch() itself threw -> classified as a network-class failure.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const kind = isAbort ? 'timeout' : 'network_error';
        const errorName = err instanceof Error ? err.name : 'Unknown';
        this.logger.warn(
          `[dexscreener] ${kind} url=${url} ` +
            `errorName=${errorName} ` +
            `elapsed_ms=${Date.now() - startedAt} ` +
            `message="${this.getErrorMessage(err)}"`,
        );
        return null;
      }

      this.logger.log(
        `[dexscreener] response url=${url} status=${response.status} ` +
          `ok=${response.ok} elapsed_ms=${Date.now() - startedAt}`,
      );

      if (!response.ok) {
        // HTTP-class failure: capture the first 200 chars of the body so we
        // can see Cloudflare blocks, rate-limit JSON, HTML error pages, etc.
        let bodyPreview = '';
        try {
          const text = await response.text();
          bodyPreview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
        } catch (readErr: unknown) {
          bodyPreview = `<failed to read body: ${this.getErrorMessage(readErr)}>`;
        }
        this.logger.warn(
          `[dexscreener] http_error url=${url} status=${response.status} ` +
            `statusText="${response.statusText}" ` +
            `bodyPreview="${bodyPreview}"`,
        );
        return null;
      }

      let data: DexScreenerResponse;
      try {
        data = (await response.json()) as DexScreenerResponse;
      } catch (err: unknown) {
        this.logger.warn(
          `[dexscreener] parse_error url=${url} ` +
            `message="${this.getErrorMessage(err)}"`,
        );
        return null;
      }

      const pairs = data.pairs?.filter(
        (pair) => pair.chainId === dexChain && pair.priceUsd,
      );

      if (!pairs || pairs.length === 0) {
        this.logger.warn(
          `[dexscreener] no_matching_pairs url=${url} ` +
            `chainFilter=${dexChain} totalPairs=${data.pairs?.length ?? 0}`,
        );
        return null;
      }

      pairs.sort(
        (left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0),
      );

      const priceUsd = Number.parseFloat(pairs[0].priceUsd ?? '0');
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        this.logger.warn(
          `[dexscreener] invalid_price url=${url} ` +
            `rawPriceUsd="${pairs[0].priceUsd ?? 'null'}"`,
        );
        return null;
      }

      this.logger.log(
        `[dexscreener] success url=${url} priceUsd=${priceUsd} ` +
          `pairCount=${pairs.length}`,
      );

      return {
        priceUsd,
        source: 'dexscreener',
        fetchedAt: new Date().toISOString(),
        confidence: 'high',
      };
    } finally {
      clearTimeout(timeoutId);
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