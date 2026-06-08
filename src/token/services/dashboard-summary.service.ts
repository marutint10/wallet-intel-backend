import { Injectable } from '@nestjs/common';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import type { RiskCallout } from './holder-aggregation.service';
import { UNSCORED_SCORE_BANDS } from './lite-scorer.service';
import {
  TokenTrustReport,
  TokenTrustReportService,
} from './token-trust-report.service';

function isUnclassifiedHolderType(primaryType: string | null): boolean {
  return (
    !primaryType ||
    primaryType === 'Insufficient Data' ||
    primaryType === 'Dormant Wallet'
  );
}

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
  convictionHolders: number;
  dormant: number;
}

/** Raw EOA archetype counts from persisted qualityMetrics. */
export interface BehavioralBreakdownCounts {
  convictionHolders: number;
  diamondHands: number;
  activeTraders: number;
  riskDegen: number;
  bots: number;
  dormant: number;
}

/** Behavioral % and counts resolved from qualityMetrics (supports legacy rows). */
export interface ResolvedQualityBreakdown {
  pct: BehavioralBreakdownCounts;
  counts: BehavioralBreakdownCounts;
}

// FIX 1: dropped `lastActiveDays` (always null in practice) and surfaced wallet-level
// portfolio context (`portfolioUsd`, `trackedTokenWeight`) that LitePortfolioService
// already computes for all analyzed top holders but was not being passed through to the dashboard.
// CHANGE 2: added `knownLabel` to expose the Etherscan-resolved contract name for
// `generic_contract` rows so the UI can show "GnosisSafeProxy" / "ERC1967Proxy"
// instead of an opaque "generic_contract" cell.
export interface HolderTableRow {
  rank: number;
  walletAddress: string;
  shortAddress: string;
  balanceUsd: number;
  percentSupply: number;
  percentSupplyBasis: 'circulating' | 'total';
  classification: string | null;
  confidence: string | null;
  score: number | null;
  walletLabel: string | null;
  teamLinked: boolean;
  portfolioRisk: string | null;
  portfolioUsd: number | null;
  trackedTokenWeight: number | null;
  knownLabel: string | null;
  retailType: string;
  retailRiskLabel: string;
  retailExplanation: string;
}

export interface SupplyBreakdownSummary {
  retail: { count: number; pctOfSupply: number };
  exchange: { count: number; pctOfSupply: number };
  contract: { count: number; pctOfSupply: number };
  team: { count: number; pctOfSupply: number };
  burn: { count: number; pctOfSupply: number };
  lp: { count: number; pctOfSupply: number };
}

export interface DistributionSummary {
  scope: string;
  retailHolderCount: number;
  decentralizationScore: number;
  giniCoefficient: number;
  top10Pct: number;
  top50Pct: number;
  top100Pct: number;
  supplyBreakdown: SupplyBreakdownSummary;
  retailSizeBuckets: {
    micro: number;
    small: number;
    medium: number;
    whale: number;
  };
  raw: {
    giniCoefficient: number;
    top10PctOfTotal: number;
    top50PctOfTotal: number;
  };
}

export interface DashboardSummaryResponse {
  token: {
    contractAddress: string;
    chain: string;
    tokenName?: string | null;
    tokenSymbol?: string | null;
    tokenPriceUsd?: number | null;
    circulatingSupply?: string | null;
  };

  /** Plain-text analyst summary from Gemini, or null if generation was skipped or failed without fallback. */
  aiSummary: string | null;

  summaryCards: SummaryCard[];

  holderQuality: {
    avgScore: number | null;
    qualityLabel: string;
    smartMoneyPct: number;
    convictionPct: number;
    activeTraderPct: number;
    degenPct: number;
    botPct: number;
    scoringBase: string;
    classifiableRetailCount: number;
    totalHoldersExamined: number;
    classificationBreakdown: Record<string, number>;
  };

  holderQualityBreakdown: HolderQualityBreakdown;

  distribution: DistributionSummary;
  tokenTrust: TokenTrustReport;

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

export interface RawHolder {
  rank?: unknown;
  walletAddress?: unknown;
  balance?: unknown;
  usdValue?: unknown;
  walletLabel?: unknown;
  walletLabelDetail?: unknown;
  knownLabel?: unknown;
  isTeamLinked?: unknown;
  classification?: {
    primaryType?: unknown;
    confidence?: unknown;
  } | null;
  score?: { score?: unknown; band?: unknown } | null;
  portfolio?: {
    portfolioRiskSignal?: unknown;
    totalPortfolioUsd?: unknown;
    trackedTokenWeight?: unknown;
  } | null;
  features?: { daysSinceLastActivity?: unknown } | null;
}

@Injectable()
export class DashboardSummaryService {
  constructor(private readonly tokenTrustReport: TokenTrustReportService) {}

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
    const circulatingSupply = parseSupplyString(quality.circulatingSupply);
    const totalSupplyFormatted = parseTotalSupply(quality.totalSupply);
    const supplyForPercent = resolveSupplyForPercent(
      circulatingSupply,
      totalSupplyFormatted,
    );

    const holderTableRows = buildHolderTableRows(rawHolders, supplyForPercent);
    const holderQualityBreakdown = computeHolderQualityBreakdown(rawHolders);
    const distributionSummary = buildDistributionSummary(distribution);

    const resolvedBreakdown = resolveQualityBreakdown(quality);
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
    const portfolioSmartMoneyCount = safeNumber(
      pnlAggregation.portfolioSmartMoneyCount,
    );
    const smartMoneyPct = computeSmartMoneyPct(
      smartMoneyCount,
      portfolioSmartMoneyCount,
      totalAnalyzedEOAs,
      rawHolders,
    );

    const avgScoreRaw = safeNumberOrNull(quality.avgScore);
    const qualityLabel = safeString(quality.qualityLabel, 'Unknown');

    const convictionPct =
      holderQualityBreakdown.convictionHolders +
      holderQualityBreakdown.diamondHands +
      holderQualityBreakdown.accumulators;
    const activeTraderPct = resolvedBreakdown.pct.activeTraders;
    const degenPct = resolvedBreakdown.pct.riskDegen;
    const botPct = resolvedBreakdown.pct.bots;

    const teamPctOfSupply = safeNumber(
      (teamDetection ?? {}).teamTotalPctOfSupply,
    );
    const exchangesEntry = (categoryConcentration.exchanges ?? {}) as Record<
      string,
      unknown
    >;
    const exchangePctOfSupply = safeNumber(exchangesEntry.pctOfSupply);

    const tokenTrust = this.tokenTrustReport.buildReport(analysis);

    const summaryCards = buildSummaryCards({
      avgScore: avgScoreRaw,
      smartMoneyPct,
      top10Pct: distributionSummary.top10Pct,
      decentralizationScore: distributionSummary.decentralizationScore,
      teamPctOfSupply,
      exchangePctOfSupply,
      botPct,
      tokenTrust,
    });

    return {
      token: {
        contractAddress: analysis.contractAddress,
        chain: analysis.chain,
        tokenName: analysis.tokenName ?? null,
        tokenSymbol: analysis.tokenSymbol ?? null,
        tokenPriceUsd,
        circulatingSupply: circulatingSupply !== null ? String(circulatingSupply) : null,
      },
      aiSummary: null,
      summaryCards,
      holderQuality: {
        avgScore: avgScoreRaw,
        qualityLabel,
        smartMoneyPct,
        convictionPct,
        activeTraderPct,
        degenPct,
        botPct,
        scoringBase: safeString(quality.scoringBase, 'retail-classifiable'),
        classifiableRetailCount: safeNumber(quality.classifiableRetailCount),
        totalHoldersExamined: safeNumber(quality.totalHoldersExamined),
        classificationBreakdown:
          (quality.classificationBreakdown as Record<string, number>) ?? {},
      },
      holderQualityBreakdown,
      distribution: distributionSummary,
      tokenTrust,
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

export function safeString(value: unknown, fallback: string): string {
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
  return parseSupplyString(value);
}

function parseSupplyString(value: unknown): number | null {
  return safeNumberOrNull(value);
}

const BEHAVIORAL_BREAKDOWN_KEYS = [
  'convictionHolders',
  'diamondHands',
  'activeTraders',
  'riskDegen',
  'bots',
  'dormant',
] as const;

function readBehavioralBreakdownRecord(
  source: Record<string, unknown> | null | undefined,
): BehavioralBreakdownCounts {
  const safe = source ?? {};
  return {
    convictionHolders: safeNumber(safe.convictionHolders),
    diamondHands: safeNumber(safe.diamondHands),
    activeTraders: safeNumber(safe.activeTraders),
    riskDegen: safeNumber(safe.riskDegen),
    bots: safeNumber(safe.bots),
    dormant: safeNumber(safe.dormant),
  };
}

/**
 * qualityMetrics.breakdown behavioral keys are percentages; breakdown.counts are raw EOA counts.
 * Legacy rows may only expose top-level breakdown (treated as %) or a deprecated breakdownCounts field.
 */
export function resolveQualityBreakdown(
  quality: Record<string, unknown>,
): ResolvedQualityBreakdown {
  const breakdown = (quality.breakdown ?? {}) as Record<string, unknown>;
  const legacyCounts = (quality.breakdownCounts ?? {}) as Record<string, unknown>;
  const nestedCounts = (breakdown.counts ?? {}) as Record<string, unknown>;

  const counts = readBehavioralBreakdownRecord(
    Object.keys(nestedCounts).length > 0 ? nestedCounts : legacyCounts,
  );

  const pct = readBehavioralBreakdownRecord(breakdown);
  const countsTotal =
    counts.convictionHolders +
    counts.diamondHands +
    counts.activeTraders +
    counts.riskDegen +
    counts.bots +
    counts.dormant;

  // Legacy cached rows stored counts at the top level of breakdown (values sum to ~78, not 100).
  const pctLooksLikeCounts =
    countsTotal > 0 &&
    BEHAVIORAL_BREAKDOWN_KEYS.every((key) => pct[key] <= countsTotal);

  const resolvedPct = pctLooksLikeCounts
    ? {
        convictionHolders: Math.round((counts.convictionHolders / countsTotal) * 100),
        diamondHands: Math.round((counts.diamondHands / countsTotal) * 100),
        activeTraders: Math.round((counts.activeTraders / countsTotal) * 100),
        riskDegen: Math.round((counts.riskDegen / countsTotal) * 100),
        bots: Math.round((counts.bots / countsTotal) * 100),
        dormant: Math.round((counts.dormant / countsTotal) * 100),
      }
    : pct;

  return { pct: resolvedPct, counts };
}

export interface SupplyForPercent {
  supply: number | null;
  basis: 'circulating' | 'total';
}

export function resolveSupplyForPercent(
  circulatingSupply: number | null,
  totalSupply: number | null,
): SupplyForPercent {
  if (circulatingSupply !== null && circulatingSupply > 0) {
    return { supply: circulatingSupply, basis: 'circulating' };
  }

  if (totalSupply !== null && totalSupply > 0) {
    return { supply: totalSupply, basis: 'total' };
  }

  return { supply: null, basis: 'total' };
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
  tokenTrust: TokenTrustReport;
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
    tokenTrust,
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
      title: 'Holder Strength Score',
      value: avgScore !== null ? `${Math.round(avgScore)}/100` : 'N/A',
      subtitle: `Risk ${tokenTrust.riskLevel}; not a safety guarantee`,
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
    convictionHolders: 0,
    dormant: 0,
  };

  if (!Array.isArray(holders) || holders.length === 0) {
    return empty;
  }

  // Mirror HolderAggregationService: retail (EOA, non-team-linked) only.
  const eoaHolders = holders.filter(
    (holder) =>
      holder &&
      holder.walletLabel === 'eoa' &&
      holder.isTeamLinked !== true,
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
    convictionHolders: 0,
    dormant: 0,
  };

  for (const holder of eoaHolders) {
    const primaryType =
      holder?.classification && typeof holder.classification.primaryType === 'string'
        ? (holder.classification.primaryType as string)
        : null;

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
      case 'Conviction Holder':
      case 'Diversified Whale':
      case 'Strategic Allocator':
        buckets.convictionHolders += 1;
        break;
      case 'Dormant Wallet':
        buckets.dormant += 1;
        break;
      default:
        buckets.dormant += 1;
        break;
    }
  }

  const total = eoaHolders.length;
  const rawPct = {
    diamondHands: buckets.diamondHands,
    accumulators: buckets.accumulators,
    swingTraders: buckets.swingTraders,
    dayTraders: buckets.dayTraders,
    degens: buckets.degens,
    bots: buckets.bots,
    convictionHolders: buckets.convictionHolders,
    dormant: buckets.dormant,
  };

  return distributeDashboardBreakdownPercentages(rawPct, total);
}

function distributeDashboardBreakdownPercentages(
  counts: {
    diamondHands: number;
    accumulators: number;
    swingTraders: number;
    dayTraders: number;
    degens: number;
    bots: number;
    convictionHolders: number;
    dormant: number;
  },
  total: number,
): HolderQualityBreakdown {
  if (total <= 0) {
    return {
      diamondHands: 0,
      accumulators: 0,
      swingTraders: 0,
      dayTraders: 0,
      degens: 0,
      bots: 0,
      convictionHolders: 0,
      dormant: 0,
    };
  }

  const keys = [
    'diamondHands',
    'accumulators',
    'swingTraders',
    'dayTraders',
    'degens',
    'bots',
    'convictionHolders',
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
    diamondHands: allocated.find((entry) => entry.key === 'diamondHands')!.pct,
    accumulators: allocated.find((entry) => entry.key === 'accumulators')!.pct,
    swingTraders: allocated.find((entry) => entry.key === 'swingTraders')!.pct,
    dayTraders: allocated.find((entry) => entry.key === 'dayTraders')!.pct,
    degens: allocated.find((entry) => entry.key === 'degens')!.pct,
    bots: allocated.find((entry) => entry.key === 'bots')!.pct,
    convictionHolders: allocated.find((entry) => entry.key === 'convictionHolders')!.pct,
    dormant: allocated.find((entry) => entry.key === 'dormant')!.pct,
  };
}

// -----------------------------
// Distribution summary
// -----------------------------

function readSupplyBucket(
  breakdown: Record<string, unknown> | undefined,
  key: string,
): { count: number; pctOfSupply: number } {
  const entry = (breakdown?.[key] ?? {}) as Record<string, unknown>;
  return {
    count: safeNumber(entry.count),
    pctOfSupply: safeNumber(entry.pctOfSupply),
  };
}

export function buildDistributionSummary(
  distribution: Record<string, unknown> | null | undefined,
): DistributionSummary {
  const safe = (distribution ?? {}) as Record<string, unknown>;
  const supplyConcentration = (safe.supplyConcentration ?? {}) as Record<
    string,
    unknown
  >;
  const supplyBreakdownRaw = (safe.supplyBreakdown ?? {}) as Record<
    string,
    unknown
  >;
  const retailSizeBucketsRaw = (safe.retailSizeBuckets ?? safe.buckets ?? {}) as Record<
    string,
    unknown
  >;
  const rawBlock = (safe.raw ?? {}) as Record<string, unknown>;
  const rawConcentration = (rawBlock.supplyConcentration ?? {}) as Record<
    string,
    unknown
  >;

  return {
    scope: safeString(safe.scope, 'retail-only'),
    retailHolderCount: safeNumber(safe.retailHolderCount),
    decentralizationScore: safeNumber(safe.decentralizationScore),
    giniCoefficient: safeNumber(safe.giniCoefficient),
    top10Pct: safeNumber(supplyConcentration.top10Pct),
    top50Pct: safeNumber(supplyConcentration.top50Pct),
    top100Pct: safeNumber(supplyConcentration.top100Pct),
    supplyBreakdown: {
      retail: readSupplyBucket(supplyBreakdownRaw, 'retail'),
      exchange: readSupplyBucket(supplyBreakdownRaw, 'exchange'),
      contract: readSupplyBucket(supplyBreakdownRaw, 'contract'),
      team: readSupplyBucket(supplyBreakdownRaw, 'team'),
      burn: readSupplyBucket(supplyBreakdownRaw, 'burn'),
      lp: readSupplyBucket(supplyBreakdownRaw, 'lp'),
    },
    retailSizeBuckets: {
      micro: safeNumber(retailSizeBucketsRaw.micro),
      small: safeNumber(retailSizeBucketsRaw.small),
      medium: safeNumber(retailSizeBucketsRaw.medium),
      whale: safeNumber(retailSizeBucketsRaw.whale),
    },
    raw: {
      giniCoefficient: safeNumber(rawBlock.giniCoefficient),
      top10PctOfTotal: safeNumber(rawConcentration.top10PctOfTotal),
      top50PctOfTotal: safeNumber(rawConcentration.top50PctOfTotal),
    },
  };
}

// -----------------------------
// Holder table
// -----------------------------

function buildHolderTableRows(
  holders: RawHolder[],
  supplyForPercent: SupplyForPercent,
): HolderTableRow[] {
  if (!Array.isArray(holders) || holders.length === 0) {
    return [];
  }

  // Frontend pagination handles rendering. We intentionally include ALL
  // analyzed holders here - no hardcoded 100-holder cap.
  const rows: HolderTableRow[] = holders.map((holder) =>
    buildHolderTableRow(holder, supplyForPercent),
  );

  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

function buildHolderTableRow(
  holder: RawHolder,
  supplyForPercent: SupplyForPercent,
): HolderTableRow {
  const walletAddress =
    typeof holder?.walletAddress === 'string' ? holder.walletAddress : '';
  const rank = safeNumber(holder?.rank, 0);
  const balanceUsd = safeNumber(holder?.usdValue, 0);
  const balanceNum = safeNumber(holder?.balance, 0);

  const supply = supplyForPercent.supply;
  const percentSupply =
    supply !== null && supply > 0 && balanceNum > 0
      ? roundTo((balanceNum / supply) * 100, 4)
      : 0;

  const classification =
    holder?.classification && typeof holder.classification.primaryType === 'string'
      ? (holder.classification.primaryType as string)
      : null;

  const confidence =
    holder?.classification && typeof holder.classification.confidence === 'string'
      ? (holder.classification.confidence as string)
      : null;

  // FIX 2: gated wallets (Dormant Wallet / legacy Insufficient Data band) surface as null
  // instead of 0 so the dashboard does not misrepresent "not scored" as "scored zero".
  const score =
    holder?.score &&
    typeof holder.score.band === 'string' &&
    UNSCORED_SCORE_BANDS.has(holder.score.band)
      ? null
      : holder?.score && typeof holder.score.score === 'number'
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

  // FIX 1: surface the wallet-level portfolio context from LitePortfolioService
  // (all top-100 analyzed holders except exchange/cex_deposit labels).
  const portfolioUsd =
    holder?.portfolio &&
    typeof holder.portfolio.totalPortfolioUsd === 'number' &&
    Number.isFinite(holder.portfolio.totalPortfolioUsd)
      ? (holder.portfolio.totalPortfolioUsd as number)
      : null;

  const trackedTokenWeight =
    holder?.portfolio &&
    typeof holder.portfolio.trackedTokenWeight === 'number' &&
    Number.isFinite(holder.portfolio.trackedTokenWeight)
      ? (holder.portfolio.trackedTokenWeight as number)
      : null;

  // CHANGE 2: surface the Etherscan-resolved contract name only for
  // `generic_contract` rows. Prefer a dedicated `knownLabel` field on the
  // raw holder if it ever gets persisted (forward-compatible), otherwise
  // fall back to `walletLabelDetail` which is where TokenIntelligenceService
  // currently writes the resolved name for generic_contract wallets. Other
  // labels keep `knownLabel: null` so we never conflate it with exchange /
  // router / vesting detail strings.
  const knownLabel =
    walletLabel === 'generic_contract'
      ? coerceContractName(holder?.knownLabel) ??
        coerceContractName(holder?.walletLabelDetail)
      : null;

  const retail = mapHolderTypeForRetail(classification, {
    walletLabel,
    percentSupply,
    trackedTokenWeight,
  });

  return {
    rank,
    walletAddress,
    shortAddress: shortenAddress(walletAddress),
    balanceUsd,
    percentSupply,
    percentSupplyBasis: supplyForPercent.basis,
    classification,
    confidence,
    score,
    walletLabel,
    teamLinked,
    portfolioRisk,
    portfolioUsd,
    trackedTokenWeight,
    knownLabel,
    retailType: retail.retailType,
    retailRiskLabel: retail.retailRiskLabel,
    retailExplanation: retail.retailExplanation,
  };
}

function coerceContractName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapHolderTypeForRetail(
  primaryType: string | null,
  holder: {
    walletLabel: string | null;
    percentSupply: number;
    trackedTokenWeight: number | null;
  },
): {
  retailType: string;
  retailRiskLabel: string;
  retailExplanation: string;
} {
  if (holder.walletLabel === 'exchange' || holder.walletLabel === 'cex_deposit') {
    return {
      retailType: 'Exchange Custody',
      retailRiskLabel: 'Liquidity Context',
      retailExplanation:
        'Exchange-held supply is treated as liquidity access, not direct sell pressure.',
    };
  }

  if (holder.walletLabel === 'burn') {
    return {
      retailType: 'Burn Address',
      retailRiskLabel: 'Low Exit Risk',
      retailExplanation: 'Burned supply is generally not expected to return to circulation.',
    };
  }

  if (primaryType === 'Conviction Holder') {
    const highExitRisk =
      holder.percentSupply >= 1 || (holder.trackedTokenWeight ?? 0) >= 80;
    return {
      retailType: 'Concentrated Holder',
      retailRiskLabel: highExitRisk ? 'High Exit Risk' : 'Moderate Exit Risk',
      retailExplanation: 'This wallet is heavily concentrated in the analyzed token.',
    };
  }

  if (primaryType === 'Diversified Whale') {
    return {
      retailType: 'Diversified Whale',
      retailRiskLabel:
        holder.percentSupply >= 5
          ? 'High Exit Risk'
          : holder.percentSupply >= 1
            ? 'Moderate Exit Risk'
            : 'Low Exit Risk',
      retailExplanation: 'Large wallet with diversified portfolio exposure.',
    };
  }

  if (primaryType === 'Strategic Allocator') {
    return {
      retailType: 'Partial Allocator',
      retailRiskLabel:
        holder.percentSupply >= 2 ? 'Moderate Exit Risk' : 'Low Exit Risk',
      retailExplanation: 'Wallet has meaningful but not all-in exposure.',
    };
  }

  if (primaryType === 'Dormant Wallet') {
    return {
      retailType: 'Low-Activity Wallet',
      retailRiskLabel: holder.percentSupply >= 1 ? 'Moderate Exit Risk' : 'Low Exit Risk',
      retailExplanation: 'Limited trading history detected in recent on-chain activity.',
    };
  }

  return {
    retailType: mapLegacyStrengthLabel(primaryType),
    retailRiskLabel:
      holder.percentSupply >= 5
        ? 'High Exit Risk'
        : holder.percentSupply >= 1
          ? 'Moderate Exit Risk'
          : 'Low Exit Risk',
    retailExplanation:
      'Retail-facing label mapped from current on-chain holder classification.',
  };
}

function mapLegacyStrengthLabel(primaryType: string | null): string {
  if (!primaryType) {
    return 'Unknown';
  }
  switch (primaryType) {
    case 'Institutional':
      return 'Very Strong';
    case 'Premium':
      return 'Strong';
    case 'Solid':
      return 'Moderate';
    case 'Developing':
      return 'Weak';
    default:
      return primaryType;
  }
}

// -----------------------------
// Smart money percentage
// -----------------------------

export function computeSmartMoneyPct(
  smartMoneyCount: number,
  portfolioSmartMoneyCount: number,
  totalAnalyzedEOAs: number,
  holders: RawHolder[],
): number {
  if (smartMoneyCount > 0 && totalAnalyzedEOAs > 0) {
    return Math.round((smartMoneyCount / totalAnalyzedEOAs) * 100);
  }

  if (portfolioSmartMoneyCount > 0 && totalAnalyzedEOAs > 0) {
    return Math.round((portfolioSmartMoneyCount / totalAnalyzedEOAs) * 100);
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
