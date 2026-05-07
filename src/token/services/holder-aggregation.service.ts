import { Injectable } from '@nestjs/common';
import { LiteClassification } from './lite-classifier.service';
import { LiteScore } from './lite-scorer.service';
import type { PortfolioContext } from './lite-portfolio.service';
import type {
  HolderLabel,
  TeamDetectionResult,
} from './token-intelligence.service';

export interface AnalyzedHolder {
  walletAddress: string;
  balance: string;
  rank: number;
  usdValue: number;
  tokenPrice: number;
  walletLabel: HolderLabel;
  walletLabelDetail?: string | null;
  isTeamLinked: boolean;
  teamConnectionPath?: string | null;
  classification: LiteClassification | null;
  score: LiteScore | null;
  portfolio?: PortfolioContext | null;
  pnl?: HolderPnlSummary | null;
  error?: string;
}

export interface HolderPnlSummary {
  totalPnlUsd: number;
  winRate: number;
  avgRoi: number;
  profitFactor: number;
  tradeCount: number;
  largestWin: number;
  largestLoss: number;
}

export interface HolderQualityMetrics {
  totalAnalyzed: number;
  avgScore: number;
  qualityLabel: string;
  breakdown: {
    convictionHolders: number;
    activeTraders: number;
    riskDegen: number;
    botsUnknown: number;
    exchanges: number;
    contractsPools: number;
    teamConnected: number;
    burnDead: number;
    vestingLocked: number;
  };
  topHolderAvgScore: number;
  pnlAggregation: HolderPnlAggregation;
}

export interface HolderPnlAggregation {
  holdersWithPnlData: number;
  avgWinRate: number | null;
  avgProfitFactor: number | null;
  holdersInProfit: number;
  holdersAtLoss: number;
  smartMoneyCount: number;
}

export interface HolderDistribution {
  totalHolders: number;
  buckets: {
    micro: number;
    small: number;
    medium: number;
    whale: number;
  };
  supplyConcentration: {
    top10Pct: number;
    top50Pct: number;
    top100Pct: number;
  };
  giniCoefficient: number;
  decentralizationScore: number;
}

export interface RiskCallout {
  type: 'warning' | 'positive' | 'info';
  title: string;
  description: string;
}

@Injectable()
export class HolderAggregationService {
  // 1. Compute quality metrics from classification results
  computeQualityMetrics(holders: AnalyzedHolder[]): HolderQualityMetrics {
    const totalHolders = holders.length;
    const exchangeCount = holders.filter(
      (holder) =>
        holder.walletLabel === 'exchange' || holder.walletLabel === 'cex_deposit',
    ).length;
    const contractPoolCount = holders.filter((holder) =>
      [
        'dex_pool',
        'dex_router',
        'staking',
        'generic_contract',
        'bridge',
      ].includes(holder.walletLabel),
    ).length;
    const teamConnectedCount = holders.filter((holder) => holder.isTeamLinked).length;
    const burnDeadCount = holders.filter(
      (holder) => holder.walletLabel === 'burn',
    ).length;
    const vestingLockedCount = holders.filter(
      (holder) => holder.walletLabel === 'vesting',
    ).length;
    const analyzed = holders.filter(
      (holder) => holder.classification !== null && holder.score !== null,
    );

    if (analyzed.length === 0) {
      return {
        totalAnalyzed: 0,
        avgScore: 0,
        qualityLabel: 'No Data',
        breakdown: {
          convictionHolders: 0,
          activeTraders: 0,
          riskDegen: 0,
          botsUnknown: 0,
          exchanges:
            totalHolders > 0
              ? Math.round((exchangeCount / totalHolders) * 100)
              : 0,
          contractsPools:
            totalHolders > 0
              ? Math.round((contractPoolCount / totalHolders) * 100)
              : 0,
          teamConnected:
            totalHolders > 0
              ? Math.round((teamConnectedCount / totalHolders) * 100)
              : 0,
          burnDead:
            totalHolders > 0
              ? Math.round((burnDeadCount / totalHolders) * 100)
              : 0,
          vestingLocked:
            totalHolders > 0
              ? Math.round((vestingLockedCount / totalHolders) * 100)
              : 0,
        },
        topHolderAvgScore: 0,
        pnlAggregation: this.computePnlAggregation(holders),
      };
    }

    const totalAnalyzed = analyzed.length;
    const scores = analyzed.map((holder) => holder.score!.score);
    const avgScore = Math.round(
      scores.reduce((total, value) => total + value, 0) / scores.length,
    );

    // Group archetypes into 4 display categories
    let convictionCount = 0;
    let activeTraderCount = 0;
    let riskDegenCount = 0;
    let botsUnknownCount = 0;

    for (const holder of analyzed) {
      const type = holder.classification!.primaryType;

      if (['Diamond Hand', 'Accumulator'].includes(type)) {
        convictionCount += 1;
      } else if (['Swing Trader', 'Day Trader'].includes(type)) {
        activeTraderCount += 1;
      } else if (['Degen'].includes(type)) {
        riskDegenCount += 1;
      } else {
        botsUnknownCount += 1; // Bot, Insufficient Data, Whale
      }
    }

    const pct = (value: number): number =>
      Math.round((value / totalAnalyzed) * 100);

    // Top 10 avg score
    const top10 = [...analyzed]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 10);

    const topHolderAvgScore =
      top10.length > 0
        ? Math.round(
            top10
              .map((holder) => holder.score!.score)
              .reduce((total, value) => total + value, 0) / top10.length,
          )
        : 0;

    const qualityLabel =
      avgScore >= 70
        ? 'Strong Community'
        : avgScore >= 50
          ? 'Average Community'
          : avgScore >= 30
            ? 'Developing Community'
            : 'Weak Community';

    return {
      totalAnalyzed,
      avgScore,
      qualityLabel,
      breakdown: {
        convictionHolders: pct(convictionCount),
        activeTraders: pct(activeTraderCount),
        riskDegen: pct(riskDegenCount),
        botsUnknown: pct(botsUnknownCount),
        exchanges:
          totalHolders > 0 ? Math.round((exchangeCount / totalHolders) * 100) : 0,
        contractsPools:
          totalHolders > 0
            ? Math.round((contractPoolCount / totalHolders) * 100)
            : 0,
        teamConnected:
          totalHolders > 0
            ? Math.round((teamConnectedCount / totalHolders) * 100)
            : 0,
        burnDead:
          totalHolders > 0
            ? Math.round((burnDeadCount / totalHolders) * 100)
            : 0,
        vestingLocked:
          totalHolders > 0
            ? Math.round((vestingLockedCount / totalHolders) * 100)
            : 0,
      },
      topHolderAvgScore,
      pnlAggregation: this.computePnlAggregation(holders),
    };
  }

  // 2. Compute distribution metrics + Gini coefficient
  computeDistribution(
    holders: Array<{ walletAddress: string; balance: string; rank: number }>,
    totalSupply: string,
    totalSupplyFormatted: number | null = null,
  ): HolderDistribution {
    const rankedHolders = [...holders].sort((left, right) => left.rank - right.rank);
    const totalHolders = rankedHolders.length;

    if (totalHolders === 0) {
      return {
        totalHolders: 0,
        buckets: { micro: 0, small: 0, medium: 0, whale: 0 },
        supplyConcentration: { top10Pct: 0, top50Pct: 0, top100Pct: 0 },
        giniCoefficient: 0,
        decentralizationScore: 50,
      };
    }

    const balances = rankedHolders.map((holder) =>
      this.parseBalanceAsNumber(holder.balance),
    );
    const totalHeld = balances.reduce((total, value) => total + value, 0);

    const onchainTotal =
      typeof totalSupplyFormatted === 'number' &&
      Number.isFinite(totalSupplyFormatted) &&
      totalSupplyFormatted > 0
        ? totalSupplyFormatted
        : null;
    const rawTotalCandidate = this.parseBalanceAsNumber(totalSupply);
    const rawTotal =
      Number.isFinite(rawTotalCandidate) && rawTotalCandidate > 0
        ? rawTotalCandidate
        : null;
    const effectiveTotal = onchainTotal ?? rawTotal ?? totalHeld;

    // Holder size buckets by % of supply
    const buckets = { micro: 0, small: 0, medium: 0, whale: 0 };

    for (const balance of balances) {
      const pct =
        effectiveTotal > 0
          ? (balance / effectiveTotal) * 100
          : 0;

      if (pct > 1) {
        buckets.whale += 1;
      } else if (pct > 0.1) {
        buckets.medium += 1;
      } else if (pct > 0.01) {
        buckets.small += 1;
      } else {
        buckets.micro += 1;
      }
    }

    // Supply concentration
    const pctHeld = (count: number): number => {
      const top = balances.slice(0, count).reduce((total, value) => total + value, 0);
      return effectiveTotal > 0
        ? Math.round((top / effectiveTotal) * 100)
        : 0;
    };

    // Gini coefficient
    const gini = this.computeGini(balances);

    return {
      totalHolders,
      buckets,
      supplyConcentration: {
        top10Pct: pctHeld(Math.min(10, totalHolders)),
        top50Pct: pctHeld(Math.min(50, totalHolders)),
        top100Pct: pctHeld(Math.min(100, totalHolders)),
      },
      giniCoefficient: Math.round(gini * 100) / 100,
      decentralizationScore: Math.round((1 - gini) * 100),
    };
  }

  // 3. Generate 3-5 auto risk callouts
  generateRiskCallouts(
    quality: HolderQualityMetrics,
    distribution: HolderDistribution,
    holders: AnalyzedHolder[] = [],
    teamDetection: TeamDetectionResult | null = null,
  ): RiskCallout[] {
    const callouts: RiskCallout[] = [];

    // Concentration warnings
    if (distribution.supplyConcentration.top10Pct > 50) {
      callouts.push({
        type: 'warning',
        title: 'High Concentration Risk',
        description: `Top 10 holders control ${distribution.supplyConcentration.top10Pct}% of supply. High sell pressure risk.`,
      });
    }

    // Degen holders
    if (quality.breakdown.riskDegen > 30) {
      callouts.push({
        type: 'warning',
        title: 'High Churn Risk',
        description: `${quality.breakdown.riskDegen}% of top holders are high-risk/degen traders with short hold histories.`,
      });
    }

    // Bot activity
    if (quality.breakdown.botsUnknown > 20) {
      callouts.push({
        type: 'warning',
        title: 'Bot Activity Detected',
        description: `${quality.breakdown.botsUnknown}% of holders show automated or unclassifiable trading patterns.`,
      });
    }

    if (teamDetection?.riskLevel === 'critical') {
      callouts.push({
        type: 'warning',
        title: 'Critical Team Concentration',
        description: `Team-connected wallets control ${teamDetection.teamTotalPctOfSupply.toFixed(1)}% of total supply across ${teamDetection.teamWalletCount} wallets. This represents significant centralization risk.`,
      });
    }

    if (teamDetection?.riskLevel === 'high') {
      callouts.push({
        type: 'warning',
        title: 'High Team Wallet Concentration',
        description: `${teamDetection.teamWalletCount} team-connected wallets hold ${teamDetection.teamTotalPctOfSupply.toFixed(1)}% of supply. Monitor for distribution events.`,
      });
    }

    // Positive signals
    if (quality.breakdown.convictionHolders > 50) {
      callouts.push({
        type: 'positive',
        title: 'Strong Conviction Base',
        description: `${quality.breakdown.convictionHolders}% of top holders are Diamond Hands or Accumulators - long-term believers.`,
      });
    }

    if (quality.avgScore > 65) {
      callouts.push({
        type: 'positive',
        title: 'Above-Average Holder Quality',
        description: `Average holder score is ${quality.avgScore}/100 - significantly above the platform average of 51.`,
      });
    }

    if (distribution.decentralizationScore > 70) {
      callouts.push({
        type: 'positive',
        title: 'Well Distributed Supply',
        description: `Decentralization score ${distribution.decentralizationScore}/100 - supply is relatively well distributed.`,
      });
    }

    const pnlAggregation = quality.pnlAggregation;
    if (pnlAggregation.holdersWithPnlData > 10) {
      const smartPct = Math.round(
        (pnlAggregation.smartMoneyCount / pnlAggregation.holdersWithPnlData) * 100,
      );

      if (smartPct > 30) {
        callouts.push({
          type: 'positive',
          title: 'Strong Smart Money Presence',
          description: `${smartPct}% of analyzed holders show profitable trading histories (win rate >60%, profit factor >1.5).`,
        });
      }

      if (pnlAggregation.avgWinRate !== null && pnlAggregation.avgWinRate < 35) {
        callouts.push({
          type: 'warning',
          title: 'Low Holder Profitability',
          description: `Average win rate across analyzed holders is ${pnlAggregation.avgWinRate}%. Most holders are losing money on their trades.`,
        });
      }
    }

    const exchangeConcentrationPct = this.computeExchangeSupplyConcentration(holders);
    if (exchangeConcentrationPct > 30) {
      callouts.push({
        type: 'info',
        title: 'Significant Exchange Holdings',
        description: `Exchange wallets hold approximately ${exchangeConcentrationPct}% of analyzed supply. Actual retail holder distribution may differ.`,
      });
    }

    const dexPoolCount = holders.filter(
      (holder) => holder.walletLabel === 'dex_pool',
    ).length;
    if (dexPoolCount > 0) {
      callouts.push({
        type: 'info',
        title: 'DEX Liquidity Pools Detected',
        description: `${dexPoolCount} liquidity pool(s) found among top holders.`,
      });
    }

    // Always have at least one callout
    if (callouts.length === 0) {
      callouts.push({
        type: 'info',
        title: 'Standard Distribution',
        description:
          'Holder distribution and quality metrics are within normal ranges for a token of this size.',
      });
    }

    return callouts.slice(0, 5);
  }

  private computeExchangeSupplyConcentration(holders: AnalyzedHolder[]): number {
    if (holders.length === 0) {
      return 0;
    }

    const totalSupply = holders.reduce(
      (sum, holder) => sum + this.parseBalanceAsNumber(holder.balance),
      0,
    );
    if (totalSupply <= 0) {
      return 0;
    }

    const exchangeSupply = holders
      .filter(
        (holder) =>
          holder.walletLabel === 'exchange' || holder.walletLabel === 'cex_deposit',
      )
      .reduce((sum, holder) => sum + this.parseBalanceAsNumber(holder.balance), 0);

    return Math.round((exchangeSupply / totalSupply) * 10000) / 100;
  }

  // --- GINI COEFFICIENT ---
  // 0 = perfectly equal, 1 = one wallet holds everything
  private computeGini(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const total = sorted.reduce((sum, value) => sum + value, 0);

    if (total === 0) {
      return 0;
    }

    let numerator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (2 * (i + 1) - n - 1) * sorted[i];
    }

    return Math.abs(numerator / (n * total));
  }

  private computePnlAggregation(holders: AnalyzedHolder[]): HolderPnlAggregation {
    const holdersWithPnl = holders.filter(
      (holder): holder is AnalyzedHolder & { pnl: HolderPnlSummary } =>
        holder.pnl !== null && holder.pnl !== undefined,
    );

    return {
      holdersWithPnlData: holdersWithPnl.length,
      avgWinRate:
        holdersWithPnl.length > 0
          ? this.roundAverage(holdersWithPnl.map((holder) => holder.pnl.winRate))
          : null,
      avgProfitFactor:
        holdersWithPnl.length > 0
          ? this.roundAverage(holdersWithPnl.map((holder) => holder.pnl.profitFactor))
          : null,
      holdersInProfit: holdersWithPnl.filter((holder) => holder.pnl.totalPnlUsd > 0)
        .length,
      holdersAtLoss: holdersWithPnl.filter((holder) => holder.pnl.totalPnlUsd < 0)
        .length,
      smartMoneyCount: holdersWithPnl.filter(
        (holder) => holder.pnl.winRate > 60 && holder.pnl.profitFactor > 1.5,
      ).length,
    };
  }

  private roundAverage(values: number[]): number {
    return Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * 100,
    ) / 100;
  }

  private parseBigIntSafe(value: string): bigint {
    try {
      return BigInt(value || '0');
    } catch {
      return 0n;
    }
  }

  private parseBalanceAsNumber(value: string): number {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    const asBigInt = this.parseBigIntSafe(value);
    return Number(asBigInt);
  }
}
