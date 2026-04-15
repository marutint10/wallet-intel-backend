import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import pLimit = require('p-limit');
import { Trade } from '../wallet.types';

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
}

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFILLAMA_API_BASE_URL = 'https://coins.llama.fi';

export type PricedTrade = Trade & { price: number };

@Injectable()
export class WalletPricingService {
  private static readonly DEFILLAMA_MAX_CONCURRENCY = 5;
  private static readonly DEFILLAMA_REQUEST_DELAY_MS = 100;
  private readonly logger = new Logger(WalletPricingService.name);
  private readonly coinGeckoApiKey: string;
  private readonly priceCache = new Map<string, number | null>();
  private readonly inFlightRequests = new Map<string, Promise<number | null>>();
  private readonly defiLlamaLimiter = pLimit(
    WalletPricingService.DEFILLAMA_MAX_CONCURRENCY,
  );
  private defiLlamaRequestSequence: Promise<void> = Promise.resolve();
  private lastDefiLlamaRequestStartedAt = 0;

  constructor(private readonly configService: ConfigService) {
    this.coinGeckoApiKey =
      this.configService.get<string>('coingecko.apiKey') ?? '';
  }

  async fetchHistoricalTradePrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    const defiLlamaPrice = await this.fetchDefiLlamaPrice(
      token,
      contractAddress,
      timestamp,
    );

    if (defiLlamaPrice > 0) {
      return defiLlamaPrice;
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
  }

  async fetchHistoricalMarketPrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    const defiLlamaPrice = await this.fetchDefiLlamaPrice(
      token,
      contractAddress,
      timestamp,
    );

    if (defiLlamaPrice > 0) {
      return defiLlamaPrice;
    }

    this.logger.warn(
      `No DefiLlama historical market price found for ${token} at ${timestamp}`,
    );

    return 0;
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
  ): Promise<number> {
    const coinKey = this.buildDefiLlamaCoinKey(token, contractAddress);

    if (!coinKey) {
      this.logger.debug(`Cannot build DeFi Llama key for ${token}`);
      return 0;
    }

    const cacheKey = this.buildPriceCacheKey(`defillama:${coinKey}`, timestamp);

    return this.fetchHistoricalPriceWithCache(cacheKey, async () => {
      try {
        const url = `${DEFILLAMA_API_BASE_URL}/prices/historical/${timestamp}/${coinKey}`;
        this.logger.debug(`[DefiLlama] GET ${url}`);

        const response = await this.runDefiLlamaRequest(() =>
          axios.get<DefiLlamaPriceResponse>(url, {
            timeout: 10000,
          }),
        );

        const coinData = response.data?.coins?.[coinKey];
        const price = coinData?.price;

        if (typeof price === 'number' && price > 0) {
          this.logger.debug(
            `[DefiLlama] ${token} @ ${timestamp} = $${price} (confidence: ${coinData.confidence})`,
          );
          return {
            value: price,
            shouldCache: true,
          };
        }

        this.logger.debug(
          `[DefiLlama] No price data for ${token} at ${timestamp}`,
        );

        return {
          value: null,
          shouldCache: true,
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          this.logger.warn(
            `[DefiLlama] HTTP ${error.response?.status ?? 'NO_RESPONSE'} for ${token} at ${timestamp}`,
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
        };
      }
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
      return 0;
    }

    const cacheKey = this.buildPriceCacheKey(`coingecko:${coinId}`, timestamp);

    return this.fetchHistoricalPriceWithCache(cacheKey, async () => {
      try {
        const date = this.formatTradeDate(timestamp);
        const response = await axios.get<CoinGeckoHistoricalPriceResponse>(
          `${COINGECKO_API_BASE_URL}/coins/${coinId}/history`,
          {
            params: {
              date,
              localization: false,
              x_cg_demo_api_key: this.coinGeckoApiKey,
            },
            timeout: 10000,
          },
        );

        const price = this.extractHistoricalUsdPrice(response.data);

        return {
          value: price > 0 ? price : null,
          shouldCache: true,
        };
      } catch {
        this.logger.warn(`[CoinGecko fallback] Failed for ${token}`);
        return {
          value: null,
          shouldCache: false,
        };
      }
    });
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
  ): Promise<number> {
    if (this.priceCache.has(cacheKey)) {
      return this.priceCache.get(cacheKey) ?? 0;
    }

    const inFlightRequest = this.inFlightRequests.get(cacheKey);

    if (inFlightRequest) {
      return (await inFlightRequest) ?? 0;
    }

    const request = (async (): Promise<number | null> => {
      const result = await fetcher();

      if (result.shouldCache) {
        this.priceCache.set(cacheKey, result.value);
      }

      return result.value;
    })();

    this.inFlightRequests.set(cacheKey, request);

    try {
      return (await request) ?? 0;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  private async runDefiLlamaRequest<T>(
    request: () => Promise<T>,
  ): Promise<T> {
    return this.defiLlamaLimiter(async () => {
      await this.waitForDefiLlamaRequestSlot();
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
}
