import { Injectable } from '@nestjs/common';
import {
  Trade,
  WalletActivityMetricsResponse,
  WalletClassificationResult,
  WalletIntelligenceClassification,
  WalletIntelligenceContext,
  WalletIntelligenceFeatures,
  WalletIntelligenceLiteResponse,
  WalletIntelligenceOptions,
  WalletIntelligenceResponse,
  WalletIntelligenceResult,
  WalletIntelligenceScore,
  WalletContextResponse,
  WalletDexMetricsResult,
  WalletFeaturesResponse,
  WalletHoldingsResponse,
  WalletHoldTimeMetricsResponse,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
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
import { WalletScoringService } from './scoring.service';
import { WalletTriageService } from './wallet-triage.service';

@Injectable()
export class WalletService {
  private static readonly INTELLIGENCE_CACHE_TTL_MS = 90_000;
  private readonly intelligenceCache = new Map<
    string,
    { expiresAt: number; value: WalletIntelligenceResult }
  >();

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPortfolioService: WalletPortfolioService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
    private readonly walletContextService: WalletContextService,
    private readonly walletScoringService: WalletScoringService,
    private readonly classificationService: ClassificationService,
    private readonly walletTriageService: WalletTriageService,
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
      const summary = await this.walletPnlService.getWalletSummary(normalizedAddress);
      const triage = await this.walletTriageService.getWalletTriage(
        normalizedAddress,
        { summary },
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
        summary,
        score: this.shapeScoreByVerbosity(score, verbose),
        classification: this.shapeClassificationByVerbosity(
          classification,
          verbose,
        ),
      };

      this.setCachedIntelligence(cacheKey, response);
      return response;
    }

    const [summary, activity, holdTime, riskMetrics, portfolio] =
      await Promise.all([
        this.walletPnlService.getWalletSummary(normalizedAddress),
        this.walletAnalyticsService.getActivityMetrics(normalizedAddress),
        this.walletAnalyticsService.getHoldTimeMetrics(normalizedAddress),
        this.walletAnalyticsService.getRiskMetrics(normalizedAddress),
        this.walletPortfolioService.getPortfolio(normalizedAddress),
      ]);
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
      summary,
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
    const response: WalletIntelligenceResponse = {
      address: summary.address,
      analyzedAt,
      context: this.shapeContextByVerbosity(context, verbose),
      summary,
      score: this.shapeScoreByVerbosity(score, verbose),
      classification: this.shapeClassificationByVerbosity(classification, verbose),
      portfolio,
      features,
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
    summary: WalletSummaryResponse,
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