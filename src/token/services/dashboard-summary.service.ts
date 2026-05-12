import { Injectable } from '@nestjs/common';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import type { RiskCallout } from './holder-aggregation.service';

// =============================================================================
// DashboardSummaryService
// -----------------------------------------------------------------------------
// PRESENTATION LAYER ONLY.
//
// This service transforms a persisted TokenAnalysisEntity (the raw analytics
// payload produced by TokenAnalysisService + HolderAggregationService) into a
// lightweight, frontend-ready DTO for the V1 B2B token intelligence dashboard.
//
// Hard rules:
//   * never mutate or re-derive analytics
//   * never throw on partial / missing data
//   * never assume any nested field exists
//
// All helper functions are pure, side-effect free, and tolerant of null /
// undefined / type-coerced JSONB values that may come back from Postgres.
// =============================================================================

// -----------------------------
// Public response interfaces
// -----------------------------

export interface SummaryCard {
  title: string;
  value: string | number;
  subtitle?: string;
  sentiment?: 'positive' | 'neutral' | 'warning';
}

export interface HolderQualityBreakdown {
  diamondHands: number;
  accumulators: number;
  swingTraders: number;
  dayTraders: number;
  degens: number;
  bots: number;
  unclassified: number;
}

export interface HolderTableRow {
  rank: number;
  walletAddress: string;
  shortAddress: string;
  balanceUsd: number;
  percentSupply: number;
  classification: string | null;
  confidence: string | null;
  score: number | null;
  walletLabel: string | null;
  teamLinked: boolean;
  portfolioRisk: string | null;
  lastActiveDays: number | null;
}

export interface DistributionSummary {
  decentralizationScore: number;
  giniCoefficient: number;
  top10Pct: number;
  top50Pct: number;
  top100Pct: number;
}

export interface DashboardSummaryResponse {
  token: {
    contractAddress: string;
    chain: string;
    tokenName?: string | null;
    tokenSymbol?: string | null;
    tokenPriceUsd?: number | null;
  };

  summaryCards: SummaryCard[];

  holderQuality: {
    avgScore: number | null;
    qualityLabel: string;
    smartMoneyPct: number;
    convictionPct: number;
    activeTraderPct: number;
    degenPct: number;
    botPct: number;
  };

  holderQualityBreakdown: HolderQualityBreakdown;

  distribution: DistributionSummary;

  holderTable: {
    total: number;
    rows: HolderTableRow[];
  };

  riskCallouts: RiskCallout[];
}

// -----------------------------
// Internal lenient shapes
// -----------------------------
// We avoid importing the heavy AnalyzedHolder type here because the entity
// stores `holdersData` as `unknown[]`. Re-asserting on a narrowed lenient
// shape keeps this layer decoupled from analytics evolution.

interface RawHolder {
  rank?: unknown;
  walletAddress?: unknown;
  balance?: unknown;
  usdValue?: unknown;
  walletLabel?: unknown;
  isTeamLinked?: unknown;
  classification?: {
    primaryType?: unknown;
    confidence?: unknown;
  } | null;
  score?: { score?: unknown } | null;
  portfolio?: { portfolioRiskSignal?: unknown } | null;
  features?: { daysSinceLastActivity?: unknown } | null;
}

@Injectable()
export class DashboardSummaryService {
  // ===========================================================================
  // Main entrypoint
  // ===========================================================================
  buildDashboardSummary(
    analysis: TokenAnalysisEntity,
  ): DashboardSummaryResponse {
    const quality = (analysis.qualityMetrics ?? {}) as Record<string, unknown>;
    const distribution = (analysis.distribution ?? {}) as Record<string, unknown>;
    const rawHolders = Array.isArray(analysis.holdersData)
      ? (analysis.holdersData as RawHolder[])
      : [];
    const riskCallouts = Array.isArray(analysis.riskCallouts)
      ? (analysis.riskCallouts as RiskCallout[])
      : [];

    const tokenPriceUsd = safeNumberOrNull(quality.tokenPriceUsd);
    const totalSupplyFormatted = parseTotalSupply(quality.totalSupply);

    const holderTableRows = buildHolderTableRows(rawHolders, totalSupplyFormatted);
    const holderQualityBreakdown = computeHolderQualityBreakdown(rawHolders);
    const distributionSummary = buildDistributionSummary(distribution);

    const breakdown = (quality.breakdown ?? {}) as Record<string, unknown>;
    const pnlAggregation = (quality.pnlAggregation ?? {}) as Record<
      string,
      unknown
    >;
    const categoryConcentration = (quality.categoryConcentration ?? {}) as Record<
      string,
      unknown
    >;
    const teamDetection = (quality.teamDetection ?? null) as Record<
      string,
      unknown
    > | null;

    const totalAnalyzedEOAs = safeNumber(quality.totalAnalyzedEOAs);
    const smartMoneyCount = safeNumber(pnlAggregation.smartMoneyCount);
    const smartMoneyPct = computeSmartMoneyPct(
      smartMoneyCount,
      totalAnalyzedEOAs,
      rawHolders,
    );

    const avgScoreRaw = safeNumberOrNull(quality.avgScore);
    const qualityLabel = safeString(quality.qualityLabel, 'Unknown');

    const convictionPct = safeNumber(breakdown.convictionHolders);
    const activeTraderPct = safeNumber(breakdown.activeTraders);
    const degenPct = safeNumber(breakdown.riskDegen);
    const botPct = safeNumber(breakdown.bots);

    const teamPctOfSupply = safeNumber(
      (teamDetection ?? {}).teamTotalPctOfSupply,
    );
    const exchangesEntry = (categoryConcentration.exchanges ?? {}) as Record<
      string,
      unknown
    >;
    const exchangePctOfSupply = safeNumber(exchangesEntry.pctOfSupply);

    const summaryCards = buildSummaryCards({
      avgScore: avgScoreRaw,
      smartMoneyPct,
      top10Pct: distributionSummary.top10Pct,
      decentralizationScore: distributionSummary.decentralizationScore,
      teamPctOfSupply,
      exchangePctOfSupply,
      botPct,
    });

    return {
      token: {
        contractAddress: analysis.contractAddress,
        chain: analysis.chain,
        tokenName: analysis.tokenName ?? null,
        tokenSymbol: analysis.tokenSymbol ?? null,
        tokenPriceUsd,
      },
      summaryCards,
      holderQuality: {
        avgScore: avgScoreRaw,
        qualityLabel,
        smartMoneyPct,
        convictionPct,
        activeTraderPct,
        degenPct,
        botPct,
      },
      holderQualityBreakdown,
      distribution: distributionSummary,
      holderTable: {
        total: holderTableRows.length,
        rows: holderTableRows,
      },
      riskCallouts,
    };
  }
}

// =============================================================================
// Pure helper functions
// -----------------------------------------------------------------------------
// All helpers are exported for unit testing. Each is responsible for one
// transformation and is tolerant to null / undefined / wrong-type inputs.
// =============================================================================

export function shortenAddress(address: unknown): string {
  if (typeof address !== 'string' || address.length < 10) {
    return typeof address === 'string' ? address : '';
  }

  const prefix = address.slice(0, 6);
  const suffix = address.slice(-4);
  return `${prefix}...${suffix}`;
}

export function formatPercent(value: unknown, digits = 1): string {
  const num = safeNumberOrNull(value);
  if (num === null) {
    return '0%';
  }

  return `${roundTo(num, digits)}%`;
}

export function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function safeNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function safeString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function parseTotalSupply(value: unknown): number | null {
  // qualityMetrics.totalSupply may be a decimal-formatted string ("1234.567")
  // or null. We deliberately do not parse scientific-notation BigInt strings
  // here; if the value cannot be coerced cleanly we fall back to null and
  // percentSupply degrades to 0 on the table rows.
  return safeNumberOrNull(value);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0';
  }

  if (Math.abs(value) >= 1_000_000_000) {
    return `$${roundTo(value / 1_000_000_000, 2)}B`;
  }

  if (Math.abs(value) >= 1_000_000) {
    return `$${roundTo(value / 1_000_000, 2)}M`;
  }

  if (Math.abs(value) >= 1_000) {
    return `$${roundTo(value / 1_000, 2)}K`;
  }

  return `$${roundTo(value, 2)}`;
}

// -----------------------------
// Summary cards builder
// -----------------------------

interface SummaryCardInputs {
  avgScore: number | null;
  smartMoneyPct: number;
  top10Pct: number;
  decentralizationScore: number;
  teamPctOfSupply: number;
  exchangePctOfSupply: number;
  botPct: number;
}

export function buildSummaryCards(inputs: SummaryCardInputs): SummaryCard[] {
  const {
    avgScore,
    smartMoneyPct,
    top10Pct,
    decentralizationScore,
    teamPctOfSupply,
    exchangePctOfSupply,
    botPct,
  } = inputs;

  const avgScoreSentiment: SummaryCard['sentiment'] =
    avgScore !== null && avgScore >= 75 ? 'positive' : 'neutral';

  const smartMoneySentiment: SummaryCard['sentiment'] =
    smartMoneyPct >= 25 ? 'positive' : botPct >= 15 ? 'warning' : 'neutral';

  const top10Sentiment: SummaryCard['sentiment'] =
    top10Pct >= 50 ? 'warning' : 'neutral';

  const decentralizationSentiment: SummaryCard['sentiment'] =
    decentralizationScore >= 70 ? 'positive' : 'neutral';

  const teamSentiment: SummaryCard['sentiment'] =
    teamPctOfSupply >= 25 ? 'warning' : 'neutral';

  const exchangeSentiment: SummaryCard['sentiment'] =
    exchangePctOfSupply >= 40 ? 'warning' : 'neutral';

  return [
    {
      title: 'Avg Holder Score',
      value: avgScore !== null ? `${Math.round(avgScore)}/100` : 'N/A',
      subtitle: 'Across analyzed EOA holders',
      sentiment: avgScoreSentiment,
    },
    {
      title: 'Smart Money Wallets',
      value: `${Math.round(smartMoneyPct)}%`,
      subtitle: 'High win-rate / profitable traders',
      sentiment: smartMoneySentiment,
    },
    {
      title: 'Top 10 Concentration',
      value: `${Math.round(top10Pct)}%`,
      subtitle: 'Supply held by top 10 holders',
      sentiment: top10Sentiment,
    },
    {
      title: 'Decentralization Score',
      value: `${Math.round(decentralizationScore)}/100`,
      subtitle: 'Higher = better distributed',
      sentiment: decentralizationSentiment,
    },
    {
      title: 'Team Allocation',
      value: `${roundTo(teamPctOfSupply, 1)}%`,
      subtitle: 'Supply held by team-linked wallets',
      sentiment: teamSentiment,
    },
    {
      title: 'Exchange Allocation',
      value: `${roundTo(exchangePctOfSupply, 1)}%`,
      subtitle: 'Supply held by CEX wallets',
      sentiment: exchangeSentiment,
    },
  ];
}

// -----------------------------
// Holder quality breakdown
// -----------------------------

export function computeHolderQualityBreakdown(
  holders: RawHolder[],
): HolderQualityBreakdown {
  const empty: HolderQualityBreakdown = {
    diamondHands: 0,
    accumulators: 0,
    swingTraders: 0,
    dayTraders: 0,
    degens: 0,
    bots: 0,
    unclassified: 0,
  };

  if (!Array.isArray(holders) || holders.length === 0) {
    return empty;
  }

  // Mirror HolderAggregationService: only EOA wallets are eligible for
  // behavioral classification. Non-EOAs (exchanges, contracts, burn) are
  // excluded so the breakdown reflects actual retail behavior.
  const eoaHolders = holders.filter(
    (holder) => holder && holder.walletLabel === 'eoa',
  );

  if (eoaHolders.length === 0) {
    return empty;
  }

  const buckets = {
    diamondHands: 0,
    accumulators: 0,
    swingTraders: 0,
    dayTraders: 0,
    degens: 0,
    bots: 0,
    unclassified: 0,
  };

  for (const holder of eoaHolders) {
    const primaryType =
      holder?.classification && typeof holder.classification.primaryType === 'string'
        ? (holder.classification.primaryType as string)
        : null;

    if (!primaryType || primaryType === 'Insufficient Data') {
      buckets.unclassified += 1;
      continue;
    }

    switch (primaryType) {
      case 'Diamond Hand':
        buckets.diamondHands += 1;
        break;
      case 'Accumulator':
        buckets.accumulators += 1;
        break;
      case 'Swing Trader':
        buckets.swingTraders += 1;
        break;
      case 'Day Trader':
        buckets.dayTraders += 1;
        break;
      case 'Degen':
      case 'Paper Hand':
        buckets.degens += 1;
        break;
      case 'Bot / Automated':
        buckets.bots += 1;
        break;
      default:
        buckets.unclassified += 1;
        break;
    }
  }

  const total = eoaHolders.length;
  const pct = (n: number): number => Math.round((n / total) * 100);

  return {
    diamondHands: pct(buckets.diamondHands),
    accumulators: pct(buckets.accumulators),
    swingTraders: pct(buckets.swingTraders),
    dayTraders: pct(buckets.dayTraders),
    degens: pct(buckets.degens),
    bots: pct(buckets.bots),
    unclassified: pct(buckets.unclassified),
  };
}

// -----------------------------
// Distribution summary
// -----------------------------

export function buildDistributionSummary(
  distribution: Record<string, unknown> | null | undefined,
): DistributionSummary {
  const safe = (distribution ?? {}) as Record<string, unknown>;
  const supplyConcentration = (safe.supplyConcentration ?? {}) as Record<
    string,
    unknown
  >;

  return {
    decentralizationScore: safeNumber(safe.decentralizationScore),
    giniCoefficient: safeNumber(safe.giniCoefficient),
    top10Pct: safeNumber(supplyConcentration.top10Pct),
    top50Pct: safeNumber(supplyConcentration.top50Pct),
    top100Pct: safeNumber(supplyConcentration.top100Pct),
  };
}

// -----------------------------
// Holder table
// -----------------------------

function buildHolderTableRows(
  holders: RawHolder[],
  totalSupplyFormatted: number | null,
): HolderTableRow[] {
  if (!Array.isArray(holders) || holders.length === 0) {
    return [];
  }

  // Frontend pagination handles rendering. We intentionally include ALL
  // analyzed holders here - no hardcoded 100-holder cap.
  const rows: HolderTableRow[] = holders.map((holder) =>
    buildHolderTableRow(holder, totalSupplyFormatted),
  );

  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

function buildHolderTableRow(
  holder: RawHolder,
  totalSupplyFormatted: number | null,
): HolderTableRow {
  const walletAddress =
    typeof holder?.walletAddress === 'string' ? holder.walletAddress : '';
  const rank = safeNumber(holder?.rank, 0);
  const balanceUsd = safeNumber(holder?.usdValue, 0);
  const balanceNum = safeNumber(holder?.balance, 0);

  const percentSupply =
    totalSupplyFormatted !== null && totalSupplyFormatted > 0 && balanceNum > 0
      ? roundTo((balanceNum / totalSupplyFormatted) * 100, 4)
      : 0;

  const classification =
    holder?.classification && typeof holder.classification.primaryType === 'string'
      ? (holder.classification.primaryType as string)
      : null;

  const confidence =
    holder?.classification && typeof holder.classification.confidence === 'string'
      ? (holder.classification.confidence as string)
      : null;

  const score =
    holder?.score && typeof holder.score.score === 'number'
      ? holder.score.score
      : null;

  const walletLabel =
    typeof holder?.walletLabel === 'string' ? holder.walletLabel : null;

  const teamLinked = holder?.isTeamLinked === true;

  const portfolioRisk =
    holder?.portfolio &&
    typeof holder.portfolio.portfolioRiskSignal === 'string'
      ? (holder.portfolio.portfolioRiskSignal as string)
      : null;

  const lastActiveDays =
    holder?.features &&
    typeof holder.features.daysSinceLastActivity === 'number' &&
    Number.isFinite(holder.features.daysSinceLastActivity)
      ? (holder.features.daysSinceLastActivity as number)
      : null;

  return {
    rank,
    walletAddress,
    shortAddress: shortenAddress(walletAddress),
    balanceUsd,
    percentSupply,
    classification,
    confidence,
    score,
    walletLabel,
    teamLinked,
    portfolioRisk,
    lastActiveDays,
  };
}

// -----------------------------
// Smart money percentage
// -----------------------------

function computeSmartMoneyPct(
  smartMoneyCount: number,
  totalAnalyzedEOAs: number,
  holders: RawHolder[],
): number {
  if (smartMoneyCount > 0 && totalAnalyzedEOAs > 0) {
    return Math.round((smartMoneyCount / totalAnalyzedEOAs) * 100);
  }

  // FAST_MODE fallback: no PnL data is computed, so smart money is derived
  // from the lite score (>= 75 = Strong Trader / Elite Smart Money band).
  if (!Array.isArray(holders) || holders.length === 0) {
    return 0;
  }

  const eoaHolders = holders.filter(
    (holder) => holder && holder.walletLabel === 'eoa',
  );
  if (eoaHolders.length === 0) {
    return 0;
  }

  const highScorers = eoaHolders.filter((holder) => {
    const score =
      holder?.score && typeof holder.score.score === 'number'
        ? holder.score.score
        : null;
    return score !== null && score >= 75;
  }).length;

  return Math.round((highScorers / eoaHolders.length) * 100);
}

// Used internally by formatPercent / formatUsd consumers; exported for future
// callers that need the same USD formatter without re-implementing it.
export { formatUsd };
