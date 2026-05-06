import { Injectable } from '@nestjs/common';
import { LiteFeatureVector } from './lite-feature.service';

export interface LiteClassification {
  primaryType: string;
  confidence: 'low' | 'medium' | 'high';
  primaryScore: number;
  secondaryType: string | null;
  reasoning: string;
}

@Injectable()
export class LiteClassifierService {
  classify(features: LiteFeatureVector): LiteClassification {
    // Gate: not enough data to classify
    if (features.swapCount < 3 || features.matchedLotCount < 2) {
      return {
        primaryType: 'Insufficient Data',
        confidence: 'low',
        primaryScore: 0,
        secondaryType: null,
        reasoning: `Only ${features.swapCount} swaps detected - need at least 3 to classify.`,
      };
    }

    const scores: Record<string, number> = {
      'Diamond Hand': this.scoreDiamondHand(features),
      'Swing Trader': this.scoreSwingTrader(features),
      'Day Trader': this.scoreDayTrader(features),
      Degen: this.scoreDegen(features),
      'Bot / Automated': this.scoreBot(features),
      Accumulator: this.scoreAccumulator(features),
      Whale: this.scoreWhale(features),
    };

    // Sort by score descending
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [primaryType, primaryScore] = sorted[0];
    const [secondaryType, secondaryScore] = sorted[1];

    // Confidence based on matchedLotCount + score gap
    const confidence = this.computeConfidence(
      features.matchedLotCount,
      features.swapCount,
      primaryScore,
      secondaryScore,
    );

    // Secondary type only if score is close to primary (within 20 points)
    const secondary = secondaryScore >= primaryScore - 20 ? secondaryType : null;

    return {
      primaryType,
      confidence,
      primaryScore: Math.round(primaryScore),
      secondaryType: secondary,
      reasoning: this.buildReasoning(primaryType, features),
    };
  }

  private scoreDiamondHand(f: LiteFeatureVector): number {
    let score = 0;
    // Strong signal: median hold > 30 days
    if (f.medianHoldHours !== null) {
      if (f.medianHoldHours > 2160) {
        score += 50;
      } else if (f.medianHoldHours > 720) {
        score += 35;
      } else if (f.medianHoldHours > 168) {
        score += 15;
      }
    }
    // Holds more than sells (low swap count relative to span)
    if (f.tradesPerDay < 0.1) {
      score += 20;
    }
    // Blue chip or stablecoin heavy
    if (f.blueChipPercent > 40) {
      score += 15;
    }
    if (f.stablecoinPercent > 30) {
      score += 10;
    }
    // Most lots in over7d bucket
    const totalLots = Object.values(f.holdBuckets).reduce((a, b) => a + b, 0);
    if (totalLots > 0 && f.holdBuckets.over7d / totalLots > 0.5) {
      score += 15;
    }
    return Math.min(score, 100);
  }

  private scoreSwingTrader(f: LiteFeatureVector): number {
    let score = 0;
    if (f.medianHoldHours !== null) {
      // Sweet spot: 1-30 days
      if (f.medianHoldHours >= 24 && f.medianHoldHours <= 720) {
        score += 45;
      } else if (f.medianHoldHours >= 12 && f.medianHoldHours <= 1440) {
        score += 25;
      }
    }
    // Moderate trading frequency
    if (f.tradesPerDay >= 0.1 && f.tradesPerDay <= 2) {
      score += 20;
    }
    // Some variety in tokens
    if (f.uniqueTokens >= 5 && f.uniqueTokens <= 30) {
      score += 15;
    }
    // Not a pure degen
    if (f.memecoinPercent < 50) {
      score += 10;
    }
    // Moderate burstiness
    if (f.burstinessCoeff >= 0.5 && f.burstinessCoeff <= 2.5) {
      score += 10;
    }
    return Math.min(score, 100);
  }

  private scoreDayTrader(f: LiteFeatureVector): number {
    let score = 0;
    if (f.medianHoldHours !== null) {
      // Hold under 24 hours
      if (f.medianHoldHours < 1) {
        score += 40;
      } else if (f.medianHoldHours < 24) {
        score += 30;
      }
    }
    // High frequency
    if (f.tradesPerDay > 2) {
      score += 30;
    } else if (f.tradesPerDay > 1) {
      score += 15;
    }
    // Short gaps between trades
    if (f.avgGapHours < 4) {
      score += 20;
    } else if (f.avgGapHours < 12) {
      score += 10;
    }
    // Heavy under24h bucket
    const totalLots = Object.values(f.holdBuckets).reduce((a, b) => a + b, 0);
    if (
      totalLots > 0 &&
      (f.holdBuckets.under1h + f.holdBuckets.under24h) / totalLots > 0.6
    ) {
      score += 10;
    }
    return Math.min(score, 100);
  }

  private scoreDegen(f: LiteFeatureVector): number {
    let score = 0;
    // Primary signal: heavy memecoin trading
    if (f.memecoinPercent > 60) {
      score += 40;
    } else if (f.memecoinPercent > 40) {
      score += 25;
    } else if (f.memecoinPercent > 20) {
      score += 10;
    }
    // Impulsive: short holds
    if (f.medianHoldHours !== null && f.medianHoldHours < 48) {
      score += 20;
    }
    // Trades in bursts (FOMO behavior)
    if (f.burstinessCoeff > 1.5) {
      score += 20;
    }
    // Low stablecoin (no risk management)
    if (f.stablecoinPercent < 10) {
      score += 10;
    }
    // Wide token scatter (tries everything)
    if (f.uniqueTokens > 20) {
      score += 10;
    }
    return Math.min(score, 100);
  }

  private scoreBot(f: LiteFeatureVector): number {
    let score = 0;
    // Very high frequency
    if (f.tradesPerDay > 10) {
      score += 40;
    } else if (f.tradesPerDay > 5) {
      score += 20;
    }
    // Very low gaps
    if (f.avgGapHours < 0.5) {
      score += 30;
    } else if (f.avgGapHours < 2) {
      score += 15;
    }
    // Very consistent (low burstiness)
    if (f.burstinessCoeff < 0.3) {
      score += 20;
    }
    // Very short holds
    if (f.medianHoldHours !== null && f.medianHoldHours < 0.5) {
      score += 10;
    }
    return Math.min(score, 100);
  }

  private scoreAccumulator(f: LiteFeatureVector): number {
    let score = 0;
    // More INs than OUTs (buy heavy)
    // Proxy: matchedLotCount low relative to swapCount = many buys, few sells
    const buyRatio = f.swapCount > 0 ? 1 - f.matchedLotCount / f.swapCount : 0;
    if (buyRatio > 0.6) {
      score += 40;
    } else if (buyRatio > 0.4) {
      score += 20;
    }
    // Long holds
    if (f.medianHoldHours !== null && f.medianHoldHours > 720) {
      score += 30;
    }
    // Focused token selection
    if (f.uniqueTokens < 10) {
      score += 20;
    }
    // Low trading frequency
    if (f.tradesPerDay < 0.2) {
      score += 10;
    }
    return Math.min(score, 100);
  }

  private scoreWhale(f: LiteFeatureVector): number {
    // We can't determine trade size from lite data alone
    // Use proxy: large holding token count + blue chip heavy
    let score = 0;
    if (f.totalHoldingTokens > 20) {
      score += 20;
    }
    if (f.blueChipPercent > 50) {
      score += 30;
    }
    if (f.holdingChainCount > 2) {
      score += 20;
    }
    if (f.tradingSpanDays > 365) {
      score += 30;
    }
    return Math.min(score, 100);
  }

  private computeConfidence(
    matchedLotCount: number,
    swapCount: number,
    topScore: number,
    secondScore: number,
  ): 'low' | 'medium' | 'high' {
    if (matchedLotCount < 5 || swapCount < 5) {
      return 'low';
    }
    if (matchedLotCount < 15 || swapCount < 10) {
      return 'medium';
    }
    if (topScore - secondScore < 15) {
      return 'medium';
    }
    return 'high';
  }

  private buildReasoning(type: string, f: LiteFeatureVector): string {
    const holdDays =
      f.medianHoldHours !== null
        ? `${(f.medianHoldHours / 24).toFixed(1)}d median hold`
        : 'no completed holds';

    switch (type) {
      case 'Diamond Hand':
        return `Holds positions for ${holdDays} with low trade frequency (${f.tradesPerDay.toFixed(2)}/day).`;
      case 'Swing Trader':
        return `${holdDays}, ${f.swapCount} swaps over ${f.tradingSpanDays.toFixed(0)} days - classic swing pattern.`;
      case 'Day Trader':
        return `Very short ${holdDays} with avg ${f.avgGapHours.toFixed(1)}h between trades.`;
      case 'Degen':
        return `${f.memecoinPercent}% memecoin exposure, ${holdDays}, burstiness ${f.burstinessCoeff.toFixed(2)}.`;
      case 'Bot / Automated':
        return `${f.tradesPerDay.toFixed(1)} trades/day with ${f.avgGapHours.toFixed(2)}h avg gap - systematic pattern.`;
      case 'Accumulator':
        return `More buys than sells (${f.matchedLotCount} matched vs ${f.swapCount} total swaps), ${holdDays}.`;
      case 'Whale':
        return `Long-term active wallet (${f.tradingSpanDays.toFixed(0)} days), ${f.blueChipPercent}% blue chip.`;
      default:
        return `Based on ${f.swapCount} swaps over ${f.tradingSpanDays.toFixed(0)} days.`;
    }
  }
}
