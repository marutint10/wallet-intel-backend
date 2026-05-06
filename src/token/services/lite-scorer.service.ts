import { Injectable } from '@nestjs/common';
import { LiteFeatureVector } from './lite-feature.service';

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
  score(features: LiteFeatureVector): LiteScore {
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
        },
      };
    }

    const consistency = this.scoreConsistency(features);
    const riskManagement = this.scoreRiskManagement(features);
    const portfolioQuality = this.scorePortfolioQuality(features);
    const experience = this.scoreExperience(features);
    const activity = this.scoreActivity(features);

    // Total out of 80 max -> scale to 100
    const rawTotal =
      consistency + riskManagement + portfolioQuality + experience + activity;
    const score = Math.round((rawTotal / 80) * 100);
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
      },
    };
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

    return Math.min(score, 20);
  }

  // PORTFOLIO QUALITY (max 15)
  // Rewards blue chip holdings and multi-chain activity
  private scorePortfolioQuality(f: LiteFeatureVector): number {
    let score = 0;

    // Blue chip percentage in trades
    if (f.blueChipPercent >= 40) {
      score += 8;
    } else if (f.blueChipPercent >= 20) {
      score += 5;
    } else if (f.blueChipPercent >= 10) {
      score += 2;
    }

    // Multi-chain activity shows sophistication
    if (f.holdingChainCount >= 3) {
      score += 4;
    } else if (f.holdingChainCount >= 2) {
      score += 2;
    }

    // Having current holdings (not just speculating and exiting)
    if (f.totalHoldingTokens >= 5) {
      score += 3;
    } else if (f.totalHoldingTokens >= 1) {
      score += 1;
    }

    return Math.min(score, 15);
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
