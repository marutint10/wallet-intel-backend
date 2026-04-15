import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import pLimit = require('p-limit');
import { Trade } from '../wallet.types';

class DefiLlamaCooldownError extends Error {
  constructor() {
    super('DefiLlama cooldown is active');
  }
}

interface CoinGeckoTokenPriceResponse {
  [contractAddress: string]: {
    usd?: number;
  };
}

interface CoinGeckoEthPriceResponse {
  ethereum?: {
    usd?: number;
  };
}

interface CoinGeckoHistoricalPriceResponse {
  market_data?: {
    current_price?: {
      usd?: number;
    };
  };
}

interface DefiLlamaPriceResponse {
  coins: {
    [key: string]: {
      price: number;
      symbol: string;
      timestamp: number;
      confidence: number;
    };
  };
}

interface HistoricalPriceFetchResult {
  value: number | null;
  shouldCache: boolean;
  status: 'success' | 'no-data' | 'error' | 'rate-limited' | 'cooldown';
}

interface PriceFetchBatchSummary {
  pricesFound: number;
  pricesMissing: number;
  requestsMade: number;
}

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFILLAMA_API_BASE_URL = 'https://coins.llama.fi';

export type PricedTrade = Trade & { price: number };

@Injectable()
export class WalletPricingService {
  private static readonly DEFILLAMA_MAX_CONCURRENCY = 5;
  private static readonly DEFILLAMA_REQUEST_DELAY_MS = 100;
  private static readonly HISTORICAL_PRICE_REQUEST_TIMEOUT_MS = 5000;
  private static readonly DEFILLAMA_MAX_429_RETRIES = 2;
  private static readonly DEFILLAMA_429_BACKOFF_BASE_MS = 2000;
  private static readonly DEFILLAMA_429_WINDOW_MS = 10000;
  private static readonly DEFILLAMA_429_THRESHOLD = 3;
  private static readonly DEFILLAMA_COOLDOWN_MS = 30000;
  private static readonly PRICE_FETCH_SUMMARY_IDLE_MS = 1000;
  private readonly logger = new Logger(WalletPricingService.name);
  private readonly coinGeckoApiKey: string;
  private readonly priceCache = new Map<string, number | null>();
  private readonly inFlightRequests = new Map<string, Promise<number | null>>();
  private readonly inFlightRequestResults = new Map<
    string,
    Promise<HistoricalPriceFetchResult>
  >();
  private readonly defiLlamaLimiter = pLimit(
    WalletPricingService.DEFILLAMA_MAX_CONCURRENCY,
  );
  private defiLlamaRequestSequence: Promise<void> = Promise.resolve();
  private lastDefiLlamaRequestStartedAt = 0;
  private defiLlama429Timestamps: number[] = [];
  private defiLlamaCooldownUntil = 0;
  private activePriceFetchCount = 0;
  private priceFetchSummaryTimeout: NodeJS.Timeout | null = null;
  private priceFetchBatchSummary: PriceFetchBatchSummary = {
    pricesFound: 0,
    pricesMissing: 0,
    requestsMade: 0,
  };

  constructor(private readonly configService: ConfigService) {
    this.coinGeckoApiKey =
      this.configService.get<string>('coingecko.apiKey') ?? '';
  }

  async fetchHistoricalTradePrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    return this.trackHistoricalPriceFetch(async () => {
      const defiLlamaResult = await this.fetchDefiLlamaPrice(
        token,
        contractAddress,
        timestamp,
      );

      if ((defiLlamaResult.value ?? 0) > 0) {
        return defiLlamaResult.value ?? 0;
      }

      if (
        defiLlamaResult.status === 'rate-limited' ||
        defiLlamaResult.status === 'cooldown'
      ) {
        this.logger.warn(
          `[DefiLlama] Skipping CoinGecko fallback for ${token} at ${timestamp} after ${defiLlamaResult.status}`,
        );
        return 0;
      }

      const coinGeckoPrice = await this.fetchCoinGeckoFallbackPrice(
        token,
        timestamp,
      );

      if (coinGeckoPrice > 0) {
        return coinGeckoPrice;
      }

      this.logger.warn(
        `No price found for ${token} at ${timestamp} from any source`,
      );

      return 0;
    });
  }

  async fetchHistoricalMarketPrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    return this.trackHistoricalPriceFetch(async () => {
      const defiLlamaResult = await this.fetchDefiLlamaPrice(
        token,
        contractAddress,
        timestamp,
      );

      if ((defiLlamaResult.value ?? 0) > 0) {
        return defiLlamaResult.value ?? 0;
      }

      this.logger.warn(
        `No DefiLlama historical market price found for ${token} at ${timestamp}`,
      );

      return 0;
    });
  }

  async fetchCoinGeckoTokenPrices(
    contractAddresses: string[],
  ): Promise<Record<string, number>> {
    if (contractAddresses.length === 0) {
      return {};
    }

    if (!this.coinGeckoApiKey) {
      this.logger.warn('COINGECKO_API_KEY is not configured');
      return {};
    }

    const response = await axios.get<CoinGeckoTokenPriceResponse>(
      `${COINGECKO_API_BASE_URL}/simple/token_price/ethereum`,
      {
        params: {
          contract_addresses: contractAddresses.join(','),
          vs_currencies: 'usd',
          x_cg_demo_api_key: this.coinGeckoApiKey,
        },
        timeout: 10000,
      },
    );

    return Object.fromEntries(
      Object.entries(response.data).map(([contractAddress, value]) => [
        contractAddress.toLowerCase(),
        typeof value.usd === 'number' ? value.usd : 0,
      ]),
    );
  }

  async fetchEthereumUsdPrice(): Promise<number> {
    if (!this.coinGeckoApiKey) {
      this.logger.warn('COINGECKO_API_KEY is not configured');
      return 0;
    }

    const response = await axios.get<CoinGeckoEthPriceResponse>(
      `${COINGECKO_API_BASE_URL}/simple/price`,
      {
        params: {
          ids: 'ethereum',
          vs_currencies: 'usd',
          x_cg_demo_api_key: this.coinGeckoApiKey,
        },
        timeout: 10000,
      },
    );

    return typeof response.data.ethereum?.usd === 'number'
      ? response.data.ethereum.usd
      : 0;
  }

  inferMissingSwapPrices(pricedTrades: PricedTrade[]): PricedTrade[] {
    const tradesByTimestamp = new Map<number, PricedTrade[]>();

    for (const trade of pricedTrades) {
      const tradesAtTimestamp = tradesByTimestamp.get(trade.timestamp) ?? [];
      tradesAtTimestamp.push(trade);
      tradesByTimestamp.set(trade.timestamp, tradesAtTimestamp);
    }

    for (const tradesAtTimestamp of tradesByTimestamp.values()) {
      if (tradesAtTimestamp.length !== 2) {
        continue;
      }

      const [firstTrade, secondTrade] = tradesAtTimestamp;

      if (firstTrade.type === secondTrade.type) {
        continue;
      }

      const missingTrades = tradesAtTimestamp.filter((trade) => trade.price === 0);

      if (missingTrades.length !== 1) {
        continue;
      }

      const knownTrade = tradesAtTimestamp.find((trade) => trade.price > 0);
      const missingTrade = missingTrades[0];

      if (!knownTrade) {
        continue;
      }

      const knownAmount = this.parsePositiveNumber(knownTrade.amount);
      const missingAmount = this.parsePositiveNumber(missingTrade.amount);

      if (knownAmount === null || missingAmount === null) {
        continue;
      }

      const knownUsdValue = knownAmount * knownTrade.price;
      const inferredPrice = knownUsdValue / missingAmount;

      if (!Number.isFinite(inferredPrice) || inferredPrice <= 0) {
        continue;
      }

      missingTrade.price = inferredPrice;
    }

    return pricedTrades;
  }

  formatUsdValue(value: number): string {
    if (!Number.isFinite(value)) {
      return '0';
    }

    const rounded = Math.round(value * 100) / 100;

    if (Object.is(rounded, -0) || rounded === 0) {
      return '0';
    }

    return rounded.toFixed(2).replace(/\.0+$|(?<=\.\d)0+$/, '');
  }

  parsePositiveNumber(value: string): number | null {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return null;
    }

    return parsedValue;
  }

  private static readonly COINGECKO_COIN_ID_MAP: Record<string, string> = {
    ETH: 'ethereum',
    BTC: 'bitcoin',
    USDT: 'tether',
  };

  private static readonly DEFILLAMA_NATIVE_TOKEN_MAP: Record<string, string> = {
    ETH: 'coingecko:ethereum',
    WETH: 'coingecko:weth',
    BTC: 'coingecko:bitcoin',
    WBTC: 'coingecko:wrapped-bitcoin',
    USDT: 'coingecko:tether',
    USDC: 'coingecko:usd-coin',
    DAI: 'coingecko:dai',
  };

  private async fetchDefiLlamaPrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<HistoricalPriceFetchResult> {
    const coinKey = this.buildDefiLlamaCoinKey(token, contractAddress);

    if (!coinKey) {
      this.logger.debug(`Cannot build DeFi Llama key for ${token}`);
      return {
        value: null,
        shouldCache: false,
        status: 'no-data',
      };
    }

    const cacheKey = this.buildPriceCacheKey(`defillama:${coinKey}`, timestamp);

    return this.fetchHistoricalPriceWithCache(cacheKey, async () => {
      return this.fetchDefiLlamaPriceUncached(token, coinKey, timestamp);
    });
  }

  private buildDefiLlamaCoinKey(
    token: string,
    contractAddress: string | undefined,
  ): string | null {
    const nativeKey =
      WalletPricingService.DEFILLAMA_NATIVE_TOKEN_MAP[token.toUpperCase()];

    if (nativeKey) {
      return nativeKey;
    }

    if (contractAddress) {
      return `ethereum:${contractAddress.toLowerCase()}`;
    }

    return null;
  }

  private async fetchCoinGeckoFallbackPrice(
    token: string,
    timestamp: number,
  ): Promise<number> {
    const coinId =
      WalletPricingService.COINGECKO_COIN_ID_MAP[token.toUpperCase()];

    if (!coinId || !this.coinGeckoApiKey) {
      if (!coinId) {
        this.logger.debug(
          `[CoinGecko fallback] No CoinGecko historical mapping configured for ${token}`,
        );
      }

      if (!this.coinGeckoApiKey) {
        this.logger.warn(
          `[CoinGecko fallback] COINGECKO_API_KEY is not configured; historical fallback is disabled for ${token}`,
        );
      }

      return 0;
    }

    const cacheKey = this.buildPriceCacheKey(`coingecko:${coinId}`, timestamp);

    return this.fetchHistoricalPriceWithCache(cacheKey, async () => {
      try {
        const date = this.formatTradeDate(timestamp);
        const url = `${COINGECKO_API_BASE_URL}/coins/${coinId}/history`;
        this.recordHistoricalRequestMade();
        const response = await axios.get<CoinGeckoHistoricalPriceResponse>(
          url,
          {
            params: {
              date,
              localization: false,
              x_cg_demo_api_key: this.coinGeckoApiKey,
            },
            timeout: WalletPricingService.HISTORICAL_PRICE_REQUEST_TIMEOUT_MS,
          },
        );

        const price = this.extractHistoricalUsdPrice(response.data);

        return {
          value: price > 0 ? price : null,
          shouldCache: true,
          status: price > 0 ? 'success' : 'no-data',
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          this.logger.warn(
            `[CoinGecko fallback] HTTP ${error.response?.status ?? error.code ?? 'NO_RESPONSE'} for ${token} via ${COINGECKO_API_BASE_URL}/coins/${coinId}/history`,
          );
        } else {
          this.logger.warn(`[CoinGecko fallback] Failed for ${token}`);
        }
        return {
          value: null,
          shouldCache: false,
          status: 'error',
        };
      }
    }).then((result) => result.value ?? 0);
  }

  private extractHistoricalUsdPrice(
    response?: CoinGeckoHistoricalPriceResponse,
  ): number {
    return typeof response?.market_data?.current_price?.usd === 'number'
      ? response.market_data.current_price.usd
      : 0;
  }

  private formatTradeDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year = date.getUTCFullYear();

    return `${day}-${month}-${year}`;
  }

  private buildPriceCacheKey(tokenIdentifier: string, timestamp: number): string {
    return `${tokenIdentifier}:${timestamp}`;
  }

  private async fetchHistoricalPriceWithCache(
    cacheKey: string,
    fetcher: () => Promise<HistoricalPriceFetchResult>,
  ): Promise<HistoricalPriceFetchResult> {
    if (this.priceCache.has(cacheKey)) {
      const cachedValue = this.priceCache.get(cacheKey) ?? null;

      return {
        value: cachedValue,
        shouldCache: true,
        status: cachedValue === null ? 'no-data' : 'success',
      };
    }

    const inFlightRequest = this.inFlightRequestResults.get(cacheKey);

    if (inFlightRequest) {
      return inFlightRequest;
    }

    const request = (async (): Promise<HistoricalPriceFetchResult> => {
      const result = await fetcher();

      if (result.shouldCache) {
        this.priceCache.set(cacheKey, result.value);
      }

      return result;
    })();

    this.inFlightRequestResults.set(cacheKey, request);
    this.inFlightRequests.set(
      cacheKey,
      request.then((result) => result.value),
    );

    try {
      return await request;
    } finally {
      this.inFlightRequestResults.delete(cacheKey);
      this.inFlightRequests.delete(cacheKey);
    }
  }

  private async runDefiLlamaRequest<T>(
    request: () => Promise<T>,
  ): Promise<T> {
    return this.defiLlamaLimiter(async () => {
      await this.waitForDefiLlamaRequestSlot();

      if (this.isDefiLlamaCooldownActive()) {
        throw new DefiLlamaCooldownError();
      }

      return request();
    });
  }

  private async waitForDefiLlamaRequestSlot(): Promise<void> {
    const previousSequence = this.defiLlamaRequestSequence;
    let releaseSequence!: () => void;

    this.defiLlamaRequestSequence = new Promise<void>((resolve) => {
      releaseSequence = resolve;
    });

    await previousSequence;

    const now = Date.now();
    const waitMs = Math.max(
      0,
      this.lastDefiLlamaRequestStartedAt +
        WalletPricingService.DEFILLAMA_REQUEST_DELAY_MS -
        now,
    );

    if (waitMs > 0) {
      await this.delay(waitMs);
    }

    this.lastDefiLlamaRequestStartedAt = Date.now();
    releaseSequence();
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async fetchDefiLlamaPriceUncached(
    token: string,
    coinKey: string,
    timestamp: number,
  ): Promise<HistoricalPriceFetchResult> {
    const url = `${DEFILLAMA_API_BASE_URL}/prices/historical/${timestamp}/${coinKey}`;

    for (
      let attempt = 0;
      attempt <= WalletPricingService.DEFILLAMA_MAX_429_RETRIES;
      attempt += 1
    ) {
      if (this.isDefiLlamaCooldownActive()) {
        this.logger.warn(
          `[DefiLlama] Global cooldown active; skipping ${token} at ${timestamp}`,
        );

        return {
          value: null,
          shouldCache: false,
          status: 'cooldown',
        };
      }

      try {
        this.logger.debug(`[DefiLlama] GET ${url}`);

        const response = await this.runDefiLlamaRequest(async () => {
          this.recordHistoricalRequestMade();

          return axios.get<DefiLlamaPriceResponse>(url, {
            timeout: WalletPricingService.HISTORICAL_PRICE_REQUEST_TIMEOUT_MS,
          });
        });

        const coinData = response.data?.coins?.[coinKey];
        const price = coinData?.price;

        if (typeof price === 'number' && price > 0) {
          this.logger.debug(
            `[DefiLlama] ${token} @ ${timestamp} = $${price} (confidence: ${coinData.confidence})`,
          );

          return {
            value: price,
            shouldCache: true,
            status: 'success',
          };
        }

        this.logger.debug(
          `[DefiLlama] No price data for ${token} at ${timestamp}`,
        );

        return {
          value: null,
          shouldCache: true,
          status: 'no-data',
        };
      } catch (error) {
        if (error instanceof DefiLlamaCooldownError) {
          this.logger.warn(
            `[DefiLlama] Global cooldown active; skipping ${token} at ${timestamp}`,
          );

          return {
            value: null,
            shouldCache: false,
            status: 'cooldown',
          };
        }

        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const cooldownActivated = this.recordDefiLlamaRateLimit();

          this.logger.warn(
            `[DefiLlama] HTTP 429 for ${token} at ${timestamp} (attempt ${attempt + 1}/${WalletPricingService.DEFILLAMA_MAX_429_RETRIES + 1})`,
          );

          if (cooldownActivated) {
            return {
              value: null,
              shouldCache: false,
              status: 'cooldown',
            };
          }

          if (attempt < WalletPricingService.DEFILLAMA_MAX_429_RETRIES) {
            const backoffMs =
              WalletPricingService.DEFILLAMA_429_BACKOFF_BASE_MS *
              2 ** attempt;

            this.logger.warn(
              `[DefiLlama] Retrying ${token} at ${timestamp} in ${backoffMs}ms after HTTP 429`,
            );
            await this.delay(backoffMs);
            continue;
          }

          return {
            value: null,
            shouldCache: false,
            status: 'rate-limited',
          };
        }

        if (axios.isAxiosError(error)) {
          this.logger.warn(
            `[DefiLlama] HTTP ${error.response?.status ?? error.code ?? 'NO_RESPONSE'} for ${token} at ${timestamp}`,
          );
        } else {
          this.logger.warn(
            `[DefiLlama] Failed for ${token} at ${timestamp}`,
            error instanceof Error ? error.stack : undefined,
          );
        }

        return {
          value: null,
          shouldCache: false,
          status: 'error',
        };
      }
    }

    return {
      value: null,
      shouldCache: false,
      status: 'rate-limited',
    };
  }

  private isDefiLlamaCooldownActive(): boolean {
    return this.defiLlamaCooldownUntil > Date.now();
  }

  private recordDefiLlamaRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - WalletPricingService.DEFILLAMA_429_WINDOW_MS;

    this.defiLlama429Timestamps = this.defiLlama429Timestamps.filter(
      (timestamp) => timestamp >= windowStart,
    );
    this.defiLlama429Timestamps.push(now);

    if (
      this.defiLlama429Timestamps.length >=
      WalletPricingService.DEFILLAMA_429_THRESHOLD
    ) {
      this.defiLlamaCooldownUntil =
        now + WalletPricingService.DEFILLAMA_COOLDOWN_MS;
      this.defiLlama429Timestamps = [];

      this.logger.warn(
        `[DefiLlama] Entering global cooldown for ${WalletPricingService.DEFILLAMA_COOLDOWN_MS}ms after repeated HTTP 429 responses`,
      );

      return true;
    }

    return false;
  }

  private async trackHistoricalPriceFetch(
    operation: () => Promise<number>,
  ): Promise<number> {
    this.activePriceFetchCount += 1;
    this.clearPriceFetchSummaryTimeout();

    try {
      const price = await operation();

      if (price > 0) {
        this.priceFetchBatchSummary.pricesFound += 1;
      } else {
        this.priceFetchBatchSummary.pricesMissing += 1;
      }

      return price;
    } finally {
      this.activePriceFetchCount -= 1;

      if (this.activePriceFetchCount === 0) {
        this.schedulePriceFetchSummaryLog();
      }
    }
  }

  private recordHistoricalRequestMade(): void {
    this.priceFetchBatchSummary.requestsMade += 1;
  }

  private schedulePriceFetchSummaryLog(): void {
    this.clearPriceFetchSummaryTimeout();
    this.priceFetchSummaryTimeout = setTimeout(() => {
      if (this.activePriceFetchCount > 0) {
        return;
      }

      const { pricesFound, pricesMissing, requestsMade } =
        this.priceFetchBatchSummary;

      if (pricesFound === 0 && pricesMissing === 0 && requestsMade === 0) {
        return;
      }

      this.logger.log(
        `Price fetch complete: ${pricesFound} prices found, ${pricesMissing} prices missing, ${requestsMade} requests made`,
      );

      this.priceFetchBatchSummary = {
        pricesFound: 0,
        pricesMissing: 0,
        requestsMade: 0,
      };
      this.priceFetchSummaryTimeout = null;
    }, WalletPricingService.PRICE_FETCH_SUMMARY_IDLE_MS);
    this.priceFetchSummaryTimeout.unref?.();
  }

  private clearPriceFetchSummaryTimeout(): void {
    if (!this.priceFetchSummaryTimeout) {
      return;
    }

    clearTimeout(this.priceFetchSummaryTimeout);
    this.priceFetchSummaryTimeout = null;
  }
}
