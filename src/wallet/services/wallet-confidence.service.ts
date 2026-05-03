import { Injectable } from '@nestjs/common';
import {
  NormalizedTransaction,
  Trade,
  WalletActivityMetricsResponse,
  WalletConfidenceFields,
  WalletConfidenceLabel,
  WalletHoldTimeBuckets,
  WalletHoldTimeMetricsResponse,
  WalletSummaryResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletCoreService } from './wallet-core.service';
import { WalletPnlService } from './wallet-pnl.service';
import { PricedTrade } from './wallet-pricing.service';
import {
  DEFAULT_SUPPORTED_CHAIN,
  SupportedChain,
} from '../../shared/constants/chains';

interface WalletConfidenceInput {
  summary?: WalletSummaryResponse;
  activity?: WalletActivityMetricsResponse;
  holdTime?: WalletHoldTimeMetricsResponse;
  trades?: Trade[];
  pricedTrades?: PricedTrade[];
  transactions?: NormalizedTransaction[];
}

@Injectable()
export class WalletConfidenceService {
  constructor(
    private readonly walletPnlService: WalletPnlService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
    private readonly walletCoreService: WalletCoreService,
  ) {}

  async getConfidence(
    address: string,
    input: WalletConfidenceInput = {},
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletConfidenceFields> {
    const [summary, activity, holdTime, transactions, pricedTrades] =
      await Promise.all([
        input.summary
          ? Promise.resolve(input.summary)
          : this.walletPnlService.getWalletSummary(address, chain),
        input.activity
          ? Promise.resolve(input.activity)
          : this.walletAnalyticsService.getActivityMetrics(address, chain),
        input.holdTime
          ? Promise.resolve(input.holdTime)
          : this.walletAnalyticsService.getHoldTimeMetrics(address, chain),
        input.transactions
          ? Promise.resolve(input.transactions)
          : this.walletCoreService
              .getStoredTransactions(address, chain)
              .then((result) => result.transactions),
        input.pricedTrades
          ? Promise.resolve(input.pricedTrades)
          : this.walletPnlService.getPricedTrades(address, chain),
      ]);

    const trades = input.trades ?? pricedTrades;

    const parsedCoverage = this.computeParsedTransactionCoverage(transactions);
    const pricedTradeCoverage = this.computeUsablePricedTradeCoverage(pricedTrades);
    const dataQualityScore = this.roundDecimal(
      parsedCoverage * 0.55 + pricedTradeCoverage * 0.45,
    );

    const walletAgeDays = this.computeWalletAgeDays(transactions);
    const walletAgeScore = this.scoreWalletAge(walletAgeDays);

    const activeTradingDays = this.computeActiveTradingDays(trades);
    const swapCountScore = this.scoreSwapCount(summary.total_swaps);
    const activeTradingDaysScore = this.scoreActiveTradingDays(activeTradingDays);
    const swapSampleSizeScore = this.roundDecimal(
      swapCountScore * 0.7 + activeTradingDaysScore * 0.3,
    );

    const dominantHoldShare = this.computeDominantHoldBucketShare(
      holdTime.holdBuckets,
    );
    const holdStabilityScore = this.scoreHoldStability(dominantHoldShare);
    const repeatedBehaviorScore = this.computeRepeatedBehaviorScore(
      activity.tradingSpanRatio,
      activeTradingDays,
    );
    const lowVarianceScore = this.scoreLowVariance(activity.burstinessScore);
    const signalConsistencyScore = this.roundDecimal(
      holdStabilityScore * 0.35 +
        repeatedBehaviorScore * 0.35 +
        lowVarianceScore * 0.3,
    );

    const dataQualityContribution = this.roundDecimal(dataQualityScore * 0.3);
    const walletAgeContribution = this.roundDecimal(walletAgeScore * 0.2);
    const swapSampleContribution = this.roundDecimal(swapSampleSizeScore * 0.3);
    const signalConsistencyContribution = this.roundDecimal(
      signalConsistencyScore * 0.2,
    );

    const confidenceScore = this.clampInt(
      Math.round(
        dataQualityContribution +
          walletAgeContribution +
          swapSampleContribution +
          signalConsistencyContribution,
      ),
      0,
      100,
    );
    const confidenceLabel = this.toConfidenceLabel(confidenceScore);
    const confidenceReason = this.buildConfidenceReason({
      confidenceLabel,
      summary,
      parsedCoverage,
      pricedTradeCoverage,
      activity,
    });

    return {
      confidence: confidenceLabel,
      confidenceLabel,
      confidenceScore,
      confidenceReason,
      confidenceReasoning: [
        `Data quality (${dataQualityContribution}/30): parsed transaction coverage ${this.formatPercent(parsedCoverage)} and usable priced trade coverage ${this.formatPercent(pricedTradeCoverage)}.`,
        `Wallet age (${walletAgeContribution}/20): ${Math.round(walletAgeDays)} days since first stored transaction.`,
        `Swap sample size (${swapSampleContribution}/30): ${summary.total_swaps} swaps across ${activeTradingDays} active trading days.`,
        `Signal consistency (${signalConsistencyContribution}/20): hold-time stability ${this.formatPercent(dominantHoldShare * 100)}, repeated behavior score ${Math.round(repeatedBehaviorScore)}, activity variance score ${Math.round(lowVarianceScore)}.`,
        `Final confidence is ${confidenceLabel} (${confidenceScore}/100).`,
      ],
    };
  }

  private buildConfidenceReason(input: {
    confidenceLabel: WalletConfidenceLabel;
    summary: WalletSummaryResponse;
    parsedCoverage: number;
    pricedTradeCoverage: number;
    activity: WalletActivityMetricsResponse;
  }): string {
    if (input.confidenceLabel === 'high') {
      const reasons = [
        input.summary.total_swaps >= 600
          ? '600+ swaps'
          : `${input.summary.total_swaps} swaps`,
        'strong realized trade history',
        input.pricedTradeCoverage >= 70
          ? 'priced assets available'
          : 'partial pricing coverage',
        input.activity.tradingSpanRatio >= 0.35
          ? 'clear behavioral patterns'
          : 'consistent activity signals',
      ];

      return `High confidence due to ${reasons.join(', ')}.`;
    }

    if (input.confidenceLabel === 'medium') {
      const reasons = [
        input.summary.total_swaps >= 40
          ? 'moderate swap history'
          : 'limited swaps',
        input.pricedTradeCoverage >= 60
          ? 'acceptable pricing coverage'
          : 'incomplete pricing coverage',
      ];

      return `Medium confidence due to ${reasons.join(' and ')}.`;
    }

    const lowConfidenceReasons = [
      input.summary.total_swaps <= 5 ? 'sparse data' : 'low signal depth',
      input.summary.total_transfers > input.summary.total_swaps
        ? 'mostly transfers'
        : 'limited realized trading evidence',
      input.parsedCoverage < 50 ? 'partial parsing coverage' : null,
    ].filter((value): value is string => Boolean(value));

    return `Low confidence due to ${lowConfidenceReasons.join(', ')}.`;
  }

  private computeParsedTransactionCoverage(
    transactions: NormalizedTransaction[],
  ): number {
    if (transactions.length === 0) {
      return 0;
    }

    const parsedCount = transactions.filter((transaction) => {
      const hasHash = Boolean(transaction.hash?.trim());
      const hasValidTimestamp = Number.isFinite(Date.parse(transaction.timestamp));
      const hasLegs = transaction.inputs.length + transaction.outputs.length > 0;
      return hasHash && hasValidTimestamp && hasLegs;
    }).length;

    return this.clampPercentage((parsedCount / transactions.length) * 100);
  }

  private computeUsablePricedTradeCoverage(pricedTrades: PricedTrade[]): number {
    if (pricedTrades.length === 0) {
      return 0;
    }

    const usableCount = pricedTrades.filter(
      (trade) => Number.isFinite(trade.price) && trade.price > 0,
    ).length;

    return this.clampPercentage((usableCount / pricedTrades.length) * 100);
  }

  private computeWalletAgeDays(transactions: NormalizedTransaction[]): number {
    if (transactions.length === 0) {
      return 0;
    }

    const timestamps = transactions
      .map((transaction) => Date.parse(transaction.timestamp))
      .filter((value) => Number.isFinite(value));

    if (timestamps.length === 0) {
      return 0;
    }

    const oldestTimestamp = Math.min(...timestamps);
    const millisecondsPerDay = 24 * 60 * 60 * 1000;

    return this.roundDecimal(
      Math.max(Date.now() - oldestTimestamp, 0) / millisecondsPerDay,
    );
  }

  private computeActiveTradingDays(trades: Trade[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const activeDays = new Set<string>();

    for (const trade of trades) {
      if (!Number.isFinite(trade.timestamp)) {
        continue;
      }

      const dateKey = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);
      activeDays.add(dateKey);
    }

    return activeDays.size;
  }

  private computeDominantHoldBucketShare(holdBuckets: WalletHoldTimeBuckets): number {
    const bucketValues = [
      holdBuckets.under1h,
      holdBuckets.under24h,
      holdBuckets.under7d,
      holdBuckets.over7d,
    ];
    const total = bucketValues.reduce((accumulator, value) => accumulator + value, 0);

    if (total <= 0) {
      return 0;
    }

    return this.roundDecimal(Math.max(...bucketValues) / total);
  }

  private scoreWalletAge(walletAgeDays: number): number {
    if (walletAgeDays >= 365) {
      return 100;
    }

    if (walletAgeDays >= 180) {
      return 85;
    }

    if (walletAgeDays >= 90) {
      return 70;
    }

    if (walletAgeDays >= 30) {
      return 50;
    }

    if (walletAgeDays >= 7) {
      return 30;
    }

    if (walletAgeDays > 0) {
      return 15;
    }

    return 0;
  }

  private scoreSwapCount(totalSwaps: number): number {
    if (totalSwaps >= 200) {
      return 100;
    }

    if (totalSwaps >= 100) {
      return 90;
    }

    if (totalSwaps >= 50) {
      return 75;
    }

    if (totalSwaps >= 20) {
      return 55;
    }

    if (totalSwaps >= 10) {
      return 35;
    }

    if (totalSwaps >= 5) {
      return 20;
    }

    if (totalSwaps > 0) {
      return 10;
    }

    return 0;
  }

  private scoreActiveTradingDays(activeTradingDays: number): number {
    if (activeTradingDays >= 120) {
      return 100;
    }

    if (activeTradingDays >= 60) {
      return 85;
    }

    if (activeTradingDays >= 30) {
      return 65;
    }

    if (activeTradingDays >= 14) {
      return 50;
    }

    if (activeTradingDays >= 7) {
      return 35;
    }

    if (activeTradingDays > 0) {
      return 15;
    }

    return 0;
  }

  private scoreHoldStability(dominantHoldShare: number): number {
    if (dominantHoldShare >= 0.75) {
      return 95;
    }

    if (dominantHoldShare >= 0.6) {
      return 80;
    }

    if (dominantHoldShare >= 0.45) {
      return 65;
    }

    if (dominantHoldShare >= 0.3) {
      return 45;
    }

    if (dominantHoldShare > 0) {
      return 30;
    }

    return 25;
  }

  private computeRepeatedBehaviorScore(
    tradingSpanRatio: number,
    activeTradingDays: number,
  ): number {
    const normalizedSpanRatio = this.clamp(tradingSpanRatio, 0, 1);
    const cadenceScore = Math.min(activeTradingDays, 90) / 90;

    return this.roundDecimal(normalizedSpanRatio * 70 + cadenceScore * 30);
  }

  private scoreLowVariance(burstinessScore: number): number {
    if (burstinessScore <= 0.4) {
      return 95;
    }

    if (burstinessScore <= 0.8) {
      return 80;
    }

    if (burstinessScore <= 1.2) {
      return 65;
    }

    if (burstinessScore <= 2) {
      return 45;
    }

    if (burstinessScore <= 3) {
      return 30;
    }

    return 15;
  }

  private toConfidenceLabel(score: number): WalletConfidenceLabel {
    if (score >= 70) {
      return 'high';
    }

    if (score >= 40) {
      return 'medium';
    }

    return 'low';
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private clampInt(value: number, min: number, max: number): number {
    return Math.trunc(this.clamp(value, min, max));
  }

  private clampPercentage(value: number): number {
    return this.roundDecimal(this.clamp(value, 0, 100));
  }

  private formatPercent(value: number): string {
    if (!Number.isFinite(value)) {
      return '0%';
    }

    return `${value.toFixed(1)}%`;
  }

  private roundDecimal(value: number, decimals = 2): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }
}
