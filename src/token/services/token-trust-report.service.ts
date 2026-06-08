import { Injectable } from '@nestjs/common';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';

export type TrustRiskLevel = 'low' | 'moderate' | 'high' | 'severe' | 'unknown';
export type TrustConfidence = 'low' | 'medium' | 'high';

export interface TokenTrustFlag {
  severity: 'low' | 'medium' | 'high' | 'severe';
  title: string;
  description: string;
  evidence?: string;
}

export interface TokenTrustPositiveSignal {
  strength: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  evidence?: string;
}

export interface WhoCanDumpSummary {
  largestRetailWalletPct: number | null;
  largestRetailWalletUsd: number | null;
  largestRetailWalletAddress: string | null;
  top10RetailPct: number | null;
  retailWhaleCount: number;
  teamLinkedPct: number | null;
  exchangePct: number | null;
  contractPct: number | null;
  lpPct: number | null;
  summary: string;
  riskLevel: TrustRiskLevel;
}

export interface TokenTrustBreakdownItem {
  score: number;
  risk: string;
}

export interface TokenTrustReport {
  trustScore: number;
  riskLevel: TrustRiskLevel;
  verdict: string;
  confidence: TrustConfidence;
  reportMode: 'fast' | 'standard';
  summary: string;
  redFlags: TokenTrustFlag[];
  positiveSignals: TokenTrustPositiveSignal[];
  whoCanDump: WhoCanDumpSummary;
  trustBreakdown: {
    holderConcentration: TokenTrustBreakdownItem;
    whaleExitRisk: TokenTrustBreakdownItem;
    teamOrInsiderRisk: TokenTrustBreakdownItem;
    exchangeLiquidityContext: TokenTrustBreakdownItem;
    holderStrength: TokenTrustBreakdownItem;
    dataConfidence: TokenTrustBreakdownItem;
  };
  limitations: string[];
}

interface RawHolder {
  walletAddress?: unknown;
  balance?: unknown;
  usdValue?: unknown;
  walletLabel?: unknown;
  isTeamLinked?: unknown;
}

@Injectable()
export class TokenTrustReportService {
  buildReport(analysis: TokenAnalysisEntity): TokenTrustReport {
    const quality = asRecord(analysis.qualityMetrics);
    const distribution = asRecord(analysis.distribution);
    const holders = Array.isArray(analysis.holdersData)
      ? (analysis.holdersData as RawHolder[])
      : [];

    const supplyConcentration = asRecord(distribution.supplyConcentration);
    const supplyBreakdown = asRecord(distribution.supplyBreakdown);
    const pnlAggregation = asRecord(quality.pnlAggregation);
    const teamDetection = asRecord(quality.teamDetection);
    const categoryConcentration = asRecord(quality.categoryConcentration);

    const top10RetailPct = safeNumberOrNull(supplyConcentration.top10Pct);
    const decentralizationScore = safeNumber(distribution.decentralizationScore);
    const avgHolderStrength = safeNumber(quality.avgScore);
    const classifiableRetailCount = safeNumber(quality.classifiableRetailCount);
    const totalAnalyzedEOAs = safeNumber(quality.totalAnalyzedEOAs);
    const reportMode: 'fast' | 'standard' =
      safeNumber(pnlAggregation.holdersWithPnlData) > 0 ? 'standard' : 'fast';

    const supply = this.resolveSupply(quality);
    const retailHolders = holders.filter(
      (holder) => holder.walletLabel === 'eoa' && holder.isTeamLinked !== true,
    );
    const retailWithPct = retailHolders
      .map((holder) => ({
        address: safeStringOrNull(holder.walletAddress),
        usdValue: safeNumberOrNull(holder.usdValue),
        percentSupply:
          supply !== null && supply > 0
            ? (safeNumber(holder.balance) / supply) * 100
            : null,
      }))
      .filter((holder) => holder.percentSupply !== null)
      .sort((left, right) => (right.percentSupply ?? 0) - (left.percentSupply ?? 0));

    const largestRetail = retailWithPct[0] ?? null;
    const largestRetailWalletPct = largestRetail?.percentSupply ?? null;
    const largestRetailWalletUsd = largestRetail?.usdValue ?? null;
    const largestRetailWalletAddress = largestRetail?.address ?? null;
    const retailWhaleCount = retailWithPct.filter(
      (holder) => (holder.percentSupply ?? 0) >= 1,
    ).length;

    const top10RetailResolved =
      top10RetailPct !== null
        ? top10RetailPct
        : retailWithPct.slice(0, 10).reduce((sum, holder) => sum + (holder.percentSupply ?? 0), 0);

    const teamLinkedPct = this.resolveTeamPct(supplyBreakdown, categoryConcentration, teamDetection);
    const exchangePct = safeNumberOrNull(asRecord(supplyBreakdown.exchange).pctOfSupply);
    const contractPct = safeNumberOrNull(asRecord(supplyBreakdown.contract).pctOfSupply);
    const lpPct = safeNumberOrNull(asRecord(supplyBreakdown.lp).pctOfSupply);

    const hasEnoughData =
      (classifiableRetailCount > 0 || totalAnalyzedEOAs > 0 || retailWithPct.length > 0) &&
      top10RetailResolved !== null &&
      Number.isFinite(top10RetailResolved);

    const concentrationPenalty = !hasEnoughData
      ? 12
      : top10RetailResolved >= 70
        ? 30
        : top10RetailResolved >= 50
          ? 22
          : top10RetailResolved >= 35
            ? 14
            : top10RetailResolved >= 20
              ? 7
              : 2;

    const decentralizationPenalty =
      decentralizationScore < 25
        ? 20
        : decentralizationScore < 45
          ? 14
          : decentralizationScore < 65
            ? 8
            : 2;

    const whalePenalty =
      largestRetailWalletPct === null
        ? 12
        : largestRetailWalletPct >= 10
          ? 25
          : largestRetailWalletPct >= 5
            ? 18
            : largestRetailWalletPct >= 2
              ? 10
              : largestRetailWalletPct >= 1
                ? 5
                : 1;

    const teamPenaltyBase =
      teamLinkedPct === null
        ? 10
        : teamLinkedPct >= 20
          ? 30
          : teamLinkedPct >= 10
            ? 22
            : teamLinkedPct >= 5
              ? 12
              : teamLinkedPct >= 2
                ? 6
                : 1;
    const teamRiskLevel = safeString(teamDetection.riskLevel).toLowerCase();
    const teamPenaltyExtra =
      teamRiskLevel === 'critical' ? 10 : teamRiskLevel === 'high' ? 8 : teamRiskLevel === 'medium' ? 5 : 0;
    const teamPenalty = teamPenaltyBase + teamPenaltyExtra;

    const holderStrengthPenalty =
      avgHolderStrength < 30 ? 10 : avgHolderStrength < 45 ? 7 : avgHolderStrength < 60 ? 4 : 1;

    const analyzedRetail = Math.max(classifiableRetailCount, totalAnalyzedEOAs, retailWithPct.length);
    const dataPenalty = analyzedRetail < 20 ? 12 : analyzedRetail < 50 ? 6 : 1;

    const trustScore = clamp(
      100 -
        concentrationPenalty -
        decentralizationPenalty -
        whalePenalty -
        teamPenalty -
        holderStrengthPenalty -
        dataPenalty,
      0,
      100,
    );

    const riskLevel: TrustRiskLevel = !hasEnoughData
      ? 'unknown'
      : trustScore >= 80
        ? 'low'
        : trustScore >= 60
          ? 'moderate'
          : trustScore >= 40
            ? 'high'
            : 'severe';

    const confidence: TrustConfidence =
      analyzedRetail < 20 ? 'low' : analyzedRetail < 50 ? 'medium' : 'high';

    const verdict = this.resolveVerdict(riskLevel, top10RetailResolved, teamLinkedPct);
    const whoCanDumpRiskLevel = this.resolveWhoCanDumpRiskLevel(
      top10RetailResolved,
      largestRetailWalletPct,
      teamLinkedPct,
      hasEnoughData,
    );

    const redFlags = this.buildRedFlags({
      top10RetailPct: top10RetailResolved,
      largestRetailWalletPct,
      largestRetailWalletUsd,
      teamLinkedPct,
      analyzedRetail,
      avgHolderStrength,
    });
    const positiveSignals = this.buildPositiveSignals({
      teamLinkedPct,
      exchangePct,
      top10RetailPct: top10RetailResolved,
      avgHolderStrength,
    });
    const limitations = this.buildLimitations(reportMode, analyzedRetail);

    const whoCanDump: WhoCanDumpSummary = {
      largestRetailWalletPct: nullableRound(largestRetailWalletPct, 2),
      largestRetailWalletUsd: nullableRound(largestRetailWalletUsd, 2),
      largestRetailWalletAddress,
      top10RetailPct: nullableRound(top10RetailResolved, 2),
      retailWhaleCount,
      teamLinkedPct: nullableRound(teamLinkedPct, 2),
      exchangePct: nullableRound(exchangePct, 2),
      contractPct: nullableRound(contractPct, 2),
      lpPct: nullableRound(lpPct, 2),
      riskLevel: whoCanDumpRiskLevel,
      summary: this.buildWhoCanDumpSummary(
        whoCanDumpRiskLevel,
        top10RetailResolved,
        largestRetailWalletPct,
        teamLinkedPct,
        exchangePct,
      ),
    };

    return {
      trustScore,
      riskLevel,
      verdict,
      confidence,
      reportMode,
      summary: `${verdict}. Concentration, team exposure, and wallet exit pressure are weighted more heavily than holder profile quality.`,
      redFlags,
      positiveSignals,
      whoCanDump,
      trustBreakdown: {
        holderConcentration: scoreItem(30 - concentrationPenalty, this.riskLabelFromPenalty(concentrationPenalty)),
        whaleExitRisk: scoreItem(25 - whalePenalty, this.riskLabelFromPenalty(whalePenalty)),
        teamOrInsiderRisk: scoreItem(30 - teamPenalty, this.riskLabelFromPenalty(teamPenalty)),
        exchangeLiquidityContext: scoreItem(
          exchangePct !== null ? 70 : 50,
          exchangePct !== null
            ? 'Exchange custody is liquidity context, not direct sell pressure.'
            : 'Exchange custody data is limited.',
        ),
        holderStrength: scoreItem(20 - holderStrengthPenalty, this.riskLabelFromPenalty(holderStrengthPenalty)),
        dataConfidence: scoreItem(20 - dataPenalty, this.riskLabelFromPenalty(dataPenalty)),
      },
      limitations,
    };
  }

  private resolveSupply(quality: Record<string, unknown>): number | null {
    const circulating = safeNumberOrNull(quality.circulatingSupply);
    if (circulating !== null && circulating > 0) {
      return circulating;
    }
    const total = safeNumberOrNull(quality.totalSupply);
    return total !== null && total > 0 ? total : null;
  }

  private resolveTeamPct(
    supplyBreakdown: Record<string, unknown>,
    categoryConcentration: Record<string, unknown>,
    teamDetection: Record<string, unknown>,
  ): number | null {
    const bySupplyBreakdown = safeNumberOrNull(asRecord(supplyBreakdown.team).pctOfSupply);
    const byCategory = safeNumberOrNull(asRecord(categoryConcentration.teamLinked).pctOfSupply);
    const byTeamDetection = safeNumberOrNull(teamDetection.teamTotalPctOfSupply);
    return bySupplyBreakdown ?? byCategory ?? byTeamDetection;
  }

  private resolveVerdict(
    riskLevel: TrustRiskLevel,
    top10RetailPct: number | null,
    teamLinkedPct: number | null,
  ): string {
    if (riskLevel === 'unknown') {
      return 'Insufficient data for a confident verdict';
    }
    if (riskLevel === 'severe' && (teamLinkedPct ?? 0) >= 20) {
      return 'Severe insider or whale-control risk';
    }
    if (riskLevel === 'severe' || (top10RetailPct ?? 0) >= 70) {
      return 'High concentration risk with elevated exit pressure';
    }
    if (riskLevel === 'high') {
      return 'Moderate-to-high risk; concentration and wallet exits need review';
    }
    if (riskLevel === 'moderate') {
      return 'Moderate risk — watch holder concentration and large wallet behavior';
    }
    return 'Low visible risk, but still requires review';
  }

  private resolveWhoCanDumpRiskLevel(
    top10RetailPct: number | null,
    largestRetailPct: number | null,
    teamLinkedPct: number | null,
    hasEnoughData: boolean,
  ): TrustRiskLevel {
    if (!hasEnoughData) {
      return 'unknown';
    }
    if ((top10RetailPct ?? 0) >= 70 || (largestRetailPct ?? 0) >= 10 || (teamLinkedPct ?? 0) >= 20) {
      return 'severe';
    }
    if ((top10RetailPct ?? 0) >= 50 || (largestRetailPct ?? 0) >= 5 || (teamLinkedPct ?? 0) >= 10) {
      return 'high';
    }
    if ((top10RetailPct ?? 0) >= 30 || (largestRetailPct ?? 0) >= 2 || (teamLinkedPct ?? 0) >= 5) {
      return 'moderate';
    }
    return 'low';
  }

  private buildWhoCanDumpSummary(
    riskLevel: TrustRiskLevel,
    top10RetailPct: number | null,
    largestRetailPct: number | null,
    teamLinkedPct: number | null,
    exchangePct: number | null,
  ): string {
    if (riskLevel === 'unknown') {
      return 'Retail holder coverage is limited, so exit-pressure analysis is uncertain.';
    }
    if (riskLevel === 'severe') {
      return 'Retail concentration is high. A small number of wallets can create meaningful sell pressure.';
    }
    if (riskLevel === 'high') {
      return 'Large wallets can influence price, and concentration should be monitored closely.';
    }
    if ((teamLinkedPct ?? 0) >= 5) {
      return 'Team-linked wallets control a meaningful share of supply and should be monitored alongside retail whales.';
    }
    if ((exchangePct ?? 0) >= 30) {
      return 'Exchange custody is high; treat this as liquidity access, not direct sell pressure.';
    }
    if ((top10RetailPct ?? 0) >= 30 || (largestRetailPct ?? 0) >= 2) {
      return 'No single wallet dominates, but top-holder concentration still needs monitoring.';
    }
    return 'No single retail wallet appears dominant in the analyzed holder set.';
  }

  private buildRedFlags(input: {
    top10RetailPct: number | null;
    largestRetailWalletPct: number | null;
    largestRetailWalletUsd: number | null;
    teamLinkedPct: number | null;
    analyzedRetail: number;
    avgHolderStrength: number;
  }): TokenTrustFlag[] {
    const flags: TokenTrustFlag[] = [];

    if ((input.top10RetailPct ?? 0) >= 35) {
      const severity: TokenTrustFlag['severity'] =
        (input.top10RetailPct ?? 0) >= 70 ? 'severe' : (input.top10RetailPct ?? 0) >= 50 ? 'high' : 'medium';
      flags.push({
        severity,
        title: 'High Retail Concentration',
        description: `Top 10 retail wallets control ${roundTo(input.top10RetailPct ?? 0, 1)}% of retail-held supply.`,
      });
    }

    if ((input.largestRetailWalletPct ?? 0) >= 1) {
      const severity: TokenTrustFlag['severity'] =
        (input.largestRetailWalletPct ?? 0) >= 10
          ? 'severe'
          : (input.largestRetailWalletPct ?? 0) >= 5
            ? 'high'
            : 'medium';
      flags.push({
        severity,
        title: 'Large Wallet Can Move Price',
        description: `The largest retail wallet controls ${roundTo(input.largestRetailWalletPct ?? 0, 2)}% of supply, worth approximately ${formatUsd(input.largestRetailWalletUsd ?? 0)}.`,
      });
    }

    if ((input.teamLinkedPct ?? 0) >= 5) {
      const severity: TokenTrustFlag['severity'] =
        (input.teamLinkedPct ?? 0) >= 20 ? 'severe' : (input.teamLinkedPct ?? 0) >= 10 ? 'high' : 'medium';
      flags.push({
        severity,
        title: 'Team-Linked Supply Detected',
        description: `Team-linked or treasury wallets account for ${roundTo(input.teamLinkedPct ?? 0, 1)}% of supply.`,
      });
    }

    if (input.analyzedRetail < 50) {
      flags.push({
        severity: input.analyzedRetail < 20 ? 'high' : 'medium',
        title: 'Limited Retail Sample',
        description: `Only ${input.analyzedRetail} retail wallets were classifiable in the top 100 holders.`,
      });
    }

    if (input.avgHolderStrength < 45) {
      flags.push({
        severity: input.avgHolderStrength < 30 ? 'high' : 'medium',
        title: 'Weak Holder Strength',
        description: `Average holder strength is ${roundTo(input.avgHolderStrength, 1)}/100.`,
      });
    }

    return flags;
  }

  private buildPositiveSignals(input: {
    teamLinkedPct: number | null;
    exchangePct: number | null;
    top10RetailPct: number | null;
    avgHolderStrength: number;
  }): TokenTrustPositiveSignal[] {
    const positives: TokenTrustPositiveSignal[] = [];

    if ((input.teamLinkedPct ?? 100) < 5) {
      positives.push({
        strength: (input.teamLinkedPct ?? 0) < 2 ? 'high' : 'medium',
        title: 'Low Detected Team Allocation',
        description: `Team-linked wallets appear to control only ${roundTo(input.teamLinkedPct ?? 0, 1)}% of supply.`,
      });
    }

    if ((input.exchangePct ?? 0) >= 25) {
      positives.push({
        strength: (input.exchangePct ?? 0) >= 40 ? 'high' : 'medium',
        title: 'Broad Exchange Access',
        description: `${roundTo(input.exchangePct ?? 0, 1)}% of supply is held in exchange custody. This can support liquidity access but is not direct sell pressure.`,
      });
    }

    if (input.top10RetailPct !== null && input.top10RetailPct < 30) {
      positives.push({
        strength: input.top10RetailPct < 20 ? 'high' : 'medium',
        title: 'Well Distributed Retail Supply',
        description: 'Retail concentration appears lower than many small-cap tokens.',
      });
    }

    if (input.avgHolderStrength >= 60) {
      positives.push({
        strength: input.avgHolderStrength >= 75 ? 'high' : 'medium',
        title: 'Stronger Holder Base',
        description: `Average holder strength is ${roundTo(input.avgHolderStrength, 1)}/100 across analyzed retail wallets.`,
      });
    }

    return positives;
  }

  private buildLimitations(
    reportMode: 'fast' | 'standard',
    analyzedRetail: number,
  ): string[] {
    const limitations = [
      'Contract safety analysis is not included yet.',
      'Off-chain credibility analysis is not included yet.',
      'Holder classifications are based on available on-chain data and may be incomplete.',
      'Exchange custody is treated as liquidity context, not direct sell pressure.',
    ];

    if (reportMode === 'fast') {
      limitations.push(
        'FAST_MODE uses recent transfer history only; long-term trading PnL is not calculated.',
      );
    }
    if (analyzedRetail < 20) {
      limitations.push('Retail sample coverage is limited; confidence is low.');
    }
    return limitations;
  }

  private riskLabelFromPenalty(penalty: number): string {
    if (penalty >= 25) return 'Severe risk';
    if (penalty >= 15) return 'High risk';
    if (penalty >= 7) return 'Moderate risk';
    return 'Lower risk';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function nullableRound(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return roundTo(value, digits);
}

function scoreItem(score: number, risk: string): TokenTrustBreakdownItem {
  return { score: clamp(Math.round(score), 0, 100), risk };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  if (Math.abs(value) >= 1_000_000_000) return `$${roundTo(value / 1_000_000_000, 2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${roundTo(value / 1_000_000, 2)}M`;
  if (Math.abs(value) >= 1_000) return `$${roundTo(value / 1_000, 2)}K`;
  return `$${roundTo(value, 2)}`;
}
