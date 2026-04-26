import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import pLimit = require('p-limit');
import { TOKEN_CATEGORY_MAP } from '../constants/token-categories';
import { Trade, WalletPricingCoverage } from '../wallet.types';

class ProviderCooldownError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} cooldown is active`);
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

interface DexScreenerPair {
  chainId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerTokenResponse {
  pairs?: DexScreenerPair[];
}

interface HistoricalPriceFetchResult {
  value: number | null;
  shouldCache: boolean;
  status: 'success' | 'no-data' | 'error' | 'rate-limited' | 'cooldown' | 'cached-no-data';
}

interface PriceFetchBatchSummary {
  pricesFound: number;
  pricesMissing: number;
  requestsMade: number;
  requestsBlockedCount: number;
}

interface PriceCacheEntry {
  price: number | null;
  source: string;
  expiresAt: number;
}

interface ProviderCircuitState {
  rateLimitHits: number[];
  cooldownUntil: number;
}

interface UnsupportedContractEntry {
  expiresAt: number;
  reason: string;
}

interface UnsupportedContractNullHitEntry {
  hits: number;
  lastSeenAt: number;
}

interface InferredPriceCacheEntry {
  price: number;
  source: 'swap_inference';
  confidenceScore: number;
  sampleCount: number;
  expiresAt: number;
}

export interface HistoricalPriceCandidate {
  price: number;
  source: 'swap_inference';
  confidenceScore: number;
}

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFILLAMA_API_BASE_URL = 'https://coins.llama.fi';
const DEXSCREENER_API_BASE_URL = 'https://api.dexscreener.com';

export interface TokenMarketSignal {
  price: number | null;
  liquidityUsd: number | null;
  priceSources: string[];
  liquiditySources: string[];
}

export type PricedTrade = Trade & { price: number };

@Injectable()
export class WalletPricingService {
  private static readonly PRICING_PROVIDERS = [
    'defillama',
    'coingecko',
    'dexscreener',
  ] as const;
  private static readonly DEFILLAMA_MAX_CONCURRENCY = 5;
  private static readonly DEFILLAMA_REQUEST_DELAY_MS = 100;
  private static readonly HISTORICAL_PRICE_REQUEST_TIMEOUT_MS = 5000;
  private static readonly DEFILLAMA_MAX_429_RETRIES = 2;
  private static readonly RATE_LIMIT_BACKOFF_BASE_MS = 2000;
  private static readonly PROVIDER_RATE_LIMIT_WINDOW_MS = 30_000;
  private static readonly PROVIDER_RATE_LIMIT_THRESHOLD = 6;
  private static readonly PROVIDER_RATE_LIMIT_COOLDOWN_MS = 30_000;
  private static readonly PRICE_FETCH_SUMMARY_IDLE_MS = 1000;
  private static readonly HISTORICAL_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly HISTORICAL_UNSUPPORTED_CACHE_TTL_MS =
    24 * 60 * 60 * 1000;
  private static readonly HISTORICAL_UNSUPPORTED_NULL_HIT_THRESHOLD = 3;
  private static readonly INFERRED_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly INFERRED_PRICE_CONFIDENCE_MIN = 0.45;
  private static readonly PREFILTER_LIQUIDITY_MIN_USD = 25_000;
  private static readonly PREFILTER_LIQUIDITY_CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly PREFILTER_MAX_SYMBOL_LENGTH = 14;
  private static readonly PREFILTER_SPAM_KEYWORDS = [
    'http',
    '.com',
    'claim',
    'visit',
    'airdrop',
    'free',
    'bonus',
    'reward',
    'promo',
  ];
  private static readonly KNOWN_INFERENCE_SYMBOLS = new Set([
    'ETH',
    'WETH',
    'USDT',
    'USDC',
    'DAI',
    'WBTC',
    'BTC',
    'STETH',
    'WSTETH',
    'CBETH',
    'RETH',
    'LINK',
    'UNI',
    'AAVE',
    'MKR',
    'SOL',
    'MATIC',
    'ARB',
    'OP',
    'PEPE',
    'DOGE',
    'SHIB',
  ]);
  private static readonly LIVE_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly logger = new Logger(WalletPricingService.name);
  private readonly coinGeckoApiKey: string;
  private readonly priceCache = new Map<string, PriceCacheEntry>();
  private readonly historicalSuccessCache = new Map<string, PriceCacheEntry>();
  private readonly unsupportedContractCache = new Map<
    string,
    UnsupportedContractEntry
  >();
  private readonly unsupportedContractNullHits = new Map<
    string,
    UnsupportedContractNullHitEntry
  >();
  private readonly historicallyPricedContracts = new Set<string>();
  private readonly inferredHistoricalPriceCache = new Map<
    string,
    InferredPriceCacheEntry
  >();
  private readonly prefilterLiquidityCache = new Map<
    string,
    { liquidityUsd: number | null; expiresAt: number }
  >();
  private readonly providerCircuitState = new Map<string, ProviderCircuitState>();
  private readonly inFlightRequests = new Map<string, Promise<number | null>>();
  private readonly inFlightLiveRequests = new Map<string, Promise<number>>();
  private readonly inFlightRequestResults = new Map<
    string,
    Promise<HistoricalPriceFetchResult>
  >();
  private readonly defiLlamaLimiter = pLimit(
    WalletPricingService.DEFILLAMA_MAX_CONCURRENCY,
  );
  private defiLlamaRequestSequence: Promise<void> = Promise.resolve();
  private lastDefiLlamaRequestStartedAt = 0;
  private activePriceFetchCount = 0;
  private priceFetchSummaryTimeout: NodeJS.Timeout | null = null;
  private priceFetchBatchSummary: PriceFetchBatchSummary = {
    pricesFound: 0,
    pricesMissing: 0,
    requestsMade: 0,
    requestsBlockedCount: 0,
  };
  private lastCompletedPriceFetchBatchSummary: PriceFetchBatchSummary = {
    pricesFound: 0,
    pricesMissing: 0,
    requestsMade: 0,
    requestsBlockedCount: 0,
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
      const normalizedContractAddress = contractAddress?.toLowerCase();
      const historicalSuccessCacheKey = this.buildHistoricalSuccessCacheKey(
        normalizedContractAddress,
        timestamp,
      );
      const cachedSuccessPrice = this.getHistoricalSuccessCachePrice(
        historicalSuccessCacheKey,
      );

      if (cachedSuccessPrice > 0) {
        return cachedSuccessPrice;
      }

      const inferredPrice = this.getInferredHistoricalPriceCandidate(
        token,
        normalizedContractAddress,
        timestamp,
      );

      if (inferredPrice) {
        this.setHistoricalSuccessCachePrice(
          historicalSuccessCacheKey,
          inferredPrice.price,
          inferredPrice.source,
        );

        return inferredPrice.price;
      }

      const unsupportedContractKey = this.buildUnsupportedContractKey(
        normalizedContractAddress,
      );

      if (this.isContractMarkedUnsupported(unsupportedContractKey)) {
        this.logger.debug(
          `[Pricing precheck] Skipping unsupported contract ${unsupportedContractKey} for ${token} at ${timestamp}`,
        );
        return 0;
      }

      const shouldSkipByPrefilter = await this.shouldSkipHistoricalPricingToken(
        token,
        normalizedContractAddress,
      );

      if (shouldSkipByPrefilter.skip && unsupportedContractKey) {
        this.markContractUnsupported(
          unsupportedContractKey,
          shouldSkipByPrefilter.reason,
        );
        return 0;
      }

      const defiLlamaResult = await this.fetchDefiLlamaPrice(
        token,
        contractAddress,
        timestamp,
      );

      if ((defiLlamaResult.value ?? 0) > 0) {
        const historicalPrice = defiLlamaResult.value ?? 0;
        this.setHistoricalSuccessCachePrice(
          historicalSuccessCacheKey,
          historicalPrice,
          'defillama',
        );
        this.markContractAsHistoricallyPriced(normalizedContractAddress);
        return historicalPrice;
      }

      if (defiLlamaResult.status === 'cached-no-data') {
        if (!this.hasCoinGeckoHistoricalMapping(token)) {
          this.logger.debug(
            `Price cache hit (null): no CoinGecko mapping for ${token}, skipping fallback at ${timestamp}`,
          );
          return 0;
        }

        this.logger.debug(
          `Price cache hit (null): trying CoinGecko fallback for ${token} at ${timestamp}`,
        );
      }

      const coinGeckoPrice = await this.fetchCoinGeckoFallbackPrice(
        token,
        timestamp,
      );

      if (coinGeckoPrice > 0) {
        this.setHistoricalSuccessCachePrice(
          historicalSuccessCacheKey,
          coinGeckoPrice,
          'coingecko',
        );
        this.markContractAsHistoricallyPriced(normalizedContractAddress);
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
      const normalizedContractAddress = contractAddress?.toLowerCase();
      const historicalSuccessCacheKey = this.buildHistoricalSuccessCacheKey(
        normalizedContractAddress,
        timestamp,
      );
      const cachedSuccessPrice = this.getHistoricalSuccessCachePrice(
        historicalSuccessCacheKey,
      );

      if (cachedSuccessPrice > 0) {
        return cachedSuccessPrice;
      }

      const inferredPrice = this.getInferredHistoricalPriceCandidate(
        token,
        normalizedContractAddress,
        timestamp,
      );

      if (inferredPrice) {
        this.setHistoricalSuccessCachePrice(
          historicalSuccessCacheKey,
          inferredPrice.price,
          inferredPrice.source,
        );
        return inferredPrice.price;
      }

      const unsupportedContractKey = this.buildUnsupportedContractKey(
        normalizedContractAddress,
      );

      if (this.isContractMarkedUnsupported(unsupportedContractKey)) {
        return 0;
      }

      const shouldSkipByPrefilter = await this.shouldSkipHistoricalPricingToken(
        token,
        normalizedContractAddress,
      );

      if (shouldSkipByPrefilter.skip && unsupportedContractKey) {
        this.markContractUnsupported(
          unsupportedContractKey,
          shouldSkipByPrefilter.reason,
        );
        return 0;
      }

      const defiLlamaResult = await this.fetchDefiLlamaPrice(
        token,
        contractAddress,
        timestamp,
      );

      if ((defiLlamaResult.value ?? 0) > 0) {
        const historicalPrice = defiLlamaResult.value ?? 0;
        this.setHistoricalSuccessCachePrice(
          historicalSuccessCacheKey,
          historicalPrice,
          'defillama',
        );
        this.markContractAsHistoricallyPriced(normalizedContractAddress);
        return historicalPrice;
      }

      if (defiLlamaResult.status !== 'cached-no-data') {
        this.logger.warn(
          `No DefiLlama historical market price found for ${token} at ${timestamp}`,
        );
      } else {
        this.logger.debug(
          `Price cache hit (null): no market price for ${token} at ${timestamp}`,
        );
      }

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

    const result: Record<string, number> = {};
    const uncachedAddresses: string[] = [];
    const now = Date.now();

    for (const address of contractAddresses) {
      const normalizedAddress = address.toLowerCase();
      const cacheKey = `live:ethereum:${normalizedAddress}`;
      const cached = this.priceCache.get(cacheKey);

      if (cached && cached.expiresAt > now) {
        this.logger.debug(`Price cache hit: ${cacheKey} ($${cached.price})`);

        if (cached.price !== null) {
          result[normalizedAddress] = cached.price;
        }
      } else {
        this.logger.debug(`Price cache miss: ${cacheKey}`);
        uncachedAddresses.push(address);
      }
    }

    if (uncachedAddresses.length === 0) {
      return result;
    }

    if (this.isProviderRateLimited('coingecko')) {
      this.recordHistoricalRequestBlocked('coingecko');
      this.logger.warn(
        '[CoinGecko] Live token price request skipped due to active circuit breaker cooldown',
      );
      return result;
    }

    let response: { data: CoinGeckoTokenPriceResponse };

    try {
      response = await axios.get<CoinGeckoTokenPriceResponse>(
        `${COINGECKO_API_BASE_URL}/simple/token_price/ethereum`,
        {
          params: {
            contract_addresses: uncachedAddresses.join(','),
            vs_currencies: 'usd',
            x_cg_demo_api_key: this.coinGeckoApiKey,
          },
          timeout: 10000,
        },
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.recordProviderRateLimitHit('coingecko');
      }

      this.logger.warn(
        `[CoinGecko] Live token price lookup failed with HTTP ${axios.isAxiosError(error) ? (error.response?.status ?? error.code ?? 'NO_RESPONSE') : 'UNKNOWN'}`,
      );

      return result;
    }

    const fetchedAt = Date.now();

    for (const [contractAddress, value] of Object.entries(response.data)) {
      const normalizedAddress = contractAddress.toLowerCase();
      const price = typeof value.usd === 'number' ? value.usd : 0;
      result[normalizedAddress] = price;

      const cacheKey = `live:ethereum:${normalizedAddress}`;
      this.priceCache.set(cacheKey, {
        price: price > 0 ? price : null,
        source: 'coingecko',
        expiresAt: fetchedAt + WalletPricingService.LIVE_PRICE_CACHE_TTL_MS,
      });
      this.logger.debug(`Price cache set: ${cacheKey} = $${price}`);
    }

    for (const address of uncachedAddresses) {
      const normalizedAddress = address.toLowerCase();

      if (!(normalizedAddress in result)) {
        const cacheKey = `live:ethereum:${normalizedAddress}`;
        this.priceCache.set(cacheKey, {
          price: null,
          source: 'coingecko',
          expiresAt: fetchedAt + WalletPricingService.LIVE_PRICE_CACHE_TTL_MS,
        });
      }
    }

    return result;
  }

  async fetchTokenMarketSignals(
    contractAddresses: string[],
  ): Promise<Record<string, TokenMarketSignal>> {
    const normalizedAddresses = Array.from(
      new Set(
        contractAddresses
          .map((address) => address.toLowerCase())
          .filter((address) => Boolean(address)),
      ),
    );

    if (normalizedAddresses.length === 0) {
      return {};
    }

    const [defiLlamaResult, dexScreenerResult, coinGeckoResult] =
      await Promise.allSettled([
        this.fetchDefiLlamaCurrentTokenPrices(normalizedAddresses),
        this.fetchDexScreenerTokenSignals(normalizedAddresses),
        this.fetchCoinGeckoTokenPrices(normalizedAddresses),
      ]);

    if (defiLlamaResult.status === 'rejected') {
      this.logger.warn(
        'DefiLlama live pricing lookup failed for token-quality filtering',
        defiLlamaResult.reason instanceof Error
          ? defiLlamaResult.reason.stack
          : undefined,
      );
    }

    if (dexScreenerResult.status === 'rejected') {
      this.logger.warn(
        'DexScreener market lookup failed for token-quality filtering',
        dexScreenerResult.reason instanceof Error
          ? dexScreenerResult.reason.stack
          : undefined,
      );
    }

    if (coinGeckoResult.status === 'rejected') {
      this.logger.warn(
        'CoinGecko fallback lookup failed for token-quality filtering',
        coinGeckoResult.reason instanceof Error
          ? coinGeckoResult.reason.stack
          : undefined,
      );
    }

    const defiLlamaPrices =
      defiLlamaResult.status === 'fulfilled' ? defiLlamaResult.value : {};
    const dexScreenerSignals =
      dexScreenerResult.status === 'fulfilled' ? dexScreenerResult.value : {};
    const coinGeckoPrices =
      coinGeckoResult.status === 'fulfilled' ? coinGeckoResult.value : {};
    const marketSignals: Record<string, TokenMarketSignal> = {};

    for (const address of normalizedAddresses) {
      const defiLlamaPrice = defiLlamaPrices[address] ?? 0;
      const dexSignal = dexScreenerSignals[address] ?? {
        price: null,
        liquidityUsd: null,
      };
      const coinGeckoPrice = coinGeckoPrices[address] ?? 0;
      const priceSources: string[] = [];

      if (defiLlamaPrice > 0) {
        priceSources.push('defillama');
      }

      if ((dexSignal.price ?? 0) > 0) {
        priceSources.push('dexscreener');
      }

      if (coinGeckoPrice > 0) {
        priceSources.push('coingecko');
      }

      marketSignals[address] = {
        price:
          defiLlamaPrice > 0
            ? defiLlamaPrice
            : (dexSignal.price ?? 0) > 0
              ? dexSignal.price
              : coinGeckoPrice > 0
                ? coinGeckoPrice
                : null,
        liquidityUsd:
          Number.isFinite(dexSignal.liquidityUsd) &&
          (dexSignal.liquidityUsd ?? 0) > 0
            ? dexSignal.liquidityUsd
            : null,
        priceSources,
        liquiditySources:
          Number.isFinite(dexSignal.liquidityUsd) &&
          (dexSignal.liquidityUsd ?? 0) > 0
            ? ['dexscreener']
            : [],
      };
    }

    return marketSignals;
  }

  async fetchEthereumUsdPrice(): Promise<number> {
    if (!this.coinGeckoApiKey) {
      this.logger.warn('COINGECKO_API_KEY is not configured');
      return 0;
    }

    const cacheKey = 'live:ethereum:eth';
    const cached = this.priceCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      this.logger.debug(`Price cache hit: ${cacheKey} ($${cached.price})`);
      return cached.price ?? 0;
    }

    this.logger.debug(`Price cache miss: ${cacheKey}`);

    const inFlight = this.inFlightLiveRequests.get(cacheKey);

    if (inFlight) {
      return inFlight;
    }

    const request = (async (): Promise<number> => {
      if (this.isProviderRateLimited('coingecko')) {
        this.recordHistoricalRequestBlocked('coingecko');
        this.logger.warn(
          '[CoinGecko] ETH live price request skipped due to active circuit breaker cooldown',
        );
        return 0;
      }

      let response: { data: CoinGeckoEthPriceResponse };

      try {
        response = await axios.get<CoinGeckoEthPriceResponse>(
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
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.recordProviderRateLimitHit('coingecko');
        }

        this.logger.warn(
          `[CoinGecko] ETH live price lookup failed with HTTP ${axios.isAxiosError(error) ? (error.response?.status ?? error.code ?? 'NO_RESPONSE') : 'UNKNOWN'}`,
        );
        return 0;
      }

      const price =
        typeof response.data.ethereum?.usd === 'number'
          ? response.data.ethereum.usd
          : 0;

      this.priceCache.set(cacheKey, {
        price: price > 0 ? price : null,
        source: 'coingecko',
        expiresAt: Date.now() + WalletPricingService.LIVE_PRICE_CACHE_TTL_MS,
      });
      this.logger.debug(`Price cache set: ${cacheKey} = $${price}`);

      return price;
    })();

    this.inFlightLiveRequests.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.inFlightLiveRequests.delete(cacheKey);
    }
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

      const inferenceDecision = this.tryInferUnknownSidePrice(
        knownTrade,
        knownTrade.price,
        missingTrade,
        tradesAtTimestamp.length,
      );

      if (!inferenceDecision) {
        continue;
      }

      missingTrade.price = inferenceDecision.price;
      this.recordInferredHistoricalPrice(
        missingTrade.token,
        missingTrade.contractAddress,
        missingTrade.timestamp,
        inferenceDecision.price,
        inferenceDecision.confidenceScore,
      );
    }

    return pricedTrades;
  }

  isKnownInferenceAsset(token: string, contractAddress?: string): boolean {
    const tokenUpper = token.toUpperCase();

    if (WalletPricingService.KNOWN_INFERENCE_SYMBOLS.has(tokenUpper)) {
      return true;
    }

    if (!contractAddress) {
      return false;
    }

    return contractAddress.toLowerCase() in TOKEN_CATEGORY_MAP;
  }

  getHistoricalPriceCandidate(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): HistoricalPriceCandidate | null {
    return this.getInferredHistoricalPriceCandidate(
      token,
      contractAddress?.toLowerCase(),
      timestamp,
    );
  }

  tryInferUnknownSidePrice(
    knownTrade: Pick<Trade, 'token' | 'amount' | 'contractAddress' | 'timestamp'>,
    knownUsdPrice: number,
    unknownTrade: Pick<Trade, 'token' | 'amount' | 'contractAddress' | 'timestamp'>,
    tradesAtTimestampCount: number,
  ): HistoricalPriceCandidate | null {
    const knownAmount = this.parsePositiveNumber(knownTrade.amount);
    const unknownAmount = this.parsePositiveNumber(unknownTrade.amount);

    if (
      knownAmount === null ||
      unknownAmount === null ||
      !Number.isFinite(knownUsdPrice) ||
      knownUsdPrice <= 0
    ) {
      return null;
    }

    const tradeValueUsd = knownAmount * knownUsdPrice;

    if (!Number.isFinite(tradeValueUsd) || tradeValueUsd < 10) {
      return null;
    }

    if (unknownAmount <= 0 || unknownAmount < 1e-10) {
      return null;
    }

    const inferredPrice = tradeValueUsd / unknownAmount;

    if (!Number.isFinite(inferredPrice) || inferredPrice <= 0) {
      return null;
    }

    let confidenceScore = 0.9;

    if (tradeValueUsd < 25) {
      confidenceScore -= 0.25;
    } else if (tradeValueUsd < 100) {
      confidenceScore -= 0.1;
    }

    if (tradesAtTimestampCount > 2) {
      confidenceScore -= 0.5;
    }

    if (unknownAmount < 1e-7) {
      confidenceScore -= 0.25;
    }

    const unknownSymbol = unknownTrade.token.toLowerCase();

    if (unknownSymbol.includes('tax') || unknownSymbol.includes('fee')) {
      confidenceScore -= 0.2;
    }

    const nearbyCandidate = this.getInferredHistoricalPriceCandidate(
      unknownTrade.token,
      unknownTrade.contractAddress?.toLowerCase(),
      unknownTrade.timestamp,
      0.2,
    );

    if (nearbyCandidate) {
      const deviation = Math.abs(inferredPrice - nearbyCandidate.price) /
        Math.max(nearbyCandidate.price, 1e-12);

      if (deviation > 0.9) {
        return null;
      }

      if (deviation > 0.4) {
        confidenceScore -= 0.25;
      } else if (deviation > 0.2) {
        confidenceScore -= 0.1;
      }
    }

    confidenceScore = this.clamp01(confidenceScore);

    if (confidenceScore < WalletPricingService.INFERRED_PRICE_CONFIDENCE_MIN) {
      return null;
    }

    return {
      price: inferredPrice,
      source: 'swap_inference',
      confidenceScore,
    };
  }

  recordInferredHistoricalPrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
    inferredPrice: number,
    confidenceScore: number,
  ): void {
    if (!Number.isFinite(inferredPrice) || inferredPrice <= 0) {
      return;
    }

    const tokenIdentifier = this.buildInferredTokenIdentifier(
      token,
      contractAddress?.toLowerCase(),
    );
    const cacheKey = this.buildPriceCacheKey(tokenIdentifier, timestamp);
    const now = Date.now();
    const existing = this.inferredHistoricalPriceCache.get(cacheKey);

    if (!existing || existing.expiresAt <= now) {
      this.inferredHistoricalPriceCache.set(cacheKey, {
        price: inferredPrice,
        source: 'swap_inference',
        confidenceScore: this.clamp01(confidenceScore),
        sampleCount: 1,
        expiresAt: now + WalletPricingService.INFERRED_PRICE_CACHE_TTL_MS,
      });
    } else {
      const existingWeight = Math.max(existing.sampleCount, 1);
      const incomingWeight = Math.max(this.clamp01(confidenceScore), 0.1);
      const mergedPrice =
        (existing.price * existingWeight + inferredPrice * incomingWeight) /
        (existingWeight + incomingWeight);
      const mergedConfidence =
        (existing.confidenceScore * existingWeight +
          this.clamp01(confidenceScore) * incomingWeight) /
        (existingWeight + incomingWeight);

      this.inferredHistoricalPriceCache.set(cacheKey, {
        price: mergedPrice,
        source: 'swap_inference',
        confidenceScore: this.clamp01(mergedConfidence),
        sampleCount: existing.sampleCount + 1,
        expiresAt: now + WalletPricingService.INFERRED_PRICE_CACHE_TTL_MS,
      });
    }

    this.markContractAsHistoricallyPriced(contractAddress?.toLowerCase());
  }

  buildPricingCoverage(pricedTrades: PricedTrade[]): WalletPricingCoverage {
    const totalTrades = pricedTrades.length;
    const pricedTradesCount = pricedTrades.filter((trade) => trade.price > 0).length;
    const unpricedTrades = Math.max(0, totalTrades - pricedTradesCount);
    const {
      providerStatus,
      cooldownUntil,
    } = this.getProviderCooldownDebugSnapshot();
    const { requestsBlockedCount } = this.getPriceFetchBatchSummarySnapshot();
    const unsupportedTokens = Array.from(
      new Set(
        pricedTrades
          .filter((trade) => trade.price <= 0)
          .map((trade) => {
            const unsupportedKey = this.buildUnsupportedContractKey(
              trade.contractAddress?.toLowerCase(),
            );

            if (
              unsupportedKey &&
              this.isContractMarkedUnsupported(unsupportedKey)
            ) {
              return unsupportedKey;
            }

            return null;
          })
          .filter((value): value is string => value !== null),
      ),
    ).sort((left, right) => left.localeCompare(right));

    const coveragePercent =
      totalTrades > 0
        ? this.roundTo(
            (pricedTradesCount / Math.max(totalTrades, 1)) * 100,
            2,
          )
        : 0;

    return {
      totalTrades,
      pricedTrades: pricedTradesCount,
      unpricedTrades,
      coveragePercent,
      unsupportedTokens,
      requestsBlockedCount,
      providerStatus,
      cooldownUntil,
    };
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

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.max(0, Math.min(1, value));
  }

  private roundTo(value: number, decimals = 2): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }

  private static readonly COINGECKO_COIN_ID_MAP: Record<string, string> = {
    ETH: 'ethereum',
    WETH: 'weth',
    BTC: 'bitcoin',
    WBTC: 'wrapped-bitcoin',
    USDT: 'tether',
    USDC: 'usd-coin',
    DAI: 'dai',
    STETH: 'staked-ether',
    WSTETH: 'wrapped-steth',
    LINK: 'chainlink',
    UNI: 'uniswap',
    AAVE: 'aave',
    MKR: 'maker',
    ARB: 'arbitrum',
    OP: 'optimism',
    MATIC: 'matic-network',
    SOL: 'solana',
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
    const result = await this.fetchHistoricalPriceWithCache(
      cacheKey,
      'defillama',
      async () => {
        return this.fetchDefiLlamaPriceUncached(token, coinKey, timestamp);
      },
    );
    const unsupportedContractKey = this.buildUnsupportedContractKey(
      contractAddress?.toLowerCase(),
    );

    if ((result.value ?? 0) > 0) {
      this.markContractAsHistoricallyPriced(contractAddress?.toLowerCase());

      if (unsupportedContractKey) {
        this.unsupportedContractCache.delete(unsupportedContractKey);
        this.unsupportedContractNullHits.delete(unsupportedContractKey);
      }
    } else if (result.status === 'no-data' && unsupportedContractKey) {
      this.recordUnsupportedContractNullHit(
        unsupportedContractKey,
        'repeated_no_historical_data',
      );
    }

    return result;
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

    return this.fetchHistoricalPriceWithCache(cacheKey, 'coingecko', async () => {
      if (this.isProviderRateLimited('coingecko')) {
        this.recordHistoricalRequestBlocked('coingecko');
        this.logger.warn(
          `[CoinGecko fallback] Circuit breaker active; skipping ${token} at ${timestamp}`,
        );

        return {
          value: null,
          shouldCache: false,
          status: 'cooldown',
        };
      }

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
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.recordProviderRateLimitHit('coingecko');
        }

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

  private async fetchDefiLlamaCurrentTokenPrices(
    contractAddresses: string[],
  ): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const addressBatches = this.chunkArray(contractAddresses, 80);

    if (this.isProviderRateLimited('defillama')) {
      this.recordHistoricalRequestBlocked('defillama');
      this.logger.warn(
        '[DefiLlama] Live token price requests paused by circuit breaker cooldown',
      );
      return results;
    }

    for (const addressBatch of addressBatches) {
      const coinKeys = addressBatch.map((address) => `ethereum:${address}`);
      const url = `${DEFILLAMA_API_BASE_URL}/prices/current/${coinKeys.join(',')}`;

      try {
        const response = await axios.get<DefiLlamaPriceResponse>(url, {
          timeout: 10000,
        });

        for (const [coinKey, coinData] of Object.entries(
          response.data?.coins ?? {},
        )) {
          const contractAddress = this.extractContractAddressFromDefiLlamaKey(
            coinKey,
          );

          if (!contractAddress) {
            continue;
          }

          const price = this.toFinitePositiveNumber(coinData?.price);

          if (price === null) {
            continue;
          }

          results[contractAddress] = price;
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.recordProviderRateLimitHit('defillama');
        }

        if (axios.isAxiosError(error)) {
          this.logger.warn(
            `[DefiLlama] Live price lookup failed for ${addressBatch.length} contracts with HTTP ${error.response?.status ?? error.code ?? 'NO_RESPONSE'}`,
          );
        } else {
          this.logger.warn(
            `[DefiLlama] Live price lookup failed for ${addressBatch.length} contracts`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }

    return results;
  }

  private async fetchDexScreenerTokenSignals(
    contractAddresses: string[],
  ): Promise<Record<string, { price: number | null; liquidityUsd: number | null }>> {
    const results: Record<string, { price: number | null; liquidityUsd: number | null }> = {};
    const requestedAddressSet = new Set(contractAddresses.map((address) => address.toLowerCase()));
    const addressBatches = this.chunkArray(contractAddresses, 30);

    if (this.isProviderRateLimited('dexscreener')) {
      this.recordHistoricalRequestBlocked('dexscreener');
      this.logger.warn(
        '[DexScreener] Market requests paused by circuit breaker cooldown',
      );
      return results;
    }

    for (const addressBatch of addressBatches) {
      const url = `${DEXSCREENER_API_BASE_URL}/latest/dex/tokens/${addressBatch.join(',')}`;

      try {
        const response = await axios.get<DexScreenerTokenResponse>(url, {
          timeout: 10000,
        });
        const pairs = response.data?.pairs ?? [];

        for (const pair of pairs) {
          if ((pair.chainId ?? '').toLowerCase() !== 'ethereum') {
            continue;
          }

          const pairPrice = this.toFinitePositiveNumber(pair.priceUsd);
          const pairLiquidityUsd = this.toFinitePositiveNumber(pair.liquidity?.usd);
          const baseTokenAddress = pair.baseToken?.address?.toLowerCase() ?? '';

          // DexScreener priceUsd is reliable for the base token side only.
          if (!requestedAddressSet.has(baseTokenAddress)) {
            continue;
          }

          const current = results[baseTokenAddress] ?? {
            price: null,
            liquidityUsd: null,
          };
          const currentLiquidity = current.liquidityUsd ?? -1;
          const nextLiquidity = pairLiquidityUsd ?? -1;

          if (nextLiquidity >= currentLiquidity) {
            results[baseTokenAddress] = {
              price: pairPrice ?? current.price,
              liquidityUsd: pairLiquidityUsd,
            };
          }
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.recordProviderRateLimitHit('dexscreener');
        }

        if (axios.isAxiosError(error)) {
          this.logger.warn(
            `[DexScreener] Market lookup failed for ${addressBatch.length} contracts with HTTP ${error.response?.status ?? error.code ?? 'NO_RESPONSE'}`,
          );
        } else {
          this.logger.warn(
            `[DexScreener] Market lookup failed for ${addressBatch.length} contracts`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }

    return results;
  }

  private extractContractAddressFromDefiLlamaKey(
    coinKey: string,
  ): string | null {
    const [chain, contractAddress] = coinKey.split(':');

    if (chain !== 'ethereum' || !contractAddress) {
      return null;
    }

    return contractAddress.toLowerCase();
  }

  private toFinitePositiveNumber(value: unknown): number | null {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return null;
    }

    return parsedValue;
  }

  private chunkArray<T>(values: T[], chunkSize: number): T[][] {
    if (values.length === 0 || chunkSize <= 0) {
      return [];
    }

    const chunks: T[][] = [];

    for (let index = 0; index < values.length; index += chunkSize) {
      chunks.push(values.slice(index, index + chunkSize));
    }

    return chunks;
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
    const roundedTs = Math.floor(timestamp / 3600) * 3600;
    return `${tokenIdentifier}:${roundedTs}`;
  }

  private hasCoinGeckoHistoricalMapping(token: string): boolean {
    return Boolean(
      WalletPricingService.COINGECKO_COIN_ID_MAP[token.toUpperCase()],
    );
  }

  private getPriceFetchBatchSummarySnapshot(): PriceFetchBatchSummary {
    const hasCurrentBatchData =
      this.priceFetchBatchSummary.pricesFound > 0 ||
      this.priceFetchBatchSummary.pricesMissing > 0 ||
      this.priceFetchBatchSummary.requestsMade > 0 ||
      this.priceFetchBatchSummary.requestsBlockedCount > 0;

    if (hasCurrentBatchData || this.activePriceFetchCount > 0) {
      return this.priceFetchBatchSummary;
    }

    return this.lastCompletedPriceFetchBatchSummary;
  }

  private getProviderCooldownDebugSnapshot(): Pick<
    WalletPricingCoverage,
    'providerStatus' | 'cooldownUntil'
  > {
    const providerStatus: WalletPricingCoverage['providerStatus'] = {};
    const cooldownUntil: WalletPricingCoverage['cooldownUntil'] = {};

    for (const provider of WalletPricingService.PRICING_PROVIDERS) {
      const inCooldown = this.isProviderRateLimited(provider);
      const providerState = this.getProviderCircuitState(provider);

      providerStatus[provider] = inCooldown ? 'cooldown' : 'active';
      cooldownUntil[provider] = inCooldown
        ? new Date(providerState.cooldownUntil).toISOString()
        : null;
    }

    return {
      providerStatus,
      cooldownUntil,
    };
  }

  private buildHistoricalSuccessCacheKey(
    contractAddress: string | undefined,
    timestamp: number,
  ): string | null {
    if (!contractAddress) {
      return null;
    }

    return `ethereum:${contractAddress.toLowerCase()}:${Math.floor(timestamp)}`;
  }

  private getHistoricalSuccessCachePrice(cacheKey: string | null): number {
    if (!cacheKey) {
      return 0;
    }

    const cached = this.historicalSuccessCache.get(cacheKey);

    if (!cached || cached.expiresAt <= Date.now() || cached.price === null) {
      if (cached && cached.expiresAt <= Date.now()) {
        this.historicalSuccessCache.delete(cacheKey);
      }

      return 0;
    }

    return cached.price;
  }

  private setHistoricalSuccessCachePrice(
    cacheKey: string | null,
    price: number,
    source: string,
  ): void {
    if (!cacheKey || !Number.isFinite(price) || price <= 0) {
      return;
    }

    this.historicalSuccessCache.set(cacheKey, {
      price,
      source,
      expiresAt: Date.now() + WalletPricingService.HISTORICAL_PRICE_CACHE_TTL_MS,
    });
  }

  private buildUnsupportedContractKey(
    contractAddress: string | null | undefined,
  ): string | null {
    if (!contractAddress) {
      return null;
    }

    return `ethereum:${contractAddress.toLowerCase()}`;
  }

  private isContractMarkedUnsupported(
    unsupportedContractKey: string | null,
  ): boolean {
    if (!unsupportedContractKey) {
      return false;
    }

    const entry = this.unsupportedContractCache.get(unsupportedContractKey);

    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.unsupportedContractCache.delete(unsupportedContractKey);
      this.unsupportedContractNullHits.delete(unsupportedContractKey);
      return false;
    }

    return true;
  }

  private markContractUnsupported(
    unsupportedContractKey: string,
    reason: string,
  ): void {
    const now = Date.now();

    this.unsupportedContractCache.set(unsupportedContractKey, {
      expiresAt: now + WalletPricingService.HISTORICAL_UNSUPPORTED_CACHE_TTL_MS,
      reason,
    });
  }

  private recordUnsupportedContractNullHit(
    unsupportedContractKey: string,
    reason: string,
  ): void {
    const now = Date.now();
    const existing = this.unsupportedContractNullHits.get(unsupportedContractKey);
    const nextHits =
      existing &&
      now - existing.lastSeenAt <= WalletPricingService.HISTORICAL_UNSUPPORTED_CACHE_TTL_MS
        ? existing.hits + 1
        : 1;

    if (
      nextHits >=
      WalletPricingService.HISTORICAL_UNSUPPORTED_NULL_HIT_THRESHOLD
    ) {
      this.markContractUnsupported(unsupportedContractKey, reason);
      this.unsupportedContractNullHits.delete(unsupportedContractKey);
      return;
    }

    this.unsupportedContractNullHits.set(unsupportedContractKey, {
      hits: nextHits,
      lastSeenAt: now,
    });
  }

  private markContractAsHistoricallyPriced(
    contractAddress: string | undefined,
  ): void {
    if (!contractAddress) {
      return;
    }

    this.historicallyPricedContracts.add(contractAddress.toLowerCase());
  }

  private async shouldSkipHistoricalPricingToken(
    token: string,
    contractAddress: string | undefined,
  ): Promise<{ skip: boolean; reason: string }> {
    if (!contractAddress) {
      return { skip: false, reason: 'non_contract_token' };
    }

    const normalizedContract = contractAddress.toLowerCase();

    if (this.historicallyPricedContracts.has(normalizedContract)) {
      return { skip: false, reason: 'previously_priced_successfully' };
    }

    if (normalizedContract in TOKEN_CATEGORY_MAP) {
      return { skip: false, reason: 'known_category_map' };
    }

    if (this.isKnownInferenceAsset(token, normalizedContract)) {
      return { skip: false, reason: 'trusted_token_list' };
    }

    const tokenLower = token.toLowerCase();
    const looksLikeSpam =
      token.length > WalletPricingService.PREFILTER_MAX_SYMBOL_LENGTH ||
      WalletPricingService.PREFILTER_SPAM_KEYWORDS.some((keyword) =>
        tokenLower.includes(keyword),
      );

    if (!looksLikeSpam) {
      return { skip: false, reason: 'no_spam_signal' };
    }

    const liquidityUsd = await this.getContractLiquidityUsd(normalizedContract);

    if (
      liquidityUsd !== null &&
      liquidityUsd >= WalletPricingService.PREFILTER_LIQUIDITY_MIN_USD
    ) {
      return { skip: false, reason: 'sufficient_liquidity' };
    }

    return { skip: true, reason: 'prefilter_spam_or_low_liquidity' };
  }

  private async getContractLiquidityUsd(
    contractAddress: string,
  ): Promise<number | null> {
    const normalizedContract = contractAddress.toLowerCase();
    const cached = this.prefilterLiquidityCache.get(normalizedContract);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.liquidityUsd;
    }

    const signal = await this.fetchDexScreenerTokenSignals([normalizedContract]);
    const liquidityUsd = signal[normalizedContract]?.liquidityUsd ?? null;

    this.prefilterLiquidityCache.set(normalizedContract, {
      liquidityUsd,
      expiresAt: Date.now() + WalletPricingService.PREFILTER_LIQUIDITY_CACHE_TTL_MS,
    });

    return liquidityUsd;
  }

  private buildInferredTokenIdentifier(
    token: string,
    contractAddress: string | undefined,
  ): string {
    if (contractAddress) {
      return `inferred:ethereum:${contractAddress.toLowerCase()}`;
    }

    return `inferred:symbol:${token.toUpperCase()}`;
  }

  private getInferredHistoricalPriceCandidate(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
    minConfidence = WalletPricingService.INFERRED_PRICE_CONFIDENCE_MIN,
  ): HistoricalPriceCandidate | null {
    const tokenIdentifier = this.buildInferredTokenIdentifier(
      token,
      contractAddress,
    );
    const bucketOffsets = [0, -3600, 3600, -7200, 7200];
    let bestCandidate: InferredPriceCacheEntry | null = null;

    for (const offsetSeconds of bucketOffsets) {
      const key = this.buildPriceCacheKey(tokenIdentifier, timestamp + offsetSeconds);
      const candidate = this.inferredHistoricalPriceCache.get(key);

      if (!candidate) {
        continue;
      }

      if (candidate.expiresAt <= Date.now()) {
        this.inferredHistoricalPriceCache.delete(key);
        continue;
      }

      if (candidate.confidenceScore < minConfidence) {
        continue;
      }

      if (!bestCandidate) {
        bestCandidate = candidate;
        continue;
      }

      if (candidate.confidenceScore > bestCandidate.confidenceScore) {
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) {
      return null;
    }

    return {
      price: bestCandidate.price,
      source: 'swap_inference',
      confidenceScore: bestCandidate.confidenceScore,
    };
  }

  private getProviderCircuitState(provider: string): ProviderCircuitState {
    const existingState = this.providerCircuitState.get(provider);

    if (existingState) {
      return existingState;
    }

    const initialState: ProviderCircuitState = {
      rateLimitHits: [],
      cooldownUntil: 0,
    };
    this.providerCircuitState.set(provider, initialState);
    return initialState;
  }

  private isProviderRateLimited(provider: string): boolean {
    const now = Date.now();
    const state = this.getProviderCircuitState(provider);

    this.pruneProviderRateLimitHits(state, now);

    if (state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      return false;
    }

    return state.cooldownUntil > 0;
  }

  private recordProviderRateLimitHit(provider: string): void {
    const now = Date.now();
    const state = this.getProviderCircuitState(provider);

    this.pruneProviderRateLimitHits(state, now);
    state.rateLimitHits.push(now);

    const hitRate = this.roundTo(
      state.rateLimitHits.length /
        (WalletPricingService.PROVIDER_RATE_LIMIT_WINDOW_MS / 1000),
      3,
    );

    if (
      state.rateLimitHits.length < WalletPricingService.PROVIDER_RATE_LIMIT_THRESHOLD
    ) {
      return;
    }

    const cooldownStart = now;
    const cooldownEnd =
      now + WalletPricingService.PROVIDER_RATE_LIMIT_COOLDOWN_MS;
    state.cooldownUntil = cooldownEnd;
    state.rateLimitHits = [];

    this.logger.warn(
      `[Pricing circuit breaker] provider=${provider} hitRate=${hitRate}/s cooldownStart=${new Date(cooldownStart).toISOString()} cooldownEnd=${new Date(cooldownEnd).toISOString()}`,
    );
  }

  private pruneProviderRateLimitHits(
    state: ProviderCircuitState,
    now: number,
  ): void {
    const windowStart = now - WalletPricingService.PROVIDER_RATE_LIMIT_WINDOW_MS;
    state.rateLimitHits = state.rateLimitHits.filter(
      (timestamp) => timestamp >= windowStart,
    );
  }

  private async fetchHistoricalPriceWithCache(
    cacheKey: string,
    source: string,
    fetcher: () => Promise<HistoricalPriceFetchResult>,
  ): Promise<HistoricalPriceFetchResult> {
    const cached = this.priceCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      if (cached.price !== null) {
        this.logger.debug(
          `Price cache hit: ${cacheKey} ($${cached.price} via ${cached.source})`,
        );
      } else {
        this.logger.debug(`Price cache hit (null): ${cacheKey}`);
      }

      return {
        value: cached.price,
        shouldCache: true,
        status: cached.price === null ? 'cached-no-data' : 'success',
      };
    }

    this.logger.debug(`Price cache miss: ${cacheKey}`);

    const inFlightRequest = this.inFlightRequestResults.get(cacheKey);

    if (inFlightRequest) {
      return inFlightRequest;
    }

    const request = (async (): Promise<HistoricalPriceFetchResult> => {
      const result = await fetcher();

      if (result.shouldCache) {
        this.priceCache.set(cacheKey, {
          price: result.value,
          source,
          expiresAt: Date.now() + WalletPricingService.HISTORICAL_PRICE_CACHE_TTL_MS,
        });
        this.logger.debug(
          `Price cache set: ${cacheKey} = $${result.value} via ${source}`,
        );
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

      if (this.isProviderRateLimited('defillama')) {
        throw new ProviderCooldownError('defillama');
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
    const unsupportedContractKey = this.buildUnsupportedContractKey(
      this.extractContractAddressFromDefiLlamaKey(coinKey),
    );

    for (
      let attempt = 0;
      attempt <= WalletPricingService.DEFILLAMA_MAX_429_RETRIES;
      attempt += 1
    ) {
      if (this.isProviderRateLimited('defillama')) {
        this.recordHistoricalRequestBlocked('defillama');
        this.logger.warn(
          `[DefiLlama] Provider cooldown active; skipping ${token} at ${timestamp}`,
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
        if (error instanceof ProviderCooldownError) {
          this.recordHistoricalRequestBlocked('defillama');
          this.logger.warn(
            `[DefiLlama] Provider cooldown active; skipping ${token} at ${timestamp}`,
          );

          return {
            value: null,
            shouldCache: false,
            status: 'cooldown',
          };
        }

        if (axios.isAxiosError(error) && error.response?.status === 429) {
          this.recordProviderRateLimitHit('defillama');

          this.logger.warn(
            `[DefiLlama] HTTP 429 for ${token} at ${timestamp} (attempt ${attempt + 1}/${WalletPricingService.DEFILLAMA_MAX_429_RETRIES + 1})`,
          );

          if (this.isProviderRateLimited('defillama')) {
            this.recordHistoricalRequestBlocked('defillama');
            return {
              value: null,
              shouldCache: false,
              status: 'cooldown',
            };
          }

          if (attempt < WalletPricingService.DEFILLAMA_MAX_429_RETRIES) {
            const backoffMs =
              WalletPricingService.RATE_LIMIT_BACKOFF_BASE_MS * 2 ** attempt;

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

        if (
          axios.isAxiosError(error) &&
          (error.response?.status === 404 || error.response?.status === 400) &&
          unsupportedContractKey
        ) {
          this.markContractUnsupported(
            unsupportedContractKey,
            'provider_not_supported',
          );

          return {
            value: null,
            shouldCache: true,
            status: 'no-data',
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

  private recordHistoricalRequestBlocked(provider: string): void {
    if (this.activePriceFetchCount <= 0) {
      return;
    }

    this.priceFetchBatchSummary.requestsBlockedCount += 1;
    this.logger.debug(
      `[Pricing request blocked] provider=${provider} due to active cooldown`,
    );
  }

  private schedulePriceFetchSummaryLog(): void {
    this.clearPriceFetchSummaryTimeout();
    this.priceFetchSummaryTimeout = setTimeout(() => {
      if (this.activePriceFetchCount > 0) {
        return;
      }

      const { pricesFound, pricesMissing, requestsMade, requestsBlockedCount } =
        this.priceFetchBatchSummary;
      const requestsAttempted = requestsMade + requestsBlockedCount;
      const {
        providerStatus,
        cooldownUntil,
      } = this.getProviderCooldownDebugSnapshot();

      if (
        pricesFound === 0 &&
        pricesMissing === 0 &&
        requestsMade === 0 &&
        requestsBlockedCount === 0
      ) {
        return;
      }

      this.logger.log(
        `Price fetch complete: ${pricesFound} prices found, ${pricesMissing} prices missing, ${requestsAttempted} requests attempted (${requestsMade} sent, ${requestsBlockedCount} blocked), providerStatus=${JSON.stringify(providerStatus)}, cooldownUntil=${JSON.stringify(cooldownUntil)}`,
      );

      this.lastCompletedPriceFetchBatchSummary = {
        ...this.priceFetchBatchSummary,
      };

      this.priceFetchBatchSummary = {
        pricesFound: 0,
        pricesMissing: 0,
        requestsMade: 0,
        requestsBlockedCount: 0,
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
