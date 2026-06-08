import { Injectable } from '@nestjs/common';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';

export type TrustRiskLevel = 'low' | 'moderate' | 'high' | 'severe' | 'unknown';
export type TrustConfidence = 'low' | 'medium' | 'high';

/** Max score until contract safety + off-chain credibility are implemented. */
const MAX_TRUST_SCORE_WITHOUT_FULL_AUDIT = 82;
const SCORE_BASELINE = 70;

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

export interface ConcentrationContext {
  retailSupplyPct: number | null;
  top10RetailPctOfRetail: number | null;
  top10RetailPctOfTotal: number | null;
  top50RetailPctOfTotal: number | null;
  top100RetailPctOfTotal: number | null;
  largestRetailWalletPctOfTotal: number | null;
  explanation: string;
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
  scoreType: 'visible_onchain_score';
  scoreLabel: 'Visible On-chain Score';
  scoreStatus: 'partial';
  scoreCoverage: string[];
  availableModules?: string[];
  missingScoreInputs: string[];
  riskLevel: TrustRiskLevel;
  verdict: string;
  confidence: TrustConfidence;
  reportMode: 'fast' | 'standard';
  summary: string;
  redFlags: TokenTrustFlag[];
  positiveSignals: TokenTrustPositiveSignal[];
  concentrationContext: ConcentrationContext;
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
  knownLabel?: unknown;
}

interface TeamExposureAnalysis {
  teamLinkedPct: number | null;
  treasuryVestingPct: number;
  suspiciousEoaPct: number;
  mostlyTreasuryVesting: boolean;
}

interface ScoringContext {
  hasEnoughData: boolean;
  analyzedRetail: number;
  avgHolderStrength: number;
  decentralizationScore: number;
  exchangePct: number | null;
  retailSupplyPct: number | null;
  top10RetailPctOfRetail: number | null;
  top10RetailPctOfTotal: number | null;
  top50RetailPctOfTotal: number | null;
  top100RetailPctOfTotal: number | null;
  largestRetailWalletPctOfTotal: number | null;
  largestRetailWalletUsd: number | null;
  team: TeamExposureAnalysis;
  teamRiskLevel: string;
  reportMode: 'fast' | 'standard';
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

    const decentralizationScore = safeNumber(distribution.decentralizationScore);
    const avgHolderStrength = safeNumber(quality.avgScore);
    const classifiableRetailCount = safeNumber(quality.classifiableRetailCount);
    const totalAnalyzedEOAs = safeNumber(quality.totalAnalyzedEOAs);
    const reportMode: 'fast' | 'standard' =
      safeNumber(pnlAggregation.holdersWithPnlData) > 0 ? 'standard' : 'fast';
    const teamRiskLevel = safeString(teamDetection.riskLevel).toLowerCase();

    const supply = this.resolveSupply(quality);
    const retailHolders = holders.filter(
      (holder) => holder.walletLabel === 'eoa' && holder.isTeamLinked !== true,
    );
    const retailWithPct = retailHolders
      .map((holder) => ({
        address: safeStringOrNull(holder.walletAddress),
        usdValue: safeNumberOrNull(holder.usdValue),
        percentSupply: holderPercentOfSupply(holder, supply),
      }))
      .filter((holder) => holder.percentSupply !== null)
      .sort((left, right) => (right.percentSupply ?? 0) - (left.percentSupply ?? 0));

    const largestRetail = retailWithPct[0] ?? null;
    const largestRetailWalletPctOfTotal = largestRetail?.percentSupply ?? null;
    const largestRetailWalletUsd = largestRetail?.usdValue ?? null;
    const largestRetailWalletAddress = largestRetail?.address ?? null;
    const retailWhaleCount = retailWithPct.filter(
      (holder) => (holder.percentSupply ?? 0) >= 1,
    ).length;

    const retailSupplyPct = safeNumberOrNull(asRecord(supplyBreakdown.retail).pctOfSupply);
    const top10RetailPctOfRetail =
      safeNumberOrNull(supplyConcentration.top10Pct) ??
      (retailWithPct.length > 0
        ? retailWithPct
            .slice(0, 10)
            .reduce((sum, holder) => sum + (holder.percentSupply ?? 0), 0)
        : null);

    const top50RetailPctOfRetail = safeNumberOrNull(supplyConcentration.top50Pct);
    const top100RetailPctOfRetail = safeNumberOrNull(supplyConcentration.top100Pct);

    const top10RetailPctOfTotal = retailPctOfTotal(retailSupplyPct, top10RetailPctOfRetail);
    const top50RetailPctOfTotal = retailPctOfTotal(retailSupplyPct, top50RetailPctOfRetail);
    const top100RetailPctOfTotal = retailPctOfTotal(retailSupplyPct, top100RetailPctOfRetail);

    const team = this.analyzeTeamExposure(
      holders,
      supply,
      this.resolveTeamPct(supplyBreakdown, categoryConcentration, teamDetection),
    );
    const exchangePct = safeNumberOrNull(asRecord(supplyBreakdown.exchange).pctOfSupply);
    const contractPct = safeNumberOrNull(asRecord(supplyBreakdown.contract).pctOfSupply);
    const lpPct = safeNumberOrNull(asRecord(supplyBreakdown.lp).pctOfSupply);

    const analyzedRetail = Math.max(
      classifiableRetailCount,
      totalAnalyzedEOAs,
      retailWithPct.length,
    );

    const hasEnoughData =
      analyzedRetail > 0 &&
      top10RetailPctOfRetail !== null &&
      Number.isFinite(top10RetailPctOfRetail);

    const concentrationContext = this.buildConcentrationContext({
      retailSupplyPct,
      top10RetailPctOfRetail,
      top10RetailPctOfTotal,
      top50RetailPctOfTotal,
      top100RetailPctOfTotal,
      largestRetailWalletPctOfTotal,
    });

    const ctx: ScoringContext = {
      hasEnoughData,
      analyzedRetail,
      avgHolderStrength,
      decentralizationScore,
      exchangePct,
      retailSupplyPct,
      top10RetailPctOfRetail,
      top10RetailPctOfTotal,
      top50RetailPctOfTotal,
      top100RetailPctOfTotal,
      largestRetailWalletPctOfTotal,
      largestRetailWalletUsd,
      team,
      teamRiskLevel,
      reportMode,
    };

    const adjustments = this.computeAdjustments(ctx);
    const trustScore = clamp(
      Math.round(SCORE_BASELINE + adjustments.total),
      0,
      MAX_TRUST_SCORE_WITHOUT_FULL_AUDIT,
    );

    const hardSevere = this.hasHardSevereTrigger(ctx);
    const riskLevel = this.resolveRiskLevel(trustScore, hardSevere, hasEnoughData);

    const verdict = this.resolveVerdict(ctx, riskLevel, hardSevere);
    const whoCanDumpRiskLevel = this.resolveWhoCanDumpRiskLevel(ctx);

    const redFlags = this.buildRedFlags(ctx);
    const positiveSignals = this.buildPositiveSignals(ctx);
    const hasContractSafety = this.hasContractSafetyModule(quality);
    const hasMarketContext = this.hasMarketContextModule(quality);
    const hasOffChainCredibility = this.hasOffChainCredibilityModule(quality);
    const limitations = this.buildLimitations(
      reportMode,
      analyzedRetail,
      hasContractSafety,
      hasMarketContext,
      hasOffChainCredibility,
    );

    const whoCanDump: WhoCanDumpSummary = {
      largestRetailWalletPct: nullableRound(largestRetailWalletPctOfTotal, 2),
      largestRetailWalletUsd: nullableRound(largestRetailWalletUsd, 2),
      largestRetailWalletAddress,
      top10RetailPct: nullableRound(top10RetailPctOfTotal, 2),
      retailWhaleCount,
      teamLinkedPct: nullableRound(team.teamLinkedPct, 2),
      exchangePct: nullableRound(exchangePct, 2),
      contractPct: nullableRound(contractPct, 2),
      lpPct: nullableRound(lpPct, 2),
      riskLevel: whoCanDumpRiskLevel,
      summary: this.buildWhoCanDumpSummary(ctx, whoCanDumpRiskLevel),
    };

    return {
      trustScore,
      scoreType: 'visible_onchain_score',
      scoreLabel: 'Visible On-chain Score',
      scoreStatus: 'partial',
      scoreCoverage: [
        'holder_structure',
        'wallet_concentration',
        'team_treasury_exposure',
      ],
      availableModules: [
        'holder_structure',
        ...(hasContractSafety ? (['contract_safety'] as const) : []),
        ...(hasMarketContext ? (['market_context'] as const) : []),
        ...(hasOffChainCredibility ? (['off_chain_credibility'] as const) : []),
      ],
      missingScoreInputs: [
        ...(hasContractSafety ? [] : (['contract_safety'] as const)),
        ...(hasMarketContext ? [] : (['market_context', 'liquidity_depth'] as const)),
        ...(hasOffChainCredibility ? [] : (['off_chain_credibility'] as const)),
      ],
      riskLevel,
      verdict,
      confidence: this.resolveConfidence(analyzedRetail),
      reportMode,
      summary: `${verdict}. ${concentrationContext.explanation}`,
      redFlags,
      positiveSignals,
      concentrationContext,
      whoCanDump,
      trustBreakdown: {
        holderConcentration: scoreItem(
          70 + adjustments.concentrationTotal,
          breakdownSafetyLabel(70 + adjustments.concentrationTotal),
        ),
        whaleExitRisk: scoreItem(
          70 + adjustments.whale,
          breakdownSafetyLabel(70 + adjustments.whale),
        ),
        teamOrInsiderRisk: scoreItem(
          70 + adjustments.teamTotal,
          breakdownSafetyLabel(70 + adjustments.teamTotal),
        ),
        exchangeLiquidityContext: scoreItem(
          70 + adjustments.exchange,
          exchangePct !== null
            ? 'Exchange custody is liquidity context, not direct sell pressure.'
            : 'Exchange custody data is limited.',
        ),
        holderStrength: scoreItem(
          70 + adjustments.holderStrength,
          breakdownSafetyLabel(70 + adjustments.holderStrength),
        ),
        dataConfidence: scoreItem(
          70 + adjustments.dataConfidence,
          breakdownSafetyLabel(70 + adjustments.dataConfidence),
        ),
      },
      limitations,
    };
  }

  private buildConcentrationContext(input: {
    retailSupplyPct: number | null;
    top10RetailPctOfRetail: number | null;
    top10RetailPctOfTotal: number | null;
    top50RetailPctOfTotal: number | null;
    top100RetailPctOfTotal: number | null;
    largestRetailWalletPctOfTotal: number | null;
  }): ConcentrationContext {
    const retail = input.top10RetailPctOfRetail;
    const total = input.top10RetailPctOfTotal;

    let explanation = 'Retail concentration metrics are unavailable for this snapshot.';
    if (retail !== null && total !== null) {
      explanation =
        `Top 10 retail wallets control ${roundTo(retail, 1)}% of retail-held supply, ` +
        `equal to roughly ${roundTo(total, 1)}% of total supply.`;
    } else if (retail !== null) {
      explanation = `Top 10 retail wallets control ${roundTo(retail, 1)}% of retail-held supply.`;
    }

    return {
      retailSupplyPct: nullableRound(input.retailSupplyPct, 2),
      top10RetailPctOfRetail: nullableRound(input.top10RetailPctOfRetail, 2),
      top10RetailPctOfTotal: nullableRound(input.top10RetailPctOfTotal, 2),
      top50RetailPctOfTotal: nullableRound(input.top50RetailPctOfTotal, 2),
      top100RetailPctOfTotal: nullableRound(input.top100RetailPctOfTotal, 2),
      largestRetailWalletPctOfTotal: nullableRound(
        input.largestRetailWalletPctOfTotal,
        2,
      ),
      explanation,
    };
  }

  private computeAdjustments(ctx: ScoringContext): {
    concentrationTotal: number;
    whale: number;
    teamTotal: number;
    exchange: number;
    holderStrength: number;
    decentralization: number;
    dataConfidence: number;
    total: number;
  } {
    const top10Total = ctx.top10RetailPctOfTotal;
    const top10Retail = ctx.top10RetailPctOfRetail;
    const largest = ctx.largestRetailWalletPctOfTotal;
    const teamPct = ctx.team.teamLinkedPct ?? 0;

    let concentrationTotal = 0;
    if (!ctx.hasEnoughData) {
      concentrationTotal = -8;
    } else if (top10Total === null) {
      concentrationTotal -= 4;
    } else if (top10Total >= 35) concentrationTotal -= 25;
    else if (top10Total >= 25) concentrationTotal -= 18;
    else if (top10Total >= 15) concentrationTotal -= 10;
    else if (top10Total >= 8) concentrationTotal -= 5;
    else if (top10Total >= 3) concentrationTotal -= 2;
    else concentrationTotal += 2;

    if (top10Retail === null) {
      concentrationTotal -= 1;
    } else if (top10Retail >= 70) concentrationTotal -= 6;
    else if (top10Retail >= 50) concentrationTotal -= 4;
    else if (top10Retail >= 35) concentrationTotal -= 2;
    else concentrationTotal += 1;

    let whale = 0;
    if (largest === null) {
      whale -= 2;
    } else if (largest >= 10) whale -= 20;
    else if (largest >= 5) whale -= 10;
    else if (largest >= 2) whale -= 5;
    else if (largest >= 1) whale -= 2;
    else whale += 1;

    let teamBase = 0;
    if (teamPct >= 30) teamBase -= 20;
    else if (teamPct >= 20) teamBase -= 12;
    else if (teamPct >= 10) teamBase -= 6;
    else if (teamPct >= 5) teamBase -= 3;
    else teamBase += 2;

    const treasuryHeavy =
      ctx.team.mostlyTreasuryVesting &&
      !['high', 'critical', 'severe'].includes(ctx.teamRiskLevel) &&
      ctx.team.suspiciousEoaPct < 5;

    if (treasuryHeavy && teamBase < -8) {
      teamBase = -8;
    }

    let suspiciousExtra = 0;
    const suspicious = ctx.team.suspiciousEoaPct;
    if (suspicious >= 15) suspiciousExtra -= 15;
    else if (suspicious >= 10) suspiciousExtra -= 10;
    else if (suspicious >= 5) suspiciousExtra -= 5;

    const teamTotal = teamBase + suspiciousExtra;

    let holderStrength = 0;
    if (ctx.avgHolderStrength >= 70) holderStrength += 8;
    else if (ctx.avgHolderStrength >= 60) holderStrength += 5;
    else if (ctx.avgHolderStrength >= 45) holderStrength += 1;
    else if (ctx.avgHolderStrength >= 30) holderStrength -= 3;
    else holderStrength -= 6;

    let decentralization = 0;
    if (ctx.decentralizationScore >= 75) decentralization += 6;
    else if (ctx.decentralizationScore >= 60) decentralization += 3;
    else if (ctx.decentralizationScore >= 40) decentralization -= 3;
    else if (ctx.decentralizationScore >= 25) decentralization -= 7;
    else decentralization -= 12;

    let exchange = 0;
    const ex = ctx.exchangePct ?? 0;
    if (ex >= 20 && ex <= 60) exchange += 3;
    else if (ex > 70) exchange -= 3;
    else if (ex < 2) exchange -= 2;

    let dataConfidence = 0;
    if (!ctx.hasEnoughData) dataConfidence -= 4;
    else if (ctx.analyzedRetail >= 50) dataConfidence += 3;
    else if (ctx.analyzedRetail >= 25) dataConfidence += 0;
    else dataConfidence -= 6;

    const total =
      concentrationTotal +
      whale +
      teamTotal +
      holderStrength +
      decentralization +
      exchange +
      dataConfidence;

    return {
      concentrationTotal,
      whale,
      teamTotal,
      exchange,
      holderStrength,
      decentralization,
      dataConfidence,
      total,
    };
  }

  private hasHardSevereTrigger(ctx: ScoringContext): boolean {
    const top10Total = ctx.top10RetailPctOfTotal ?? 0;
    const largest = ctx.largestRetailWalletPctOfTotal ?? 0;
    const suspiciousTeam = ctx.team.suspiciousEoaPct;

    if (largest >= 10) return true;
    if (top10Total >= 35) return true;
    if (suspiciousTeam >= 20) return true;

    const weakData = ctx.analyzedRetail < 20;
    const highConcentration = top10Total >= 25 || largest >= 5;
    if (weakData && highConcentration) return true;

    return false;
  }

  private resolveRiskLevel(
    trustScore: number,
    hardSevere: boolean,
    hasEnoughData: boolean,
  ): TrustRiskLevel {
    if (!hasEnoughData) return 'unknown';
    if (hardSevere) return 'severe';
    if (trustScore >= 80) return 'low';
    if (trustScore >= 65) return 'moderate';
    if (trustScore >= 45) return 'high';
    return 'severe';
  }

  private resolveConfidence(analyzedRetail: number): TrustConfidence {
    if (analyzedRetail < 20) return 'low';
    if (analyzedRetail < 50) return 'medium';
    return 'high';
  }

  private resolveVerdict(
    ctx: ScoringContext,
    riskLevel: TrustRiskLevel,
    hardSevere: boolean,
  ): string {
    if (riskLevel === 'unknown') {
      return 'Insufficient data for a confident verdict';
    }

    const top10Total = ctx.top10RetailPctOfTotal ?? 0;
    const suspiciousTeam = ctx.team.suspiciousEoaPct;
    const teamPct = ctx.team.teamLinkedPct ?? 0;
    const isMemeLike = ctx.avgHolderStrength < 45 && top10Total >= 15;

    if (hardSevere) {
      if (suspiciousTeam >= 20) {
        return 'Severe insider-control risk';
      }
      if ((ctx.largestRetailWalletPctOfTotal ?? 0) >= 10) {
        return 'Severe whale-control risk';
      }
      return 'Severe concentration and exit-pressure risk';
    }

    if (isMemeLike && riskLevel === 'high') {
      return 'Meme token with high retail concentration and elevated exit-pressure risk';
    }

    if (riskLevel === 'high') {
      return 'High holder concentration risk';
    }

    if (riskLevel === 'moderate') {
      if (teamPct >= 10 && ctx.team.mostlyTreasuryVesting) {
        return 'Established token with treasury exposure and concentration to review';
      }
      return 'Moderate visible risk — treasury exposure and large wallets should be reviewed';
    }

    if (riskLevel === 'low') {
      return 'Low visible risk, but still requires review';
    }

    return 'Moderate-to-high risk; concentration and wallet exits need review';
  }

  private resolveWhoCanDumpRiskLevel(ctx: ScoringContext): TrustRiskLevel {
    if (!ctx.hasEnoughData) return 'unknown';

    const top10Total = ctx.top10RetailPctOfTotal ?? 0;
    const largest = ctx.largestRetailWalletPctOfTotal ?? 0;
    const suspiciousTeam = ctx.team.suspiciousEoaPct;

    if (top10Total >= 35 || largest >= 10 || suspiciousTeam >= 20) {
      return 'severe';
    }
    if (top10Total >= 20 || largest >= 5 || suspiciousTeam >= 10) {
      return 'high';
    }
    if (top10Total >= 10 || largest >= 2 || suspiciousTeam >= 5) {
      return 'moderate';
    }
    return 'low';
  }

  private buildWhoCanDumpSummary(
    ctx: ScoringContext,
    riskLevel: TrustRiskLevel,
  ): string {
    if (riskLevel === 'unknown') {
      return 'Retail holder coverage is limited, so exit-pressure analysis is uncertain.';
    }

    const top10Total = ctx.top10RetailPctOfTotal ?? 0;
    const largest = ctx.largestRetailWalletPctOfTotal ?? 0;
    const teamPct = ctx.team.teamLinkedPct ?? 0;
    const exchangePct = ctx.exchangePct ?? 0;

    if (riskLevel === 'severe') {
      return 'A small number of wallets can create meaningful sell pressure on total supply.';
    }
    if (riskLevel === 'high') {
      return 'Large wallets can influence price, and concentration should be monitored closely.';
    }
    if (teamPct >= 10 && ctx.team.mostlyTreasuryVesting) {
      return 'Treasury or vesting wallets hold a meaningful share of supply and should be reviewed alongside retail whales.';
    }
    if (exchangePct >= 30) {
      return 'Exchange custody is high; treat this as liquidity access, not direct sell pressure.';
    }
    if (top10Total >= 8 || largest >= 2) {
      return 'No single retail wallet dominates total supply, but top-holder concentration still needs monitoring.';
    }
    return 'No single retail wallet appears dominant in total-supply terms.';
  }

  private buildRedFlags(ctx: ScoringContext): TokenTrustFlag[] {
    const flags: TokenTrustFlag[] = [];
    const retail = ctx.top10RetailPctOfRetail ?? 0;
    const total = ctx.top10RetailPctOfTotal ?? 0;
    const largest = ctx.largestRetailWalletPctOfTotal ?? 0;
    const teamPct = ctx.team.teamLinkedPct ?? 0;

    if (retail >= 35 || total >= 8) {
      let severity: TokenTrustFlag['severity'] = 'low';
      if (total >= 35) severity = 'severe';
      else if (total >= 20) severity = 'high';
      else if (total >= 10) severity = 'medium';
      else if (retail >= 70) severity = 'medium';

      flags.push({
        severity,
        title: concentrationRedFlagTitle(severity),
        description:
          `Top 10 retail wallets control ${roundTo(retail, 1)}% of retail-held supply, ` +
          `equal to roughly ${roundTo(total, 1)}% of total supply.`,
      });
    }

    if (largest >= 1) {
      const severity: TokenTrustFlag['severity'] =
        largest >= 10 ? 'severe' : largest >= 5 ? 'high' : largest >= 2 ? 'medium' : 'low';
      flags.push({
        severity,
        title: 'Large Wallet Can Move Price',
        description: `The largest retail wallet controls ${roundTo(largest, 2)}% of total supply, worth approximately ${formatUsd(ctx.largestRetailWalletUsd ?? 0)}.`,
      });
    }

    if (teamPct >= 5) {
      const suspicious = ctx.team.suspiciousEoaPct;
      const treasuryHeavy = ctx.team.mostlyTreasuryVesting;
      let severity: TokenTrustFlag['severity'] = 'medium';
      let title = 'Treasury / Team Supply Requires Review';

      if (suspicious >= 10 || ['high', 'critical', 'severe'].includes(ctx.teamRiskLevel)) {
        severity = suspicious >= 20 || teamPct >= 30 ? 'severe' : 'high';
        title = 'Suspicious Team or Insider Supply Detected';
      } else if (treasuryHeavy && teamPct < 25) {
        severity = 'medium';
      } else if (teamPct >= 25) {
        severity = 'high';
        title = 'Suspicious Team or Insider Supply Detected';
      }

      flags.push({
        severity,
        title,
        description: treasuryHeavy
          ? `Treasury or vesting wallets account for ${roundTo(teamPct, 1)}% of supply and should be reviewed.`
          : `Team-linked or insider wallets account for ${roundTo(teamPct, 1)}% of supply.`,
      });
    }

    if (ctx.analyzedRetail < 50) {
      flags.push({
        severity: ctx.analyzedRetail < 20 ? 'high' : 'medium',
        title: 'Limited Retail Sample',
        description: `Only ${ctx.analyzedRetail} retail wallets were classifiable in the top 100 holders.`,
      });
    }

    if (ctx.avgHolderStrength < 45) {
      flags.push({
        severity: ctx.avgHolderStrength < 30 ? 'high' : 'medium',
        title: 'Weak Holder Strength',
        description: `Average holder strength is ${roundTo(ctx.avgHolderStrength, 1)}/100.`,
      });
    }

    return flags;
  }

  private buildPositiveSignals(ctx: ScoringContext): TokenTrustPositiveSignal[] {
    const positives: TokenTrustPositiveSignal[] = [];
    const teamPct = ctx.team.teamLinkedPct ?? 100;
    const exchangePct = ctx.exchangePct ?? 0;
    const top10Total = ctx.top10RetailPctOfTotal ?? 100;
    const largest = ctx.largestRetailWalletPctOfTotal ?? 100;

    if (teamPct < 5) {
      positives.push({
        strength: teamPct < 2 ? 'high' : 'medium',
        title: 'Low Detected Team Allocation',
        description: `Team-linked wallets appear to control only ${roundTo(teamPct, 1)}% of supply.`,
      });
    }

    if (exchangePct >= 20) {
      positives.push({
        strength: exchangePct >= 40 ? 'high' : 'medium',
        title: 'Broad Exchange Access',
        description: `${roundTo(exchangePct, 1)}% of supply is held in exchange custody. This can support liquidity access but is not direct sell pressure.`,
      });
    }

    if (top10Total < 15) {
      positives.push({
        strength: top10Total < 8 ? 'high' : 'medium',
        title: 'Well Distributed Retail Supply',
        description: `Top 10 retail wallets control roughly ${roundTo(top10Total, 1)}% of total supply.`,
      });
    }

    if (ctx.decentralizationScore >= 75) {
      positives.push({
        strength: ctx.decentralizationScore >= 85 ? 'high' : 'medium',
        title: 'Strong Retail Decentralization',
        description: `Decentralization score is ${roundTo(ctx.decentralizationScore, 0)}/100 across analyzed retail wallets.`,
      });
    }

    if (ctx.avgHolderStrength >= 60) {
      positives.push({
        strength: ctx.avgHolderStrength >= 75 ? 'high' : 'medium',
        title: 'Strong Holder Strength',
        description: `Average holder strength is ${roundTo(ctx.avgHolderStrength, 1)}/100 across analyzed retail wallets.`,
      });
    }

    if (largest < 2 && ctx.team.suspiciousEoaPct < 5) {
      positives.push({
        strength: 'medium',
        title: 'No Dominant Single Retail Wallet',
        description: 'No single analyzed retail wallet controls a large share of total supply.',
      });
    }

    if (ctx.team.suspiciousEoaPct < 2) {
      positives.push({
        strength: 'medium',
        title: 'Low Detected Deployer/Owner Control',
        description: 'Deployer, owner, and team-connected EOAs control little detected supply.',
      });
    }

    return positives;
  }

  private analyzeTeamExposure(
    holders: RawHolder[],
    supply: number | null,
    teamLinkedPct: number | null,
  ): TeamExposureAnalysis {
    const treasuryLabels = new Set(['treasury', 'vesting', 'staking']);
    const suspiciousLabels = new Set(['deployer', 'owner', 'team_connected']);

    let treasuryVestingPct = 0;
    let suspiciousEoaPct = 0;

    for (const holder of holders) {
      const label = safeString(holder.walletLabel).toLowerCase();
      const pct = holderPercentOfSupply(holder, supply) ?? 0;

      if (treasuryLabels.has(label)) {
        treasuryVestingPct += pct;
        continue;
      }

      if (suspiciousLabels.has(label)) {
        suspiciousEoaPct += pct;
        continue;
      }

      if (label === 'eoa' && holder.isTeamLinked === true) {
        suspiciousEoaPct += pct;
      }
    }

    const resolvedTeamPct = teamLinkedPct ?? treasuryVestingPct + suspiciousEoaPct;
    const mostlyTreasuryVesting =
      resolvedTeamPct > 0 && treasuryVestingPct / resolvedTeamPct >= 0.7;

    return {
      teamLinkedPct: resolvedTeamPct > 0 ? resolvedTeamPct : teamLinkedPct,
      treasuryVestingPct,
      suspiciousEoaPct,
      mostlyTreasuryVesting,
    };
  }

  private hasContractSafetyModule(quality: Record<string, unknown>): boolean {
    const contractSafety = asRecord(quality.contractSafety);
    const status = safeString(contractSafety.status).toLowerCase();
    return status === 'done' || status === 'partial';
  }

  private hasMarketContextModule(quality: Record<string, unknown>): boolean {
    const marketContext = asRecord(quality.marketContext);
    const status = safeString(marketContext.status).toLowerCase();
    return status === 'done' || status === 'partial';
  }

  private hasOffChainCredibilityModule(quality: Record<string, unknown>): boolean {
    const offChainCredibility = asRecord(quality.offChainCredibility);
    const status = safeString(offChainCredibility.status).toLowerCase();
    return status === 'done' || status === 'partial';
  }

  private buildLimitations(
    reportMode: 'fast' | 'standard',
    analyzedRetail: number,
    hasContractSafety: boolean,
    hasMarketContext: boolean,
    hasOffChainCredibility: boolean,
  ): string[] {
    const hasSupplementalModules =
      hasContractSafety || hasMarketContext || hasOffChainCredibility;
    const limitations = [
      hasSupplementalModules
        ? 'Visible score is currently based on on-chain holder structure.'
        : 'This is a partial visible on-chain score. Full trust scoring will require contract safety, market maturity, liquidity depth, and off-chain credibility analysis.',
      hasContractSafety || hasMarketContext || hasOffChainCredibility
        ? 'Contract safety, market context, and off-chain credibility are shown as separate modules.'
        : 'Supplemental trust modules are not included yet.',
      hasContractSafety
        ? 'Contract safety is shown separately and is not yet merged into the visible on-chain score.'
        : 'Contract safety analysis is not included yet.',
      hasMarketContext
        ? 'Market maturity and liquidity context are shown separately and are not yet merged into the visible on-chain score.'
        : 'Market maturity and liquidity depth analysis is not included yet.',
      hasOffChainCredibility
        ? 'Off-chain credibility is shown separately and is not yet merged into the visible on-chain score.'
        : 'Off-chain credibility analysis is not included yet.',
      'Holder classifications are based on available on-chain data and may be incomplete.',
      'Exchange custody is treated as liquidity context, not direct sell pressure.',
      hasOffChainCredibility &&
      hasContractSafety &&
      hasMarketContext
        ? `Visible on-chain score remains partial and is capped at ${MAX_TRUST_SCORE_WITHOUT_FULL_AUDIT}/100 until modules are merged into one score.`
        : `Visible on-chain score is capped at ${MAX_TRUST_SCORE_WITHOUT_FULL_AUDIT}/100 until missing inputs are added.`,
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
}

function holderPercentOfSupply(holder: RawHolder, supply: number | null): number | null {
  if (supply === null || supply <= 0) return null;
  const balance = safeNumber(holder.balance);
  return (balance / supply) * 100;
}

function retailPctOfTotal(
  retailSupplyPct: number | null,
  retailScopedPct: number | null,
): number | null {
  if (retailSupplyPct === null || retailScopedPct === null) return null;
  return (retailSupplyPct * retailScopedPct) / 100;
}

export function concentrationRedFlagTitle(
  severity: TokenTrustFlag['severity'],
): string {
  if (severity === 'severe' || severity === 'high') {
    return 'High Retail Concentration';
  }
  if (severity === 'medium') {
    return 'Retail Concentration Requires Review';
  }
  return 'Retail Holder Concentration';
}

function breakdownSafetyLabel(score: number): string {
  if (score >= 80) return 'Favorable signal';
  if (score >= 65) return 'Moderate / watch';
  if (score >= 45) return 'Elevated risk';
  return 'High risk';
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
