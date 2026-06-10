import { Injectable } from '@nestjs/common';
import type { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import type { DashboardSummaryResponse } from './dashboard-summary.service';
import type { ContractSafetyReport } from './token-contract-safety.service';
import type { MarketContextReport } from './token-market-context.service';
import type { OffChainCredibilityReport } from './token-offchain-credibility.service';
import type { TokenTrustReport } from './token-trust-report.service';

export type FinalReportRiskLevel = 'low' | 'moderate' | 'high' | 'severe';
export type FinalReportConfidence = 'low' | 'medium' | 'high';

export interface FinalReportFinding {
  title: string;
  severity?: 'low' | 'medium' | 'high' | 'severe';
  strength?: 'low' | 'medium' | 'high';
  description: string;
  source?: string;
}

export interface FinalReportOverall {
  score: number;
  riskLevel: FinalReportRiskLevel;
  confidence: FinalReportConfidence;
  verdict: string;
  summary: string;
  reportType: 'risk_first_token_intelligence';
}

export interface FinalReportKeyFindings {
  positives: FinalReportFinding[];
  risks: FinalReportFinding[];
  unknowns: string[];
}

export interface FinalReportModuleScoreBlock {
  score: number | null;
  riskLevel: string | null;
  confidence: string | null;
  verdict: string;
}

export interface FinalReportHolderStrengthBlock {
  score: number | null;
  label: string | null;
  smartMoneyPct: number | null;
  verdict: string;
}

export interface FinalReportModuleScores {
  onchain: FinalReportModuleScoreBlock;
  holderStrength: FinalReportHolderStrengthBlock;
  contractSafety: FinalReportModuleScoreBlock;
  marketContext: FinalReportModuleScoreBlock;
  offchainCredibility: FinalReportModuleScoreBlock;
}

export interface FinalReportWhoCanDump {
  largestRetailWalletPct: number | null;
  largestRetailWalletUsd: number | null;
  top10RetailPct: number | null;
  teamLinkedPct: number | null;
  exchangePct: number | null;
  contractPct: number | null;
  lpPct: number | null;
  summary: string;
  riskLevel: string;
  watchItems: string[];
}

export interface FinalReportContractSafety {
  verdict: string;
  score: number | null;
  riskLevel: string | null;
  ownerStatus: string | null;
  keyPermissions: string[];
  positiveSignals: FinalReportFinding[];
  riskFlags: FinalReportFinding[];
  unknowns: string[];
}

export interface FinalReportMarketAndLiquidity {
  verdict: string;
  score: number | null;
  riskLevel: string | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  tokenAgeDays: number | null;
  maturityTier: string | null;
  liquidityRisk: { level: string; reason: string } | null;
  exchangeContext: string | null;
  liquidityDoesNotRemoveHolderRiskNote: string;
}

export interface FinalReportOffchainCredibility {
  verdict: string;
  score: number | null;
  riskLevel: string | null;
  confidence: string | null;
  category: string | null;
  identityStatus: string | null;
  discoveredOfficialLinks: Array<{ label: string; url: string }>;
  evidenceQuality: string | null;
  externalValidation: string | null;
  riskFlags: FinalReportFinding[];
  credibilitySignals: FinalReportFinding[];
}

export interface FinalReportDeepAnalysisSections {
  projectOverview: string;
  marketPosition: string;
  holderStructure: string;
  whaleAndTeamRisk: string;
  contractRisk: string;
  offchainLegitimacy: string;
  onchainVsOffchainAlignment: string;
  riskAssessment: string;
}

export interface FinalReportEvidence {
  officialLinks: Array<{ label: string; url: string }>;
  trustedSourcesCount: number;
  officialSourcesCount: number;
  rejectedOrUnrelatedCount: number;
  notes: string[];
}

export interface FinalReportMonitoringPlan {
  recommendation: string;
  watchItems: string[];
  alertCTA: string;
}

export interface TokenFinalReport {
  overall: FinalReportOverall;
  keyFindings: FinalReportKeyFindings;
  moduleScores: FinalReportModuleScores;
  whoCanDump: FinalReportWhoCanDump;
  contractSafety: FinalReportContractSafety;
  marketAndLiquidity: FinalReportMarketAndLiquidity;
  offchainCredibility: FinalReportOffchainCredibility;
  deepAnalysis: FinalReportDeepAnalysisSections;
  evidence: FinalReportEvidence;
  monitoringPlan: FinalReportMonitoringPlan;
  limitations: string[];
}

const LIQUIDITY_HOLDER_RISK_NOTE =
  'Exchange liquidity and market depth can improve access, but they do not remove retail holder concentration or team-linked supply risk.';

const MONITORING_CTA =
  'Track this token 24/7 and get Telegram alerts when whale, team, exchange, liquidity, or contract-risk signals change.';

@Injectable()
export class TokenFinalReportService {
  buildFinalReport(params: {
    analysis: TokenAnalysisEntity;
    dashboard: DashboardSummaryResponse;
  }): TokenFinalReport {
    const { dashboard } = params;
    const tokenTrust = dashboard.tokenTrust;
    const contractSafety = dashboard.contractSafety;
    const marketContext = dashboard.marketContext;
    const offChain = dashboard.offChainCredibility;

    const teamWhaleScore = deriveTeamWhaleScore(tokenTrust);
    const moduleScores = buildModuleScores(
      dashboard,
      tokenTrust,
      contractSafety,
      marketContext,
      offChain,
    );
    const whoCanDump = buildWhoCanDump(dashboard);
    const overall = buildOverall(
      tokenTrust,
      contractSafety,
      marketContext,
      offChain,
      teamWhaleScore,
      whoCanDump,
      dashboard,
    );
    const keyFindings = buildKeyFindings(dashboard);
    const deepAnalysis = buildDeepAnalysisSections(dashboard, overall);
    const evidence = buildEvidence(offChain);
    const monitoringPlan = buildMonitoringPlan(dashboard, whoCanDump, contractSafety, offChain);

    return {
      overall,
      keyFindings,
      moduleScores,
      whoCanDump,
      contractSafety: buildContractSafetySection(contractSafety),
      marketAndLiquidity: buildMarketSection(marketContext),
      offchainCredibility: buildOffchainSection(offChain),
      deepAnalysis,
      evidence,
      monitoringPlan,
      limitations: buildLimitations(dashboard, contractSafety, marketContext, offChain),
    };
  }
}

function buildModuleScores(
  dashboard: DashboardSummaryResponse,
  tokenTrust: TokenTrustReport,
  contractSafety: ContractSafetyReport | null,
  marketContext: MarketContextReport | null,
  offChain: OffChainCredibilityReport | null,
): FinalReportModuleScores {
  return {
    onchain: {
      score: tokenTrust.trustScore,
      riskLevel: tokenTrust.riskLevel,
      confidence: tokenTrust.confidence,
      verdict: tokenTrust.verdict,
    },
    holderStrength: {
      score: dashboard.holderQuality.avgScore,
      label: dashboard.holderQuality.qualityLabel,
      smartMoneyPct: dashboard.holderQuality.smartMoneyPct,
      verdict: holderStrengthVerdict(dashboard.holderQuality),
    },
    contractSafety: {
      score: contractSafety?.score ?? null,
      riskLevel: contractSafety?.riskLevel ?? null,
      confidence: contractSafety?.confidence ?? null,
      verdict: contractSafety?.verdict ?? 'Contract safety was not available for this report.',
    },
    marketContext: {
      score: marketContext?.score ?? null,
      riskLevel: marketContext?.riskLevel ?? null,
      confidence: marketContext?.confidence ?? null,
      verdict: marketContext?.verdict ?? 'Market and liquidity context was not available for this report.',
    },
    offchainCredibility: {
      score: offChain?.score ?? null,
      riskLevel: offChain?.riskLevel ?? null,
      confidence: offChain?.confidence ?? null,
      verdict: offChain?.verdict ?? 'Off-chain credibility was not available for this report.',
    },
  };
}

function buildOverall(
  tokenTrust: TokenTrustReport,
  contractSafety: ContractSafetyReport | null,
  marketContext: MarketContextReport | null,
  offChain: OffChainCredibilityReport | null,
  teamWhaleScore: number,
  whoCanDump: FinalReportWhoCanDump,
  dashboard: DashboardSummaryResponse,
): FinalReportOverall {
  let score = computeWeightedFinalScore(
    tokenTrust.trustScore,
    contractSafety?.score,
    teamWhaleScore,
    marketContext?.score,
    offChain?.score,
  );

  score = applyScoreCaps(score, contractSafety, tokenTrust, whoCanDump, offChain, marketContext);
  score = clamp(Math.round(score), 0, 100);

  const scoreRisk = scoreToRiskLevel(score);
  const moduleRisk = worstRiskLevel([
    scoreRisk,
    elevateRisk(contractSafety?.riskLevel),
    elevateRisk(tokenTrust.riskLevel),
    elevateRisk(marketContext?.riskLevel),
    elevateRisk(offChain?.riskLevel),
  ]);

  const confidence = resolveFinalConfidence(tokenTrust, contractSafety, marketContext, offChain);
  const verdict = buildFinalVerdict(dashboard, moduleRisk, offChain, tokenTrust, contractSafety);
  const summary = buildFinalSummary(dashboard, score, moduleRisk, verdict);

  return {
    score,
    riskLevel: moduleRisk,
    confidence,
    verdict,
    summary,
    reportType: 'risk_first_token_intelligence',
  };
}

function computeWeightedFinalScore(
  onchainScore: number,
  contractScore: number | null | undefined,
  teamWhaleScore: number,
  marketScore: number | null | undefined,
  offchainScore: number | null | undefined,
): number {
  const parts = [
    { weight: 0.3, score: onchainScore },
    { weight: 0.2, score: contractScore ?? 50 },
    { weight: 0.2, score: teamWhaleScore },
    { weight: 0.15, score: marketScore ?? 50 },
    { weight: 0.15, score: offchainScore ?? 50 },
  ];
  return parts.reduce((sum, part) => sum + part.weight * part.score, 0);
}

function applyScoreCaps(
  score: number,
  contractSafety: ContractSafetyReport | null,
  tokenTrust: TokenTrustReport,
  whoCanDump: FinalReportWhoCanDump,
  offChain: OffChainCredibilityReport | null,
  marketContext: MarketContextReport | null,
): number {
  let capped = score;

  if (contractSafety?.riskLevel === 'severe') {
    capped = Math.min(capped, 45);
  } else if (contractSafety?.riskLevel === 'high') {
    capped = Math.min(capped, 65);
  }

  if (tokenTrust.riskLevel === 'severe') {
    capped = Math.min(capped, 55);
  } else if (tokenTrust.riskLevel === 'high') {
    capped = Math.min(capped, 70);
  }

  const teamLinked = whoCanDump.teamLinkedPct ?? 0;
  if (teamLinked >= 50) {
    capped = Math.min(capped, 50);
  } else if (teamLinked >= 30) {
    capped = Math.min(capped, 60);
  }

  const largestRetail = whoCanDump.largestRetailWalletPct ?? 0;
  if (largestRetail >= 20) {
    capped = Math.min(capped, 50);
  } else if (largestRetail >= 10) {
    capped = Math.min(capped, 60);
  }

  if (offChain?.officialLinkConfidence.level === 'low') {
    capped = Math.min(capped, 55);
  }

  if (marketContext?.liquidityRisk.level === 'high') {
    capped = Math.min(capped, 75);
  }

  return capped;
}

function deriveTeamWhaleScore(tokenTrust: TokenTrustReport): number {
  const who = tokenTrust.whoCanDump;
  let score = 85;
  const team = who.teamLinkedPct ?? 0;
  const largest = who.largestRetailWalletPct ?? 0;
  const top10 = who.top10RetailPct ?? 0;

  if (team >= 50) {
    score = Math.min(score, 25);
  } else if (team >= 30) {
    score = Math.min(score, 40);
  } else if (team >= 15) {
    score = Math.min(score, 55);
  }

  if (largest >= 20) {
    score = Math.min(score, 35);
  } else if (largest >= 10) {
    score = Math.min(score, 50);
  } else if (largest >= 5) {
    score = Math.min(score, 65);
  }

  if (top10 >= 50) {
    score = Math.min(score, 45);
  } else if (top10 >= 35) {
    score = Math.min(score, 55);
  }

  if (tokenTrust.riskLevel === 'severe') {
    score = Math.min(score, 30);
  } else if (tokenTrust.riskLevel === 'high') {
    score = Math.min(score, 50);
  } else if (tokenTrust.riskLevel === 'moderate') {
    score = Math.min(score, 70);
  }

  return score;
}

function buildWhoCanDump(dashboard: DashboardSummaryResponse): FinalReportWhoCanDump {
  const who = dashboard.tokenTrust.whoCanDump;
  const breakdown = dashboard.distribution.supplyBreakdown;
  const watchItems: string[] = [];

  if ((who.largestRetailWalletPct ?? 0) >= 5) {
    watchItems.push('Monitor largest retail wallet for large sells or rapid balance reductions.');
  }
  if ((who.top10RetailPct ?? 0) >= 25) {
    watchItems.push('Watch top-10 retail concentration for coordinated selling pressure.');
  }
  if ((who.teamLinkedPct ?? 0) >= 10) {
    watchItems.push('Track team-linked or treasury wallet movements for unexpected supply releases.');
  }
  const exchangePct = breakdown.exchange?.pctOfSupply ?? null;
  const contractPct = breakdown.contract?.pctOfSupply ?? null;
  const lpPct = breakdown.lp?.pctOfSupply ?? null;

  if ((exchangePct ?? 0) >= 15) {
    watchItems.push('Monitor exchange-wallet inflows that could increase near-term sell pressure.');
  }

  return {
    largestRetailWalletPct: who.largestRetailWalletPct,
    largestRetailWalletUsd: who.largestRetailWalletUsd,
    top10RetailPct: who.top10RetailPct,
    teamLinkedPct: who.teamLinkedPct,
    exchangePct,
    contractPct,
    lpPct,
    summary: who.summary,
    riskLevel: who.riskLevel,
    watchItems,
  };
}

function buildContractSafetySection(
  contractSafety: ContractSafetyReport | null,
): FinalReportContractSafety {
  if (!contractSafety) {
    return {
      verdict: 'Contract safety was not available for this report.',
      score: null,
      riskLevel: null,
      ownerStatus: null,
      keyPermissions: [],
      positiveSignals: [],
      riskFlags: [],
      unknowns: ['Contract safety scan was not available.'],
    };
  }

  const ownerStatus = contractSafety.owner.isRenounced
    ? 'Ownership appears renounced.'
    : contractSafety.owner.ownerAddress
      ? `Owner/admin control present (${contractSafety.owner.ownerType ?? 'unknown'}).`
      : 'Owner status could not be confirmed.';

  const keyPermissions = Object.entries(contractSafety.permissions)
    .filter(([, signal]) => signal.detected === true)
    .map(([name]) => name);

  return {
    verdict: contractSafety.verdict,
    score: contractSafety.score,
    riskLevel: contractSafety.riskLevel,
    ownerStatus,
    keyPermissions,
    positiveSignals: contractSafety.positiveSignals.map((signal) => ({
      title: signal.title,
      strength: signal.strength,
      description: signal.description,
      source: 'contract_safety',
    })),
    riskFlags: contractSafety.flags.map((flag) => ({
      title: flag.title,
      severity: flag.severity,
      description: flag.description,
      source: 'contract_safety',
    })),
    unknowns: contractSafety.unknowns,
  };
}

function buildMarketSection(
  marketContext: MarketContextReport | null,
): FinalReportMarketAndLiquidity {
  if (!marketContext) {
    return {
      verdict: 'Market and liquidity context was not available for this report.',
      score: null,
      riskLevel: null,
      marketCapUsd: null,
      fdvUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      tokenAgeDays: null,
      maturityTier: null,
      liquidityRisk: null,
      exchangeContext: null,
      liquidityDoesNotRemoveHolderRiskNote: LIQUIDITY_HOLDER_RISK_NOTE,
    };
  }

  return {
    verdict: marketContext.verdict,
    score: marketContext.score,
    riskLevel: marketContext.riskLevel,
    marketCapUsd: marketContext.marketCapUsd,
    fdvUsd: marketContext.fdvUsd,
    liquidityUsd: marketContext.liquidityUsd,
    volume24hUsd: marketContext.volume24hUsd,
    tokenAgeDays: marketContext.tokenAgeDays,
    maturityTier: marketContext.maturityTier,
    liquidityRisk: {
      level: marketContext.liquidityRisk.level,
      reason: marketContext.liquidityRisk.reason,
    },
    exchangeContext: marketContext.exchangeContext.cexSignals.interpretation,
    liquidityDoesNotRemoveHolderRiskNote: LIQUIDITY_HOLDER_RISK_NOTE,
  };
}

function buildOffchainSection(
  offChain: OffChainCredibilityReport | null,
): FinalReportOffchainCredibility {
  if (!offChain) {
    return {
      verdict: 'Off-chain credibility was not available for this report.',
      score: null,
      riskLevel: null,
      confidence: null,
      category: null,
      identityStatus: null,
      discoveredOfficialLinks: [],
      evidenceQuality: null,
      externalValidation: null,
      riskFlags: [],
      credibilitySignals: [],
    };
  }

  return {
    verdict: offChain.verdict,
    score: offChain.score,
    riskLevel: offChain.riskLevel,
    confidence: offChain.confidence,
    category: offChain.projectUnderstanding?.category ?? offChain.projectProfile.category,
    identityStatus: offChain.projectUnderstanding?.identityStatus ?? null,
    discoveredOfficialLinks: collectOfficialLinks(offChain),
    evidenceQuality: offChain.projectUnderstanding?.evidenceQuality ?? null,
    externalValidation: offChain.projectUnderstanding?.externalValidation ?? null,
    riskFlags: offChain.riskFlags.map((flag) => ({
      title: flag.title,
      severity: flag.severity,
      description: flag.description,
      source: 'offchain_credibility',
    })),
    credibilitySignals: offChain.credibilitySignals.map((signal) => ({
      title: signal.title,
      strength: signal.strength,
      description: signal.description,
      source: 'offchain_credibility',
    })),
  };
}

function buildKeyFindings(dashboard: DashboardSummaryResponse): FinalReportKeyFindings {
  const positives: FinalReportFinding[] = [];
  const risks: FinalReportFinding[] = [];
  const unknowns: string[] = [];

  for (const signal of dashboard.tokenTrust.positiveSignals) {
    positives.push({
      title: signal.title,
      strength: signal.strength,
      description: signal.description,
      source: 'token_trust',
    });
  }

  for (const flag of dashboard.tokenTrust.redFlags) {
    risks.push({
      title: flag.title,
      severity: flag.severity,
      description: flag.description,
      source: 'token_trust',
    });
  }

  if (dashboard.contractSafety) {
    for (const signal of dashboard.contractSafety.positiveSignals) {
      positives.push({
        title: signal.title,
        strength: signal.strength,
        description: signal.description,
        source: 'contract_safety',
      });
    }
    for (const flag of dashboard.contractSafety.flags) {
      risks.push({
        title: flag.title,
        severity: flag.severity,
        description: flag.description,
        source: 'contract_safety',
      });
    }
    unknowns.push(...dashboard.contractSafety.unknowns);
  }

  if (dashboard.marketContext) {
    for (const signal of dashboard.marketContext.maturitySignals) {
      positives.push({
        title: signal.title,
        strength: signal.strength,
        description: signal.description,
        source: 'market_context',
      });
    }
    for (const flag of dashboard.marketContext.riskFlags) {
      risks.push({
        title: flag.title,
        severity: flag.severity,
        description: flag.description,
        source: 'market_context',
      });
    }
    unknowns.push(...dashboard.marketContext.unknowns);
  }

  if (dashboard.offChainCredibility) {
    for (const signal of dashboard.offChainCredibility.credibilitySignals) {
      positives.push({
        title: signal.title,
        strength: signal.strength,
        description: signal.description,
        source: 'offchain_credibility',
      });
    }
    for (const flag of dashboard.offChainCredibility.riskFlags) {
      risks.push({
        title: flag.title,
        severity: flag.severity,
        description: flag.description,
        source: 'offchain_credibility',
      });
    }
    unknowns.push(...dashboard.offChainCredibility.unknowns);
  }

  if (dashboard.offChainCredibility?.officialLinkConfidence.level === 'low') {
    risks.push({
      title: 'Official Identity Not Verified',
      severity: 'high',
      description:
        'Official website, documentation, or external identity evidence could not be confidently verified.',
      source: 'offchain_credibility',
    });
  }

  if (
    dashboard.offChainCredibility?.projectProfile.category === 'meme' ||
    dashboard.offChainCredibility?.projectUnderstanding?.category === 'meme'
  ) {
    risks.push({
      title: 'Limited Functional Utility Evidence',
      severity: 'medium',
      description:
        'Project positioning appears meme or community-driven with limited functional utility documentation.',
      source: 'final_report',
    });
  }

  for (const callout of dashboard.riskCallouts) {
    const target = callout.type === 'positive' ? positives : risks;
    target.push({
      title: callout.title,
      severity: callout.type === 'warning' ? 'medium' : callout.type === 'info' ? 'low' : undefined,
      strength: callout.type === 'positive' ? 'medium' : undefined,
      description: callout.description,
      source: 'risk_callouts',
    });
  }

  return {
    positives: dedupeFindings(positives).slice(0, 12),
    risks: dedupeFindings(risks).slice(0, 12),
    unknowns: [...new Set(unknowns)].slice(0, 10),
  };
}

function buildDeepAnalysisSections(
  dashboard: DashboardSummaryResponse,
  overall: FinalReportOverall,
): FinalReportDeepAnalysisSections {
  const tokenTrust = dashboard.tokenTrust;
  const offChain = dashboard.offChainCredibility;
  const contractSafety = dashboard.contractSafety;
  const market = dashboard.marketContext;
  const category = offChain?.projectUnderstanding?.category ?? offChain?.projectProfile.category ?? 'unknown';
  const identityStatus = offChain?.projectUnderstanding?.identityStatus ?? 'unknown';
  const tokenName = dashboard.token.tokenName ?? 'This token';
  const tokenSymbol = dashboard.token.tokenSymbol ?? '';

  const projectOverview = buildProjectOverviewParagraph(
    tokenName,
    tokenSymbol,
    category,
    identityStatus,
    offChain,
  );
  const marketPosition = buildMarketPositionParagraph(market, dashboard.distribution);
  const holderStructure = buildHolderStructureParagraph(dashboard);
  const whaleAndTeamRisk = buildWhaleTeamParagraph(tokenTrust);
  const contractRisk = buildContractRiskParagraph(contractSafety);
  const offchainLegitimacy = buildOffchainLegitimacyParagraph(offChain);
  const onchainVsOffchainAlignment = buildAlignmentParagraph(
    offChain,
    tokenTrust,
    category,
    identityStatus,
  );
  const riskAssessment = buildRiskAssessmentParagraph(overall, tokenTrust, offChain, contractSafety);

  return {
    projectOverview,
    marketPosition,
    holderStructure,
    whaleAndTeamRisk,
    contractRisk,
    offchainLegitimacy,
    onchainVsOffchainAlignment,
    riskAssessment,
  };
}

function buildProjectOverviewParagraph(
  tokenName: string,
  tokenSymbol: string,
  category: string,
  identityStatus: string,
  offChain: OffChainCredibilityReport | null,
): string {
  const label = tokenSymbol ? `${tokenName} (${tokenSymbol})` : tokenName;
  const useCase = offChain?.projectUnderstanding?.claimedUseCase ?? offChain?.projectProfile.claimedUseCase;
  const identityText =
    identityStatus === 'verified' || identityStatus === 'partially_verified'
      ? 'Official identity signals appear verified from discovered links and metadata.'
      : 'Official identity could not be fully verified from available public materials.';

  if (category === 'meme') {
    return `${label} is categorized as a meme/community token. ${identityText} Functional utility evidence is limited, and positioning is primarily community-driven rather than product-driven.`;
  }
  if (category === 'rwa') {
    return `${label} is positioned in the real-world asset / institutional on-chain finance category. ${identityText} ${useCase ? `Reported use case: ${useCase}.` : 'Documentation and project materials support an RWA finance narrative.'}`;
  }
  if (category === 'infrastructure') {
    return `${label} is categorized as crypto infrastructure. ${identityText} ${useCase ? `Reported use case: ${useCase}.` : 'Official materials describe protocol or infrastructure services.'}`;
  }

  return `${label} is categorized as ${category}. ${identityText} ${useCase ? `Reported use case: ${useCase}.` : 'Public project context remains limited in the available module data.'}`;
}

function buildMarketPositionParagraph(
  market: MarketContextReport | null,
  distribution: DashboardSummaryResponse['distribution'],
): string {
  if (!market) {
    return 'Market and liquidity context was not available, so maturity and trading-depth signals are limited in this report.';
  }

  const maturity = market.maturityTier ?? 'unknown';
  const liquidity = market.liquidityUsd !== null ? `Liquidity is approximately $${formatCompactUsd(market.liquidityUsd)}.` : 'Liquidity data is limited.';
  const decentralization = `Retail decentralization score is ${distribution.decentralizationScore}/100 with top-10 retail concentration at ${distribution.top10Pct}% of retail-held supply.`;

  return `Market maturity is classified as ${maturity}. ${liquidity} ${decentralization} Strong liquidity alone does not remove holder concentration risk.`;
}

function buildHolderStructureParagraph(dashboard: DashboardSummaryResponse): string {
  const hq = dashboard.holderQuality;
  const dist = dashboard.distribution;
  const retailPct = dist.supplyBreakdown.retail?.pctOfSupply ?? null;
  const exchangePct = dist.supplyBreakdown.exchange?.pctOfSupply ?? null;
  const teamPct = dist.supplyBreakdown.team?.pctOfSupply ?? null;
  return `Holder strength averages ${hq.avgScore ?? 'N/A'}/100 (${hq.qualityLabel}) across analyzed retail wallets, with smart-money representation near ${hq.smartMoneyPct}%. Retail supply is ${formatPct(retailPct)} of total supply, while exchanges hold ${formatPct(exchangePct)} and team-linked supply is ${formatPct(teamPct)}.`;
}

function buildWhaleTeamParagraph(tokenTrust: TokenTrustReport): string {
  const who = tokenTrust.whoCanDump;
  return `Largest analyzed retail wallet holds about ${formatPct(who.largestRetailWalletPct)} of supply${who.largestRetailWalletUsd ? ` (~$${formatCompactUsd(who.largestRetailWalletUsd)})` : ''}. Top-10 retail concentration is ${formatPct(who.top10RetailPct)}, and team-linked supply is ${formatPct(who.teamLinkedPct)}. ${who.summary}`;
}

function buildContractRiskParagraph(contractSafety: ContractSafetyReport | null): string {
  if (!contractSafety) {
    return 'Contract safety scanning was not available, so permission and admin-control risks could not be fully assessed.';
  }

  const owner = contractSafety.owner.isRenounced
    ? 'Ownership appears renounced.'
    : contractSafety.owner.ownerAddress
      ? 'Admin or owner controls may still be active.'
      : 'Owner/admin status is unclear.';

  const flagged = contractSafety.flags.length;
  return `Contract safety risk is ${contractSafety.riskLevel} with score ${contractSafety.score ?? 'N/A'}/100. ${owner} ${flagged > 0 ? `${flagged} contract risk flag(s) were identified.` : 'No major contract risk flags were flagged in the scan.'}`;
}

function buildOffchainLegitimacyParagraph(offChain: OffChainCredibilityReport | null): string {
  if (!offChain) {
    return 'Off-chain credibility was not assessed, so website, documentation, and external validation signals are unavailable.';
  }

  const links = collectOfficialLinks(offChain);
  const linkSummary =
    links.length > 0
      ? `Discovered official links include ${links.map((item) => item.label).join(', ')}.`
      : 'No official website or documentation links were confidently discovered.';

  return `Off-chain credibility is ${offChain.riskLevel} risk with score ${offChain.score ?? 'N/A'}/100 and ${offChain.officialLinkConfidence.level} official-link confidence. ${linkSummary} External validation is ${offChain.projectUnderstanding?.externalValidation ?? 'limited'}.`;
}

function buildAlignmentParagraph(
  offChain: OffChainCredibilityReport | null,
  tokenTrust: TokenTrustReport,
  category: string,
  identityStatus: string,
): string {
  const offchainStrong =
    (offChain?.score ?? 0) >= 80 &&
    (offChain?.officialLinkConfidence.level === 'high' || offChain?.officialLinkConfidence.level === 'medium');
  const onchainWeak = tokenTrust.riskLevel === 'high' || tokenTrust.riskLevel === 'severe';

  if (!offChain || offChain.officialLinkConfidence.level === 'low') {
    return 'On-chain holder and concentration signals dominate this report because official off-chain identity evidence is weak or missing.';
  }

  if (category === 'meme' && (identityStatus === 'verified' || identityStatus === 'partially_verified')) {
    return 'Off-chain identity appears credible, but on-chain holder concentration and limited functional utility keep overall risk elevated for a meme/community token.';
  }

  if (offchainStrong && onchainWeak) {
    return 'Off-chain project credibility appears relatively strong, but on-chain holder, team, or contract signals still warrant elevated monitoring.';
  }

  if (offchainStrong && !onchainWeak) {
    return 'Off-chain credibility, contract safety, and on-chain holder signals are broadly aligned, though large-wallet or treasury exposure may still require monitoring.';
  }

  return 'Off-chain and on-chain signals are mixed; users should weigh verified project materials against holder concentration and contract-control risks.';
}

function buildRiskAssessmentParagraph(
  overall: FinalReportOverall,
  tokenTrust: TokenTrustReport,
  offChain: OffChainCredibilityReport | null,
  contractSafety: ContractSafetyReport | null,
): string {
  const parts = [
    `Overall WalletIntel risk is ${overall.riskLevel} with a composite score of ${overall.score}/100.`,
    `Visible on-chain trust is ${tokenTrust.riskLevel} risk (${tokenTrust.trustScore}/100).`,
  ];

  if (contractSafety) {
    parts.push(`Contract safety is ${contractSafety.riskLevel} risk.`);
  }
  if (offChain) {
    parts.push(`Off-chain credibility is ${offChain.riskLevel} risk.`);
  }

  parts.push('This is a risk-first intelligence summary, not investment advice.');
  return parts.join(' ');
}

function buildEvidence(offChain: OffChainCredibilityReport | null): FinalReportEvidence {
  const officialLinks = collectOfficialLinks(offChain);
  const summary = offChain?.externalEvidence?.summary;
  const notes: string[] = [];

  if (!offChain) {
    notes.push('Off-chain evidence collection was not available.');
  } else if (officialLinks.length === 0) {
    notes.push('No official website, docs, or social links were confidently discovered.');
  }

  if (summary && summary.unrelatedCount > 0) {
    notes.push(`${summary.unrelatedCount} unrelated or rejected evidence item(s) were excluded from the summary.`);
  }

  return {
    officialLinks,
    trustedSourcesCount: summary?.trustedDirectoryCount ?? 0,
    officialSourcesCount: summary?.officialSourceCount ?? 0,
    rejectedOrUnrelatedCount: summary?.unrelatedCount ?? 0,
    notes,
  };
}

function buildMonitoringPlan(
  dashboard: DashboardSummaryResponse,
  whoCanDump: FinalReportWhoCanDump,
  contractSafety: ContractSafetyReport | null,
  offChain: OffChainCredibilityReport | null,
): FinalReportMonitoringPlan {
  const watchItems = [...whoCanDump.watchItems];

  if ((whoCanDump.teamLinkedPct ?? 0) >= 20) {
    watchItems.push('Alert on team or treasury wallet transfers that increase circulating supply risk.');
  }
  if ((whoCanDump.exchangePct ?? 0) >= 15) {
    watchItems.push('Alert on large exchange inflows that may precede sell pressure.');
  }
  if (dashboard.marketContext?.liquidityRisk.level === 'high' || dashboard.marketContext?.liquidityRisk.level === 'severe') {
    watchItems.push('Monitor liquidity drops, volume collapses, and pair depth deterioration.');
  }
  if (contractSafety && contractSafety.flags.length > 0) {
    watchItems.push('Monitor contract admin changes, permission events, and proxy upgrades if applicable.');
  }
  if (offChain?.officialLinkConfidence.level === 'low') {
    watchItems.push('Re-check official website, docs, and social links if new listings or impersonation sites appear.');
  }
  if ((whoCanDump.largestRetailWalletPct ?? 0) >= 5) {
    watchItems.push('Set alerts for top-holder sells and sudden wallet balance changes.');
  }

  const uniqueWatchItems = [...new Set(watchItems)];
  const recommendation =
    uniqueWatchItems.length > 0
      ? 'Maintain active monitoring across holder, team, exchange, liquidity, contract, and off-chain identity signals.'
      : 'Continue periodic monitoring because market and holder conditions can change quickly.';

  return {
    recommendation,
    watchItems: uniqueWatchItems,
    alertCTA: MONITORING_CTA,
  };
}

function buildLimitations(
  dashboard: DashboardSummaryResponse,
  contractSafety: ContractSafetyReport | null,
  marketContext: MarketContextReport | null,
  offChain: OffChainCredibilityReport | null,
): string[] {
  const limitations = [
    'This final report composes deterministic module outputs and does not include AI-generated narrative research.',
    'Final score is risk-first and does not prove investment safety.',
    ...dashboard.tokenTrust.limitations,
  ];

  if (contractSafety) {
    limitations.push(...contractSafety.limitations);
  }
  if (marketContext) {
    limitations.push(...marketContext.limitations);
  }
  if (offChain) {
    limitations.push(...offChain.limitations);
  }

  return [...new Set(limitations)].slice(0, 12);
}

function buildFinalVerdict(
  dashboard: DashboardSummaryResponse,
  moduleRisk: FinalReportRiskLevel,
  offChain: OffChainCredibilityReport | null,
  tokenTrust: TokenTrustReport,
  contractSafety: ContractSafetyReport | null,
): string {
  const category = offChain?.projectUnderstanding?.category ?? offChain?.projectProfile.category;
  const identityLow = offChain?.officialLinkConfidence.level === 'low' || !offChain?.discoveredLinks.website;
  const onchainSevere = tokenTrust.riskLevel === 'severe' || tokenTrust.riskLevel === 'high';
  const offchainStrong = (offChain?.score ?? 0) >= 85 && offChain?.officialLinkConfidence.level === 'high';

  if (identityLow) {
    return 'Official identity could not be verified. Website, documentation, and external evidence are limited, so the token should be treated as high risk until stronger proof appears.';
  }

  if (category === 'meme') {
    return 'Official identity appears verified, but this is primarily a meme/community token. Functional utility evidence is limited, and holder concentration should be monitored closely.';
  }

  if (offchainStrong && onchainSevere) {
    return 'Project credibility appears strong, with verified official links and documentation, but on-chain holder/team concentration and contract controls require careful review.';
  }

  if (
    offchainStrong &&
    (contractSafety?.riskLevel === 'low' || contractSafety?.riskLevel === 'moderate') &&
    (tokenTrust.riskLevel === 'low' || tokenTrust.riskLevel === 'moderate')
  ) {
    return 'The token shows strong off-chain credibility, contract safety, and market maturity, with moderate treasury or large-wallet exposure that should still be monitored.';
  }

  if (moduleRisk === 'severe' || moduleRisk === 'high') {
    return 'Multiple risk modules remain elevated. Even if some project signals look credible, holder concentration, contract controls, or weak identity evidence require cautious monitoring.';
  }

  return dashboard.tokenTrust.verdict;
}

function buildFinalSummary(
  dashboard: DashboardSummaryResponse,
  score: number,
  riskLevel: FinalReportRiskLevel,
  verdict: string,
): string {
  const tokenLabel = dashboard.token.tokenSymbol ?? dashboard.token.tokenName ?? 'Token';
  return `${tokenLabel} WalletIntel composite score is ${score}/100 (${riskLevel} risk). ${verdict}`;
}

function resolveFinalConfidence(
  tokenTrust: TokenTrustReport,
  contractSafety: ContractSafetyReport | null,
  marketContext: MarketContextReport | null,
  offChain: OffChainCredibilityReport | null,
): FinalReportConfidence {
  const moduleConfidences: Array<'low' | 'medium' | 'high'> = [];
  if (contractSafety?.confidence) {
    moduleConfidences.push(contractSafety.confidence);
  }
  if (marketContext?.confidence) {
    moduleConfidences.push(marketContext.confidence);
  }
  if (offChain?.confidence) {
    moduleConfidences.push(offChain.confidence);
  }

  const highCount = moduleConfidences.filter((value) => value === 'high').length;
  const lowCount = moduleConfidences.filter((value) => value === 'low').length;

  if (tokenTrust.confidence === 'high' && highCount >= 2) {
    return 'high';
  }
  if (lowCount >= 2 || tokenTrust.confidence === 'low') {
    return 'low';
  }
  return 'medium';
}

function collectOfficialLinks(
  offChain: OffChainCredibilityReport | null,
): Array<{ label: string; url: string }> {
  if (!offChain) {
    return [];
  }

  const entries: Array<{ label: string; url: string | null }> = [
    { label: 'website', url: offChain.discoveredLinks.website },
    { label: 'docs', url: offChain.discoveredLinks.docs },
    { label: 'github', url: offChain.discoveredLinks.github },
    { label: 'twitter', url: offChain.discoveredLinks.twitter },
    { label: 'telegram', url: offChain.discoveredLinks.telegram },
    { label: 'discord', url: offChain.discoveredLinks.discord },
    { label: 'whitepaper', url: offChain.discoveredLinks.whitepaper },
    { label: 'blog', url: offChain.discoveredLinks.blog },
  ];

  return entries
    .filter((entry): entry is { label: string; url: string } => Boolean(entry.url))
    .map((entry) => ({ label: entry.label, url: entry.url }));
}

function holderStrengthVerdict(holderQuality: DashboardSummaryResponse['holderQuality']): string {
  if (holderQuality.avgScore === null) {
    return 'Holder strength data is limited for analyzed wallets.';
  }
  return `Average holder strength is ${Math.round(holderQuality.avgScore)}/100 (${holderQuality.qualityLabel}) with ${holderQuality.smartMoneyPct}% smart-money representation.`;
}

function scoreToRiskLevel(score: number): FinalReportRiskLevel {
  if (score >= 80) {
    return 'low';
  }
  if (score >= 60) {
    return 'moderate';
  }
  if (score >= 40) {
    return 'high';
  }
  return 'severe';
}

function elevateRisk(value: string | null | undefined): FinalReportRiskLevel | null {
  if (value === 'severe' || value === 'high' || value === 'moderate' || value === 'low') {
    return value;
  }
  return null;
}

function worstRiskLevel(levels: Array<FinalReportRiskLevel | null>): FinalReportRiskLevel {
  const order: FinalReportRiskLevel[] = ['low', 'moderate', 'high', 'severe'];
  let worst: FinalReportRiskLevel = 'low';
  for (const level of levels) {
    if (!level) {
      continue;
    }
    if (order.indexOf(level) > order.indexOf(worst)) {
      worst = level;
    }
  }
  return worst;
}

function dedupeFindings(findings: FinalReportFinding[]): FinalReportFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.title}:${finding.description}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return 'N/A';
  }
  return `${Math.round(value * 10) / 10}%`;
}

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000_000) {
    return `${Math.round((value / 1_000_000_000) * 10) / 10}B`;
  }
  if (value >= 1_000_000) {
    return `${Math.round((value / 1_000_000) * 10) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round((value / 1_000) * 10) / 10}K`;
  }
  return `${Math.round(value)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
