import { Injectable } from '@nestjs/common';
import {
  Trade,
  WalletActivityMetricsResponse,
  WalletClassificationResult,
  WalletIntelligenceClassification,
  WalletIntelligenceContext,
  WalletIntelligenceFeatures,
  WalletIntelligence,
  WalletIntelligenceLiteResponse,
  WalletIntelligenceMetrics,
  WalletIntelligenceOptions,
  WalletIntelligenceResponse,
  WalletIntelligenceResult,
  WalletIntelligenceScore,
  WalletIntelligenceSummary,
  WalletPortfolioSummary,
  WalletContextResponse,
  WalletDexMetricsResult,
  WalletFeaturesResponse,
  WalletHoldingsResponse,
  WalletHoldTimeMetricsResponse,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsResponse,
  WalletRiskMetricsResult,
  WalletScoreOrTriageResult,
  StoredWalletTransactionsResponse,
  WalletSummaryResponse,
  WalletTokenCategoryMetricsResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { ClassificationService } from './classification.service';
import { WalletContextService } from './wallet-context.service';
import { WalletCoreService } from './wallet-core.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';
import { PricedTrade, WalletPricingService } from './wallet-pricing.service';
import { WalletAiService } from './wallet-ai.service';
import { WalletScoringService } from './scoring.service';
import { WalletTriageService } from './wallet-triage.service';

@Injectable()
export class WalletService {
  private static readonly INTELLIGENCE_CACHE_TTL_MS = 90_000;
  private static readonly LIFETIME_VOLUME_MIN_RECEIVE_AMOUNT = 1e-9;
  private static readonly LIFETIME_VOLUME_ABSURD_UNIT_PRICE_USD = 1_000_000_000;
  private static readonly LIFETIME_VOLUME_SUPPLY_DISTORTION_AMOUNT =
    1_000_000_000_000;
  private static readonly LIFETIME_VOLUME_TINY_LIQUIDITY_NOTIONAL_USD = 250_000;
  private static readonly LIFETIME_VOLUME_SANITY_CAP_MULTIPLIER = 20;
  private static readonly VISIBLE_PORTFOLIO_MATERIAL_VALUE_USD = 100;
  private static readonly VISIBLE_PORTFOLIO_MATERIAL_ALLOCATION_PERCENT = 0.5;
  private static readonly VISIBLE_PORTFOLIO_TOP_MEANINGFUL_LIMIT = 12;
  private static readonly VISIBLE_PORTFOLIO_MAJOR_SYMBOLS = new Set([
    'ETH',
    'WETH',
    'BTC',
    'WBTC',
    'USDC',
    'USDT',
    'DAI',
    'USDE',
    'USDS',
    'USDB',
    'STETH',
    'WSTETH',
    'CBETH',
    'RETH',
    'LINK',
    'UNI',
    'AAVE',
    'LDO',
    'OP',
    'ARB',
    'MKR',
  ]);
  private readonly intelligenceCache = new Map<
    string,
    { expiresAt: number; value: WalletIntelligenceResult }
  >();

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPricingService: WalletPricingService,
    private readonly walletPortfolioService: WalletPortfolioService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
    private readonly walletContextService: WalletContextService,
    private readonly walletScoringService: WalletScoringService,
    private readonly classificationService: ClassificationService,
    private readonly walletTriageService: WalletTriageService,
    private readonly walletAiService: WalletAiService,
  ) {}

  async getWalletData(address: string): Promise<WalletTransactionsResponse> {
    return this.walletCoreService.getWalletData(address);
  }

  async getStoredTransactions(
    address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    return this.walletCoreService.getStoredTransactions(address);
  }

  async getTrades(address: string): Promise<Trade[]> {
    return this.walletPnlService.getTrades(address);
  }

  async getPricedTrades(address: string) {
    return this.walletPnlService.getPricedTrades(address);
  }

  async getPnL(address: string): Promise<WalletPnLResponse> {
    return this.walletPnlService.getPnL(address);
  }

  async getWalletSummary(address: string): Promise<WalletSummaryResponse> {
    return this.walletPnlService.getWalletSummary(address);
  }

  async getWalletFeatures(address: string): Promise<WalletFeaturesResponse> {
    const [summary, riskMetrics, holdTime, activity] = await Promise.all([
      this.getWalletSummary(address),
      this.getRiskMetrics(address),
      this.getHoldTimeMetrics(address),
      this.getActivityMetrics(address),
    ]);

    return {
      summary,
      risk: {
        profitFactor: riskMetrics.profitFactor,
        maxDrawdown: riskMetrics.maxDrawdown,
        returnStdDev: riskMetrics.returnStdDev,
        concentrationRisk: riskMetrics.concentrationRisk,
      },
      holdTime,
      activity,
    };
  }

  async getWalletIntelligence(
    address: string,
    options: WalletIntelligenceOptions = {},
  ): Promise<WalletIntelligenceResult> {
    const normalizedAddress = address.toLowerCase();
    const lite = options.lite === true;
    const verbose = options.verbose === true;
    const cacheKey = this.buildIntelligenceCacheKey({
      address: normalizedAddress,
      lite,
      verbose,
    });
    const cached = this.getCachedIntelligence(cacheKey);

    if (cached) {
      return cached;
    }

    const analyzedAt = new Date().toISOString();

    if (lite) {
      const [summary, litePortfolio] = await Promise.all([
        this.walletPnlService.getWalletSummary(normalizedAddress),
        this.walletPortfolioService.getPortfolio(normalizedAddress),
      ]);
      const triage = await this.walletTriageService.getWalletTriage(
        normalizedAddress,
        { summary },
      );
      const intelligenceSummary = this.buildIntelligenceSummary(summary);
      const metrics = await this.buildRoiMetrics(
        normalizedAddress,
        summary,
        litePortfolio,
      );

      const [score, classification] =
        triage && !triage.traderEligible
          ? ([triage, triage] as [
              WalletScoreOrTriageResult,
              WalletClassificationResult,
            ])
          : await Promise.all([
              this.walletScoringService.getWalletScore(normalizedAddress),
              this.classificationService.getClassification(normalizedAddress),
            ]);

      const response: WalletIntelligenceLiteResponse = {
        address: summary.address,
        analyzedAt,
        summary: intelligenceSummary,
        metrics,
        score: this.shapeScoreByVerbosity(score, verbose),
        classification: this.shapeClassificationByVerbosity(
          classification,
          verbose,
        ),
      };

      this.setCachedIntelligence(cacheKey, response);
      return response;
    }

    const [summary, activity, holdTime, riskMetrics, fullPortfolio] =
      await Promise.all([
        this.walletPnlService.getWalletSummary(normalizedAddress),
        this.walletAnalyticsService.getActivityMetrics(normalizedAddress),
        this.walletAnalyticsService.getHoldTimeMetrics(normalizedAddress),
        this.walletAnalyticsService.getRiskMetrics(normalizedAddress),
        this.walletPortfolioService.getPortfolio(normalizedAddress),
      ]);
    const metrics = await this.buildRoiMetrics(
      normalizedAddress,
      summary,
      fullPortfolio,
      riskMetrics,
    );
    const portfolioSummary = this.buildPortfolioSummary(fullPortfolio, metrics);
    const visiblePortfolio = this.buildVisiblePortfolio(fullPortfolio);
    const visiblePortfolioKeys = new Set(
      visiblePortfolio.map((item) => this.getPortfolioItemIdentity(item)),
    );
    const speculativePortfolio = fullPortfolio.filter(
      (item) =>
        item.tokenQualityLabel === 'speculative' ||
        item.displayTier === 'active' ||
        item.displayTier === 'secondary',
    );
    const topSpeculativePortfolio = this.selectTopSpeculativePortfolio(
      speculativePortfolio.filter(
        (item) =>
          !visiblePortfolioKeys.has(this.getPortfolioItemIdentity(item)),
      ),
      12,
    );
    const defaultPortfolio = [...visiblePortfolio, ...topSpeculativePortfolio];
    const hiddenPortfolio = fullPortfolio.filter(
      (item) => item.displayTier === 'hidden',
    );
    const triage = await this.walletTriageService.getWalletTriage(
      normalizedAddress,
      {
        summary,
      },
    );
    const context = await this.walletContextService.getWalletContext(
      normalizedAddress,
      {
        summary,
        activity,
        triage,
      },
    );

    const [score, classification] =
      triage && !triage.traderEligible
        ? ([triage, triage] as [
            WalletScoreOrTriageResult,
            WalletClassificationResult,
          ])
        : await Promise.all([
            this.walletScoringService.getWalletScore(normalizedAddress),
            this.classificationService.getClassification(normalizedAddress),
          ]);

    const features = this.buildIntelligenceFeatures(
      this.buildIntelligenceSummary(summary),
      {
        profitFactor: riskMetrics.profitFactor,
        maxDrawdown: riskMetrics.maxDrawdown,
        returnStdDev: riskMetrics.returnStdDev,
        concentrationRisk: riskMetrics.concentrationRisk,
      },
      holdTime,
      activity,
      verbose,
    );
    const intelligencePayload: WalletIntelligence = {
      address: summary.address,
      analyzedAt,
      context: this.shapeContextByVerbosity(context, verbose),
      summary: this.buildIntelligenceSummary(summary),
      metrics,
      score: this.shapeScoreByVerbosity(score, verbose),
      classification: this.shapeClassificationByVerbosity(classification, verbose),
      portfolio: defaultPortfolio,
      visiblePortfolio,
      portfolioSummary,
      ...(verbose
        ? {
            hiddenPortfolio,
            fullPortfolio,
          }
        : {}),
      features,
      aiSummary: null,
      deepAnalysis: null,
    };
    const [aiSummary, deepAnalysis] = await Promise.all([
      this.walletAiService.generateSummary(address, intelligencePayload),
      this.walletAiService.generateDeepAnalysis(address, intelligencePayload),
    ]);
    const response: WalletIntelligenceResponse = {
      ...intelligencePayload,
      aiSummary,
      deepAnalysis,
    };

    this.setCachedIntelligence(cacheKey, response);
    return response;
  }

  async getWalletContext(address: string): Promise<WalletContextResponse> {
    return this.walletContextService.getWalletContext(address);
  }

  async getWalletScore(
    address: string,
    debug = false,
  ): Promise<WalletScoreOrTriageResult> {
    const triage = await this.walletTriageService.getWalletTriage(address);

    if (triage && !triage.traderEligible) {
      return triage;
    }

    return this.walletScoringService.getWalletScore(address, debug);
  }

  async getClassification(address: string): Promise<WalletClassificationResult> {
    const triage = await this.walletTriageService.getWalletTriage(address);

    if (triage && !triage.traderEligible) {
      return triage;
    }

    return this.classificationService.getClassification(address);
  }

  async getDexMetrics(
    address: string,
    debug = false,
  ): Promise<WalletDexMetricsResult> {
    return this.walletAnalyticsService.getDexMetrics(address, debug);
  }

  async getTokenCategoryMetrics(
    address: string,
  ): Promise<WalletTokenCategoryMetricsResponse> {
    return this.walletAnalyticsService.getTokenCategoryMetrics(address);
  }

  async getTokenFlow(address: string): Promise<WalletTokenFlowResponse> {
    return this.walletPortfolioService.getTokenFlow(address);
  }

  async getNetFlow(address: string): Promise<WalletNetFlowResponse> {
    return this.walletPortfolioService.getNetFlow(address);
  }

  async getLedger(address: string): Promise<WalletLedgerResponse> {
    return this.walletPortfolioService.getLedger(address);
  }

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
    return this.walletPortfolioService.getPortfolio(address);
  }

  async getHoldings(address: string): Promise<WalletHoldingsResponse> {
    return this.walletPortfolioService.getHoldings(address);
  }

  async getActivityMetrics(
    address: string,
  ): Promise<WalletActivityMetricsResponse> {
    return this.walletAnalyticsService.getActivityMetrics(address);
  }

  async getHoldTimeMetrics(
    address: string,
  ): Promise<WalletHoldTimeMetricsResponse> {
    return this.walletAnalyticsService.getHoldTimeMetrics(address);
  }

  async getRiskMetrics(
    address: string,
    debug = false,
  ): Promise<WalletRiskMetricsResult> {
    return this.walletAnalyticsService.getRiskMetrics(address, debug);
  }

  private shapeContextByVerbosity(
    context: WalletContextResponse,
    verbose: boolean,
  ): WalletIntelligenceContext {
    if (verbose) {
      return context;
    }

    const { reasoning, ...rest } = context;
    void reasoning;
    return rest;
  }

  private shapeScoreByVerbosity(
    score: WalletScoreOrTriageResult,
    verbose: boolean,
  ): WalletIntelligenceScore {
    if (verbose) {
      return score;
    }

    return this.stripReasoningFields(score);
  }

  private shapeClassificationByVerbosity(
    classification: WalletClassificationResult,
    verbose: boolean,
  ): WalletIntelligenceClassification {
    if (verbose) {
      return classification;
    }

    return this.stripReasoningFields(classification);
  }

  private stripReasoningFields<T extends object>(value: T): T {
    const sanitized = { ...(value as object) } as {
      reasoning?: unknown;
      confidenceReasoning?: unknown;
    };
    delete sanitized.reasoning;
    delete sanitized.confidenceReasoning;

    return sanitized as T;
  }

  private buildIntelligenceFeatures(
    summary: WalletIntelligenceSummary,
    risk: {
      profitFactor: number;
      maxDrawdown: number;
      returnStdDev: number;
      concentrationRisk: number;
    },
    holdTime: WalletHoldTimeMetricsResponse,
    activity: WalletActivityMetricsResponse,
    verbose: boolean,
  ): WalletIntelligenceFeatures {
    const features: WalletIntelligenceFeatures = {
      summary,
      risk,
      holdTime,
      activity,
    };

    if (verbose) {
      features.rawFeatureMetrics = {
        risk,
        holdTime,
        activity,
      };
    }

    return features;
  }

  private buildIntelligenceSummary(
    summary: WalletSummaryResponse,
  ): WalletIntelligenceSummary {
    const { avgROI, ...rest } = summary;
    const averageTradeRoi = this.roundDecimal(avgROI, 4);

    return {
      ...rest,
      averageTradeRoi,
      averagePerTradeROI: averageTradeRoi,
    };
  }

  private async buildRoiMetrics(
    address: string,
    summary: WalletSummaryResponse,
    portfolio: WalletPortfolioResponse = [],
    riskMetrics?: WalletRiskMetricsResponse,
  ): Promise<WalletIntelligenceMetrics> {
    const resolvedRiskMetrics =
      riskMetrics ?? (await this.walletAnalyticsService.getRiskMetrics(address));
    const pricedTrades = await this.walletPnlService.getPricedTrades(address);
    const pricingCoverage = this.walletPricingService.buildPricingCoverage(
      pricedTrades,
    );
    const pricingCoverageNotice =
      'PnL based on priced subset of trades where historical pricing was available.';
    const portfolioTotalValueUsd = this.computePortfolioTotalValueUsd(portfolio);
    const capitalBase = this.computeCapitalBase(pricedTrades, portfolio);
    const lifetimeTradeMetrics = this.computeLifetimeTradeVolumeMetrics(
      pricedTrades,
      capitalBase,
    );
    const realizedRoiThreshold = 100;
    const realizedRoi =
      capitalBase > 0
        ? this.roundDecimal(
            (summary.totalRealizedPnL /
              Math.max(capitalBase, realizedRoiThreshold)) *
              100,
          )
        : 0;
    const averageTradeRoi = this.roundDecimal(summary.avgROI, 4);
    const medianTradeRoi =
      this.walletPnlService.computeMedianRealizedTradeRoi(pricedTrades);
    const unrealizedRoi = this.computeUnrealizedRoi(portfolio);
    const rawScoreAdjustedRoi =
      this.walletScoringService.getTraderWeightedRoiValue(
        summary,
        resolvedRiskMetrics,
      );
    const scoreAdjustedRoiReliability =
      this.resolveScoreAdjustedRoiReliability(summary.total_swaps);
    const scoreAdjustedRoi = scoreAdjustedRoiReliability.visible
      ? this.roundDecimal(
          rawScoreAdjustedRoi * scoreAdjustedRoiReliability.multiplier,
          4,
        )
      : null;
    const realizedPnL = this.roundDecimal(summary.totalRealizedPnL, 4);
    const unrealizedPnL = this.computeUnrealizedPortfolioPnl(portfolio);
    const netPnL = this.roundDecimal(realizedPnL + unrealizedPnL, 4);
    const roiLabels = this.buildRoiLabels();
    const pnlLabels = this.buildPnlLabels();
    const roiSampleWarnings = this.buildRoiSampleWarnings(
      summary.total_swaps,
      lifetimeTradeMetrics.lifetimeTradeCounted,
      scoreAdjustedRoiReliability.warning,
    );
    const realizedCapitalRoiVisible = capitalBase >= 25;
    const realizedCapitalRoiNotice = realizedCapitalRoiVisible
      ? null
      : 'ROI statistically unreliable due to very low capital base';
    const roiConfidence: WalletIntelligenceMetrics['roiConfidence'] =
      capitalBase < 100 ? 'low' : capitalBase < 500 ? 'medium' : 'high';
    const trustSignals = {
      confidence: roiConfidence,
      sampleSize: {
        totalSwaps: summary.total_swaps,
        pricedTrades: lifetimeTradeMetrics.lifetimeTradeCounted,
        minimumRecommendedSwaps: 10,
        minimumRecommendedPricedTrades: 10,
      },
      pricingCoverage,
      warnings: this.buildTrustWarnings(
        roiSampleWarnings,
        realizedCapitalRoiNotice,
        pricingCoverage,
      ),
    };

    return {
      realizedRoi,
      averageTradeRoi,
      medianTradeRoi,
      unrealizedRoi,
      scoreAdjustedRoi,
      realizedCapitalROI: realizedRoi,
      averagePerTradeROI: averageTradeRoi,
      medianTradeROI: medianTradeRoi,
      openPortfolioROI: unrealizedRoi,
      scoreAdjustedROI: scoreAdjustedRoi,
      realizedPnL,
      unrealizedPnL,
      netPnL,
      roiLabels,
      pnlLabels,
      roiSampleWarnings,
      trustSignals,
      trustSignalLabels: this.buildTrustSignalLabels(),
      capitalBase: this.roundDecimal(capitalBase),
      portfolioTotalValueUsd,
      lifetimeTradeVolumeUsd: lifetimeTradeMetrics.lifetimeTradeVolumeUsd,
      lifetimeTradeCounted: lifetimeTradeMetrics.lifetimeTradeCounted,
      lifetimeTradeSkipped: lifetimeTradeMetrics.lifetimeTradeSkipped,
      lifetimeTradeConfidence: lifetimeTradeMetrics.lifetimeTradeConfidence,
      roiConfidence,
      realizedCapitalRoiVisible,
      realizedCapitalRoiNotice,
      pricingCoverage,
      pricingCoverageNotice,
    };
  }

  private computeUnrealizedRoi(portfolio: WalletPortfolioResponse): number {
    let totalUnrealizedPnlUsd = 0;
    let totalCostBasisUsd = 0;

    for (const item of portfolio) {
      if (item.tokenQualityLabel === 'spoofed_major_symbol') {
        continue;
      }

      const usdValue = Number(item.usdValue);
      const pnlValue = Number(item.pnl);

      if (!Number.isFinite(usdValue) || !Number.isFinite(pnlValue)) {
        continue;
      }

      const costBasisUsd = usdValue - pnlValue;

      if (!Number.isFinite(costBasisUsd) || costBasisUsd <= 0) {
        continue;
      }

      totalUnrealizedPnlUsd += pnlValue;
      totalCostBasisUsd += costBasisUsd;
    }

    if (totalCostBasisUsd <= 0) {
      return 0;
    }

    return this.roundDecimal((totalUnrealizedPnlUsd / totalCostBasisUsd) * 100, 4);
  }

  private computeUnrealizedPortfolioPnl(
    portfolio: WalletPortfolioResponse,
  ): number {
    const totalUnrealizedPnlUsd = portfolio.reduce((total, item) => {
      if (item.tokenQualityLabel === 'spoofed_major_symbol') {
        return total;
      }

      const pnlValue = Number(item.pnl);

      if (!Number.isFinite(pnlValue)) {
        return total;
      }

      return total + pnlValue;
    }, 0);

    return this.roundDecimal(totalUnrealizedPnlUsd, 4);
  }

  private buildRoiLabels(): WalletIntelligenceMetrics['roiLabels'] {
    const realizedRoiLabel = 'Realized ROI (%)';
    const averageTradeRoiLabel = 'Average Trade ROI (%)';
    const medianTradeRoiLabel = 'Median Trade ROI (%)';
    const unrealizedRoiLabel = 'Unrealized ROI (%)';
    const scoreAdjustedRoiLabel = 'Score-Adjusted ROI (%)';

    return {
      realizedRoi: realizedRoiLabel,
      averageTradeRoi: averageTradeRoiLabel,
      medianTradeRoi: medianTradeRoiLabel,
      unrealizedRoi: unrealizedRoiLabel,
      scoreAdjustedRoi: scoreAdjustedRoiLabel,
      realizedCapitalROI: realizedRoiLabel,
      averagePerTradeROI: averageTradeRoiLabel,
      medianTradeROI: medianTradeRoiLabel,
      openPortfolioROI: unrealizedRoiLabel,
      scoreAdjustedROI: scoreAdjustedRoiLabel,
    };
  }

  private buildPnlLabels(): WalletIntelligenceMetrics['pnlLabels'] {
    return {
      realizedPnL: 'Realized PnL (USD)',
      unrealizedPnL: 'Unrealized PnL (USD)',
      netPnL: 'Net PnL (USD)',
    };
  }

  private buildRoiSampleWarnings(
    totalSwaps: number,
    countedPricedTrades: number,
    scoreAdjustedWarning: string | null,
  ): WalletIntelligenceMetrics['roiSampleWarnings'] {
    const perSwapWarning =
      totalSwaps < 10
        ? `Low sample size: only ${totalSwaps} swaps available (minimum recommended: 10).`
        : null;
    const realizedWarning =
      countedPricedTrades < 10
        ? `Low sample size: only ${countedPricedTrades} priced trades contributed (minimum recommended: 10).`
        : null;

    return {
      realizedRoi: realizedWarning,
      averageTradeRoi: perSwapWarning,
      medianTradeRoi: perSwapWarning,
      unrealizedRoi: null,
      scoreAdjustedRoi: scoreAdjustedWarning,
      realizedCapitalROI: realizedWarning,
      averagePerTradeROI: perSwapWarning,
      medianTradeROI: perSwapWarning,
      openPortfolioROI: null,
      scoreAdjustedROI: scoreAdjustedWarning,
    };
  }

  private resolveScoreAdjustedRoiReliability(totalSwaps: number): {
    visible: boolean;
    multiplier: number;
    warning: string | null;
  } {
    if (totalSwaps <= 4) {
      return {
        visible: false,
        multiplier: 0,
        warning: `Score-adjusted ROI hidden: only ${totalSwaps} swaps available (minimum required: 5).`,
      };
    }

    if (totalSwaps <= 9) {
      return {
        visible: true,
        multiplier: 0.25,
        warning: `Score-adjusted ROI reduced by 75% due to limited sample size (${totalSwaps} swaps).`,
      };
    }

    if (totalSwaps <= 19) {
      return {
        visible: true,
        multiplier: 0.65,
        warning: `Score-adjusted ROI reduced by 35% until at least 20 swaps are available (current: ${totalSwaps}).`,
      };
    }

    return {
      visible: true,
      multiplier: 1,
      warning: null,
    };
  }

  private buildTrustWarnings(
    roiSampleWarnings: WalletIntelligenceMetrics['roiSampleWarnings'],
    realizedCapitalRoiNotice: string | null,
    pricingCoverage: WalletIntelligenceMetrics['pricingCoverage'],
  ): string[] {
    const pricingCoverageWarning =
      pricingCoverage.unpricedTrades > 0
        ? `${pricingCoverage.unpricedTrades} trades were excluded due to missing historical pricing.`
        : null;

    const warnings = [
      roiSampleWarnings.realizedRoi,
      roiSampleWarnings.averageTradeRoi,
      roiSampleWarnings.medianTradeRoi,
      roiSampleWarnings.scoreAdjustedRoi,
      realizedCapitalRoiNotice,
      pricingCoverageWarning,
    ].filter((warning): warning is string => Boolean(warning));

    return Array.from(new Set(warnings));
  }

  private buildTrustSignalLabels(): WalletIntelligenceMetrics['trustSignalLabels'] {
    return {
      confidence: 'ROI Confidence',
      sampleSize: 'Sample Size',
      pricingCoverage: 'Pricing Coverage',
      warnings: 'Trust Warnings',
    };
  }

  private computePortfolioTotalValueUsd(
    portfolio: WalletPortfolioResponse,
  ): number {
    const totalUsd = portfolio.reduce((total, item) => {
      if (item.tokenQualityLabel === 'spoofed_major_symbol') {
        return total;
      }

      const usdValue = Number(item.usdValue);

      if (!Number.isFinite(usdValue) || usdValue <= 0) {
        return total;
      }

      return total + usdValue;
    }, 0);

    return this.roundDecimal(totalUsd, 2);
  }

  private computeLifetimeTradeVolumeMetrics(
    pricedTrades: PricedTrade[],
    historicalCapitalBase: number,
  ): {
    lifetimeTradeVolumeUsd: number;
    lifetimeTradeCounted: number;
    lifetimeTradeSkipped: number;
    lifetimeTradeConfidence: number;
  } {
    const tradesBySwap = new Map<string, PricedTrade[]>();

    for (const trade of pricedTrades) {
      const swapKey = this.getSwapGroupingKey(trade);
      const group = tradesBySwap.get(swapKey) ?? [];
      group.push(trade);
      tradesBySwap.set(swapKey, group);
    }

    const capitalReference = this.computeLifetimeVolumeCapitalReference(
      pricedTrades,
      historicalCapitalBase,
    );
    let lifetimeTradeVolumeUsd = 0;
    let lifetimeTradeCounted = 0;
    let lifetimeTradeSkipped = 0;
    let knownSideCounted = 0;

    for (const tradesForSwap of tradesBySwap.values()) {
      const dedupedTrades = this.dedupeSwapTrades(tradesForSwap);

      if (dedupedTrades.length === 0) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      let knownBuyNotionalUsd = 0;
      let knownSellNotionalUsd = 0;
      let totalBuyNotionalUsd = 0;
      let totalSellNotionalUsd = 0;
      let buyAmount = 0;
      let hasMajorTokenInSwap = false;
      let hasAbsurdUnitPrice = false;
      let hasSupplyDistortion = false;
      let hasSpoofedMajorSymbol = false;

      for (const trade of dedupedTrades) {
        const normalizedAmount = this.normalizeTradeAmountForVolume(trade);

        if (normalizedAmount === null || normalizedAmount <= 0) {
          continue;
        }

        if (
          this.walletPricingService.isSpoofedMajorSymbol(
            trade.token,
            trade.contractAddress,
          )
        ) {
          hasSpoofedMajorSymbol = true;
          continue;
        }

        if (trade.type === 'BUY') {
          buyAmount += normalizedAmount;
        }

        if (!Number.isFinite(trade.price) || trade.price <= 0) {
          continue;
        }

        if (trade.price > WalletService.LIFETIME_VOLUME_ABSURD_UNIT_PRICE_USD) {
          hasAbsurdUnitPrice = true;
        }

        const isMajorToken = this.walletPricingService.isTrustedMajorToken(
          trade.token,
          trade.contractAddress,
        );

        if (isMajorToken) {
          hasMajorTokenInSwap = true;
        }

        if (
          !isMajorToken &&
          normalizedAmount > WalletService.LIFETIME_VOLUME_SUPPLY_DISTORTION_AMOUNT
        ) {
          hasSupplyDistortion = true;
        }

        const tradeNotionalUsd = normalizedAmount * trade.price;

        if (!Number.isFinite(tradeNotionalUsd) || tradeNotionalUsd <= 0) {
          continue;
        }

        if (trade.type === 'BUY') {
          totalBuyNotionalUsd += tradeNotionalUsd;
        } else {
          totalSellNotionalUsd += tradeNotionalUsd;
        }

        if (isMajorToken) {
          if (trade.type === 'BUY') {
            knownBuyNotionalUsd += tradeNotionalUsd;
          } else {
            knownSellNotionalUsd += tradeNotionalUsd;
          }
        }
      }

      if (
        buyAmount > 0 &&
        buyAmount < WalletService.LIFETIME_VOLUME_MIN_RECEIVE_AMOUNT
      ) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      if (hasSpoofedMajorSymbol) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      if (hasAbsurdUnitPrice || hasSupplyDistortion) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      const hasKnownSide = knownBuyNotionalUsd > 0 || knownSellNotionalUsd > 0;
      const candidateNotionalUsd = hasKnownSide
        ? Math.max(knownBuyNotionalUsd, knownSellNotionalUsd)
        : Math.max(totalBuyNotionalUsd, totalSellNotionalUsd);

      if (!Number.isFinite(candidateNotionalUsd) || candidateNotionalUsd <= 0) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      if (
        !hasKnownSide &&
        !hasMajorTokenInSwap &&
        candidateNotionalUsd > WalletService.LIFETIME_VOLUME_TINY_LIQUIDITY_NOTIONAL_USD
      ) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      if (
        capitalReference > 0 &&
        candidateNotionalUsd >
          capitalReference * WalletService.LIFETIME_VOLUME_SANITY_CAP_MULTIPLIER &&
        !hasMajorTokenInSwap
      ) {
        lifetimeTradeSkipped += 1;
        continue;
      }

      lifetimeTradeVolumeUsd += candidateNotionalUsd;
      lifetimeTradeCounted += 1;

      if (hasKnownSide) {
        knownSideCounted += 1;
      }
    }

    const totalEvaluatedTrades = lifetimeTradeCounted + lifetimeTradeSkipped;
    const countedRatio =
      totalEvaluatedTrades > 0
        ? lifetimeTradeCounted / totalEvaluatedTrades
        : 0;
    const knownSideRatio =
      lifetimeTradeCounted > 0 ? knownSideCounted / lifetimeTradeCounted : 0;
    const lifetimeTradeConfidence = this.roundDecimal(
      Math.max(0, Math.min(1, countedRatio * 0.6 + knownSideRatio * 0.4)),
      3,
    );

    return {
      lifetimeTradeVolumeUsd: this.roundDecimal(lifetimeTradeVolumeUsd, 2),
      lifetimeTradeCounted,
      lifetimeTradeSkipped,
      lifetimeTradeConfidence,
    };
  }

  private computeLifetimeVolumeCapitalReference(
    pricedTrades: PricedTrade[],
    historicalCapitalBase: number,
  ): number {
    if (Number.isFinite(historicalCapitalBase) && historicalCapitalBase > 0) {
      return historicalCapitalBase;
    }

    let fallbackReference = 0;

    for (const trade of pricedTrades) {
      if (
        this.walletPricingService.isSpoofedMajorSymbol(
          trade.token,
          trade.contractAddress,
        )
      ) {
        continue;
      }

      const normalizedAmount = this.normalizeTradeAmountForVolume(trade);

      if (normalizedAmount === null || normalizedAmount <= 0) {
        continue;
      }

      if (!Number.isFinite(trade.price) || trade.price <= 0) {
        continue;
      }

      if (
        !this.walletPricingService.isTrustedMajorToken(
          trade.token,
          trade.contractAddress,
        )
      ) {
        continue;
      }

      const notional = normalizedAmount * trade.price;

      if (Number.isFinite(notional) && notional > fallbackReference) {
        fallbackReference = notional;
      }
    }

    return Math.max(fallbackReference, 100);
  }

  private getSwapGroupingKey(trade: PricedTrade): string {
    const normalizedHash = trade.transactionHash?.toLowerCase();

    if (normalizedHash) {
      return `${normalizedHash}:${trade.timestamp}`;
    }

    return `timestamp:${trade.timestamp}`;
  }

  private dedupeSwapTrades(trades: PricedTrade[]): PricedTrade[] {
    const dedupedTrades = new Map<string, PricedTrade>();

    for (const trade of trades) {
      const tokenKey = trade.contractAddress
        ? `contract:${trade.contractAddress.toLowerCase()}`
        : `symbol:${trade.token.toUpperCase()}`;
      const amountKey = trade.rawAmount ?? trade.amount;
      const dedupeKey = [
        trade.transactionHash?.toLowerCase() ?? 'no-hash',
        trade.timestamp.toString(),
        (trade.routeHopIndex ?? -1).toString(),
        trade.type,
        tokenKey,
        amountKey,
      ].join(':');

      if (!dedupedTrades.has(dedupeKey)) {
        dedupedTrades.set(dedupeKey, trade);
      }
    }

    return Array.from(dedupedTrades.values());
  }

  private normalizeTradeAmountForVolume(trade: PricedTrade): number | null {
    if (trade.rawAmount) {
      try {
        const rawAmount = BigInt(trade.rawAmount);

        if (rawAmount <= 0n) {
          return null;
        }

        const decimals =
          typeof trade.decimals === 'number' &&
          Number.isInteger(trade.decimals) &&
          trade.decimals >= 0
            ? trade.decimals
            : 18;
        const divisor = 10n ** BigInt(decimals);
        const wholePart = rawAmount / divisor;
        const fractionalPart = rawAmount % divisor;
        const normalizedAmountString =
          fractionalPart === 0n
            ? wholePart.toString()
            : `${wholePart.toString()}.${fractionalPart
                .toString()
                .padStart(decimals, '0')
                .replace(/0+$/, '')}`;
        const normalizedAmount = Number(normalizedAmountString);

        if (Number.isFinite(normalizedAmount) && normalizedAmount > 0) {
          return normalizedAmount;
        }
      } catch {
        // Fallback to parsed decimal amount below.
      }
    }

    const parsedAmount = Number(trade.amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return null;
    }

    return parsedAmount;
  }

  private computeCapitalBase(
    pricedTrades: PricedTrade[],
    portfolio: WalletPortfolioResponse,
  ): number {
    const sortedTrades = [...pricedTrades].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    let deployedCapital = 0;
    let runningPortfolioEstimate = 0;
    let maxHistoricalPortfolioEstimate = 0;

    for (const trade of sortedTrades) {
      if (
        this.walletPricingService.isSpoofedMajorSymbol(
          trade.token,
          trade.contractAddress,
        )
      ) {
        continue;
      }

      const amount = Number(trade.amount);

      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(trade.price) || trade.price <= 0) {
        continue;
      }

      const notionalUsd = amount * trade.price;

      if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
        continue;
      }

      if (trade.type === 'BUY') {
        deployedCapital += notionalUsd;
        runningPortfolioEstimate += notionalUsd;
      } else {
        runningPortfolioEstimate = Math.max(0, runningPortfolioEstimate - notionalUsd);
      }

      maxHistoricalPortfolioEstimate = Math.max(
        maxHistoricalPortfolioEstimate,
        runningPortfolioEstimate,
      );
    }

    const currentPortfolioEstimate = portfolio.reduce((total, item) => {
      if (item.tokenQualityLabel === 'spoofed_major_symbol') {
        return total;
      }

      const usdValue = Number(item.usdValue);
      return total + (Number.isFinite(usdValue) && usdValue > 0 ? usdValue : 0);
    }, 0);

    return Math.max(
      this.roundDecimal(deployedCapital),
      this.roundDecimal(maxHistoricalPortfolioEstimate),
      this.roundDecimal(currentPortfolioEstimate),
    );
  }

  private selectTopSpeculativePortfolio(
    portfolio: WalletPortfolioResponse,
    limit: number,
  ): WalletPortfolioResponse {
    if (portfolio.length === 0 || limit <= 0) {
      return [];
    }

    return [...portfolio]
      .sort((left, right) => {
        const leftQuality = left.tokenQualityScore ?? 0;
        const rightQuality = right.tokenQualityScore ?? 0;

        if (rightQuality !== leftQuality) {
          return rightQuality - leftQuality;
        }

        const leftUsdValue = Number(left.usdValue);
        const rightUsdValue = Number(right.usdValue);
        const leftSafeUsdValue =
          Number.isFinite(leftUsdValue) && leftUsdValue > 0 ? leftUsdValue : 0;
        const rightSafeUsdValue =
          Number.isFinite(rightUsdValue) && rightUsdValue > 0 ? rightUsdValue : 0;

        if (rightSafeUsdValue !== leftSafeUsdValue) {
          return rightSafeUsdValue - leftSafeUsdValue;
        }

        return left.token.localeCompare(right.token);
      })
      .slice(0, limit);
  }

  private buildVisiblePortfolio(
    portfolio: WalletPortfolioResponse,
  ): WalletPortfolioResponse {
    if (portfolio.length === 0) {
      return [];
    }

    const baseVisible = portfolio.filter((item) =>
      this.shouldIncludeInVisiblePortfolio(item),
    );
    const topMeaningfulHoldings = [...portfolio]
      .filter(
        (item) =>
          !this.isHiddenPortfolioItem(item) &&
          this.isMaterialVisibleHolding(item),
      )
      .sort((left, right) => this.comparePortfolioItemsByMateriality(left, right))
      .slice(0, WalletService.VISIBLE_PORTFOLIO_TOP_MEANINGFUL_LIMIT);

    return this.dedupePortfolioItems([...baseVisible, ...topMeaningfulHoldings]).sort(
      (left, right) => {
        const leftTierRank = this.resolveVisibleTierRank(left.displayTier);
        const rightTierRank = this.resolveVisibleTierRank(right.displayTier);

        if (leftTierRank !== rightTierRank) {
          return leftTierRank - rightTierRank;
        }

        return this.comparePortfolioItemsByMateriality(left, right);
      },
    );
  }

  private shouldIncludeInVisiblePortfolio(
    item: WalletPortfolioResponse[number],
  ): boolean {
    if (this.isHiddenPortfolioItem(item)) {
      return false;
    }

    if (item.displayTier === 'core' || item.displayTier === 'active') {
      return true;
    }

    if (this.isMaterialMajorHolding(item)) {
      return true;
    }

    return this.isMaterialVisibleHolding(item);
  }

  private isHiddenPortfolioItem(item: WalletPortfolioResponse[number]): boolean {
    if (item.displayTier === 'hidden') {
      return true;
    }

    return item.tokenQualityLabel === 'spoofed_major_symbol';
  }

  private isMaterialMajorHolding(
    item: WalletPortfolioResponse[number],
  ): boolean {
    const usdValue = this.parsePositiveUsdValue(item.usdValue);

    if (usdValue < WalletService.VISIBLE_PORTFOLIO_MATERIAL_VALUE_USD) {
      return false;
    }

    if (this.walletPricingService.isTrustedMajorToken(item.token, item.contractAddress)) {
      return true;
    }

    return WalletService.VISIBLE_PORTFOLIO_MAJOR_SYMBOLS.has(
      item.token.trim().toUpperCase(),
    );
  }

  private isMaterialVisibleHolding(
    item: WalletPortfolioResponse[number],
  ): boolean {
    const usdValue = this.parsePositiveUsdValue(item.usdValue);

    if (usdValue >= WalletService.VISIBLE_PORTFOLIO_MATERIAL_VALUE_USD) {
      return true;
    }

    const allocationPercent = this.parsePositiveAllocation(item.allocation);

    return (
      allocationPercent >= WalletService.VISIBLE_PORTFOLIO_MATERIAL_ALLOCATION_PERCENT
    );
  }

  private comparePortfolioItemsByMateriality(
    left: WalletPortfolioResponse[number],
    right: WalletPortfolioResponse[number],
  ): number {
    const leftUsdValue = this.parsePositiveUsdValue(left.usdValue);
    const rightUsdValue = this.parsePositiveUsdValue(right.usdValue);

    if (rightUsdValue !== leftUsdValue) {
      return rightUsdValue - leftUsdValue;
    }

    const leftAllocation = this.parsePositiveAllocation(left.allocation);
    const rightAllocation = this.parsePositiveAllocation(right.allocation);

    if (rightAllocation !== leftAllocation) {
      return rightAllocation - leftAllocation;
    }

    const leftQuality = left.tokenQualityScore ?? 0;
    const rightQuality = right.tokenQualityScore ?? 0;

    if (rightQuality !== leftQuality) {
      return rightQuality - leftQuality;
    }

    return left.token.localeCompare(right.token);
  }

  private dedupePortfolioItems(
    portfolio: WalletPortfolioResponse,
  ): WalletPortfolioResponse {
    const deduped = new Map<string, WalletPortfolioResponse[number]>();

    for (const item of portfolio) {
      const identity = this.getPortfolioItemIdentity(item);

      if (!deduped.has(identity)) {
        deduped.set(identity, item);
      }
    }

    return Array.from(deduped.values());
  }

  private resolveVisibleTierRank(displayTier: string): number {
    if (displayTier === 'core') {
      return 0;
    }

    if (displayTier === 'active') {
      return 1;
    }

    if (displayTier === 'secondary') {
      return 2;
    }

    return 3;
  }

  private getPortfolioItemIdentity(item: WalletPortfolioResponse[number]): string {
    if (item.contractAddress) {
      return `contract:${item.contractAddress.toLowerCase()}`;
    }

    return `symbol:${item.token.trim().toLowerCase()}`;
  }

  private parsePositiveUsdValue(value: string | null): number {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return 0;
    }

    return parsedValue;
  }

  private parsePositiveAllocation(value: string): number {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return 0;
    }

    return parsedValue;
  }

  private buildPortfolioSummary(
    portfolio: WalletPortfolioResponse,
    metrics?: Pick<
      WalletIntelligenceMetrics,
      'portfolioTotalValueUsd' | 'lifetimeTradeVolumeUsd'
    >,
  ): WalletPortfolioSummary {
    const hiddenItems = portfolio.filter((item) => item.displayTier === 'hidden');
    const hiddenUsdValue = hiddenItems.reduce((total, item) => {
      const usdValue = Number(item.usdValue);
      return total + (Number.isFinite(usdValue) && usdValue > 0 ? usdValue : 0);
    }, 0);
    const spamCount = hiddenItems.filter((item) => {
      const reason = item.hiddenReason?.toLowerCase() ?? '';
      return (
        reason.includes('spam') ||
        reason.includes('promo') ||
        reason.includes('airdrop') ||
        reason.includes('unknown')
      );
    }).length;

    const scaleSummary = metrics
      ? ` | scale: $${this.formatUsdCompact(metrics.portfolioTotalValueUsd)} portfolio, $${this.formatUsdCompact(metrics.lifetimeTradeVolumeUsd)} lifetime traded`
      : '';

    return {
      hiddenCount: hiddenItems.length,
      hiddenUsdValue: this.roundDecimal(hiddenUsdValue).toString(),
      spamCount,
      uiSummary: `+${hiddenItems.length} hidden inactive / spam assets${scaleSummary}`,
    };
  }

  private formatUsdCompact(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return '0';
    }

    const absoluteValue = Math.abs(value);

    if (absoluteValue >= 1_000_000_000) {
      return `${this.roundDecimal(value / 1_000_000_000, 2)}B`;
    }

    if (absoluteValue >= 1_000_000) {
      return `${this.roundDecimal(value / 1_000_000, 2)}M`;
    }

    if (absoluteValue >= 1_000) {
      return `${this.roundDecimal(value / 1_000, 2)}K`;
    }

    return this.roundDecimal(value, 2).toString();
  }

  private roundDecimal(value: number, decimals = 6): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }

  private buildIntelligenceCacheKey(input: {
    address: string;
    lite: boolean;
    verbose: boolean;
  }): string {
    return `${input.address}:lite=${input.lite}:verbose=${input.verbose}`;
  }

  private getCachedIntelligence(
    cacheKey: string,
  ): WalletIntelligenceResult | null {
    const cached = this.intelligenceCache.get(cacheKey);

    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.intelligenceCache.delete(cacheKey);
      return null;
    }

    return this.clonePayload(cached.value);
  }

  private setCachedIntelligence(
    cacheKey: string,
    value: WalletIntelligenceResult,
  ): void {
    this.pruneExpiredIntelligenceCache();

    this.intelligenceCache.set(cacheKey, {
      expiresAt: Date.now() + WalletService.INTELLIGENCE_CACHE_TTL_MS,
      value: this.clonePayload(value),
    });
  }

  private pruneExpiredIntelligenceCache(): void {
    const now = Date.now();

    for (const [key, value] of this.intelligenceCache.entries()) {
      if (value.expiresAt <= now) {
        this.intelligenceCache.delete(key);
      }
    }
  }

  private clonePayload<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}