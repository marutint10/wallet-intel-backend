export type HolderConfidenceLabel = 'low' | 'medium' | 'high';

export interface HolderConfidenceInput {
  walletAgeDays: number;
  totalPortfolioUsd: number;
  uniqueTokenCount: number;
  categoryDiversity: number;
  nonDustCount: number;
  balancesAvailable: boolean;
  hasPortfolioContext: boolean;
  swapCount: number;
  totalTransfers: number;
}

export interface HolderConfidenceResult {
  confidence: HolderConfidenceLabel;
  confidenceScore: number;
}

/**
 * Holder-path confidence: portfolio observability and wallet maturity,
 * not swap-sample depth (which passive holders lack by design).
 */
export function resolveHolderConfidence(
  input: HolderConfidenceInput,
): HolderConfidenceResult {
  let score = 0;

  if (input.walletAgeDays >= 730) {
    score += 28;
  } else if (input.walletAgeDays >= 365) {
    score += 22;
  } else if (input.walletAgeDays >= 180) {
    score += 16;
  } else if (input.walletAgeDays >= 90) {
    score += 10;
  } else if (input.walletAgeDays >= 30) {
    score += 5;
  }

  if (input.totalPortfolioUsd >= 5_000_000) {
    score += 25;
  } else if (input.totalPortfolioUsd >= 1_000_000) {
    score += 20;
  } else if (input.totalPortfolioUsd >= 100_000) {
    score += 12;
  } else if (input.totalPortfolioUsd >= 10_000) {
    score += 6;
  } else if (input.totalPortfolioUsd >= 1_000) {
    score += 2;
  }

  const diversitySignal = Math.min(
    input.categoryDiversity * 4 + Math.min(input.uniqueTokenCount, 10),
    20,
  );
  score += diversitySignal;

  if (input.nonDustCount >= 5) {
    score += 10;
  } else if (input.nonDustCount >= 3) {
    score += 6;
  } else if (input.nonDustCount >= 1) {
    score += 2;
  }

  if (input.balancesAvailable && input.hasPortfolioContext) {
    score += 12;
  } else if (input.hasPortfolioContext) {
    score += 6;
  }

  if (input.swapCount >= 1 || input.totalTransfers >= 5) {
    score += 5;
  }

  const confidenceScore = Math.min(100, Math.max(0, Math.round(score)));
  const confidence: HolderConfidenceLabel =
    confidenceScore >= 70
      ? 'high'
      : confidenceScore >= 40
        ? 'medium'
        : 'low';

  return { confidence, confidenceScore };
}
