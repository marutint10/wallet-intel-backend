import { Injectable } from '@nestjs/common';
import {
  LiteFeatureVector,
  hasPortfolioContext,
} from './lite-feature.service';
import type { CategoryAllocations } from './lite-portfolio.service';
import type { WalletPnlMetrics } from './lite-pnl.service';
import {
  B2B_HOLDER_SCORE_BANDS,
  buildHolderScoringInputFromLite,
  scoreHolderWallet,
} from '../../scoring/holder-scoring.engine';
import { resolveHolderConfidence } from '../../scoring/holder-confidence';

export interface LiteScore {
  score: number;
  confidence: 'low' | 'medium' | 'high';
  band: string;
  breakdown: {
    consistency: number;
    riskManagement: number;
    portfolioQuality: number;
    experience: number;
    activity: number;
    profitability: number;
  };
}

const SCORE_BANDS = B2B_HOLDER_SCORE_BANDS;

/** Bands that mean the wallet was not scored (dashboard surfaces score as null). */
export const UNSCORED_SCORE_BANDS = new Set(['Dormant Wallet', 'Insufficient Data']);

@Injectable()
export class LiteScorerService {
  score(
    features: LiteFeatureVector,
    pnlMetrics: WalletPnlMetrics | null = null,
  ): LiteScore {
    // FIX 2: gated wallets keep `score: 0` internally to preserve the
    // `LiteScore.score: number` contract that HolderAggregationService relies on,
    // but `band: 'Dormant Wallet'` is the canonical "not scored" signal that
    // DashboardSummaryService translates into `null` in the API response.
    // Treat 0 here as a sentinel, not a real score.
    if (features.swapCount < 3) {
      if (hasPortfolioContext(features)) {
        return this.scoreHolderPortfolio(features);
      }

      return {
        score: 0,
        confidence: 'low',
        band: 'Dormant Wallet',
        breakdown: {
          consistency: 0,
          riskManagement: 0,
          portfolioQuality: 0,
          experience: 0,
          activity: 0,
          profitability: 0,
        },
      };
    }

    const consistency = this.scoreConsistency(features);
    const riskManagement = this.scoreRiskManagement(features);
    const portfolioQuality = this.scorePortfolioQuality(features);
    const experience = this.scoreExperience(features);
    const activity = this.scoreActivity(features);
    const profitability = this.scoreProfitability(pnlMetrics);

    // FIX 3: when profitability is unavailable (FAST_MODE / no PnL) we boost
    // experience (1.5x) and portfolioQuality (1.3x) so that long-tenured,
    // bluechip-holding conviction wallets like Diamond Hands score in the
    // 55-70 range instead of ~21 under the old flat redistribution. With
    // profitability present we keep the original 70/30 split unchanged.
    let score: number;
    if (profitability > 0) {
      const rawTotal =
        consistency + riskManagement + portfolioQuality + experience + activity;
      const maxRawTotal = features.holdingCategoryMix ? 165 : 90;
      score = Math.round((rawTotal / maxRawTotal) * 70 + profitability);
    } else {
      const boostedExperience = experience * 1.5;
      const boostedPortfolioQuality = portfolioQuality * 1.3;
      const rawTotal =
        consistency +
        riskManagement +
        boostedPortfolioQuality +
        boostedExperience +
        activity;
      const maxPortfolioQuality = features.holdingCategoryMix ? 100 : 25;
      const maxRawTotal =
        20 /* consistency */ +
        20 /* riskManagement */ +
        maxPortfolioQuality * 1.3 +
        15 * 1.5 /* experience */ +
        10 /* activity */;
      score = Math.round((rawTotal / maxRawTotal) * 100);
    }
    const clampedScore = Math.min(100, Math.max(0, score));

    const band =
      SCORE_BANDS.find((scoreBand) => clampedScore >= scoreBand.min)?.label ??
      'Developing';

    const confidence =
      features.swapCount >= 10 ||
      features.totalTransfers >= 25 ||
      features.walletAgeDays >= 180
        ? 'high'
        : features.swapCount >= 5 || features.totalTransfers >= 10
          ? 'medium'
          : 'low';

    return {
      score: clampedScore,
      confidence,
      band,
      breakdown: {
        consistency,
        riskManagement,
        portfolioQuality,
        experience,
        activity,
        profitability,
      },
    };
  }

  private scoreProfitability(pnlMetrics: WalletPnlMetrics | null): number {
    if (!pnlMetrics || pnlMetrics.trades.length < 3) {
      return 0;
    }

    const winRateScore = this.clamp(pnlMetrics.winRate / 4, 0, 25);
    const profitFactorScore = this.clamp((pnlMetrics.profitFactor / 2) * 25, 0, 25);
    const roiScore = this.clamp((pnlMetrics.avgRoiPercent / 50) * 25, 0, 25);
    const consistencyScore = pnlMetrics.winRate > 55 ? 20 : 10;

    return Math.round(
      ((winRateScore + profitFactorScore + roiScore + consistencyScore) / 100) *
        30,
    );
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Institutional-grade passive holder scoring (0–100).
   * Uses the same dimension model as wallet holder scoring.
   */
  private scoreHolderPortfolio(features: LiteFeatureVector): LiteScore {
    const holderInput = buildHolderScoringInputFromLite({
      totalPortfolioUsd: features.totalPortfolioUsd,
      trackedTokenWeight: features.trackedTokenWeight,
      walletAgeDays: features.walletAgeDays,
      daysSinceLastActivity: features.daysSinceLastActivity,
      activityConsistencyScore: features.activityConsistencyScore,
      portfolioDiversificationScore: features.portfolioDiversificationScore,
      portfolioConcentrationScore: features.portfolioConcentrationScore,
      memecoinPercent: features.memecoinPercent,
      blueChipPercent: features.blueChipPercent,
      stablecoinPercent: features.stablecoinPercent,
      uniqueTokens: features.uniqueTokens,
      holdingCategoryMix: features.holdingCategoryMix as CategoryAllocations | null,
      portfolioRiskSignal: features.portfolioRiskSignal,
      medianHoldHours: features.medianHoldHours,
    });
    const result = scoreHolderWallet(holderInput);
    const holderConfidence = resolveHolderConfidence({
      walletAgeDays: features.walletAgeDays,
      totalPortfolioUsd: features.totalPortfolioUsd ?? 0,
      uniqueTokenCount: features.uniqueTokens,
      categoryDiversity: holderInput.categoryDiversity,
      nonDustCount: features.totalHoldingTokens,
      balancesAvailable: true,
      hasPortfolioContext: true,
      swapCount: features.swapCount,
      totalTransfers: features.totalTransfers,
    });

    const { dimensions } = result;

    return {
      score: result.score,
      confidence: holderConfidence.confidence,
      band: result.band,
      breakdown: {
        consistency: 0,
        activity: 0,
        profitability: 0,
        riskManagement: Math.round(dimensions.conviction * 0.35),
        portfolioQuality: dimensions.portfolioQuality,
        experience: dimensions.longevityStability + Math.round(dimensions.conviction * 0.25),
      },
    };
  }

  // CONSISTENCY (max 20)
  // Rewards wallets that trade steadily, not in panic bursts.
  // In FAST_MODE matchedLotCount is a round-trip proxy, not a true FIFO count,
  // so we also consider raw swapCount as a completed-activity signal.
  private scoreConsistency(f: LiteFeatureVector): number {
    let score = 0;

    if (f.burstinessCoeff < 0.5) {
      score += 10;
    } else if (f.burstinessCoeff < 1.0) {
      score += 7;
    } else if (f.burstinessCoeff < 1.5) {
      score += 4;
    } else if (f.burstinessCoeff < 2.0) {
      score += 2;
    }

    const completedActivity = Math.max(f.matchedLotCount, f.swapCount);
    if (completedActivity >= 20) {
      score += 10;
    } else if (completedActivity >= 10) {
      score += 7;
    } else if (completedActivity >= 5) {
      score += 4;
    } else {
      score += 1;
    }

    return Math.min(score, 20);
  }

  // RISK MANAGEMENT (max 20)
  private scoreRiskManagement(f: LiteFeatureVector): number {
    let score = 0;

    if (f.memecoinPercent < 10) {
      score += 10;
    } else if (f.memecoinPercent < 25) {
      score += 7;
    } else if (f.memecoinPercent < 50) {
      score += 3;
    }

    if (f.stablecoinPercent >= 10 && f.stablecoinPercent <= 60) {
      score += 5;
    } else if (f.stablecoinPercent > 0) {
      score += 2;
    }

    if (f.uniqueTokens >= 5 && f.uniqueTokens <= 25) {
      score += 5;
    } else if (f.uniqueTokens > 0) {
      score += 2;
    }

    let riskBonus = 0;
    if (f.portfolioRiskSignal === 'conservative') {
      riskBonus += 10;
    } else if (f.portfolioRiskSignal === 'balanced') {
      riskBonus += 5;
    } else if (f.portfolioRiskSignal === 'degen') {
      riskBonus -= 5;
    }

    score += riskBonus;

    return Math.max(0, Math.min(score, 20));
  }

  // PORTFOLIO QUALITY (max 100 when holdings data is available)
  private scorePortfolioQuality(f: LiteFeatureVector): number {
    let score = 0;

    if (f.holdingCategoryMix) {
      const divScore = f.portfolioDiversificationScore || 0;
      score += (divScore / 100) * 30;

      const trackedWeight = f.trackedTokenWeight ?? 0;
      const adjustedMix = this.buildAdjustedCategoryMix(f);
      const nonTrackedPct = Math.max(0, 100 - trackedWeight);

      if (adjustedMix && nonTrackedPct > 0 && typeof f.trackedTokenWeight === 'number') {
        const qualityInNonTracked =
          (adjustedMix.bluechip || 0) +
          (adjustedMix.defi || 0) +
          (adjustedMix.infrastructure || 0);
        const qualityAllocationPct = (qualityInNonTracked / nonTrackedPct) * 100;
        score += Math.min(30, qualityAllocationPct * 0.4);
      } else if (adjustedMix) {
        const qualityAllocation =
          (adjustedMix.bluechip || 0) +
          (adjustedMix.defi || 0) +
          (adjustedMix.infrastructure || 0);
        score += Math.min(30, qualityAllocation * 0.4);
      }

      const stablePct =
        adjustedMix?.stablecoin ?? (f.holdingCategoryMix.stablecoin || 0);
      if (stablePct >= 5 && stablePct <= 40) {
        score += 15;
      } else if (stablePct > 40) {
        score += 8;
      }

      const tokenCount = f.totalHoldingTokens || 0;
      if (tokenCount >= 5 && tokenCount <= 30) {
        score += 15;
      } else if (tokenCount > 30) {
        score += 8;
      } else if (tokenCount >= 2) {
        score += 5;
      }

      const concentrationWeight = f.trackedTokenWeight || 0;
      if (concentrationWeight > 80) {
        score -= 2;
        if (f.walletAgeDays > 90) {
          score += 5;
        }
      } else if (concentrationWeight > 50) {
        score -= 1;
      }
    } else {
      if (f.totalHoldingTokens >= 5) {
        score += 15;
      } else if (f.totalHoldingTokens >= 2) {
        score += 8;
      }

      if (f.holdingChainCount >= 2) {
        score += 10;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  private buildAdjustedCategoryMix(
    f: LiteFeatureVector,
  ): CategoryAllocations | null {
    if (!f.holdingCategoryMix) {
      return null;
    }

    const trackedWeight = f.trackedTokenWeight ?? 0;
    const trackedCat = f.trackedTokenCategory || 'other';
    const adjustedMix: CategoryAllocations = { ...f.holdingCategoryMix };

    if (trackedWeight > 0 && trackedCat in adjustedMix) {
      adjustedMix[trackedCat] = Math.max(0, adjustedMix[trackedCat] - trackedWeight);
    }

    return adjustedMix;
  }

  private scoreExperience(f: LiteFeatureVector): number {
    let score = 0;

    if (f.tradingSpanDays >= 365) {
      score += 8;
    } else if (f.tradingSpanDays >= 180) {
      score += 6;
    } else if (f.tradingSpanDays >= 90) {
      score += 4;
    } else if (f.tradingSpanDays >= 30) {
      score += 2;
    }

    const logSwaps = Math.log10(f.swapCount + 1);
    if (logSwaps >= 2.5) {
      score += 7;
    } else if (logSwaps >= 2.0) {
      score += 5;
    } else if (logSwaps >= 1.5) {
      score += 3;
    } else if (logSwaps >= 1.0) {
      score += 1;
    }

    return Math.min(score, 15);
  }

  private scoreActivity(f: LiteFeatureVector): number {
    let score = 0;

    if (f.tradesPerDay >= 0.1 && f.tradesPerDay <= 5) {
      score += 5;
    } else if (f.tradesPerDay > 0) {
      score += 2;
    }

    const completedProxy = Math.max(
      f.matchedLotCount,
      Math.floor(f.swapCount / 2),
    );
    if (completedProxy >= 10) {
      score += 5;
    } else if (completedProxy >= 3) {
      score += 3;
    } else if (completedProxy >= 1) {
      score += 1;
    }

    return Math.min(score, 10);
  }
}
