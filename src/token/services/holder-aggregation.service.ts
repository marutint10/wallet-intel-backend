import { Injectable, Logger } from '@nestjs/common';
import { LiteClassification } from './lite-classifier.service';
import { LiteScore } from './lite-scorer.service';
import type { PortfolioContext } from './lite-portfolio.service';
import type {
  HolderLabel,
  LabelEvidence,
  TeamDetectionResult,
} from './token-intelligence.service';

export interface AnalyzedHolder {
  walletAddress: string;
  balance: string;
  rawBalance?: string;
  rank: number;
  usdValue: number;
  tokenPrice: number;
  walletLabel: HolderLabel;
  walletLabelDetail?: string | null;
  // Etherscan-resolved contract name surfaced for `generic_contract` holders
  // (e.g. "GnosisSafeProxy", "ERC1967Proxy"). Null for every other label.
  knownLabel: string | null;
  isTeamLinked: boolean;
  teamConnectionPath?: string | null;
  labelConfidence: number;
  labelEvidence: LabelEvidence[];
  teamConnectionScore: number;
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
  scoredHolderCount: number;
  totalAnalyzedEOAs: number;
  avgScore: number;
  qualityLabel: string;
  breakdown: {
    convictionHolders: number;
    diamondHands: number;
    activeTraders: number;
    riskDegen: number;
    bots: number;
    dormant: number;
    exchanges: number;
    contractsPools: number;
    teamConnected: number;
    burnDead: number;
    vestingLocked: number;
  };
  /** Raw EOA archetype counts; sums to totalAnalyzedEOAs. */
  breakdownCounts: {
    convictionHolders: number;
    diamondHands: number;
    activeTraders: number;
    riskDegen: number;
    bots: number;
    dormant: number;
  };
  topHolderAvgScore: number;
  pnlAggregation: HolderPnlAggregation;
  categoryConcentration: CategoryConcentration;
}

export interface CategoryConcentration {
  eoaHolders: {
    count: number;
    pctOfSupply: number;
    avgScore: number | null;
    scoredCount: number;
  };
  teamLinked: { count: number; pctOfSupply: number; avgConfidence: number };
  exchanges: { count: number; pctOfSupply: number };
  contractsAndPools: { count: number; pctOfSupply: number };
  vestingLocked: { count: number; pctOfSupply: number };
  burnDead: { count: number; pctOfSupply: number };
  dust: { count: number; pctOfSupply: number };
}

export interface HolderPnlAggregation {
  holdersWithPnlData: number;
  avgWinRate: number | null;
  avgProfitFactor: number | null;
  holdersInProfit: number;
  holdersAtLoss: number;
  smartMoneyCount: number;
  portfolioSmartMoneyCount: number;
}

function isUnclassifiedHolderType(primaryType: string | null | undefined): boolean {
  return (
    !primaryType ||
    primaryType === 'Insufficient Data' ||
    primaryType === 'Dormant Wallet'
  );
}

function isBehavioralEoaHolder(holder: AnalyzedHolder): boolean {
  return holder.walletLabel === 'eoa' || holder.walletLabel === 'team_connected';
}

/** Largest-remainder allocation so rounded behavioral % sum to 100. */
function distributeBehavioralPercentages(
  counts: {
    convictionHolders: number;
    diamondHands: number;
    activeTraders: number;
    riskDegen: number;
    bots: number;
    dormant: number;
  },
  total: number,
): typeof counts {
  if (total <= 0) {
    return {
      convictionHolders: 0,
      diamondHands: 0,
      activeTraders: 0,
      riskDegen: 0,
      bots: 0,
      dormant: 0,
    };
  }

  const keys = [
    'convictionHolders',
    'diamondHands',
    'activeTraders',
    'riskDegen',
    'bots',
    'dormant',
  ] as const;

  const allocated = keys.map((key) => {
    const exact = (counts[key] / total) * 100;
    return {
      key,
      pct: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  let leftover = 100 - allocated.reduce((sum, entry) => sum + entry.pct, 0);
  allocated.sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; leftover > 0; index += 1) {
    allocated[index % allocated.length].pct += 1;
    leftover -= 1;
  }

  return {
    convictionHolders: allocated.find((entry) => entry.key === 'convictionHolders')!.pct,
    diamondHands: allocated.find((entry) => entry.key === 'diamondHands')!.pct,
    activeTraders: allocated.find((entry) => entry.key === 'activeTraders')!.pct,
    riskDegen: allocated.find((entry) => entry.key === 'riskDegen')!.pct,
    bots: allocated.find((entry) => entry.key === 'bots')!.pct,
    dormant: allocated.find((entry) => entry.key === 'dormant')!.pct,
  };
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
  private readonly logger = new Logger(HolderAggregationService.name);

  // 1. Compute quality metrics from classification results
  computeQualityMetrics(
    holders: AnalyzedHolder[],
    totalSupply: string = '0',
    totalSupplyFormatted: number | null = null,
  ): HolderQualityMetrics {
    const totalHolders = holders.length;
    const categoryConcentration = this.computeCategoryConcentration(
      holders,
      totalSupply,
      totalSupplyFormatted,
    );
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
    const analyzedEOAHolders = holders.filter(isBehavioralEoaHolder);
    const totalAnalyzedEOAs = analyzedEOAHolders.length;
    const scoredHolders = analyzedEOAHolders.filter(
      (holder) => typeof holder.score?.score === 'number' && holder.score.score > 0,
    );
    const scoredHolderCount = scoredHolders.length;
    const avgScore =
      scoredHolderCount > 0
        ? Math.round(
            scoredHolders.reduce((sum, holder) => sum + holder.score!.score, 0) /
              scoredHolderCount,
          )
        : 0;

    const breakdownCounts = {
      convictionHolders: 0,
      diamondHands: 0,
      activeTraders: 0,
      riskDegen: 0,
      bots: 0,
      dormant: 0,
    };

    for (const holder of analyzedEOAHolders) {
      const type = holder.classification?.primaryType ?? null;

      if (holder.classification === null || isUnclassifiedHolderType(type)) {
        breakdownCounts.dormant += 1;
        continue;
      }

      switch (type) {
        case 'Diamond Hand':
          breakdownCounts.diamondHands += 1;
          break;
        case 'Conviction Holder':
        case 'Diversified Whale':
        case 'Strategic Allocator':
          breakdownCounts.convictionHolders += 1;
          break;
        case 'Swing Trader':
        case 'Day Trader':
        case 'Accumulator':
          breakdownCounts.activeTraders += 1;
          break;
        case 'Degen':
        case 'Paper Hand':
          breakdownCounts.riskDegen += 1;
          break;
        case 'Bot / Automated':
          breakdownCounts.bots += 1;
          break;
        default:
          breakdownCounts.dormant += 1;
          break;
      }
    }

    const behavioralBucketTotal =
      breakdownCounts.convictionHolders +
      breakdownCounts.diamondHands +
      breakdownCounts.activeTraders +
      breakdownCounts.riskDegen +
      breakdownCounts.bots +
      breakdownCounts.dormant;

    if (behavioralBucketTotal !== totalAnalyzedEOAs) {
      this.logger.warn(
        `EOA breakdown invariant mismatch: ${behavioralBucketTotal} bucketed vs ${totalAnalyzedEOAs} EOAs`,
      );
    }

    const behavioralPct = distributeBehavioralPercentages(
      breakdownCounts,
      totalAnalyzedEOAs,
    );

    const pct = (value: number): number =>
      totalHolders > 0 ? Math.round((value / totalHolders) * 100) : 0;

    // Top 10 avg score from holders that have a usable score.
    const top10 = [...scoredHolders]
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

    const baseQualityLabel = this.computeQualityLabel(
      avgScore,
      breakdownCounts.convictionHolders +
        breakdownCounts.diamondHands +
        breakdownCounts.activeTraders,
      breakdownCounts.riskDegen,
      breakdownCounts.bots,
      totalAnalyzedEOAs,
    );
    const qualityLabel =
      scoredHolderCount === 0
        ? 'Insufficient Trading Data'
        : scoredHolderCount < 5
          ? `Limited Data - ${baseQualityLabel}`
          : baseQualityLabel;

    const pnlAggregation = this.computePnlAggregation(analyzedEOAHolders);

    return {
      totalAnalyzed: totalAnalyzedEOAs,
      scoredHolderCount,
      totalAnalyzedEOAs,
      avgScore,
      qualityLabel,
      breakdown: {
        convictionHolders: behavioralPct.convictionHolders,
        diamondHands: behavioralPct.diamondHands,
        activeTraders: behavioralPct.activeTraders,
        riskDegen: behavioralPct.riskDegen,
        bots: behavioralPct.bots,
        dormant: behavioralPct.dormant,
        exchanges: pct(exchangeCount),
        contractsPools: pct(contractPoolCount),
        teamConnected: pct(teamConnectedCount),
        burnDead: pct(burnDeadCount),
        vestingLocked: pct(vestingLockedCount),
      },
      breakdownCounts,
      topHolderAvgScore,
      pnlAggregation,
      categoryConcentration,
    };
  }

  private computeQualityLabel(
    avgScore: number,
    loyaltyHolderCount: number,
    riskDegenCount: number,
    confirmedBotCount: number,
    totalAnalyzedEOAs: number,
  ): string {
    if (totalAnalyzedEOAs <= 0) {
      return 'Weak Community';
    }

    const convictionPct = (loyaltyHolderCount / totalAnalyzedEOAs) * 100;
    const degenRiskPct =
      ((riskDegenCount + confirmedBotCount) / totalAnalyzedEOAs) * 100;

    const effectiveScore =
      avgScore +
      (convictionPct > 40 ? 8 : convictionPct > 25 ? 4 : 0) -
      (degenRiskPct > 30 ? 8 : degenRiskPct > 15 ? 4 : 0);

    if (effectiveScore >= 70) {
      return 'Strong Community';
    }
    if (effectiveScore >= 50) {
      return 'Average Community';
    }
    if (effectiveScore >= 30) {
      return 'Developing Community';
    }
    return 'Weak Community';
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

    const analyzedEOAHolders = holders.filter(isBehavioralEoaHolder);
    const totalAnalyzedEOAs = analyzedEOAHolders.length;
    const confirmedBotCount = analyzedEOAHolders.filter(
      (holder) => holder.classification?.primaryType === 'Bot / Automated',
    ).length;
    const confirmedBotPct =
      totalAnalyzedEOAs > 0
        ? Math.round((confirmedBotCount / totalAnalyzedEOAs) * 100)
        : 0;
    const dormantOrUnknownCount = analyzedEOAHolders.filter((holder) =>
      isUnclassifiedHolderType(holder.classification?.primaryType ?? null),
    ).length;
    const analysisFailedCount = analyzedEOAHolders.filter(
      (holder) => holder.classification === null,
    ).length;
    const dormantPct =
      totalAnalyzedEOAs > 0
        ? Math.round((dormantOrUnknownCount / totalAnalyzedEOAs) * 100)
        : 0;

    // Confirmed bot activity only.
    if (confirmedBotPct > 10) {
      callouts.push({
        type: 'warning',
        title: 'Bot Activity Detected',
        description: `${confirmedBotPct}% of analyzed holders show confirmed automated trading patterns (24/7 activity, uniform timing).`,
      });
    }

    if (dormantPct > 50) {
      callouts.push({
        type: 'info',
        title: 'Limited Trading Data Available',
        description: `${dormantPct}% of top holders have insufficient on-chain swap history for behavioral classification. These wallets likely acquired tokens via transfers, OTC, or exchange withdrawals rather than DEX trading.`,
      });
    }

    if (analysisFailedCount > 0) {
      callouts.push({
        type: 'info',
        title: 'Partial Analysis Coverage',
        description: `${analysisFailedCount} EOA holder(s) could not be fully analyzed by the pipeline.`,
      });
    }

    const classifiedTraderHolders = analyzedEOAHolders.filter(
      (holder) =>
        Boolean(holder.classification?.primaryType) &&
        holder.classification!.primaryType !== 'Insufficient Data' &&
        holder.classification!.primaryType !== 'Dormant Wallet',
    );
    const classifiedTraderCount = classifiedTraderHolders.length;

    if (classifiedTraderCount >= 3) {
      const typeBreakdown: Record<string, number> = {};

      for (const holder of classifiedTraderHolders) {
        const type = holder.classification!.primaryType;
        typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;
      }

      const typeList = Object.entries(typeBreakdown)
        .sort((left, right) => right[1] - left[1])
        .map(([type, count]) => `${count} ${type}(s)`)
        .join(', ');

      callouts.push({
        type: 'positive',
        title: 'Active Traders Identified',
        description: `${classifiedTraderCount} holder(s) with classifiable trading behavior: ${typeList}.`,
      });
    }

    if (quality.categoryConcentration.eoaHolders.pctOfSupply < 30) {
      callouts.push({
        type: 'warning',
        title: 'Low Retail Holder Concentration',
        description: `Only ${quality.categoryConcentration.eoaHolders.pctOfSupply.toFixed(1)}% of analyzed supply is held by individual wallets (EOAs). The majority is in exchanges, contracts, and team wallets.`,
      });
    }

    if (
      quality.categoryConcentration.teamLinked.count > 0 &&
      quality.categoryConcentration.teamLinked.avgConfidence > 70
    ) {
      callouts.push({
        type: 'info',
        title: 'High-Confidence Team Detection',
        description: `${quality.categoryConcentration.teamLinked.count} team-connected wallet(s) identified with average confidence score of ${quality.categoryConcentration.teamLinked.avgConfidence}. Evidence-based detection, not speculation.`,
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

  private computeCategoryConcentration(
    holders: AnalyzedHolder[],
    totalSupply: string,
    totalSupplyFormatted: number | null,
  ): CategoryConcentration {
    const totals = {
      eoa: { count: 0, balance: 0, scoreSum: 0, scoredCount: 0 },
      team: { count: 0, balance: 0, confidenceSum: 0 },
      exchanges: { count: 0, balance: 0 },
      contracts: { count: 0, balance: 0 },
      vesting: { count: 0, balance: 0 },
      burn: { count: 0, balance: 0 },
      dust: { count: 0, balance: 0 },
    };

    const totalHeld = holders.reduce(
      (sum, holder) => sum + this.parseBalanceAsNumber(holder.balance),
      0,
    );
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
    const effectiveSupply = onchainTotal ?? rawTotal ?? totalHeld;

    for (const holder of holders) {
      const balance = this.parseBalanceAsNumber(holder.balance);

      if (holder.walletLabel === 'eoa') {
        totals.eoa.count += 1;
        totals.eoa.balance += balance;
        const score = holder.score?.score;
        const primaryType = holder.classification?.primaryType ?? null;
        if (
          typeof score === 'number' &&
          score > 0 &&
          !isUnclassifiedHolderType(primaryType)
        ) {
          totals.eoa.scoreSum += score;
          totals.eoa.scoredCount += 1;
        }
      }

      if (holder.isTeamLinked) {
        totals.team.count += 1;
        totals.team.balance += balance;
        totals.team.confidenceSum += holder.teamConnectionScore;
      }

      if (holder.walletLabel === 'exchange' || holder.walletLabel === 'cex_deposit') {
        totals.exchanges.count += 1;
        totals.exchanges.balance += balance;
      }

      if (
        ['dex_pool', 'dex_router', 'bridge', 'staking', 'generic_contract'].includes(
          holder.walletLabel,
        )
      ) {
        totals.contracts.count += 1;
        totals.contracts.balance += balance;
      }

      if (holder.walletLabel === 'vesting') {
        totals.vesting.count += 1;
        totals.vesting.balance += balance;
      }

      if (holder.walletLabel === 'burn') {
        totals.burn.count += 1;
        totals.burn.balance += balance;
      }

      if (holder.walletLabel === 'dust') {
        totals.dust.count += 1;
        totals.dust.balance += balance;
      }
    }

    const toPct = (value: number): number =>
      effectiveSupply > 0 ? Math.round((value / effectiveSupply) * 10000) / 100 : 0;

    return {
      eoaHolders: {
        count: totals.eoa.count,
        pctOfSupply: toPct(totals.eoa.balance),
        avgScore:
          totals.eoa.scoredCount > 0
            ? Math.round(totals.eoa.scoreSum / totals.eoa.scoredCount)
            : null,
        scoredCount: totals.eoa.scoredCount,
      },
      teamLinked: {
        count: totals.team.count,
        pctOfSupply: toPct(totals.team.balance),
        avgConfidence:
          totals.team.count > 0
            ? Math.round(totals.team.confidenceSum / totals.team.count)
            : 0,
      },
      exchanges: {
        count: totals.exchanges.count,
        pctOfSupply: toPct(totals.exchanges.balance),
      },
      contractsAndPools: {
        count: totals.contracts.count,
        pctOfSupply: toPct(totals.contracts.balance),
      },
      vestingLocked: {
        count: totals.vesting.count,
        pctOfSupply: toPct(totals.vesting.balance),
      },
      burnDead: {
        count: totals.burn.count,
        pctOfSupply: toPct(totals.burn.balance),
      },
      dust: {
        count: totals.dust.count,
        pctOfSupply: toPct(totals.dust.balance),
      },
    };
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
      portfolioSmartMoneyCount: this.computePortfolioSmartMoneyCount(holders),
    };
  }

  private computePortfolioSmartMoneyCount(holders: AnalyzedHolder[]): number {
    return holders
      .filter(isBehavioralEoaHolder)
      .filter((holder) => {
        if (!holder.classification) {
          return false;
        }

        const type = holder.classification.primaryType;
        const portfolio = holder.portfolio;
        const score = holder.score?.score ?? 0;

        if (
          type === 'Diversified Whale' &&
          (portfolio?.totalPortfolioUsd ?? 0) >= 500_000
        ) {
          return true;
        }

        if ((portfolio?.totalPortfolioUsd ?? 0) >= 1_000_000 && score >= 40) {
          return true;
        }

        if (score >= 75) {
          return true;
        }

        return false;
      }).length;
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
