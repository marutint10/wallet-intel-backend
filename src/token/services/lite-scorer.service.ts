import { Injectable } from '@nestjs/common';
import { LiteFeatureVector } from './lite-feature.service';
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
    // Gate: not enough data
    if (features.swapCount < 3) {
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

    const rawTotal =
      consistency + riskManagement + portfolioQuality + experience + activity;
    const maxRawTotal = features.holdingCategoryMix ? 165 : 90;
    const score =
      profitability > 0
        ? Math.round((rawTotal / maxRawTotal) * 70 + profitability)
        : Math.round((rawTotal / maxRawTotal) * 100);
    const clampedScore = Math.min(100, Math.max(0, score));

    const band =
      SCORE_BANDS.find((scoreBand) => clampedScore >= scoreBand.min)?.label ??
      'Weak / Risky';

    const confidence =
      features.matchedLotCount < 5
        ? 'low'
        : features.matchedLotCount < 15
          ? 'medium'
          : 'high';

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

  // CONSISTENCY (max 20)
  // Rewards wallets that trade steadily, not in panic bursts
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

    // Hold time consistency: having matched lots is good
    if (f.matchedLotCount >= 20) {
      score += 10;
    } else if (f.matchedLotCount >= 10) {
      score += 7;
    } else if (f.matchedLotCount >= 5) {
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

      // Category quality (0-30)
      const qualityAllocation =
        (f.holdingCategoryMix.bluechip || 0) +
        (f.holdingCategoryMix.defi || 0) +
        (f.holdingCategoryMix.infrastructure || 0);
      score += Math.min(30, qualityAllocation * 0.4);

      // Stablecoin reserve bonus (0-15)
      const stablePct = f.holdingCategoryMix.stablecoin || 0;
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

      // Concentration penalty (0 to -10)
      const trackedWeight = f.trackedTokenWeight || 0;
      if (trackedWeight > 80) {
        score -= 10;
      } else if (trackedWeight > 50) {
        score -= 5;
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
  // Rewards wallets that are actively trading, not just holding
  private scoreActivity(f: LiteFeatureVector): number {
    let score = 0;

    // Trades per day: some activity but not bot-like
    if (f.tradesPerDay >= 0.1 && f.tradesPerDay <= 5) {
      score += 5;
    } else if (f.tradesPerDay > 0) {
      score += 2;
    }

    // Has completed trades (matched lots exist)
    if (f.matchedLotCount >= 10) {
      score += 5;
    } else if (f.matchedLotCount >= 3) {
      score += 3;
    } else if (f.matchedLotCount >= 1) {
      score += 1;
    }

    return Math.min(score, 10);
  }
}
