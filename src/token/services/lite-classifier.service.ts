import { Injectable } from '@nestjs/common';
import { LiteFeatureVector, hasPortfolioContext } from './lite-feature.service';
import type { WalletPnlMetrics } from './lite-pnl.service';

export interface LiteClassification {
  primaryType: string;
  confidence: 'low' | 'medium' | 'high';
  primaryScore: number;
  secondaryType: string | null;
  reasoning: string;
}

@Injectable()
export class LiteClassifierService {
  classify(
    features: LiteFeatureVector,
    pnlMetrics: WalletPnlMetrics | null = null,
  ): LiteClassification {
    // Gate: need at least some on-chain activity. PnL and FIFO matched lots are
    // no longer required - FAST_MODE classification leans on cadence, category
    // mix, and portfolio context instead of realized trade reconstruction.
    if (features.swapCount < 3 && !this.hasUsablePnl(pnlMetrics)) {
      // IMPROVEMENT 2: Classify passive holders from portfolio when DEX history is missing (top-50).
      if (hasPortfolioContext(features)) {
        return this.classifyPassiveHolder(features);
      }

      return {
        primaryType: 'Dormant Wallet',
        confidence: 'low',
        primaryScore: 0,
        secondaryType: null,
        reasoning: 'Wallet is dormant on DEXs with no recent swap history to profile.',
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

    // PnL boosts are applied opportunistically and only when realized trades
    // are available. They are never required for a classification.
    this.applyPnlSignals(scores, pnlMetrics);

    // Sort by score descending
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [primaryType, primaryScore] = sorted[0];
    const [secondaryType, secondaryScore] = sorted[1];

    const confidence = this.computeConfidence(
      features,
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
      reasoning: this.buildReasoning(primaryType, features, pnlMetrics),
    };
  }

  private applyPnlSignals(
    scores: Record<string, number>,
    pnlMetrics: WalletPnlMetrics | null,
  ): void {
    if (!this.hasUsablePnl(pnlMetrics)) {
      return;
    }

    if (pnlMetrics.winRate > 65 && pnlMetrics.avgRoiPercent > 30) {
      scores['Smart Money'] = Math.max(scores['Smart Money'] ?? 0, 82);
      scores['Swing Trader'] = Math.min(100, scores['Swing Trader'] + 20);
      scores['Diamond Hand'] = Math.min(100, scores['Diamond Hand'] + 10);
    }

    if (pnlMetrics.winRate < 35 && pnlMetrics.profitFactor < 0.8) {
      scores.Degen = Math.min(100, scores.Degen + 25);
    }

    if (pnlMetrics.avgRoiPercent < -10 && pnlMetrics.avgHoldDurationHours < 48) {
      scores['Paper Hand'] = Math.max(scores['Paper Hand'] ?? 0, 72);
    }

    if (
      pnlMetrics.winRate > 60 &&
      pnlMetrics.avgHoldDurationHours < 2 &&
      Math.abs(pnlMetrics.avgRoiPercent) < 10
    ) {
      scores['Bot / Automated'] = Math.min(100, scores['Bot / Automated'] + 20);
    }
  }

  private hasUsablePnl(
    pnlMetrics: WalletPnlMetrics | null,
  ): pnlMetrics is WalletPnlMetrics {
    return Boolean(pnlMetrics && pnlMetrics.trades.length >= 3);
  }

  // IMPROVEMENT 2: Portfolio-based labels for holders who acquired via transfer/OTC, not DEX.
  private classifyPassiveHolder(features: LiteFeatureVector): LiteClassification {
    const trackedWeight = features.trackedTokenWeight ?? 0;
    const diversification = features.portfolioDiversificationScore ?? 0;
    const totalUsd = features.totalPortfolioUsd ?? 0;

    const isDiversifiedWhale =
      (totalUsd > 5_000_000 && trackedWeight < 30) ||
      (totalUsd > 500_000 && trackedWeight < 20 && diversification > 50) ||
      (totalUsd > 1_000_000 &&
        trackedWeight < 30 &&
        (features.holdingCategoryMix?.bluechip ?? 0) > 50);

    if (isDiversifiedWhale) {
      return {
        primaryType: 'Diversified Whale',
        confidence: 'medium',
        primaryScore: 75,
        secondaryType: null,
        reasoning:
          `Large diversified portfolio ($${(totalUsd / 1_000_000).toFixed(1)}M total) with ` +
          `${trackedWeight.toFixed(1)}% allocation to this token. No DEX trading detected.`,
      };
    }

    if (trackedWeight >= 80) {
      return {
        primaryType: 'Conviction Holder',
        confidence: totalUsd > 1_000_000 ? 'medium' : 'low',
        primaryScore: 55,
        secondaryType: null,
        reasoning:
          `Demonstrates strong conviction holding ${trackedWeight.toFixed(1)}% of total balance sheet in this token with no active trading profile.`,
      };
    }

    if (diversification > 30 && trackedWeight < 50) {
      return {
        primaryType: 'Strategic Allocator',
        confidence: totalUsd > 1_000_000 ? 'medium' : 'low',
        primaryScore: 50,
        secondaryType: null,
        reasoning:
          'Maintains a well-diversified portfolio structure with a strategic exposure allocation to this token.',
      };
    }

    return {
      primaryType: 'Conviction Holder',
      confidence: 'low',
      primaryScore: 40,
      secondaryType: null,
      reasoning:
        'Long-term asset holder with a static portfolio distribution and no short-term execution activity.',
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

    if (f.holdingCategoryMix) {
      if ((f.trackedTokenWeight ?? 0) > 30 && f.holdingCategoryMix.bluechip > 30) {
        score += 10;
      }

      if (
        f.portfolioRiskSignal === 'conservative' ||
        f.portfolioRiskSignal === 'balanced'
      ) {
        score += 5;
      }
    }

    // Long-tenured wallet still active = conviction signal even without FIFO.
    if (f.walletAgeDays >= 365 && f.daysSinceLastActivity <= 60) {
      score += 10;
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

    if (f.holdingCategoryMix) {
      if (
        (f.portfolioDiversificationScore ?? 0) > 50 &&
        f.holdingCategoryMix.defi > 20
      ) {
        score += 5;
      }
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

    if (f.holdingCategoryMix) {
      if (f.holdingCategoryMix.stablecoin > 30) {
        score += 5;
      }
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

    if (f.holdingCategoryMix) {
      if (f.portfolioRiskSignal === 'degen') {
        score += 15;
      }

      if (f.holdingCategoryMix.meme > 50) {
        score += 10;
      }

      if ((f.trackedTokenWeight ?? 0) > 60) {
        score += 10;
      }
    }

    // Extreme single-position concentration is a degen / yolo tell.
    if (f.portfolioConcentrationScore > 70) {
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
    // Mechanical cadence over a sustained span = automation tell.
    if (f.activityConsistencyScore > 80 && f.tradesPerDay > 3) {
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

    if (f.holdingCategoryMix) {
      if (f.holdingCategoryMix.bluechip > 40) {
        score += 10;
      }

      if ((f.portfolioDiversificationScore ?? 0) > 60) {
        score += 5;
      }
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
    features: LiteFeatureVector,
    topScore: number,
    secondScore: number,
  ): 'low' | 'medium' | 'high' {
    // Confidence is now driven by data richness signals that are available in
    // FAST_MODE: swap count, sample size, wallet age, and score separation.
    // matchedLotCount is no longer required, which lets us classify wallets
    // confidently even when FIFO is intentionally skipped.
    const richSample =
      features.swapCount >= 10 ||
      features.totalTransfers >= 25 ||
      features.walletAgeDays >= 180;
    const minimalSample =
      features.swapCount < 5 && features.totalTransfers < 10;

    if (minimalSample) {
      return 'low';
    }
    if (!richSample) {
      return 'medium';
    }
    if (topScore - secondScore < 15) {
      return 'medium';
    }
    return 'high';
  }

  private buildReasoning(
    type: string,
    f: LiteFeatureVector,
    pnlMetrics: WalletPnlMetrics | null,
  ): string {
    const holdDays =
      f.medianHoldHours !== null
        ? `${(f.medianHoldHours / 24).toFixed(1)}d median hold`
        : 'no completed holds';

    let baseReasoning: string;
    switch (type) {
      case 'Smart Money':
        baseReasoning = pnlMetrics
          ? `${pnlMetrics.winRate}% win rate, ${pnlMetrics.avgRoiPercent}% average ROI, and ${pnlMetrics.profitFactor} profit factor across realized trades.`
          : `Profitable realized trading pattern across ${f.swapCount} swaps.`;
        break;
      case 'Paper Hand':
        baseReasoning = pnlMetrics
          ? `Sells quickly at a loss: ${pnlMetrics.avgRoiPercent}% average ROI with ${pnlMetrics.avgHoldDurationHours}h average holds.`
          : `Short hold behavior across ${f.swapCount} swaps.`;
        break;
      case 'Diamond Hand':
        baseReasoning = `Holds positions for ${holdDays} with low trade frequency (${f.tradesPerDay.toFixed(2)}/day).`;
        break;
      case 'Swing Trader':
        baseReasoning = `${holdDays}, ${f.swapCount} swaps over ${f.tradingSpanDays.toFixed(0)} days - classic swing pattern.`;
        break;
      case 'Day Trader':
        baseReasoning = `Very short ${holdDays} with avg ${f.avgGapHours.toFixed(1)}h between trades.`;
        break;
      case 'Degen':
        baseReasoning = `${f.memecoinPercent}% memecoin exposure, ${holdDays}, burstiness ${f.burstinessCoeff.toFixed(2)}.`;
        break;
      case 'Bot / Automated':
        baseReasoning = `${f.tradesPerDay.toFixed(1)} trades/day with ${f.avgGapHours.toFixed(2)}h avg gap - systematic pattern.`;
        break;
      case 'Accumulator':
        baseReasoning = `More buys than sells (${f.matchedLotCount} matched vs ${f.swapCount} total swaps), ${holdDays}.`;
        break;
      case 'Whale':
        baseReasoning = `Long-term active wallet (${f.tradingSpanDays.toFixed(0)} days), ${f.blueChipPercent}% blue chip.`;
        break;
      case 'Diversified Whale':
        baseReasoning =
          `Large portfolio (${(f.totalPortfolioUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })} USD) ` +
          `with ${(f.trackedTokenWeight ?? 0).toFixed(1)}% in this token; no DEX swaps observed.`;
        break;
      case 'Conviction Holder':
      case 'Strategic Allocator':
        baseReasoning =
          `Holds ${(f.trackedTokenWeight ?? 0).toFixed(1)}% of portfolio in this token; ` +
          'no DEX trading activity detected.';
        break;
      case 'Dormant Wallet':
        baseReasoning = 'Wallet is dormant on DEXs with no recent swap history to profile.';
        break;
      default:
        baseReasoning = `Based on ${f.swapCount} swaps over ${f.tradingSpanDays.toFixed(0)} days.`;
        break;
    }

    const portfolioReasoning = this.getPortfolioReasoning(type, f);
    const contextReasoning = this.getPortfolioContextReasoning(f);

    const segments = [baseReasoning, ...portfolioReasoning];
    if (contextReasoning) {
      segments.push(contextReasoning);
    }

    return segments.join(' ');
  }

  private getPortfolioReasoning(type: string, f: LiteFeatureVector): string[] {
    if (!f.holdingCategoryMix) {
      return [];
    }

    const notes: string[] = [];

    if (type === 'Degen') {
      if (f.holdingCategoryMix.meme > 50) {
        notes.push(`Portfolio is ${f.holdingCategoryMix.meme}% meme tokens.`);
      }

      if ((f.trackedTokenWeight ?? 0) > 60) {
        notes.push(
          `This token represents ${(f.trackedTokenWeight ?? 0).toFixed(2)}% of wallet's total portfolio.`,
        );
      }
    }

    if (type === 'Diamond Hand') {
      if (
        ((f.trackedTokenWeight ?? 0) > 30 && f.holdingCategoryMix.bluechip > 30) ||
        f.portfolioRiskSignal === 'conservative' ||
        f.portfolioRiskSignal === 'balanced'
      ) {
        notes.push(
          'Diversified portfolio with significant conviction in this token.',
        );
      }
    }

    if (type === 'Accumulator') {
      if (
        f.holdingCategoryMix.bluechip > 40 ||
        (f.portfolioDiversificationScore ?? 0) > 60
      ) {
        notes.push('Bluechip-heavy portfolio suggests disciplined accumulation.');
      }
    }

    if (type === 'Swing Trader') {
      if (
        (f.portfolioDiversificationScore ?? 0) > 50 &&
        f.holdingCategoryMix.defi > 20
      ) {
        notes.push('DeFi-engaged portfolio with diversified positions.');
      }
    }

    if (type === 'Day Trader') {
      if (f.holdingCategoryMix.stablecoin > 30) {
        notes.push('High stablecoin reserves suggest active trading strategy.');
      }
    }

    return notes;
  }

  private getPortfolioContextReasoning(f: LiteFeatureVector): string | null {
    if (!f.holdingCategoryMix) {
      return null;
    }

    return (
      `Portfolio context: ${(f.portfolioRiskSignal ?? 'aggressive')} profile, ` +
      `${f.totalHoldingTokens} tokens, ${(f.trackedTokenWeight ?? 0).toFixed(2)}% allocated to this token.`
    );
  }
}
