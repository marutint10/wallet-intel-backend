import { Injectable } from '@nestjs/common';
import {
  LiteFeatureVector,
  hasPortfolioContext,
} from './lite-feature.service';
import type { CategoryAllocations } from './lite-portfolio.service';
import type { WalletPnlMetrics } from './lite-pnl.service';

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

const SCORE_BANDS = [
  { min: 90, label: 'Elite Smart Money' },
  { min: 75, label: 'Strong Trader' },
  { min: 60, label: 'Good Trader' },
  { min: 40, label: 'Average' },
  { min: 0, label: 'Weak / Risky' },
];

@Injectable()
export class LiteScorerService {
  score(
    features: LiteFeatureVector,
    pnlMetrics: WalletPnlMetrics | null = null,
  ): LiteScore {
    // FIX 2: gated wallets keep `score: 0` internally to preserve the
    // `LiteScore.score: number` contract that HolderAggregationService relies on,
    // but `band: 'Insufficient Data'` is the canonical "not scored" signal that
    // DashboardSummaryService translates into `null` in the API response.
    // Treat 0 here as a sentinel, not a real score.
    if (features.swapCount < 3) {
      // IMPROVEMENT 3: Score passive holders from portfolio context when DEX history is absent.
      if (hasPortfolioContext(features)) {
        return this.scorePortfolioOnly(features);
      }

      return {
        score: 0,
        confidence: 'low',
        band: 'Insufficient Data',
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
      'Weak / Risky';

    // Confidence is driven by sample richness signals that are present even
    // without FIFO matched lots: swap count, sample size, and wallet age.
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

  // IMPROVEMENT 3: Portfolio-only path for wallets without DEX swaps (top-50 holders with holdings data).
  private scorePortfolioOnly(features: LiteFeatureVector): LiteScore {
    const trackedWeight = features.trackedTokenWeight ?? 0;
    if (
      trackedWeight >= 80 &&
      (!features.holdingCategoryMix || features.totalHoldingTokens <= 1)
    ) {
      const floorScore = features.walletAgeDays > 180 ? 25 : 18;
      return {
        score: floorScore,
        confidence: 'low',
        band: 'Average',
        breakdown: {
          consistency: 0,
          riskManagement: 10,
          portfolioQuality: 0,
          experience: floorScore - 10,
          activity: 0,
          profitability: 0,
        },
      };
    }

    const portfolioQuality = this.scorePortfolioQuality(features);
    const riskManagement = this.scoreRiskManagementPortfolioOnly(features);
    const experience = this.scorePortfolioOnlyExperience(features);

    const rawScore = Math.round(
      (portfolioQuality / 100) * 45 + (riskManagement / 20) * 12 + experience,
    );
    const clampedScore = Math.min(60, Math.max(0, rawScore));

    const band =
      SCORE_BANDS.find((scoreBand) => clampedScore >= scoreBand.min)?.label ??
      'Weak / Risky';

    return {
      score: clampedScore,
      confidence: 'low',
      band,
      breakdown: {
        consistency: 0,
        riskManagement,
        portfolioQuality,
        experience,
        activity: 0,
        profitability: 0,
      },
    };
  }

  // IMPROVEMENT 3: Partial risk score using portfolio signals only (no trade cadence).
  private scoreRiskManagementPortfolioOnly(f: LiteFeatureVector): number {
    let score = 0;

    const memePct = f.holdingCategoryMix?.meme ?? f.memecoinPercent;
    if (memePct < 10) {
      score += 10;
    } else if (memePct < 25) {
      score += 7;
    } else if (memePct < 50) {
      score += 3;
    }

    if (f.portfolioRiskSignal === 'conservative') {
      score += 10;
    } else if (f.portfolioRiskSignal === 'balanced') {
      score += 5;
    } else if (f.portfolioRiskSignal === 'degen') {
      score -= 5;
    }

    return Math.max(0, Math.min(score, 20));
  }

  private scorePortfolioOnlyExperience(f: LiteFeatureVector): number {
    if (f.walletAgeDays > 365) {
      return 8;
    }
    if (f.walletAgeDays > 180) {
      return 5;
    }
    return 0;
  }

  // CONSISTENCY (max 20)
  // Rewards wallets that trade steadily, not in panic bursts.
  // In FAST_MODE matchedLotCount is a round-trip proxy, not a true FIFO count,
  // so we also consider raw swapCount as a completed-activity signal.
  private scoreConsistency(f: LiteFeatureVector): number {
    let score = 0;

    // Burstiness: lower is better (steady = disciplined)
    if (f.burstinessCoeff < 0.5) {
      score += 10;
    } else if (f.burstinessCoeff < 1.0) {
      score += 7;
    } else if (f.burstinessCoeff < 1.5) {
      score += 4;
    } else if (f.burstinessCoeff < 2.0) {
      score += 2;
    }

    // Completed-activity tier (whichever proxy is richer for this wallet).
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
  // Rewards diversification and avoiding pure memecoin gambling
  private scoreRiskManagement(f: LiteFeatureVector): number {
    let score = 0;

    // Memecoin exposure: lower is better
    if (f.memecoinPercent < 10) {
      score += 10;
    } else if (f.memecoinPercent < 25) {
      score += 7;
    } else if (f.memecoinPercent < 50) {
      score += 3;
    }

    // Stablecoin usage: having some stables = risk awareness
    if (f.stablecoinPercent >= 10 && f.stablecoinPercent <= 60) {
      score += 5;
    } else if (f.stablecoinPercent > 0) {
      score += 2;
    }

    // Token diversity: some diversity is good, too much is scattered
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
  // Falls back to placeholder holdings signals when portfolio context is absent.
  private scorePortfolioQuality(f: LiteFeatureVector): number {
    let score = 0;

    if (f.holdingCategoryMix) {
      // REAL portfolio data available.

      // Diversification (0-30)
      const divScore = f.portfolioDiversificationScore || 0;
      score += (divScore / 100) * 30;

      // IMPROVEMENT 1: Subtract tracked token weight from its category bucket before quality scoring.
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

      // Stablecoin reserve bonus (0-15)
      const stablePct =
        adjustedMix?.stablecoin ?? (f.holdingCategoryMix.stablecoin || 0);
      if (stablePct >= 5 && stablePct <= 40) {
        score += 15;
      } else if (stablePct > 40) {
        score += 8;
      }

      // Token count bonus (0-15)
      const tokenCount = f.totalHoldingTokens || 0;
      if (tokenCount >= 5 && tokenCount <= 30) {
        score += 15;
      } else if (tokenCount > 30) {
        score += 8;
      } else if (tokenCount >= 2) {
        score += 5;
      }

      // IMPROVEMENT 1: In B2B token reports, heavy allocation to the analyzed token is conviction, not risk.
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
      // NO portfolio data: keep placeholder logic.
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

  // EXPERIENCE (max 15)
  // Rewards wallets with long history and meaningful trade volume
  private scoreExperience(f: LiteFeatureVector): number {
    let score = 0;

    // Trading span
    if (f.tradingSpanDays >= 365) {
      score += 8;
    } else if (f.tradingSpanDays >= 180) {
      score += 6;
    } else if (f.tradingSpanDays >= 90) {
      score += 4;
    } else if (f.tradingSpanDays >= 30) {
      score += 2;
    }

    // Swap count (log scale - diminishing returns)
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

  // ACTIVITY (max 10)
  // Rewards wallets that are actively trading, not just holding.
  // Uses the richer of (matchedLotCount, swapCount/2) so FAST_MODE wallets
  // without FIFO still earn an activity score from raw swap evidence.
  private scoreActivity(f: LiteFeatureVector): number {
    let score = 0;

    // Trades per day: some activity but not bot-like
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
