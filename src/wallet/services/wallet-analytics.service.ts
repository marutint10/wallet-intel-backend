import { Injectable, Logger } from '@nestjs/common';
import {
  Trade,
  WalletActivityMetricsResponse,
  WalletDexMetricsDebugResponse,
  WalletDexMetricsResponse,
  WalletDexMetricsResult,
  WalletHoldTimeBuckets,
  WalletHoldTimeMetricsResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsDebugResponse,
  WalletRiskMetricsResult,
  WalletRiskMetricsResponse,
  WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import {
  AGGREGATOR_ROUTERS,
  CUSTOM_HIGH_FREQUENCY_ROUTER_LABEL,
  CUSTOM_HIGH_FREQUENCY_ROUTER_THRESHOLD,
  DEX_ROUTERS,
  UNKNOWN_DEX_LABEL,
} from '../constants/dex-routers';
import {
  MAJOR_SYMBOL_CATEGORY_FALLBACKS,
  NATIVE_TOKEN_CATEGORIES,
  TOKEN_CATEGORY_MAPS,
  TokenCategory,
  classifyToken,
} from '../constants/token-categories';
import {
  RealizedTradeMetrics,
  WalletPnlService,
} from './wallet-pnl.service';
import { WalletCoreService } from './wallet-core.service';
import { WalletPortfolioService } from './wallet-portfolio.service';
import { WalletPricingService } from './wallet-pricing.service';
import {
  DEFAULT_SUPPORTED_CHAIN,
  SupportedChain,
} from '../../shared/constants/chains';

interface PortfolioConcentrationSnapshot {
  largestHoldingUsd: string;
  totalPortfolioUsd: string;
  concentrationRisk: number;
}

type AnalyticsTokenCategory =
  | 'Blue Chip / L1'
  | 'DeFi'
  | 'Stablecoin'
  | 'AI'
  | 'Gaming'
  | 'Memecoin'
  | 'Other';

interface TokenCategoryMarketSignal {
  liquidityUsd: number | null;
  priceSources: string[];
}

interface TokenClassificationInput {
  token: string;
  contractAddress?: string | null;
  chain: SupportedChain;
  marketSignal?: TokenCategoryMarketSignal;
}

const TOKEN_CATEGORY_BUCKETS: AnalyticsTokenCategory[] = [
  'Blue Chip / L1',
  'DeFi',
  'Stablecoin',
  'AI',
  'Gaming',
  'Memecoin',
  'Other',
];

const TOKEN_CATEGORY_PRIORITY: Record<AnalyticsTokenCategory, number> = {
  Memecoin: 7,
  AI: 6,
  Gaming: 5,
  DeFi: 4,
  Other: 3,
  'Blue Chip / L1': 2,
  Stablecoin: 1,
};

const MEMECOIN_FALLBACK_LIQUIDITY_USD = 500_000;

@Injectable()
export class WalletAnalyticsService {
  private readonly logger = new Logger(WalletAnalyticsService.name);

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPortfolioService: WalletPortfolioService,
    private readonly walletPricingService: WalletPricingService,
  ) {}

  async getRiskMetrics(
    address: string,
    debug = false,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletRiskMetricsResult> {
    const [realizedTrades, portfolio] = await Promise.all([
      this.walletPnlService.getRealizedTradeMetrics(address, chain),
      this.walletPortfolioService.getPortfolio(address, chain),
    ]);
    const filteredPortfolio = portfolio.filter((holding) =>
      this.isMetricEligibleHolding(holding, chain),
    );
    const positivePnLTrades = realizedTrades
      .filter((trade) => trade.pnl > 0)
      .map((trade) => this.roundDecimal(trade.pnl));
    const negativePnLTrades = realizedTrades
      .filter((trade) => trade.pnl < 0)
      .map((trade) => this.roundDecimal(trade.pnl));
    const cumulativePnLCurve = this.buildCumulativePnLCurve(realizedTrades);
    const tradeROIs = realizedTrades.map((trade) => this.roundDecimal(trade.roi));
    const concentrationSnapshot = this.computeConcentrationSnapshot(
      filteredPortfolio,
    );

    const metrics: WalletRiskMetricsResponse = {
      profitFactor: this.computeProfitFactorFromValues(
        positivePnLTrades,
        negativePnLTrades,
      ),
      maxDrawdown: this.computeMaxDrawdownFromCurve(cumulativePnLCurve),
      returnStdDev: this.computePopulationStdDev(tradeROIs),
      concentrationRisk: concentrationSnapshot.concentrationRisk,
    };

    if (!debug) {
      return metrics;
    }

    return {
      ...metrics,
      positivePnLTrades,
      negativePnLTrades,
      cumulativePnLCurve,
      tradeROIs,
      largestHoldingUsd: this.toFiniteNumber(
        concentrationSnapshot.largestHoldingUsd,
      ),
      totalPortfolioUsd: this.toFiniteNumber(
        concentrationSnapshot.totalPortfolioUsd,
      ),
    } satisfies WalletRiskMetricsDebugResponse;
  }

  async getHoldTimeMetrics(
    address: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletHoldTimeMetricsResponse> {
    const completedTradeLots =
      await this.walletPnlService.getCompletedTradeLots(address, chain);

    if (completedTradeLots.length === 0) {
      return {
        avgHoldHours: 0,
        medianHoldHours: 0,
        holdBuckets: this.createEmptyHoldBuckets(),
      };
    }

    const holdHours = completedTradeLots
      .map((tradeLot) => this.roundDecimal(tradeLot.holdHours))
      .sort((left, right) => left - right);

    const avgHoldHours = this.roundDecimal(
      holdHours.reduce((total, value) => total + value, 0) / holdHours.length,
    );

    return {
      avgHoldHours,
      medianHoldHours: this.computeMedian(holdHours),
      holdBuckets: this.buildHoldBuckets(holdHours),
    };
  }

  async getActivityMetrics(
    address: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletActivityMetricsResponse> {
    const trades = await this.walletPnlService.getTrades(address, chain);

    if (trades.length === 0) {
      return {
        tradesPerActiveDay: 0,
        tradesPerLifetimeDay: 0,
        avgTradeGapHours: 0,
        burstinessScore: 0,
        tradingSpanRatio: 0,
      };
    }

    const sortedTrades = [...trades].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const activeTradingDays = this.countActiveTradingDays(sortedTrades);
    const walletAgeDays = this.computeWalletAgeDays(sortedTrades);
    const tradeGapHours = this.buildTradeGapHours(sortedTrades);
    const avgTradeGapHours =
      tradeGapHours.length > 0
        ? this.roundDecimal(
            tradeGapHours.reduce((total, value) => total + value, 0) /
              tradeGapHours.length,
          )
        : 0;
    const tradingSpanRatio = this.computeTradingSpanRatio(sortedTrades);

    return {
      tradesPerActiveDay:
        activeTradingDays > 0
          ? this.roundDecimal(sortedTrades.length / activeTradingDays)
          : 0,
      tradesPerLifetimeDay:
        walletAgeDays > 0
          ? this.roundDecimal(sortedTrades.length / walletAgeDays)
          : 0,
      avgTradeGapHours,
      burstinessScore:
        avgTradeGapHours > 0
          ? this.roundDecimal(
              this.computePopulationStdDev(tradeGapHours) / avgTradeGapHours,
            )
          : 0,
      tradingSpanRatio,
    };
  }

  async getDexMetrics(
    address: string,
    debug = false,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletDexMetricsResult> {
    const transactions = await this.walletCoreService.getTransactionEntities(
      address,
      chain,
    );
    const swapTransactions = transactions.filter(
      (transaction) => transaction.type === 'swap',
    );

    if (swapTransactions.length === 0) {
      const emptyMetrics: WalletDexMetricsResponse = {
        tradesPerDex: {},
        primaryDex: null,
        primaryDexShare: 0,
        dexDiversity: 0,
        unknownDexPercent: 0,
      };

      if (!debug) {
        return emptyMetrics;
      }

      return {
        ...emptyMetrics,
        unknownRouterAddresses: [],
      };
    }

    const normalizedAddress = address.toLowerCase();
    const routerCandidates = swapTransactions.map((transaction) =>
      this.resolveDexCandidate(
        transaction,
        normalizedAddress,
        chain,
      ),
    );
    const unknownRouterCounts = new Map<string, number>();

    for (const candidate of routerCandidates) {
      if (!candidate.knownDexName) {
        unknownRouterCounts.set(
          candidate.unknownRouterAddress,
          (unknownRouterCounts.get(candidate.unknownRouterAddress) ?? 0) + 1,
        );
      }
    }

    const tradesPerDex = new Map<string, number>();

    for (const candidate of routerCandidates) {
      const dexName = candidate.knownDexName
        ? candidate.knownDexName
        : this.resolveUnknownDexName(
            candidate.unknownRouterAddress,
            unknownRouterCounts,
          );

      tradesPerDex.set(dexName, (tradesPerDex.get(dexName) ?? 0) + 1);
    }

    const tradesPerDexObject = Object.fromEntries(tradesPerDex.entries());
    const primaryDexEntry = Array.from(tradesPerDex.entries()).sort(
      (left, right) => right[1] - left[1],
    )[0] ?? null;
    const unknownTrades = tradesPerDex.get(UNKNOWN_DEX_LABEL) ?? 0;
    const matchedDexNames = Array.from(tradesPerDex.keys()).filter(
      (dexName) => dexName !== UNKNOWN_DEX_LABEL,
    );

    const metrics: WalletDexMetricsResponse = {
      tradesPerDex: tradesPerDexObject,
      primaryDex: primaryDexEntry?.[0] ?? null,
      primaryDexShare: primaryDexEntry
        ? this.roundDecimal((primaryDexEntry[1] / swapTransactions.length) * 100)
        : 0,
      dexDiversity: matchedDexNames.length,
      unknownDexPercent: this.roundDecimal(
        (unknownTrades / swapTransactions.length) * 100,
      ),
    };

    if (!debug) {
      return metrics;
    }

    return {
      ...metrics,
      unknownRouterAddresses: Array.from(unknownRouterCounts.entries())
        .map(([address, count]) => ({ address, count }))
        .sort((left, right) => right.count - left.count),
    };
  }

  private resolveUnknownDexName(
    unknownRouterAddress: string,
    unknownRouterCounts: Map<string, number>,
  ): string {
    if (
      (unknownRouterCounts.get(unknownRouterAddress) ?? 0) >
      CUSTOM_HIGH_FREQUENCY_ROUTER_THRESHOLD
    ) {
      return CUSTOM_HIGH_FREQUENCY_ROUTER_LABEL;
    }

    return UNKNOWN_DEX_LABEL;
  }

  private resolveDexCandidate(
    transaction: {
      to_address?: string | null;
      from_address?: string | null;
    },
    walletAddress: string,
    chain: SupportedChain,
  ): { knownDexName: string | null; unknownRouterAddress: string } {
    const toAddress = transaction.to_address?.toLowerCase() ?? '';
    const fromAddress = transaction.from_address?.toLowerCase() ?? '';
    const toDexName = this.resolveKnownDexName(toAddress, chain);

    if (toDexName) {
      return {
        knownDexName: toDexName,
        unknownRouterAddress: toAddress || '(empty)',
      };
    }

    const fromDexName = this.resolveKnownDexName(fromAddress, chain);

    if (fromDexName) {
      return {
        knownDexName: fromDexName,
        unknownRouterAddress: fromAddress || toAddress || '(empty)',
      };
    }

    return {
      knownDexName: null,
      unknownRouterAddress: this.selectUnknownRouterAddress(
        toAddress,
        fromAddress,
        walletAddress,
      ),
    };
  }

  private selectUnknownRouterAddress(
    toAddress: string,
    fromAddress: string,
    walletAddress: string,
  ): string {
    const nonWalletCandidates = [toAddress, fromAddress].filter(
      (address) => address && address !== walletAddress,
    );

    return nonWalletCandidates[0] ?? (toAddress || fromAddress || '(empty)');
  }

  private resolveKnownDexName(
    routerAddress: string,
    chain: SupportedChain,
  ): string | null {
    if (!routerAddress) {
      return null;
    }

    return (
      DEX_ROUTERS[chain][routerAddress] ??
      AGGREGATOR_ROUTERS[chain][routerAddress] ??
      null
    );
  }

  async getTokenCategoryMetrics(
    address: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletTokenCategoryMetricsResponse> {
    const [pricedTrades, portfolio] = await Promise.all([
      this.walletPnlService.getPricedTrades(address, chain),
      this.walletPortfolioService.getPortfolio(address, chain),
    ]);
    const metricEligibleTrades = pricedTrades.filter((trade) =>
      this.isMetricEligibleTrade(trade, chain),
    );
    const metricEligibleHoldings = portfolio.filter((holding) =>
      this.isMetricEligibleHolding(holding, chain),
    );
    const tradesByCategory = new Map<string, number>();
    const volumeByCategory = new Map<string, number>();
    const currentHoldingsByCategory = new Map<string, number>();
    const marketSignals = this.buildTokenCategoryMarketSignals(
      metricEligibleHoldings,
    );
    const tradesBySwap = this.groupTradesBySwap(metricEligibleTrades);

    for (const swapTrades of tradesBySwap.values()) {
      const categoryLabel = this.classifySwapCategory(
        swapTrades,
        marketSignals,
        chain,
      );

      tradesByCategory.set(
        categoryLabel,
        (tradesByCategory.get(categoryLabel) ?? 0) + 1,
      );

      const tradeVolume = this.computeSwapVolumeUsd(swapTrades);

      if (tradeVolume > 0) {
        volumeByCategory.set(
          categoryLabel,
          this.roundDecimal(
            (volumeByCategory.get(categoryLabel) ?? 0) + tradeVolume,
          ),
        );
      }
    }

    for (const holding of metricEligibleHoldings) {
      if (!holding.usdValue) {
        continue;
      }

      const usdValue = Number(holding.usdValue);

      if (!Number.isFinite(usdValue)) {
        continue;
      }

      const categoryLabel = this.classifyTokenCategory({
        token: holding.token,
        contractAddress: holding.contractAddress,
        chain,
        marketSignal: this.getTokenCategoryMarketSignal(
          holding.token,
          holding.contractAddress,
          marketSignals,
        ),
      });

      currentHoldingsByCategory.set(
        categoryLabel,
        this.roundDecimal(
          (currentHoldingsByCategory.get(categoryLabel) ?? 0) + usdValue,
        ),
      );
    }

    const totalTrades = Array.from(tradesByCategory.values()).reduce(
      (total, value) => total + value,
      0,
    );
    const totalVolume = Array.from(volumeByCategory.values()).reduce(
      (total, value) => total + value,
      0,
    );
    const totalHoldingsUsd = Array.from(currentHoldingsByCategory.values()).reduce(
      (total, value) => total + value,
      0,
    );
    const tradePercentByCategory = this.buildCategoryPercentages(
      tradesByCategory,
      totalTrades,
    );
    const holdingPercentByCategory = this.buildCategoryPercentages(
      currentHoldingsByCategory,
      totalHoldingsUsd,
    );
    const dominantTradingCategory = this.resolveDominantCategory(
      tradePercentByCategory,
    );
    const dominantHoldingCategoryEntry = Array.from(
      currentHoldingsByCategory.entries(),
    ).sort((left, right) => right[1] - left[1])[0] ?? null;

    return {
      tradesByCategory: Object.fromEntries(tradesByCategory.entries()),
      historicalVolumeByCategory: Object.fromEntries(volumeByCategory.entries()),
      dominantTradingCategory,
      categoryDiversity: tradesByCategory.size,
      memecoinTradePercent: tradePercentByCategory.Memecoin,
      blueChipTradePercent: tradePercentByCategory['Blue Chip / L1'],
      defiTradePercent: tradePercentByCategory.DeFi,
      stablecoinTradePercent: tradePercentByCategory.Stablecoin,
      aiNarrativeTradePercent: tradePercentByCategory.AI,
      gamingTradePercent: tradePercentByCategory.Gaming,
      otherTradePercent: tradePercentByCategory.Other,
      currentHoldingsByCategory: Object.fromEntries(
        currentHoldingsByCategory.entries(),
      ),
      dominantHoldingCategory: dominantHoldingCategoryEntry?.[0] ?? null,
      memecoinHoldingPercent: holdingPercentByCategory.Memecoin,
      blueChipHoldingPercent: holdingPercentByCategory['Blue Chip / L1'],
      defiHoldingPercent: holdingPercentByCategory.DeFi,
      stablecoinHoldingPercent: holdingPercentByCategory.Stablecoin,
      aiNarrativeHoldingPercent: holdingPercentByCategory.AI,
      gamingHoldingPercent: holdingPercentByCategory.Gaming,
      otherHoldingPercent: holdingPercentByCategory.Other,
    };
  }

  private groupTradesBySwap<T extends Trade>(trades: T[]): Map<string, T[]> {
    const tradesBySwap = new Map<string, T[]>();

    trades.forEach((trade, index) => {
      const swapKey = trade.transactionHash
        ? trade.transactionHash.toLowerCase()
        : `${trade.timestamp}:${trade.routeHopIndex ?? index}`;
      const swapTrades = tradesBySwap.get(swapKey) ?? [];

      swapTrades.push(trade);
      tradesBySwap.set(swapKey, swapTrades);
    });

    return tradesBySwap;
  }

  private classifySwapCategory<T extends Trade>(
    trades: T[],
    marketSignals: Map<string, TokenCategoryMarketSignal>,
    chain: SupportedChain,
  ): AnalyticsTokenCategory {
    const categories = trades.map((trade) =>
      this.classifyTokenCategory({
        token: trade.token,
        contractAddress: trade.contractAddress,
        chain,
        marketSignal: this.getTokenCategoryMarketSignal(
          trade.token,
          trade.contractAddress,
          marketSignals,
        ),
      }),
    );

    return categories.sort(
      (left, right) => TOKEN_CATEGORY_PRIORITY[right] - TOKEN_CATEGORY_PRIORITY[left],
    )[0] ?? 'Other';
  }

  private classifyTokenCategory(
    input: TokenClassificationInput,
  ): AnalyticsTokenCategory {
    const tokenMeta = classifyToken(input.contractAddress, input.token, input.chain);
    const hasVerifiedCategory = this.hasVerifiedTokenCategory(
      input.contractAddress,
      input.token,
      input.chain,
    );
    const classifiedCategory = hasVerifiedCategory
      ? this.normalizeVerifiedCategory(tokenMeta.category)
      : this.classifyUnknownToken(input.marketSignal);

    this.logger.debug({
      token: input.token,
      liquidityUsd: input.marketSignal?.liquidityUsd ?? null,
      classifiedCategory,
    });

    return classifiedCategory;
  }

  private hasVerifiedTokenCategory(
    contractAddress: string | null | undefined,
    token: string | null | undefined,
    chain: SupportedChain,
  ): boolean {
    if (contractAddress) {
      const normalizedAddress = contractAddress.toLowerCase();

      if (TOKEN_CATEGORY_MAPS[chain][normalizedAddress]) {
        return true;
      }
    }

    if (!token) {
      return false;
    }

    const normalizedSymbol = token.toUpperCase();

    return Boolean(
      NATIVE_TOKEN_CATEGORIES[normalizedSymbol] ||
        MAJOR_SYMBOL_CATEGORY_FALLBACKS[normalizedSymbol],
    );
  }

  private normalizeVerifiedCategory(
    category: TokenCategory,
  ): AnalyticsTokenCategory {
    switch (category) {
      case TokenCategory.BLUE_CHIP:
      case TokenCategory.LST_LRT:
        return 'Blue Chip / L1';
      case TokenCategory.DEFI:
        return 'DeFi';
      case TokenCategory.STABLECOIN:
        return 'Stablecoin';
      case TokenCategory.AI_NARRATIVE:
        return 'AI';
      case TokenCategory.GAMING:
        return 'Gaming';
      case TokenCategory.MEMECOIN:
        return 'Memecoin';
      default:
        return 'Other';
    }
  }

  private classifyUnknownToken(
    marketSignal: TokenCategoryMarketSignal | undefined,
  ): AnalyticsTokenCategory {
    const liquidityUsd = marketSignal?.liquidityUsd ?? null;
    const hasLowOrMissingLiquidity =
      liquidityUsd === null || liquidityUsd < MEMECOIN_FALLBACK_LIQUIDITY_USD;
    const priceSources = this.normalizePriceSources(marketSignal?.priceSources);
    const hasDexScreenerOnlyPrice =
      priceSources.length === 1 && priceSources[0] === 'dexscreener';
    const hasMissingCoinGeckoPrice = !priceSources.includes('coingecko');

    if (
      hasLowOrMissingLiquidity &&
      (hasDexScreenerOnlyPrice || hasMissingCoinGeckoPrice)
    ) {
      return 'Memecoin';
    }

    return 'Other';
  }

  private buildTokenCategoryMarketSignals(
    portfolio: WalletPortfolioResponse,
  ): Map<string, TokenCategoryMarketSignal> {
    const signals = new Map<string, TokenCategoryMarketSignal>();

    for (const holding of portfolio) {
      const signal: TokenCategoryMarketSignal = {
        liquidityUsd: this.parseNullableNumber(holding.liquidityUsd),
        priceSources: this.normalizePriceSources(holding.priceSources),
      };

      for (const key of this.getTokenCategorySignalKeys(
        holding.token,
        holding.contractAddress,
      )) {
        signals.set(key, signal);
      }
    }

    return signals;
  }

  private getTokenCategoryMarketSignal(
    token: string,
    contractAddress: string | null | undefined,
    marketSignals: Map<string, TokenCategoryMarketSignal>,
  ): TokenCategoryMarketSignal | undefined {
    for (const key of this.getTokenCategorySignalKeys(token, contractAddress)) {
      const signal = marketSignals.get(key);

      if (signal) {
        return signal;
      }
    }

    return undefined;
  }

  private getTokenCategorySignalKeys(
    token: string,
    contractAddress?: string | null,
  ): string[] {
    const keys: string[] = [];

    if (contractAddress) {
      keys.push(`address:${contractAddress.toLowerCase()}`);
    }

    if (token.trim().length > 0) {
      keys.push(`symbol:${token.toUpperCase()}`);
    }

    return keys;
  }

  private computeSwapVolumeUsd<T extends Trade & { price?: number }>(
    trades: T[],
  ): number {
    return trades.reduce((maxVolume, trade) => {
      const tradeAmount = Number(trade.amount);
      const price = Number(trade.price ?? 0);

      if (!Number.isFinite(tradeAmount) || !Number.isFinite(price) || price <= 0) {
        return maxVolume;
      }

      return Math.max(maxVolume, price * tradeAmount);
    }, 0);
  }

  private buildCategoryPercentages(
    valuesByCategory: Map<string, number>,
    total: number,
  ): Record<AnalyticsTokenCategory, number> {
    return Object.fromEntries(
      TOKEN_CATEGORY_BUCKETS.map((category) => [
        category,
        total > 0
          ? this.roundDecimal(((valuesByCategory.get(category) ?? 0) / total) * 100)
          : 0,
      ]),
    ) as Record<AnalyticsTokenCategory, number>;
  }

  private resolveDominantCategory(
    percentages: Record<AnalyticsTokenCategory, number>,
  ): AnalyticsTokenCategory | null {
    if (percentages.Memecoin > 40) {
      return 'Memecoin';
    }

    const sortedCategories = TOKEN_CATEGORY_BUCKETS
      .filter((category) => category !== 'Other' || percentages.Other > 50)
      .sort((left, right) => percentages[right] - percentages[left]);
    const dominantCategory = sortedCategories[0] ?? null;

    if (!dominantCategory || percentages[dominantCategory] <= 0) {
      return null;
    }

    return dominantCategory;
  }

  private normalizePriceSources(sources: string[] | undefined): string[] {
    return (sources ?? [])
      .map((source) => source.trim().toLowerCase())
      .filter((source) => source.length > 0);
  }

  private parseNullableNumber(value: string | number | null | undefined): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  private isMetricEligibleTrade(
    trade: Trade,
    chain: SupportedChain,
  ): boolean {
    return !this.walletPricingService.isSpoofedMajorSymbol(
      trade.token,
      trade.contractAddress,
      chain,
    );
  }

  private isMetricEligibleHolding(
    holding: WalletPortfolioResponse[number],
    chain: SupportedChain,
  ): boolean {
    if (holding.tokenQualityLabel === 'spoofed_major_symbol') {
      return false;
    }

    return !this.walletPricingService.isSpoofedMajorSymbol(
      holding.token,
      holding.contractAddress,
      chain,
    );
  }

  private computeProfitFactor(realizedTrades: RealizedTradeMetrics[]): number {
    return this.computeProfitFactorFromValues(
      realizedTrades
        .filter((trade) => trade.pnl > 0)
        .map((trade) => this.roundDecimal(trade.pnl)),
      realizedTrades
        .filter((trade) => trade.pnl < 0)
        .map((trade) => this.roundDecimal(trade.pnl)),
    );
  }

  private computeProfitFactorFromValues(
    positivePnLTrades: number[],
    negativePnLTrades: number[],
  ): number {
    const totalPositivePnl = positivePnLTrades.reduce(
      (total, value) => total + value,
      0,
    );
    const totalNegativePnl = negativePnLTrades.reduce(
      (total, value) => total + Math.abs(value),
      0,
    );

    if (totalNegativePnl === 0) {
      if (totalPositivePnl > 0) {
        return 10;
      }

      return 0;
    }

    return this.roundDecimal(totalPositivePnl / totalNegativePnl);
  }

  private computeMaxDrawdown(realizedTrades: RealizedTradeMetrics[]): number {
    return this.computeMaxDrawdownFromCurve(
      this.buildCumulativePnLCurve(realizedTrades),
    );
  }

  private computeMaxDrawdownFromCurve(cumulativePnLCurve: number[]): number {
    let cumulativePnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;

    for (const point of cumulativePnLCurve) {
      cumulativePnl = this.roundDecimal(point);
      peakPnl = Math.max(peakPnl, cumulativePnl);
      maxDrawdown = Math.max(
        maxDrawdown,
        this.roundDecimal(peakPnl - cumulativePnl),
      );
    }

    return this.roundDecimal(maxDrawdown);
  }

  private buildCumulativePnLCurve(realizedTrades: RealizedTradeMetrics[]): number[] {
    let cumulativePnl = 0;

    return realizedTrades.map((trade) => {
      cumulativePnl = this.roundDecimal(cumulativePnl + trade.pnl);
      return cumulativePnl;
    });
  }

  private computePopulationStdDev(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance =
      values.reduce((total, value) => total + (value - mean) ** 2, 0) /
      values.length;

    return this.roundDecimal(Math.sqrt(variance));
  }

  private computeMedian(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const midpoint = Math.floor(values.length / 2);

    if (values.length % 2 === 1) {
      return this.roundDecimal(values[midpoint]);
    }

    return this.roundDecimal((values[midpoint - 1] + values[midpoint]) / 2);
  }

  private buildHoldBuckets(holdHours: number[]): WalletHoldTimeBuckets {
    const buckets = this.createEmptyHoldBuckets();

    for (const hours of holdHours) {
      if (hours < 1) {
        buckets.under1h += 1;
        continue;
      }

      if (hours < 24) {
        buckets.under24h += 1;
        continue;
      }

      if (hours < 24 * 7) {
        buckets.under7d += 1;
        continue;
      }

      buckets.over7d += 1;
    }

    return buckets;
  }

  private countActiveTradingDays(trades: Trade[]): number {
    return new Set(
      trades.map((trade) => new Date(trade.timestamp * 1000).toISOString().slice(0, 10)),
    ).size;
  }

  private buildTradeGapHours(trades: Trade[]): number[] {
    const gapHours: number[] = [];

    for (let index = 1; index < trades.length; index += 1) {
      gapHours.push(
        this.roundDecimal(
          (trades[index].timestamp - trades[index - 1].timestamp) / 3600,
        ),
      );
    }

    return gapHours;
  }

  private computeTradingSpanRatio(trades: Trade[]): number {
    if (trades.length < 2) {
      return 0;
    }

    const firstTradeTimestamp = trades[0].timestamp;
    const lastTradeTimestamp = trades[trades.length - 1].timestamp;
    const walletAgeSeconds = Math.max(
      Math.floor(Date.now() / 1000) - firstTradeTimestamp,
      0,
    );

    if (walletAgeSeconds === 0) {
      return 0;
    }

    return this.roundDecimal(
      (lastTradeTimestamp - firstTradeTimestamp) / walletAgeSeconds,
    );
  }

  private computeWalletAgeDays(trades: Trade[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const firstTradeTimestamp = trades[0].timestamp;
    const walletAgeSeconds = Math.max(
      Math.floor(Date.now() / 1000) - firstTradeTimestamp,
      0,
    );

    if (walletAgeSeconds === 0) {
      return 0;
    }

    return this.roundDecimal(walletAgeSeconds / (24 * 3600));
  }

  private createEmptyHoldBuckets(): WalletHoldTimeBuckets {
    return {
      under1h: 0,
      under24h: 0,
      under7d: 0,
      over7d: 0,
    };
  }

  private computeConcentrationRisk(portfolio: WalletPortfolioResponse): number {
    return this.computeConcentrationSnapshot(portfolio).concentrationRisk;
  }

  private computeConcentrationSnapshot(
    portfolio: WalletPortfolioResponse,
  ): PortfolioConcentrationSnapshot {
    let largestUsdValue = '0';
    let totalUsdValue = '0';

    for (const holding of portfolio) {
      if (!holding.usdValue) {
        continue;
      }

      totalUsdValue = this.addDecimalStrings(totalUsdValue, holding.usdValue);

      if (this.compareDecimalStrings(holding.usdValue, largestUsdValue) > 0) {
        largestUsdValue = holding.usdValue;
      }
    }

    const concentrationRisk = this.divideDecimalStrings(
      this.multiplyDecimalStrings(largestUsdValue, '100'),
      totalUsdValue,
      8,
    );

    return {
      largestHoldingUsd: largestUsdValue,
      totalPortfolioUsd: totalUsdValue,
      concentrationRisk: concentrationRisk
        ? this.toFiniteNumber(concentrationRisk)
        : 0,
    };
  }

  private multiplyDecimalStrings(left: string, right: string): string {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal || !rightDecimal) {
      return '0';
    }

    if (leftDecimal.value === 0n || rightDecimal.value === 0n) {
      return '0';
    }

    return this.formatScaledInteger(
      leftDecimal.value * rightDecimal.value,
      leftDecimal.scale + rightDecimal.scale,
    );
  }

  private addDecimalStrings(left: string, right: string): string {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal && !rightDecimal) {
      return '0';
    }

    if (!leftDecimal) {
      return rightDecimal
        ? this.formatScaledInteger(rightDecimal.value, rightDecimal.scale)
        : '0';
    }

    if (!rightDecimal) {
      return this.formatScaledInteger(leftDecimal.value, leftDecimal.scale);
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue = leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue = rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    return this.formatScaledInteger(leftValue + rightValue, scale);
  }

  private divideDecimalStrings(
    numerator: string,
    denominator: string,
    precision: number,
  ): string | null {
    const numeratorDecimal = this.parseDecimalString(numerator);
    const denominatorDecimal = this.parseDecimalString(denominator);

    if (
      !numeratorDecimal ||
      !denominatorDecimal ||
      denominatorDecimal.value === 0n
    ) {
      return null;
    }

    const scaledNumerator =
      numeratorDecimal.value *
      10n ** BigInt(denominatorDecimal.scale + Math.max(0, precision));
    const scaledDenominator =
      denominatorDecimal.value * 10n ** BigInt(numeratorDecimal.scale);

    if (scaledDenominator === 0n) {
      return null;
    }

    return this.formatScaledInteger(
      scaledNumerator / scaledDenominator,
      Math.max(0, precision),
    );
  }

  private compareDecimalStrings(left: string, right: string): number {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal && !rightDecimal) {
      return 0;
    }

    if (!leftDecimal) {
      return -1;
    }

    if (!rightDecimal) {
      return 1;
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue = leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue = rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    if (leftValue === rightValue) {
      return 0;
    }

    return leftValue > rightValue ? 1 : -1;
  }

  private parseDecimalString(value: string): { value: bigint; scale: number } | null {
    const normalizedValue = this.normalizeDecimalString(value);

    if (!normalizedValue) {
      return null;
    }

    const [wholePart, fractionalPart = ''] = normalizedValue.split('.');

    return {
      value: BigInt(`${wholePart}${fractionalPart}`),
      scale: fractionalPart.length,
    };
  }

  private normalizeDecimalString(value: string): string | null {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    const match = trimmedValue.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/);

    if (!match) {
      return null;
    }

    if (!/[eE]/.test(trimmedValue)) {
      return trimmedValue.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    }

    const [base, exponentValue] = trimmedValue.toLowerCase().split('e');
    const exponent = Number(exponentValue);

    if (!Number.isInteger(exponent)) {
      return null;
    }

    const [wholePart, fractionalPart = ''] = base.split('.');
    const digits = `${wholePart}${fractionalPart}`;
    const decimalIndex = wholePart.length + exponent;

    if (decimalIndex <= 0) {
      return `0.${'0'.repeat(-decimalIndex)}${digits}`.replace(/0+$/, '');
    }

    if (decimalIndex >= digits.length) {
      return `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
    }

    return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`.replace(
      /\.0+$|(\.\d*?)0+$/,
      '$1',
    );
  }

  private formatScaledInteger(value: bigint, scale: number): string {
    if (value === 0n) {
      return '0';
    }

    if (scale === 0) {
      return value.toString();
    }

    const digits = value.toString().padStart(scale + 1, '0');
    const wholePart = digits.slice(0, digits.length - scale);
    const fractionalPart = digits.slice(digits.length - scale).replace(/0+$/, '');

    if (!fractionalPart) {
      return wholePart;
    }

    return `${wholePart}.${fractionalPart}`;
  }

  private toFiniteNumber(value: string): number {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
      return 0;
    }

    return this.roundDecimal(parsedValue);
  }

  private roundDecimal(value: number, decimals = 12): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }
}