import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cache } from 'cache-manager';
import {
  CHAIN_PROFILES,
  SUPPORTED_CHAINS,
  SupportedChain,
} from '../../shared/constants/chains';
import {
  UnifiedClassificationResponse,
  UnifiedFeaturesResponse,
  UnifiedIntelligenceMetrics,
  UnifiedIntelligenceResponse,
  UnifiedScoreChainContribution,
  UnifiedScoreResponse,
  UnifiedWalletHolding,
  WalletClassification,
  WalletConfidenceLabel,
  WalletCumulativePnLEntry,
  WalletHoldTimeBuckets,
  WalletIntelligenceDexMetrics,
  WalletIntelligenceResponse,
  WalletIntelligenceRoiLabels,
  WalletIntelligenceRoiSampleWarnings,
  WalletIntelligenceSummary,
  WalletIntelligenceTokenCategories,
  WalletIntelligenceTrustSignals,
  WalletPortfolioSummary,
  WalletPricingCoverage,
  WalletScoreBand,
  WalletScoreDimensionBreakdown,
  WalletScoreExplanation,
  WalletScoreGateStatus,
  WalletScorePath,
  WalletTriageResponse,
} from '../wallet.types';
import { WalletAiService } from './wallet-ai.service';
import { WalletService } from './wallet.service';

interface ChainIntelligenceResult {
  chain: SupportedChain;
  data: WalletIntelligenceResponse;
}

interface ChainFetchFailure {
  chain: SupportedChain;
  message: string;
  timedOut: boolean;
}

interface UnifiedFetchState {
  hasSuccessfulChain: boolean;
}

type NumericWalletScore = WalletIntelligenceResponse['score'] & {
  score: number;
  scorePath: WalletScorePath;
  confidenceScore: number;
  breakdown: Record<string, WalletScoreDimensionBreakdown>;
  scoreExplanation: WalletScoreExplanation;
  gateStatus?: WalletScoreGateStatus;
  balancesAvailable?: boolean;
};

type UnifiedTriageScore = WalletIntelligenceResponse['score'] &
  Omit<WalletTriageResponse, 'reasoning' | 'confidenceReasoning'> & {
    reasoning?: string[];
    confidenceReasoning?: string[];
  };

interface ScoredChainIntelligenceResult extends ChainIntelligenceResult {
  data: WalletIntelligenceResponse & {
    score: NumericWalletScore;
  };
}

interface WeightedChainScore {
  chain: SupportedChain;
  data: ScoredChainIntelligenceResult['data'];
  weight: number;
  rawWeight: number;
}

@Injectable()
export class UnifiedIntelligenceService {
  private static readonly CACHE_TTL_SECONDS = 86_400;
  private static readonly CHAIN_TIMEOUT_MS = 60_000;
  private static readonly CHAIN_TIMEOUT_GRACE_MS = 15_000;
  private static readonly CHAIN_FETCH_STAGGER_MS = 500;
  private readonly logger = new Logger(UnifiedIntelligenceService.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly walletAiService: WalletAiService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async getUnifiedIntelligence(
    address: string,
  ): Promise<UnifiedIntelligenceResponse> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = `unified:${normalizedAddress}`;
    const cached = await this.getCachedUnified(cacheKey, normalizedAddress);

    if (cached) {
      return cached;
    }

    const fetchState: UnifiedFetchState = { hasSuccessfulChain: false };
    const chainFetches = await Promise.allSettled(
      SUPPORTED_CHAINS.map(async (chain, index) =>
        this.fetchChainIntelligenceWithStagger(
          normalizedAddress,
          chain,
          fetchState,
          index,
        ),
      ),
    );
    const successfulChains: ChainIntelligenceResult[] = [];
    const failures: ChainFetchFailure[] = [];

    chainFetches.forEach((result, index) => {
      const chain = SUPPORTED_CHAINS[index];

      if (result.status === 'fulfilled') {
        successfulChains.push({ chain, data: result.value });
        return;
      }

      failures.push({
        chain,
        message: this.getErrorMessage(result.reason),
        timedOut: this.isTimeoutError(result.reason),
      });
    });

    if (successfulChains.length === 0) {
      throw new BadGatewayException(
        'Unable to build unified intelligence because all chain data providers failed.',
      );
    }

    const perChain = this.buildPerChainMap(successfulChains);
    const totalPortfolioValueUsd = this.sumPortfolioValue(successfulChains);
    const visiblePortfolio = this.mergeHoldings(
      successfulChains,
      totalPortfolioValueUsd,
    );
    const portfolio = visiblePortfolio;
    const summary = this.buildUnifiedSummary(normalizedAddress, successfulChains);
    const metrics = this.buildUnifiedMetrics(
      successfulChains,
      totalPortfolioValueUsd,
    );
    const cumulativePnL = this.mergeCumulativePnL(successfulChains);
    const features = this.buildUnifiedFeatures(successfulChains, summary, portfolio);
    const score = this.computeUnifiedScore(
      normalizedAddress,
      successfulChains,
      totalPortfolioValueUsd,
    );
    const classification = this.computeUnifiedClassification(
      normalizedAddress,
      successfulChains,
    );
    const chainsAnalyzed = successfulChains.map(({ chain }) => chain);
    const chainsWithActivity = successfulChains
      .filter(({ data }) => this.hasChainActivity(data))
      .map(({ chain }) => chain);
    const chainErrors = this.buildChainErrors(failures);
    const chainsTimedOut = failures
      .filter((failure) => failure.timedOut)
      .map((failure) => failure.chain);
    const chainActivity = this.buildChainActivity(successfulChains, failures);
    const partialResult = failures.length > 0;
    const note = this.buildNote(failures);
    const context = this.buildUnifiedContext(successfulChains, classification);
    const portfolioSummary = this.buildUnifiedPortfolioSummary(
      successfulChains,
      portfolio,
      totalPortfolioValueUsd,
    );
    const responseWithoutAi: UnifiedIntelligenceResponse = {
      address: normalizedAddress,
      mode: 'unified',
      analyzedAt: new Date().toISOString(),
      chainsAnalyzed,
      chainsWithActivity,
      chainsTimedOut,
      chainErrors,
      chainActivity,
      partialResult,
      note,
      context,
      summary,
      metrics,
      score,
      classification,
      portfolio,
      visiblePortfolio,
      portfolioSummary,
      cumulativePnL,
      features,
      aiSummary: null,
      deepAnalysis: null,
      perChain,
    };
    const aiAnalysis = await this.walletAiService.generateUnifiedAnalysis(
      normalizedAddress,
      responseWithoutAi,
    );
    const fallbackAiAnalysis = this.buildFallbackAiAnalysis(
      successfulChains,
      aiAnalysis.aiSummary,
      aiAnalysis.deepAnalysis,
    );
    const response: UnifiedIntelligenceResponse = {
      ...responseWithoutAi,
      aiSummary: fallbackAiAnalysis.aiSummary,
      deepAnalysis: fallbackAiAnalysis.deepAnalysis,
    };

    await this.setCachedUnified(cacheKey, response, normalizedAddress);

    return response;
  }

  async clearUnifiedCache(address: string): Promise<void> {
    const normalizedAddress = address.toLowerCase();

    try {
      await this.cacheManager.del(`unified:${normalizedAddress}`);
    } catch (error) {
      this.logger.warn(
        `Failed to clear unified cache for ${normalizedAddress}: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private async fetchChainIntelligence(
    address: string,
    chain: SupportedChain,
    fetchState: UnifiedFetchState,
  ): Promise<WalletIntelligenceResponse> {
    const result = await this.withTimeout(
      this.walletService.getWalletIntelligence(
        address,
        { lite: false, verbose: false },
        chain,
      ) as Promise<WalletIntelligenceResponse>,
      UnifiedIntelligenceService.CHAIN_TIMEOUT_MS,
      UnifiedIntelligenceService.CHAIN_TIMEOUT_GRACE_MS,
      `${chain} chain timed out after ${UnifiedIntelligenceService.CHAIN_TIMEOUT_MS / 1000} seconds`,
      () => fetchState.hasSuccessfulChain,
    );

    fetchState.hasSuccessfulChain = true;

    return result;
  }

  private async fetchChainIntelligenceWithStagger(
    address: string,
    chain: SupportedChain,
    fetchState: UnifiedFetchState,
    chainIndex: number,
  ): Promise<WalletIntelligenceResponse> {
    const staggerDelayMs =
      chainIndex * UnifiedIntelligenceService.CHAIN_FETCH_STAGGER_MS;

    if (staggerDelayMs > 0) {
      await this.delay(staggerDelayMs);
    }

    return this.fetchChainIntelligence(address, chain, fetchState);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    graceMs: number,
    timeoutMessage: string,
    shouldUseGrace: () => boolean,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (shouldUseGrace()) {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`${timeoutMessage} plus ${graceMs / 1000} seconds grace`));
          }, graceMs);
          return;
        }

        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildPerChainMap(
    activeChains: ChainIntelligenceResult[],
  ): Record<SupportedChain, WalletIntelligenceResponse | null> {
    const perChain = Object.fromEntries(
      SUPPORTED_CHAINS.map((chain) => [chain, null]),
    ) as Record<SupportedChain, WalletIntelligenceResponse | null>;

    for (const { chain, data } of activeChains) {
      perChain[chain] = data;
    }

    return perChain;
  }

  private buildFallbackAiAnalysis(
    activeChains: ChainIntelligenceResult[],
    unifiedAiSummary: UnifiedIntelligenceResponse['aiSummary'],
    unifiedDeepAnalysis: UnifiedIntelligenceResponse['deepAnalysis'],
  ) {
    if (unifiedAiSummary || activeChains.length === 0) {
      return {
        aiSummary: unifiedAiSummary,
        deepAnalysis: unifiedDeepAnalysis,
      };
    }

    const dominantChain = [...activeChains].sort(
      (left, right) =>
        this.toNumber(right.data.portfolioSummary.totalPortfolioValueUsd) -
        this.toNumber(left.data.portfolioSummary.totalPortfolioValueUsd),
    )[0];

    return {
      aiSummary: dominantChain.data.aiSummary
        ? `[Based on ${dominantChain.chain} data] ${dominantChain.data.aiSummary}`
        : null,
      deepAnalysis: dominantChain.data.deepAnalysis ?? null,
    };
  }

  private mergeHoldings(
    activeChains: ChainIntelligenceResult[],
    totalPortfolioValueUsd: number,
  ): UnifiedWalletHolding[] {
    return activeChains
      .flatMap(({ chain, data }) =>
        (data.visiblePortfolio ?? []).map((holding) => {
          const usdValue = this.toNumber(holding.usdValue);
          const allocation =
            totalPortfolioValueUsd > 0
              ? ((usdValue / totalPortfolioValueUsd) * 100).toFixed(2)
              : '0.00';

          return {
            ...holding,
            allocation,
            chain,
            chainNativeSymbol: CHAIN_PROFILES[chain].nativeSymbol,
          };
        }),
      )
      .sort((left, right) =>
        this.toNumber(right.usdValue) - this.toNumber(left.usdValue),
      );
  }

  private buildUnifiedSummary(
    address: string,
    activeChains: ChainIntelligenceResult[],
  ): WalletIntelligenceSummary {
    return {
      address,
      total_transactions: this.sum(activeChains, 'summary.total_transactions'),
      total_swaps: this.sum(activeChains, 'summary.total_swaps'),
      total_transfers: this.sum(activeChains, 'summary.total_transfers'),
      tokens_interacted: this.sum(activeChains, 'summary.tokens_interacted'),
      totalRealizedPnL: this.round(
        this.sum(activeChains, 'summary.totalRealizedPnL'),
        2,
      ),
      avgWinRate: this.round(
        this.weightedAverage(
          activeChains,
          'summary.avgWinRate',
          'summary.total_swaps',
        ),
        2,
      ),
      bestTrade: this.round(this.max(activeChains, 'summary.bestTrade'), 4),
      worstTrade: this.round(this.min(activeChains, 'summary.worstTrade'), 4),
      profitableTokens: this.sum(activeChains, 'summary.profitableTokens'),
      losingTokens: this.sum(activeChains, 'summary.losingTokens'),
      averageTradeRoi: this.round(
        this.weightedAverage(
          activeChains,
          'summary.averageTradeRoi',
          'summary.total_swaps',
        ),
        4,
      ),
      averagePerTradeROI: this.round(
        this.weightedAverage(
          activeChains,
          'summary.averagePerTradeROI',
          'summary.total_swaps',
        ),
        4,
      ),
    };
  }

  private buildUnifiedMetrics(
    activeChains: ChainIntelligenceResult[],
    totalPortfolioValueUsd: number,
  ): UnifiedIntelligenceMetrics {
    const firstMetrics = activeChains[0]?.data.metrics;
    const realizedPnL = this.sum(activeChains, 'metrics.realizedPnL');
    const unrealizedPnL = this.sum(activeChains, 'metrics.unrealizedPnL');
    const netPnL = realizedPnL + unrealizedPnL;
    const capitalBase = this.sum(activeChains, 'metrics.capitalBase');
    const lifetimeTradeVolumeUsd = this.sum(
      activeChains,
      'metrics.lifetimeTradeVolumeUsd',
    );
    const lifetimeTradeCounted = this.sum(
      activeChains,
      'metrics.lifetimeTradeCounted',
    );
    const lifetimeTradeSkipped = this.sum(
      activeChains,
      'metrics.lifetimeTradeSkipped',
    );
    const pricingCoverage = this.mergePricingCoverage(activeChains);
    const roiSampleWarnings = this.buildUnifiedRoiWarnings(
      firstMetrics?.roiSampleWarnings,
    );
    const trustSignals = this.buildUnifiedTrustSignals(
      activeChains,
      pricingCoverage,
    );

    return {
      realizedRoi: this.round(
        this.weightedAverage(activeChains, 'metrics.realizedRoi', 'metrics.capitalBase'),
        4,
      ),
      averageTradeRoi: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.averageTradeRoi',
          'metrics.lifetimeTradeCounted',
        ),
        4,
      ),
      medianTradeRoi: null,
      unrealizedRoi: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.unrealizedRoi',
          'metrics.capitalBase',
        ),
        4,
      ),
      scoreAdjustedRoi: this.nullableWeightedAverage(
        activeChains,
        'metrics.scoreAdjustedRoi',
        'metrics.capitalBase',
      ),
      realizedCapitalROI: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.realizedCapitalROI',
          'metrics.capitalBase',
        ),
        4,
      ),
      averagePerTradeROI: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.averagePerTradeROI',
          'metrics.lifetimeTradeCounted',
        ),
        4,
      ),
      medianTradeROI: null,
      openPortfolioROI: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.openPortfolioROI',
          'metrics.capitalBase',
        ),
        4,
      ),
      scoreAdjustedROI: this.nullableWeightedAverage(
        activeChains,
        'metrics.scoreAdjustedROI',
        'metrics.capitalBase',
      ),
      realizedPnL: this.round(realizedPnL, 2),
      unrealizedPnL: this.round(unrealizedPnL, 2),
      netPnL: this.round(netPnL, 2),
      roiLabels: firstMetrics?.roiLabels ?? this.defaultRoiLabels(),
      pnlLabels: firstMetrics?.pnlLabels ?? this.defaultPnlLabels(),
      roiSampleWarnings,
      trustSignals,
      trustSignalLabels: firstMetrics?.trustSignalLabels ?? {
        confidence: 'Confidence',
        sampleSize: 'Sample Size',
        pricingCoverage: 'Pricing Coverage',
        warnings: 'Warnings',
      },
      capitalBase: this.round(capitalBase, 2),
      portfolioTotalValueUsd: this.round(totalPortfolioValueUsd, 2),
      lifetimeTradeVolumeUsd: this.round(lifetimeTradeVolumeUsd, 2),
      lifetimeTradeCounted,
      lifetimeTradeSkipped,
      lifetimeTradeConfidence: this.round(
        this.weightedAverage(
          activeChains,
          'metrics.lifetimeTradeConfidence',
          'metrics.lifetimeTradeCounted',
        ),
        2,
      ),
      roiConfidence: this.lowestConfidence(
        activeChains.map(({ data }) => data.metrics.roiConfidence),
      ),
      realizedCapitalRoiVisible: activeChains.some(
        ({ data }) => data.metrics.realizedCapitalRoiVisible,
      ),
      realizedCapitalRoiNotice:
        firstMetrics?.realizedCapitalRoiNotice ?? null,
      pricingCoverage,
      pricingCoverageNotice:
        'Unified pricing coverage combines priced and unpriced trades across analyzed chains.',
      unifiedNotices: [
        'Median ROI unavailable in unified view. Check per-chain breakdown for individual medians.',
      ],
    };
  }

  private mergeCumulativePnL(
    activeChains: ChainIntelligenceResult[],
  ): WalletCumulativePnLEntry[] {
    const allPoints = activeChains.flatMap(({ chain, data }) =>
      (data.cumulativePnL ?? []).map((point) => ({
        ...point,
        chain,
      })),
    );

    allPoints.sort(
      (left, right) =>
        new Date(left.date).getTime() - new Date(right.date).getTime(),
    );

    const chainRunningTotals = Object.fromEntries(
      SUPPORTED_CHAINS.map((chain) => [chain, 0]),
    ) as Record<SupportedChain, number>;
    const mergedByDate = new Map<string, number>();

    for (const point of allPoints) {
      chainRunningTotals[point.chain] = this.toNumber(point.pnl);
      mergedByDate.set(
        point.date,
        this.round(
          Object.values(chainRunningTotals).reduce(
            (sum, value) => sum + value,
            0,
          ),
          2,
        ),
      );
    }

    return Array.from(mergedByDate.entries()).map(([date, pnl]) => ({ date, pnl }));
  }

  private buildUnifiedFeatures(
    activeChains: ChainIntelligenceResult[],
    summary: WalletIntelligenceSummary,
    mergedHoldings: UnifiedWalletHolding[],
  ): UnifiedFeaturesResponse {
    const tokenCategories = this.buildUnifiedTokenCategories(activeChains);
    const dexMetrics = this.buildUnifiedDexMetrics(activeChains);

    return {
      summary,
      risk: {
        profitFactor: this.round(
          this.weightedAverage(
            activeChains,
            'features.risk.profitFactor',
            'summary.total_swaps',
          ),
          4,
        ),
        maxDrawdown: this.round(this.max(activeChains, 'features.risk.maxDrawdown'), 4),
        returnStdDev: this.round(this.max(activeChains, 'features.risk.returnStdDev'), 4),
        concentrationRisk: this.computeUnifiedConcentrationRisk(mergedHoldings),
      },
      holdTime: {
        avgHoldHours: this.round(
          this.weightedAverage(
            activeChains,
            'features.holdTime.avgHoldHours',
            'summary.total_swaps',
          ),
          2,
        ),
        medianHoldHours: null,
        holdBuckets: this.sumHoldBuckets(activeChains),
      },
      activity: {
        tradesPerActiveDay: this.round(
          this.sum(activeChains, 'features.activity.tradesPerActiveDay'),
          4,
        ),
        tradesPerLifetimeDay: this.round(
          this.sum(activeChains, 'features.activity.tradesPerLifetimeDay'),
          4,
        ),
        avgTradeGapHours: this.round(
          this.weightedAverage(
            activeChains,
            'features.activity.avgTradeGapHours',
            'summary.total_swaps',
          ),
          2,
        ),
        burstinessScore: this.round(
          this.weightedAverage(
            activeChains,
            'features.activity.burstinessScore',
            'summary.total_swaps',
          ),
          4,
        ),
        tradingSpanRatio: this.round(
          this.max(activeChains, 'features.activity.tradingSpanRatio'),
          4,
        ),
      },
      tokenCategories,
      dexMetrics,
    };
  }

  private buildUnifiedTokenCategories(
    activeChains: ChainIntelligenceResult[],
  ): WalletIntelligenceTokenCategories {
    const percentages = {
      memecoinPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.memecoinPercent',
          'summary.total_swaps',
        ),
        2,
      ),
      blueChipPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.blueChipPercent',
          'summary.total_swaps',
        ),
        2,
      ),
      defiPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.defiPercent',
          'summary.total_swaps',
        ),
        2,
      ),
      stablecoinPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.stablecoinPercent',
          'summary.total_swaps',
        ),
        2,
      ),
      l2Percent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.l2Percent',
          'summary.total_swaps',
        ),
        2,
      ),
      aiNarrativePercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.aiNarrativePercent',
          'summary.total_swaps',
        ),
        2,
      ),
      gamingPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.gamingPercent',
          'summary.total_swaps',
        ),
        2,
      ),
      otherPercent: this.round(
        this.weightedAverage(
          activeChains,
          'features.tokenCategories.otherPercent',
          'summary.total_swaps',
        ),
        2,
      ),
    };

    return {
      ...percentages,
      dominantCategory: this.getDominantTokenCategory(percentages),
      categoryDiversity: Object.values(percentages).filter((value) => value > 0).length,
      tradesByCategory: this.mergeCountRecords(
        activeChains,
        'features.tokenCategories.tradesByCategory',
      ),
    };
  }

  private buildUnifiedDexMetrics(
    activeChains: ChainIntelligenceResult[],
  ): WalletIntelligenceDexMetrics {
    const tradesPerDex = this.mergeCountRecords(
      activeChains,
      'features.dexMetrics.tradesPerDex',
    );
    const sortedDexes = Object.entries(tradesPerDex).sort(
      (left, right) => right[1] - left[1],
    );
    const totalDexTrades = sortedDexes.reduce(
      (sum, [, count]) => sum + count,
      0,
    );

    return {
      primaryDex: sortedDexes[0]?.[0] ?? 'Unknown',
      primaryDexShare:
        totalDexTrades > 0
          ? this.round(((sortedDexes[0]?.[1] ?? 0) / totalDexTrades) * 100, 2)
          : 0,
      dexDiversity: sortedDexes.filter(([dex]) => dex !== 'Unknown').length,
      tradesPerDex,
      unknownDexPercent:
        totalDexTrades > 0
          ? this.round(((tradesPerDex.Unknown ?? 0) / totalDexTrades) * 100, 2)
          : 0,
    };
  }

  private getDominantTokenCategory(
    percentages: Omit<WalletIntelligenceTokenCategories, 'dominantCategory' | 'categoryDiversity' | 'tradesByCategory'>,
  ): string {
    const categoryLabels: Record<keyof typeof percentages, string> = {
      memecoinPercent: 'Memecoin',
      blueChipPercent: 'Blue Chip / L1',
      defiPercent: 'DeFi',
      stablecoinPercent: 'Stablecoin',
      l2Percent: 'L2 / Infrastructure',
      aiNarrativePercent: 'AI',
      gamingPercent: 'Gaming',
      otherPercent: 'Other',
    };
    const [dominantKey, dominantPercent] = Object.entries(percentages).sort(
      (left, right) => right[1] - left[1],
    )[0] ?? [null, 0];

    if (!dominantKey || dominantPercent <= 0) {
      return 'Unknown';
    }

    return categoryLabels[dominantKey as keyof typeof percentages];
  }

  private mergeCountRecords(
    activeChains: ChainIntelligenceResult[],
    path: string,
  ): Record<string, number> {
    const merged: Record<string, number> = {};

    for (const { data } of activeChains) {
      const record = this.getPath(data, path);

      if (!record || typeof record !== 'object') {
        continue;
      }

      for (const [key, value] of Object.entries(record)) {
        merged[key] = (merged[key] ?? 0) + this.toNumber(value);
      }
    }

    return merged;
  }

  private computeUnifiedScore(
    address: string,
    activeChains: ChainIntelligenceResult[],
    totalPortfolioValueUsd: number,
  ): UnifiedScoreResponse {
    const totalSwaps = this.sum(activeChains, 'summary.total_swaps');
    const scoredChains = activeChains.filter(
      (result): result is ScoredChainIntelligenceResult =>
        this.hasNumericScore(result.data),
    );

    if (scoredChains.length === 0) {
      const bestTriageChain = [...activeChains]
        .filter(
          (result): result is ChainIntelligenceResult & {
            data: WalletIntelligenceResponse & { score: UnifiedTriageScore };
          } => this.hasTriageScore(result.data),
        )
        .sort(
          (left, right) =>
            this.toNumber(right.data.score.confidenceScore) -
            this.toNumber(left.data.score.confidenceScore),
        )[0];

      if (bestTriageChain) {
        const triageScore = bestTriageChain.data.score;
        const triageLabel = triageScore.walletSubtype ?? triageScore.walletType;

        return {
          address,
          score: null,
          scorePath: 'unified_triage',
          mode: 'unified',
          confidence: triageScore.confidence,
          confidenceLabel: triageScore.confidenceLabel,
          confidenceScore: triageScore.confidenceScore,
          confidenceReason: this.getScoreConfidenceReason(triageScore),
          confidenceReasoning: triageScore.confidenceReasoning ?? [],
          band: triageLabel ?? 'Not a Trader',
          breakdown: {},
          scoreExplanation: {
            positives: [],
            negatives: [],
            summary: `This is a ${triageLabel ?? 'non-trader entity'} on ${bestTriageChain.chain}. Trader scoring does not apply.`,
          },
          walletType: triageScore.walletType,
          walletSubtype: triageScore.walletSubtype,
          chainContributions: {
            [bestTriageChain.chain]: {
              score: null,
              weight: 1,
              swaps: 0,
              portfolio: bestTriageChain.data.portfolioSummary.totalPortfolioValueUsd,
            },
          },
          chainsContributing: [bestTriageChain.chain],
          gateStatus: 'Not a Trader Wallet',
          balancesAvailable: true,
          scoredAt: new Date().toISOString(),
          note: `Triage result from ${bestTriageChain.chain}: ${triageLabel}.`,
        };
      }

      return this.buildNoDataScore(address);
    }

    const weightedChains = this.buildWeightedScoreInputs(
      scoredChains,
      totalSwaps,
      totalPortfolioValueUsd,
    );
    const weightedScore = weightedChains.reduce((sum, item) => {
      return sum + this.toNumber(item.data.score.score) * item.weight;
    }, 0);
    const finalScore = Math.round(weightedScore);
    const dominant = [...weightedChains].sort(
      (left, right) => right.weight - left.weight,
    )[0];
    const band = this.resolveUnifiedScoreBand(
      finalScore,
      dominant?.data.score.scorePath,
    );
    const confidenceScore = Math.min(
      ...weightedChains.map(({ data }) => this.toNumber(data.score.confidenceScore)),
    );
    const confidence = this.confidenceFromScore(confidenceScore);
    const chainContributions = Object.fromEntries(
      weightedChains.map(({ chain, data, weight }) => [
        chain,
        {
          score: this.toNumber(data.score.score),
          weight: this.round(weight, 4),
          swaps: data.summary.total_swaps,
          portfolio: data.portfolioSummary.totalPortfolioValueUsd,
        } satisfies UnifiedScoreChainContribution,
      ]),
    ) as Partial<Record<SupportedChain, UnifiedScoreChainContribution>>;

    return {
      address,
      score: finalScore,
      scorePath: 'unified',
      mode: 'unified',
      confidence,
      confidenceLabel: confidence,
      confidenceScore,
      confidenceReason: `Unified confidence across ${weightedChains.length} chains. Weakest chain confidence determines overall.`,
      confidenceReasoning: [
        `Computed from ${weightedChains.length} scored chains using 60% activity weight and 40% portfolio weight.`,
      ],
      band,
      breakdown: this.mergeBreakdowns(weightedChains),
      scoreExplanation: this.mergeScoreExplanations(
        weightedChains,
        finalScore,
        band,
        chainContributions,
      ),
      chainContributions,
      chainsContributing: weightedChains.map(({ chain }) => chain),
      gateStatus: (dominant?.data.score.gateStatus ?? 'Unknown') as
        | WalletScoreGateStatus
        | 'Unknown',
      balancesAvailable: weightedChains.every(
        ({ data }) => data.score.balancesAvailable !== false,
      ),
      scoredAt: new Date().toISOString(),
    };
  }

  private computeUnifiedClassification(
    address: string,
    activeChains: ChainIntelligenceResult[],
  ): UnifiedClassificationResponse {
    const classifiedChains = activeChains.filter(({ data }) =>
      this.hasPrimaryClassification(data),
    );
    const traderChains = classifiedChains.filter(
      ({ data }) => data.context.isTraderWallet,
    );
    const holderChains = classifiedChains.filter(
      ({ data }) => !data.context.isTraderWallet,
    );
    const triagedChains = activeChains.filter(
      (result): result is ChainIntelligenceResult & {
        data: WalletIntelligenceResponse & { score: UnifiedTriageScore };
      } => this.hasTriageScore(result.data),
    );
    const perChainClassifications = this.buildPerChainClassifications(
      activeChains,
    );
    const primaryChain =
      traderChains.length > 0
        ? [...traderChains].sort(
            (left, right) =>
              right.data.summary.total_swaps - left.data.summary.total_swaps,
          )[0]
        : [...holderChains].sort(
            (left, right) =>
              right.data.portfolioSummary.totalPortfolioValueUsd -
              left.data.portfolioSummary.totalPortfolioValueUsd,
          )[0];

    if (!primaryChain || !this.hasPrimaryClassification(primaryChain.data)) {
      const bestTriage = [...triagedChains].sort(
        (left, right) =>
          this.toNumber(right.data.summary.total_transactions) -
          this.toNumber(left.data.summary.total_transactions),
      )[0];

      if (bestTriage) {
        const triageScore = bestTriage.data.score;
        const triageLabel = triageScore.walletSubtype ?? triageScore.walletType;

        return {
          address,
          type: triageLabel,
          primaryType: triageLabel,
          primaryScore: 0,
          confidence: triageScore.confidence,
          confidenceLabel: triageScore.confidenceLabel,
          confidenceScore: triageScore.confidenceScore,
          confidenceReason: this.getScoreConfidenceReason(triageScore),
          confidenceReasoning: triageScore.confidenceReasoning ?? [],
          description: `Identified as ${triageLabel} based on ${bestTriage.chain} on-chain analysis. Not a trader wallet.`,
          traits: [
            triageScore.walletType,
            triageScore.walletSubtype ?? 'Unknown subtype',
          ],
          riskProfile: 'conservative',
          secondaryTypes: [],
          scoreBreakdown: {},
          allScores: {},
          mode: 'unified',
          primaryChain: bestTriage.chain,
          classificationSource: 'triage',
          perChainClassifications,
          chainsAnalyzed: activeChains.map(({ chain }) => chain),
          classifiedAt: new Date().toISOString(),
        };
      }

      return this.buildUnclassifiedResponse(address, activeChains);
    }

    const primaryClassification = primaryChain.data.classification;
    const secondaryTypes = new Set<string>();

    for (const { chain, data } of classifiedChains) {
      if (!this.hasPrimaryClassification(data)) {
        continue;
      }

      perChainClassifications[chain] = data.classification.primaryType;

      if (
        chain !== primaryChain.chain &&
        data.classification.primaryType !== primaryClassification.primaryType
      ) {
        secondaryTypes.add(data.classification.primaryType);
      }
    }

    for (const secondaryType of primaryClassification.secondaryTypes ?? []) {
      if (secondaryType !== primaryClassification.primaryType) {
        secondaryTypes.add(secondaryType);
      }
    }

    const classificationSource =
      traderChains.length > 0 ? 'trading_activity' : 'portfolio_value';

    return {
      address,
      type: primaryClassification.type,
      primaryType: primaryClassification.primaryType,
      primaryScore: primaryClassification.primaryScore,
      confidence: primaryClassification.confidence,
      confidenceLabel: primaryClassification.confidenceLabel,
      confidenceScore: primaryClassification.confidenceScore,
      confidenceReason: primaryClassification.confidenceReason,
      confidenceReasoning: primaryClassification.confidenceReasoning ?? [],
      traits: primaryClassification.traits ?? [],
      riskProfile: primaryClassification.riskProfile,
      scoreBreakdown: primaryClassification.scoreBreakdown ?? {},
      allScores: primaryClassification.allScores ?? {},
      secondaryTypes: Array.from(secondaryTypes),
      mode: 'unified',
      primaryChain: primaryChain.chain,
      classificationSource,
      perChainClassifications,
      chainsAnalyzed: activeChains.map(({ chain }) => chain),
      description: this.buildUnifiedClassificationDescription(
        primaryChain,
        activeChains,
        classificationSource,
      ),
      classifiedAt: new Date().toISOString(),
    };
  }

  private buildUnifiedContext(
    activeChains: ChainIntelligenceResult[],
    classification: UnifiedClassificationResponse,
  ) {
    const primaryChain = classification.primaryChain
      ? activeChains.find(({ chain }) => chain === classification.primaryChain)
      : activeChains[0];
    const primaryContext = primaryChain?.data.context ?? activeChains[0].data.context;

    return {
      walletType: primaryContext.walletType,
      walletSubtype: primaryContext.walletSubtype,
      isTraderWallet: activeChains.some(({ data }) => data.context.isTraderWallet),
      classificationConfidence: this.toNumber(
        primaryContext.classificationConfidence,
      ),
      perChainWalletType: Object.fromEntries(
        activeChains.map(({ chain, data }) => [
          chain,
          {
            type: data.context.walletType,
            subtype: data.context.walletSubtype,
          },
        ]),
      ),
      reasoning: [
        `Unified context uses ${classification.primaryChain ?? activeChains[0].chain} as the dominant chain and checks trader behavior across all analyzed chains.`,
      ],
    };
  }

  private buildUnifiedPortfolioSummary(
    activeChains: ChainIntelligenceResult[],
    portfolio: UnifiedWalletHolding[],
    totalPortfolioValueUsd: number,
  ): WalletPortfolioSummary & { perChainValue: Record<SupportedChain, number> } {
    const perChainValue = Object.fromEntries(
      SUPPORTED_CHAINS.map((chain) => [
        chain,
        this.round(
          activeChains.find((result) => result.chain === chain)?.data
            .portfolioSummary.totalPortfolioValueUsd ?? 0,
          2,
        ),
      ]),
    ) as Record<SupportedChain, number>;
    const hiddenCount = this.sum(activeChains, 'portfolioSummary.hiddenCount');
    const spamCount = this.sum(activeChains, 'portfolioSummary.spamCount');
    const hiddenUsdValue = this.round(
      activeChains.reduce(
        (sum, { data }) =>
          sum + this.toNumber(data.portfolioSummary.hiddenUsdValue),
        0,
      ),
      2,
    );
    const chainBreakdown = Object.entries(perChainValue)
      .filter(([, value]) => value > 0)
      .map(([chain, value]) => `${chain}: $${value.toLocaleString('en-US')}`)
      .join(' · ');
    const activeChainCount = Object.values(perChainValue).filter(
      (value) => value > 0,
    ).length;
    const uiSummary = chainBreakdown
      ? `${portfolio.length} holdings across ${activeChainCount} chains · ${chainBreakdown}`
      : `${portfolio.length} holdings across ${activeChainCount} chains`;

    return {
      hiddenCount,
      hiddenUsdValue: hiddenUsdValue.toFixed(2),
      spamCount,
      uiSummary,
      totalPortfolioValueUsd: this.round(totalPortfolioValueUsd, 2),
      perChainValue,
    };
  }

  private buildWeightedScoreInputs(
    scoredChains: ScoredChainIntelligenceResult[],
    totalSwaps: number,
    totalPortfolioValueUsd: number,
  ): WeightedChainScore[] {
    const rawWeightedChains = scoredChains.map(({ chain, data }) => {
      const chainSwaps = data.summary.total_swaps;
      const chainPortfolio = data.portfolioSummary.totalPortfolioValueUsd;
      const swapWeight = totalSwaps > 0 ? chainSwaps / totalSwaps : 0;
      const portfolioWeight =
        totalPortfolioValueUsd > 0 ? chainPortfolio / totalPortfolioValueUsd : 0;
      const rawWeight = swapWeight * 0.6 + portfolioWeight * 0.4;

      return { chain, data, rawWeight };
    });
    const rawWeightTotal = rawWeightedChains.reduce(
      (sum, item) => sum + item.rawWeight,
      0,
    );

    if (rawWeightTotal <= 0) {
      const equalWeight = 1 / scoredChains.length;
      return rawWeightedChains.map((item) => ({
        ...item,
        weight: equalWeight,
      }));
    }

    return rawWeightedChains.map((item) => ({
      ...item,
      weight: item.rawWeight / rawWeightTotal,
    }));
  }

  private mergeBreakdowns(
    weightedChains: WeightedChainScore[],
  ): Record<string, unknown> {
    const scorePaths = new Set(
      weightedChains.map(({ data }) => data.score.scorePath),
    );

    if (scorePaths.size !== 1) {
      const dominant = [...weightedChains].sort(
        (left, right) => right.weight - left.weight,
      )[0];

      return {
        ...dominant.data.score.breakdown,
        _note: `Breakdown reflects ${dominant.chain} (dominant chain). Other chains used different scoring paths. See perChain for details.`,
      };
    }

    const dimensions = new Set<string>();

    for (const { data } of weightedChains) {
      Object.keys(data.score.breakdown ?? {}).forEach((dimension) => {
        dimensions.add(dimension);
      });
    }

    const merged: Record<string, WalletScoreDimensionBreakdown> = {};

    for (const dimension of dimensions) {
      let weightedScore = 0;
      let maxScore = 0;

      for (const { data, weight } of weightedChains) {
        const breakdown = data.score.breakdown as Record<
          string,
          WalletScoreDimensionBreakdown | undefined
        >;
        const dimensionBreakdown = breakdown[dimension];

        if (!dimensionBreakdown) {
          continue;
        }

        weightedScore += dimensionBreakdown.score * weight;
        maxScore = Math.max(maxScore, dimensionBreakdown.maxScore);
      }

      merged[dimension] = {
        score: Math.round(weightedScore),
        maxScore,
      };
    }

    return merged;
  }

  private mergeScoreExplanations(
    weightedChains: WeightedChainScore[],
    finalScore: number,
    band: WalletScoreBand,
    chainContributions: Partial<Record<SupportedChain, UnifiedScoreChainContribution>>,
  ) {
    const positives = this.deduplicate(
      weightedChains.flatMap(
        ({ data }) => data.score.scoreExplanation?.positives ?? [],
      ),
    );
    const negatives = this.deduplicate(
      weightedChains.flatMap(
        ({ data }) => data.score.scoreExplanation?.negatives ?? [],
      ),
    );

    const dominantContribution = Object.entries(chainContributions).sort(
      ([, left], [, right]) => (right?.weight ?? 0) - (left?.weight ?? 0),
    )[0];
    const dominantSummary = dominantContribution
      ? `${dominantContribution[0]} contributed ${((dominantContribution[1]?.weight ?? 0) * 100).toFixed(0)}% of the score weight (${dominantContribution[1]?.swaps ?? 0} swaps, $${(dominantContribution[1]?.portfolio ?? 0).toFixed(2)} portfolio).`
      : 'No dominant chain contribution was available.';

    return {
      positives,
      negatives,
      summary: `Unified score of ${finalScore}/100 (${band}) across ${weightedChains.length} chains. ${dominantSummary}`,
    };
  }

  private buildUnifiedClassificationDescription(
    primaryChain: ChainIntelligenceResult,
    activeChains: ChainIntelligenceResult[],
    source: 'trading_activity' | 'portfolio_value',
  ): string {
    if (!this.hasPrimaryClassification(primaryChain.data)) {
      return 'No trading or holding classification was available across supported chains.';
    }

    const primary = primaryChain.data.classification;
    const chainList = activeChains.map(({ chain }) => chain).join(', ');
    const totalSwaps = this.sum(activeChains, 'summary.total_swaps');

    if (source === 'trading_activity') {
      return `Classified as ${primary.primaryType} based on ${primaryChain.chain} behavior (${primaryChain.data.summary.total_swaps} of ${totalSwaps} total swaps across ${chainList}). ${primary.description ?? ''}`.trim();
    }

    return `Classified as ${primary.primaryType} based on ${primaryChain.chain} holdings ($${primaryChain.data.portfolioSummary.totalPortfolioValueUsd.toFixed(2)} portfolio). No trading activity detected on ${chainList}. ${primary.description ?? ''}`.trim();
  }

  private buildUnclassifiedResponse(
    address: string,
    activeChains: ChainIntelligenceResult[],
  ): UnifiedClassificationResponse {
    return {
      address,
      type: 'Unclassified',
      primaryType: 'Unclassified',
      primaryScore: 0,
      confidence: 'low',
      confidenceLabel: 'low',
      confidenceScore: 0,
      confidenceReason: 'No trading or holding activity detected across supported chains.',
      confidenceReasoning: [],
      description: 'No trading or holding activity detected across any supported chain.',
      traits: [],
      riskProfile: 'moderate',
      secondaryTypes: [],
      scoreBreakdown: {},
      allScores: {},
      classifiedAt: new Date().toISOString(),
      mode: 'unified',
      primaryChain: null,
      classificationSource: 'no_data',
      perChainClassifications: {},
      chainsAnalyzed: activeChains.map(({ chain }) => chain),
    };
  }

  private buildNoDataScore(address: string): UnifiedScoreResponse {
    return {
      address,
      score: null,
      scorePath: 'unified_no_data',
      mode: 'unified',
      confidence: 'low',
      confidenceLabel: 'low',
      confidenceScore: 0,
      confidenceReason: 'No scored trading or holding behavior was available across chains.',
      confidenceReasoning: [],
      band: 'Unscored',
      breakdown: {},
      scoreExplanation: {
        positives: [],
        negatives: ['No trading activity detected across any supported chain.'],
        summary: 'No trading activity detected across any supported chain.',
      },
      chainContributions: {},
      chainsContributing: [],
      gateStatus: 'No Trading Activity',
      balancesAvailable: true,
      scoredAt: new Date().toISOString(),
      note: 'No trading activity detected across any chain.',
    };
  }

  private buildUnifiedRoiWarnings(
    sourceWarnings?: WalletIntelligenceRoiSampleWarnings,
  ): WalletIntelligenceRoiSampleWarnings {
    const medianNotice =
      'Median ROI unavailable in unified view. Check per-chain breakdown for individual medians.';

    return {
      realizedRoi: sourceWarnings?.realizedRoi ?? null,
      averageTradeRoi: sourceWarnings?.averageTradeRoi ?? null,
      medianTradeRoi: medianNotice,
      unrealizedRoi: sourceWarnings?.unrealizedRoi ?? null,
      scoreAdjustedRoi: sourceWarnings?.scoreAdjustedRoi ?? null,
      realizedCapitalROI: sourceWarnings?.realizedCapitalROI ?? null,
      averagePerTradeROI: sourceWarnings?.averagePerTradeROI ?? null,
      medianTradeROI: medianNotice,
      openPortfolioROI: sourceWarnings?.openPortfolioROI ?? null,
      scoreAdjustedROI: sourceWarnings?.scoreAdjustedROI ?? null,
    };
  }

  private buildUnifiedTrustSignals(
    activeChains: ChainIntelligenceResult[],
    pricingCoverage: WalletPricingCoverage,
  ): WalletIntelligenceTrustSignals {
    const warnings = this.deduplicate(
      activeChains.flatMap(({ data }) => data.metrics.trustSignals.warnings ?? []),
    );

    return {
      confidence: this.lowestConfidence(
        activeChains.map(({ data }) => data.metrics.trustSignals.confidence),
      ),
      sampleSize: {
        totalSwaps: this.sum(activeChains, 'metrics.trustSignals.sampleSize.totalSwaps'),
        pricedTrades: this.sum(
          activeChains,
          'metrics.trustSignals.sampleSize.pricedTrades',
        ),
        minimumRecommendedSwaps: Math.max(
          ...activeChains.map(({ data }) =>
            this.toNumber(
              data.metrics.trustSignals.sampleSize.minimumRecommendedSwaps,
            ),
          ),
        ),
        minimumRecommendedPricedTrades: Math.max(
          ...activeChains.map(({ data }) =>
            this.toNumber(
              data.metrics.trustSignals.sampleSize.minimumRecommendedPricedTrades,
            ),
          ),
        ),
      },
      pricingCoverage,
      warnings,
    };
  }

  private mergePricingCoverage(
    activeChains: ChainIntelligenceResult[],
  ): WalletPricingCoverage {
    const totalTrades = this.sum(activeChains, 'metrics.pricingCoverage.totalTrades');
    const pricedTrades = this.sum(activeChains, 'metrics.pricingCoverage.pricedTrades');
    const unpricedTrades = this.sum(activeChains, 'metrics.pricingCoverage.unpricedTrades');
    const providerStatus: WalletPricingCoverage['providerStatus'] = {
      defillama: this.mergeProviderStatus(activeChains, 'defillama'),
      coingecko: this.mergeProviderStatus(activeChains, 'coingecko'),
      dexscreener: this.mergeProviderStatus(activeChains, 'dexscreener'),
    };
    const cooldownUntil: WalletPricingCoverage['cooldownUntil'] = {
      defillama: this.latestCooldown(activeChains, 'defillama'),
      coingecko: this.latestCooldown(activeChains, 'coingecko'),
      dexscreener: this.latestCooldown(activeChains, 'dexscreener'),
    };

    return {
      totalTrades,
      pricedTrades,
      unpricedTrades,
      coveragePercent:
        totalTrades > 0 ? this.round((pricedTrades / totalTrades) * 100, 2) : 0,
      unsupportedTokens: this.deduplicate(
        activeChains.flatMap(
          ({ data }) => data.metrics.pricingCoverage.unsupportedTokens ?? [],
        ),
      ),
      requestsBlockedCount: this.sum(
        activeChains,
        'metrics.pricingCoverage.requestsBlockedCount',
      ),
      providerStatus,
      cooldownUntil,
    };
  }

  private sumHoldBuckets(
    activeChains: ChainIntelligenceResult[],
  ): WalletHoldTimeBuckets {
    return {
      under1h: this.sum(activeChains, 'features.holdTime.holdBuckets.under1h'),
      under24h: this.sum(activeChains, 'features.holdTime.holdBuckets.under24h'),
      under7d: this.sum(activeChains, 'features.holdTime.holdBuckets.under7d'),
      over7d: this.sum(activeChains, 'features.holdTime.holdBuckets.over7d'),
    };
  }

  private computeUnifiedConcentrationRisk(
    holdings: UnifiedWalletHolding[],
  ): number {
    const usdValues = holdings.map((holding) => this.toNumber(holding.usdValue));
    const totalUsd = usdValues.reduce((sum, value) => sum + value, 0);

    if (totalUsd <= 0) {
      return 0;
    }

    return this.round(Math.max(...usdValues) / totalUsd, 4);
  }

  private sumPortfolioValue(activeChains: ChainIntelligenceResult[]): number {
    return activeChains.reduce(
      (sum, { data }) => sum + this.toNumber(data.portfolioSummary.totalPortfolioValueUsd),
      0,
    );
  }

  private hasChainActivity(data: WalletIntelligenceResponse): boolean {
    return (
      data.summary.total_transactions > 0 ||
      data.visiblePortfolio.length > 0 ||
      data.portfolioSummary.totalPortfolioValueUsd > 0
    );
  }

  private buildChainErrors(
    failures: ChainFetchFailure[],
  ): Partial<Record<SupportedChain, string>> {
    return Object.fromEntries(
      failures.map(({ chain, message }) => [chain, message]),
    ) as Partial<Record<SupportedChain, string>>;
  }

  private buildChainActivity(
    activeChains: ChainIntelligenceResult[],
    failures: ChainFetchFailure[],
  ): Record<SupportedChain, 'active_trader' | 'active_holder' | 'empty' | 'failed'> {
    const result = Object.fromEntries(
      SUPPORTED_CHAINS.map((chain) => [chain, 'failed']),
    ) as Record<SupportedChain, 'active_trader' | 'active_holder' | 'empty' | 'failed'>;

    for (const { chain, data } of activeChains) {
      result[chain] = this.getChainActivity(data);
    }

    for (const failure of failures) {
      result[failure.chain] = 'failed';
    }

    return result;
  }

  private getChainActivity(
    data: WalletIntelligenceResponse,
  ): 'active_trader' | 'active_holder' | 'empty' {
    const transactions = data.summary.total_transactions ?? 0;
    const swaps = data.summary.total_swaps ?? 0;
    const portfolio = data.portfolioSummary.totalPortfolioValueUsd ?? 0;

    if (swaps > 0) {
      return 'active_trader';
    }

    if (transactions > 0 || portfolio > 0) {
      return 'active_holder';
    }

    return 'empty';
  }

  private buildNote(failures: ChainFetchFailure[]): string | null {
    if (failures.length === 0) {
      return null;
    }

    const failedChains = failures.map(({ chain }) => chain).join(', ');

    return `${failedChains} ${failures.length === 1 ? 'chain was' : 'chains were'} excluded from unified results.`;
  }

  private hasPrimaryClassification(
    data: WalletIntelligenceResponse,
  ): data is WalletIntelligenceResponse & {
    classification: WalletClassification;
  } {
    return (
      'primaryType' in data.classification &&
      typeof data.classification.primaryType === 'string' &&
      data.classification.primaryType.length > 0
    );
  }

  private buildPerChainClassifications(
    activeChains: ChainIntelligenceResult[],
  ): Partial<Record<SupportedChain, string>> {
    const perChainClassifications: Partial<Record<SupportedChain, string>> = {};

    for (const { chain, data } of activeChains) {
      if (this.hasPrimaryClassification(data)) {
        perChainClassifications[chain] = data.classification.primaryType;
        continue;
      }

      if (this.hasTriageScore(data)) {
        perChainClassifications[chain] =
          data.score.walletSubtype ?? data.score.walletType;
      }
    }

    return perChainClassifications;
  }

  private hasNumericScore(
    data: WalletIntelligenceResponse,
  ): data is ScoredChainIntelligenceResult['data'] {
    return (
      typeof data.score.score === 'number' &&
      Number.isFinite(data.score.score) &&
      'breakdown' in data.score &&
      'scoreExplanation' in data.score
    );
  }

  private hasTriageScore(
    data: WalletIntelligenceResponse,
  ): data is WalletIntelligenceResponse & { score: UnifiedTriageScore } {
    return (
      typeof data.score.scorePath === 'string' &&
      data.score.scorePath.startsWith('triage') &&
      'walletType' in data.score &&
      typeof data.score.walletType === 'string'
    );
  }

  private getScoreConfidenceReason(
    score: WalletIntelligenceResponse['score'],
  ): string {
    if ('confidenceReason' in score && typeof score.confidenceReason === 'string') {
      return score.confidenceReason;
    }

    return score.confidenceReasoning?.join(' ') ?? '';
  }

  private resolveUnifiedScoreBand(
    score: number,
    dominantScorePath?: WalletScorePath,
  ): WalletScoreBand {
    if (dominantScorePath === 'holder') {
      if (score >= 91) return 'Institutional';
      if (score >= 76) return 'Premium';
      if (score >= 61) return 'Strong';
      if (score >= 41) return 'Solid';
      if (score >= 21) return 'Basic';
      return 'Dormant';
    }

    if (score >= 91) return 'Exceptional';
    if (score >= 76) return 'Elite';
    if (score >= 61) return 'Skilled';
    if (score >= 41) return 'Capable';
    if (score >= 21) return 'Developing';
    return 'Unproven';
  }

  private confidenceFromScore(score: number): WalletConfidenceLabel {
    if (score >= 70) {
      return 'high';
    }

    if (score >= 40) {
      return 'medium';
    }

    return 'low';
  }

  private lowestConfidence(labels: WalletConfidenceLabel[]): WalletConfidenceLabel {
    const rank: Record<WalletConfidenceLabel, number> = {
      low: 0,
      medium: 1,
      high: 2,
    };
    const lowest = labels.reduce<WalletConfidenceLabel>((current, label) =>
      rank[label] < rank[current] ? label : current,
    'high');

    return lowest;
  }

  private mergeProviderStatus(
    activeChains: ChainIntelligenceResult[],
    provider: string,
  ): 'active' | 'cooldown' {
    return activeChains.some(
      ({ data }) => data.metrics.pricingCoverage.providerStatus[provider] === 'cooldown',
    )
      ? 'cooldown'
      : 'active';
  }

  private latestCooldown(
    activeChains: ChainIntelligenceResult[],
    provider: string,
  ): string | null {
    const timestamps = activeChains
      .map(({ data }) => data.metrics.pricingCoverage.cooldownUntil[provider])
      .filter((value): value is string => typeof value === 'string');

    if (timestamps.length === 0) {
      return null;
    }

    return timestamps.sort().at(-1) ?? null;
  }

  private sum(
    activeChains: ChainIntelligenceResult[],
    path: string,
  ): number {
    return activeChains.reduce(
      (total, { data }) => total + this.toNumber(this.getPath(data, path)),
      0,
    );
  }

  private weightedAverage(
    activeChains: ChainIntelligenceResult[],
    metricPath: string,
    weightPath: string,
  ): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const { data } of activeChains) {
      const metric = this.toNumber(this.getPath(data, metricPath));
      const weight = this.toNumber(this.getPath(data, weightPath));

      if (weight <= 0) {
        continue;
      }

      weightedSum += metric * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  private nullableWeightedAverage(
    activeChains: ChainIntelligenceResult[],
    metricPath: string,
    weightPath: string,
  ): number | null {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const { data } of activeChains) {
      const metric = this.toNullableNumber(this.getPath(data, metricPath));
      const weight = this.toNumber(this.getPath(data, weightPath));

      if (metric === null || weight <= 0) {
        continue;
      }

      weightedSum += metric * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? this.round(weightedSum / totalWeight, 4) : null;
  }

  private max(activeChains: ChainIntelligenceResult[], path: string): number {
    const values = activeChains.map(({ data }) => this.toNumber(this.getPath(data, path)));

    return values.length > 0 ? Math.max(...values) : 0;
  }

  private min(activeChains: ChainIntelligenceResult[], path: string): number {
    const values = activeChains.map(({ data }) => this.toNumber(this.getPath(data, path)));

    return values.length > 0 ? Math.min(...values) : 0;
  }

  private getPath(source: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, segment) => {
      if (
        current &&
        typeof current === 'object' &&
        segment in current
      ) {
        return (current as Record<string, unknown>)[segment];
      }

      return undefined;
    }, source);
  }

  private toNumber(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toNullableNumber(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  private round(value: number, decimals: number): number {
    const factor = 10 ** decimals;

    return Math.round(value * factor) / factor;
  }

  private deduplicate(values: string[]): string[] {
    return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
  }

  private defaultRoiLabels(): WalletIntelligenceRoiLabels {
    return {
      realizedRoi: 'Realized ROI',
      averageTradeRoi: 'Average Trade ROI',
      medianTradeRoi: 'Median Trade ROI',
      unrealizedRoi: 'Unrealized ROI',
      scoreAdjustedRoi: 'Score-adjusted ROI',
      realizedCapitalROI: 'Realized ROI',
      averagePerTradeROI: 'Average Trade ROI',
      medianTradeROI: 'Median Trade ROI',
      openPortfolioROI: 'Unrealized ROI',
      scoreAdjustedROI: 'Score-adjusted ROI',
    };
  }

  private defaultPnlLabels() {
    return {
      realizedPnL: 'Realized PnL',
      unrealizedPnL: 'Unrealized PnL',
      netPnL: 'Net PnL',
    };
  }

  private async getCachedUnified(
    cacheKey: string,
    address: string,
  ): Promise<UnifiedIntelligenceResponse | null> {
    try {
      const cached = await this.cacheManager.get<UnifiedIntelligenceResponse>(
        cacheKey,
      );

      if (cached) {
        this.logger.debug(`Unified intelligence cache hit for ${address}`);
        return cached;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to read unified cache for ${address}: ${this.getErrorMessage(error)}`,
      );
    }

    return null;
  }

  private async setCachedUnified(
    cacheKey: string,
    value: UnifiedIntelligenceResponse,
    address: string,
  ): Promise<void> {
    try {
      await this.cacheManager.set(
        cacheKey,
        value,
        UnifiedIntelligenceService.CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to cache unified intelligence for ${address}: ${this.getErrorMessage(error)}`,
      );
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private isTimeoutError(error: unknown): boolean {
    return this.getErrorMessage(error).toLowerCase().includes('timed out');
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
