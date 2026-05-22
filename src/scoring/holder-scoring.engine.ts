/**
 * Institutional-grade passive-holder scoring (0–100).
 * Independent from trader scoring; shares the same score-band scale.
 */

export const HOLDER_PORTFOLIO_QUALITY_MAX = 35;
export const HOLDER_CONVICTION_MAX = 30;
export const HOLDER_ASSET_SELECTION_MAX = 20;
export const HOLDER_CAPITAL_SCALE_MAX = 10;
export const HOLDER_LONGEVITY_STABILITY_MAX = 5;

export const B2B_HOLDER_SCORE_BANDS = [
  { min: 90, label: 'Institutional' },
  { min: 75, label: 'Premium' },
  { min: 60, label: 'Strong' },
  { min: 40, label: 'Solid' },
  { min: 0, label: 'Developing' },
] as const;

export type HolderScoreBandLabel = (typeof B2B_HOLDER_SCORE_BANDS)[number]['label'];

export interface HolderCategoryMix {
  bluechip?: number;
  defi?: number;
  infrastructure?: number;
  stablecoin?: number;
  meme?: number;
  ai?: number;
  gaming?: number;
  rwa?: number;
  other?: number;
}

export interface HolderScoringInput {
  totalPortfolioUsd: number;
  trackedTokenWeight: number;
  walletAgeDays: number;
  daysSinceLastActivity: number;
  activityConsistencyScore: number;
  portfolioDiversificationScore: number;
  portfolioConcentrationScore: number;
  qualityAssetPercent: number;
  categoryDiversity: number;
  uniqueTokenCount: number;
  memecoinHoldingPercent: number;
  blueChipHoldingPercent: number;
  stablecoinHoldingPercent: number;
  defiHoldingPercent: number;
  infrastructureHoldingPercent: number;
  avgHoldingDays: number;
  longestHoldDays: number;
  holdingsInProfitPercent: number;
  avgUnrealizedRoi: number;
  nonDustCount: number;
  hasNativeExposure: boolean;
  holdingCategoryMix?: HolderCategoryMix | null;
  portfolioRiskSignal?: 'conservative' | 'balanced' | 'aggressive' | 'degen' | null;
  /** When true, apply concentrated-tracked-token conviction floor (B2B). */
  applyConvictionFloor?: boolean;
}

export interface HolderDimensionScores {
  portfolioQuality: number;
  conviction: number;
  assetSelection: number;
  capitalScale: number;
  longevityStability: number;
}

export interface HolderScoringResult {
  score: number;
  band: HolderScoreBandLabel;
  dimensions: HolderDimensionScores;
  /** Legacy combined capital + longevity bucket (max 15). */
  legacyPortfolioSizeScore: number;
}

export function scoreHolderWallet(input: HolderScoringInput): HolderScoringResult {
  const dimensions = scoreHolderDimensions(input);
  const rawTotal =
    dimensions.portfolioQuality +
    dimensions.conviction +
    dimensions.assetSelection +
    dimensions.capitalScale +
    dimensions.longevityStability;
  const score = clampInt(Math.round(rawTotal), 0, 100);
  const band = resolveHolderScoreBand(score);

  return {
    score,
    band,
    dimensions,
    legacyPortfolioSizeScore:
      dimensions.capitalScale + dimensions.longevityStability,
  };
}

export function scoreHolderDimensions(
  input: HolderScoringInput,
): HolderDimensionScores {
  const portfolioQuality = scoreHolderPortfolioQuality(input);
  let conviction = scoreHolderConviction(input);
  conviction = applyConvictionQualityGate(conviction, input);
  const assetSelection = scoreHolderAssetSelection(input);
  const capitalScale = scoreHolderCapitalScale(input.totalPortfolioUsd);
  const longevityStability = scoreHolderLongevityStability(input);

  return {
    portfolioQuality,
    conviction,
    assetSelection,
    capitalScale,
    longevityStability,
  };
}

export function resolveHolderScoreBand(score: number): HolderScoreBandLabel {
  const match = B2B_HOLDER_SCORE_BANDS.find((band) => score >= band.min);
  return match?.label ?? 'Developing';
}

export function scoreHolderPortfolioQuality(input: HolderScoringInput): number {
  let score = 0;

  score += bracketScore(input.qualityAssetPercent, [
    { min: 80, points: 12 },
    { min: 60, points: 9 },
    { min: 40, points: 6 },
    { min: 20, points: 3 },
  ]);

  score += bracketScore(input.categoryDiversity, [
    { min: 4, points: 8 },
    { min: 3, points: 6 },
    { min: 2, points: 4 },
    { min: 1, points: 2 },
  ]);

  score += bracketScore(input.uniqueTokenCount, [
    { min: 8, points: 8 },
    { min: 5, points: 6 },
    { min: 3, points: 4 },
    { min: 2, points: 2 },
  ]);

  score += invertedBracketScore(input.memecoinHoldingPercent, [
    { max: 4.999, points: 7 },
    { max: 14.999, points: 5 },
    { max: 29.999, points: 3 },
    { max: 49.999, points: 1 },
  ]);

  const diversificationBoost = Math.round(
    (clamp(input.portfolioDiversificationScore, 0, 100) / 100) * 5,
  );
  score += diversificationBoost;

  const stablePct =
    input.holdingCategoryMix?.stablecoin ?? input.stablecoinHoldingPercent;
  if (stablePct >= 5 && stablePct <= 40) {
    score += 3;
  } else if (stablePct > 0 && stablePct < 5) {
    score += 1;
  }

  if (input.portfolioRiskSignal === 'conservative') {
    score += 3;
  } else if (input.portfolioRiskSignal === 'balanced') {
    score += 2;
  } else if (
    input.portfolioRiskSignal === 'aggressive' ||
    input.portfolioRiskSignal === 'degen'
  ) {
    score -= 2;
  }

  return clampInt(score, 0, HOLDER_PORTFOLIO_QUALITY_MAX);
}

export function scoreHolderConviction(input: HolderScoringInput): number {
  if (
    input.applyConvictionFloor &&
    input.trackedTokenWeight >= 95
  ) {
    return input.walletAgeDays > 180 ? 18 : 12;
  }

  if (
    input.applyConvictionFloor &&
    input.trackedTokenWeight >= 80 &&
    input.uniqueTokenCount <= 3
  ) {
    return input.walletAgeDays > 180 ? 15 : 10;
  }

  let score = 0;

  score += bracketScore(input.avgHoldingDays, [
    { min: 365.0001, points: 12 },
    { min: 180.0001, points: 9 },
    { min: 90.0001, points: 6 },
    { min: 30.0001, points: 3 },
  ]);

  score += bracketScore(input.longestHoldDays, [
    { min: 730.0001, points: 8 },
    { min: 365.0001, points: 6 },
    { min: 180.0001, points: 4 },
    { min: 90.0001, points: 2 },
  ]);

  score += bracketScore(input.holdingsInProfitPercent, [
    { min: 70.0001, points: 6 },
    { min: 50.0001, points: 4 },
    { min: 30.0001, points: 2 },
  ]);

  score += bracketScore(input.avgUnrealizedRoi, [
    { min: 50.0001, points: 4 },
    { min: 20.0001, points: 3 },
    { min: 0.0001, points: 2 },
  ]);

  const trackedWeight = input.trackedTokenWeight;
  if (trackedWeight > 50 && trackedWeight <= 80 && input.walletAgeDays > 90) {
    score += 2;
  }

  const concentrationStability = clamp(input.portfolioConcentrationScore, 0, 100);
  if (concentrationStability >= 70 && input.avgHoldingDays >= 90) {
    score += 2;
  }

  return clampInt(score, 0, HOLDER_CONVICTION_MAX);
}

function applyConvictionQualityGate(
  conviction: number,
  input: HolderScoringInput,
): number {
  if (input.memecoinHoldingPercent >= 50) {
    return Math.min(conviction, 12);
  }

  if (input.memecoinHoldingPercent >= 30) {
    const qualityFactor = clamp(input.qualityAssetPercent / 55, 0.35, 1);
    return clampInt(Math.round(conviction * qualityFactor), 0, HOLDER_CONVICTION_MAX);
  }

  if (input.qualityAssetPercent < 25 && conviction > 20) {
    return Math.min(conviction, 20);
  }

  return conviction;
}

export function scoreHolderAssetSelection(input: HolderScoringInput): number {
  let score = 0;

  score += bracketScore(input.blueChipHoldingPercent, [
    { min: 50.0001, points: 6 },
    { min: 30.0001, points: 4 },
    { min: 15.0001, points: 2 },
  ]);

  score += bracketScore(input.stablecoinHoldingPercent, [
    { min: 20.0001, points: 5 },
    { min: 10.0001, points: 3 },
    { min: 5.0001, points: 2 },
  ]);

  score += bracketScore(input.defiHoldingPercent, [
    { min: 25.0001, points: 4 },
    { min: 10.0001, points: 2 },
    { min: 3.0001, points: 1 },
  ]);

  score += bracketScore(input.infrastructureHoldingPercent, [
    { min: 15.0001, points: 3 },
    { min: 5.0001, points: 2 },
    { min: 1.0001, points: 1 },
  ]);

  if (input.hasNativeExposure) {
    score += 2;
  }

  const mix = input.holdingCategoryMix;
  const memePct = mix?.meme ?? input.memecoinHoldingPercent;
  if (memePct >= 60) {
    score -= 8;
  } else if (memePct >= 40) {
    score -= 5;
  } else if (memePct >= 25) {
    score -= 2;
  }

  if (input.qualityAssetPercent < 20 && input.blueChipHoldingPercent < 10) {
    score -= 3;
  }

  return clampInt(score, 0, HOLDER_ASSET_SELECTION_MAX);
}

export function scoreHolderCapitalScale(totalPortfolioUsd: number): number {
  if (totalPortfolioUsd >= 10_000_000) {
    return 10;
  }
  if (totalPortfolioUsd >= 1_000_000) {
    return 8;
  }
  if (totalPortfolioUsd >= 100_000) {
    return 5;
  }
  if (totalPortfolioUsd >= 10_000) {
    return 3;
  }
  if (totalPortfolioUsd >= 1_000) {
    return 1;
  }
  return 0;
}

export function scoreHolderLongevityStability(input: HolderScoringInput): number {
  let score = 0;

  score += bracketScore(input.walletAgeDays, [
    { min: 1095, points: 3 },
    { min: 365, points: 2 },
    { min: 180, points: 1 },
  ]);

  score += bracketScore(input.activityConsistencyScore, [
    { min: 75, points: 1 },
    { min: 50, points: 1 },
  ]);

  if (input.daysSinceLastActivity > 0) {
    score += invertedBracketScore(input.daysSinceLastActivity, [
      { max: 30, points: 1 },
      { max: 90, points: 1 },
    ]);
  } else if (input.walletAgeDays >= 180) {
    score += 1;
  }

  return clampInt(Math.round(score), 0, HOLDER_LONGEVITY_STABILITY_MAX);
}

export function buildHolderScoringInputFromLite(
  features: {
    totalPortfolioUsd?: number;
    trackedTokenWeight?: number;
    walletAgeDays: number;
    daysSinceLastActivity: number;
    activityConsistencyScore: number;
    portfolioDiversificationScore?: number;
    portfolioConcentrationScore: number;
    memecoinPercent: number;
    blueChipPercent: number;
    stablecoinPercent: number;
    uniqueTokens: number;
    holdingCategoryMix?: HolderCategoryMix | null;
    portfolioRiskSignal?: HolderScoringInput['portfolioRiskSignal'];
    medianHoldHours?: number | null;
  },
): HolderScoringInput {
  const mix = features.holdingCategoryMix;
  const qualityAssetPercent = computeQualityAssetPercentFromMix(mix, {
    blueChip: features.blueChipPercent,
    stablecoin: features.stablecoinPercent,
    defi: mix?.defi ?? 0,
  });
  const categoryDiversity = countActiveCategories(mix);
  const avgHoldingDays = features.medianHoldHours
    ? features.medianHoldHours / 24
    : features.walletAgeDays > 0
      ? Math.min(features.walletAgeDays * 0.4, 365)
      : 0;

  return {
    totalPortfolioUsd: features.totalPortfolioUsd ?? 0,
    trackedTokenWeight: features.trackedTokenWeight ?? 0,
    walletAgeDays: features.walletAgeDays,
    daysSinceLastActivity: features.daysSinceLastActivity,
    activityConsistencyScore: features.activityConsistencyScore,
    portfolioDiversificationScore: features.portfolioDiversificationScore ?? 0,
    portfolioConcentrationScore: features.portfolioConcentrationScore,
    qualityAssetPercent,
    categoryDiversity,
    uniqueTokenCount: features.uniqueTokens,
    memecoinHoldingPercent: mix?.meme ?? features.memecoinPercent,
    blueChipHoldingPercent: mix?.bluechip ?? features.blueChipPercent,
    stablecoinHoldingPercent: mix?.stablecoin ?? features.stablecoinPercent,
    defiHoldingPercent: mix?.defi ?? 0,
    infrastructureHoldingPercent: mix?.infrastructure ?? 0,
    avgHoldingDays,
    longestHoldDays: Math.max(avgHoldingDays, features.walletAgeDays * 0.6),
    holdingsInProfitPercent: 50,
    avgUnrealizedRoi: 0,
    nonDustCount: features.uniqueTokens,
    hasNativeExposure: (mix?.bluechip ?? features.blueChipPercent) > 5,
    holdingCategoryMix: mix,
    portfolioRiskSignal: features.portfolioRiskSignal ?? null,
    applyConvictionFloor: true,
  };
}

function computeQualityAssetPercentFromMix(
  mix: HolderCategoryMix | null | undefined,
  fallback: { blueChip: number; stablecoin: number; defi: number },
): number {
  if (!mix) {
    return clamp(
      fallback.blueChip + fallback.stablecoin + fallback.defi * 0.8,
      0,
      100,
    );
  }

  return clamp(
    (mix.bluechip ?? 0) +
      (mix.stablecoin ?? 0) +
      (mix.defi ?? 0) +
      (mix.infrastructure ?? 0) +
      (mix.rwa ?? 0) * 0.5,
    0,
    100,
  );
}

function countActiveCategories(mix: HolderCategoryMix | null | undefined): number {
  if (!mix) {
    return 0;
  }

  return Object.values(mix).filter((value) => (value ?? 0) >= 3).length;
}

function bracketScore(
  value: number,
  brackets: Array<{ min: number; points: number }>,
): number {
  for (const bracket of brackets) {
    if (value >= bracket.min) {
      return bracket.points;
    }
  }
  return 0;
}

function invertedBracketScore(
  value: number,
  brackets: Array<{ max: number; points: number }>,
): number {
  for (const bracket of brackets) {
    if (value <= bracket.max) {
      return bracket.points;
    }
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.trunc(clamp(value, min, max));
}
