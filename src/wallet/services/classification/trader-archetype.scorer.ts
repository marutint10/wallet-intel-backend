export type TraderArchetype =
  | 'Diamond Hand'
  | 'Swing Trader'
  | 'Day Trader'
  | 'Rotation Trader'
  | 'Meme Hunter'
  | 'Bot / Automated'
  | 'Accumulator'
  | 'Whale';

export interface TraderArchetypeInputs {
  totalSwaps: number;
  tradesPerActiveDay: number;
  medianHoldHours: number;
  avgHoldHours: number;
  tokensInteracted: number;
  blueChipTradeRatio: number;
  memecoinTradeRatio: number;
  concentrationRisk: number;
  burstinessScore: number;
  tradingSpanRatio: number;
  sellRatio: number;
  buySellRatio: number;
  repeatedEntryExitRatio: number;
  capitalBaseUsd: number;
}

export interface TraderArchetypeScoringResult {
  primaryType: TraderArchetype;
  primaryScore: number;
  secondaryTypes: TraderArchetype[];
  scoreBreakdown: Record<string, number>;
}

const ARCHETYPE_ORDER: TraderArchetype[] = [
  'Diamond Hand',
  'Swing Trader',
  'Day Trader',
  'Rotation Trader',
  'Meme Hunter',
  'Bot / Automated',
  'Accumulator',
  'Whale',
];

export function scoreTraderArchetypes(
  input: TraderArchetypeInputs,
): TraderArchetypeScoringResult {
  const scoreBreakdown: Record<TraderArchetype, number> = {
    'Diamond Hand': scoreDiamondHand(input),
    'Swing Trader': scoreSwingTrader(input),
    'Day Trader': scoreDayTrader(input),
    'Rotation Trader': scoreRotationTrader(input),
    'Meme Hunter': scoreMemeHunter(input),
    'Bot / Automated': scoreBotAutomated(input),
    Accumulator: scoreAccumulator(input),
    Whale: scoreWhale(input),
  };

  const ranked = ARCHETYPE_ORDER.map((type) => ({
    type,
    score: scoreBreakdown[type],
  })).sort((left, right) => {
    if (right.score === left.score) {
      return left.type.localeCompare(right.type);
    }

    return right.score - left.score;
  });

  const primary = ranked[0] ?? { type: 'Swing Trader' as TraderArchetype, score: 0 };
  const minimumSecondaryScore = Math.max(primary.score * 0.65, 35);
  const secondaryTypes = ranked
    .slice(1)
    .filter((entry) => entry.score >= minimumSecondaryScore)
    .slice(0, 2)
    .map((entry) => entry.type);

  return {
    primaryType: primary.type,
    primaryScore: primary.score,
    secondaryTypes,
    scoreBreakdown,
  };
}

function scoreDiamondHand(input: TraderArchetypeInputs): number {
  const holdStrength = weightedAverage([
    stepUp(input.medianHoldHours, [240, 720, 2160], [35, 70, 100]),
    stepUp(input.avgHoldHours, [240, 720, 2160], [35, 70, 100]),
  ]);
  const lowFrequency = stepDown(input.tradesPerActiveDay, [2, 4, 8], [100, 70, 35]);
  const blueChipBias = stepUp(input.blueChipTradeRatio, [0.35, 0.55, 0.75], [35, 70, 100]);
  const lowTokenChurn = stepDown(
    input.tokensInteracted,
    [20, 35, 60],
    [100, 70, 35],
  );

  let score = weightedTotal([
    [holdStrength, 0.4],
    [lowFrequency, 0.25],
    [blueChipBias, 0.2],
    [lowTokenChurn, 0.15],
  ]);

  if (input.medianHoldHours < 96) {
    score = Math.min(score, 30);
  }

  // Guardrail: high-swap wallets cannot be Diamond Hand unless both frequency and churn stay low.
  if (
    input.totalSwaps > 200 &&
    !(input.tradesPerActiveDay <= 2 && input.tokensInteracted <= 20)
  ) {
    score = Math.min(score, 20);
  }

  return clampScore(score);
}

function scoreSwingTrader(input: TraderArchetypeInputs): number {
  const holdWindow = rangeScore(input.medianHoldHours, 24, 720, 100, 45);
  const moderateFrequency = rangeScore(input.tradesPerActiveDay, 1, 10, 100, 40);
  const repeatedEntriesExits = stepUp(
    input.repeatedEntryExitRatio,
    [0.2, 0.4, 0.6],
    [35, 70, 100],
  );
  const stableCadence = rangeScore(input.burstinessScore, 0.4, 2.0, 90, 35);

  return clampScore(
    weightedTotal([
      [holdWindow, 0.35],
      [moderateFrequency, 0.25],
      [repeatedEntriesExits, 0.25],
      [stableCadence, 0.15],
    ]),
  );
}

function scoreDayTrader(input: TraderArchetypeInputs): number {
  const shortHolds = stepDown(input.medianHoldHours, [6, 12, 24], [100, 80, 55]);
  const highFrequency = stepUp(input.tradesPerActiveDay, [4, 8, 15], [45, 75, 100]);
  const activeSpan = stepUp(input.tradingSpanRatio, [0.2, 0.4, 0.6], [35, 70, 100]);

  let score = weightedTotal([
    [shortHolds, 0.45],
    [highFrequency, 0.35],
    [activeSpan, 0.2],
  ]);

  if (input.medianHoldHours > 48) {
    score = Math.min(score, 20);
  }

  return clampScore(score);
}

function scoreRotationTrader(input: TraderArchetypeInputs): number {
  const tokenChurnRatio = input.tokensInteracted / Math.max(input.totalSwaps, 1);
  const highChurn = stepUp(tokenChurnRatio, [0.1, 0.2, 0.35], [35, 70, 100]);
  const manySwaps = stepUp(input.totalSwaps, [40, 100, 220], [35, 70, 100]);
  const mediumHolds = rangeScore(input.avgHoldHours, 24, 336, 100, 40);
  const broadUniverse = stepUp(input.tokensInteracted, [20, 40, 70], [35, 70, 100]);

  return clampScore(
    weightedTotal([
      [highChurn, 0.35],
      [manySwaps, 0.25],
      [mediumHolds, 0.2],
      [broadUniverse, 0.2],
    ]),
  );
}

function scoreMemeHunter(input: TraderArchetypeInputs): number {
  const memecoinBias = stepUp(input.memecoinTradeRatio, [0.2, 0.4, 0.6], [35, 70, 100]);
  const burstyActivity = stepUp(input.burstinessScore, [0.8, 1.5, 2.5], [35, 70, 100]);
  const broadUniverse = stepUp(input.tokensInteracted, [15, 35, 60], [35, 70, 100]);
  const speculativeCadence = stepUp(input.tradesPerActiveDay, [2, 6, 12], [35, 70, 100]);

  return clampScore(
    weightedTotal([
      [memecoinBias, 0.45],
      [burstyActivity, 0.2],
      [broadUniverse, 0.2],
      [speculativeCadence, 0.15],
    ]),
  );
}

function scoreBotAutomated(input: TraderArchetypeInputs): number {
  const ultraHighFrequency = stepUp(
    input.tradesPerActiveDay,
    [10, 20, 35],
    [35, 70, 100],
  );
  const lowTimingVariance = stepDown(
    input.burstinessScore,
    [0.35, 0.8, 1.5],
    [100, 70, 35],
  );
  const repetitiveTiming = stepUp(
    input.tradingSpanRatio,
    [0.35, 0.6, 0.8],
    [35, 70, 100],
  );
  const executionScale = stepUp(input.totalSwaps, [80, 180, 320], [35, 70, 100]);

  return clampScore(
    weightedTotal([
      [ultraHighFrequency, 0.4],
      [lowTimingVariance, 0.25],
      [repetitiveTiming, 0.2],
      [executionScale, 0.15],
    ]),
  );
}

function scoreAccumulator(input: TraderArchetypeInputs): number {
  const lowSellPressure = stepDown(input.sellRatio, [0.25, 0.4, 0.55], [100, 70, 35]);
  const recurringBuys = stepUp(input.buySellRatio, [1.2, 1.8, 2.6], [35, 70, 100]);
  const longHolds = stepUp(input.avgHoldHours, [72, 240, 720], [35, 70, 100]);
  const controlledCadence = stepDown(
    input.tradesPerActiveDay,
    [3, 7, 12],
    [100, 70, 35],
  );

  return clampScore(
    weightedTotal([
      [lowSellPressure, 0.35],
      [recurringBuys, 0.3],
      [longHolds, 0.25],
      [controlledCadence, 0.1],
    ]),
  );
}

function scoreWhale(input: TraderArchetypeInputs): number {
  const largeCapital = stepUp(
    input.capitalBaseUsd,
    [10000, 100000, 500000],
    [35, 70, 100],
  );
  const concentratedBook = stepUp(
    input.concentrationRisk,
    [0.35, 0.55, 0.75],
    [35, 70, 100],
  );
  const scaleParticipation = stepUp(input.totalSwaps, [20, 80, 180], [35, 70, 100]);

  return clampScore(
    weightedTotal([
      [largeCapital, 0.5],
      [concentratedBook, 0.35],
      [scaleParticipation, 0.15],
    ]),
  );
}

function weightedAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function weightedTotal(entries: Array<[number, number]>): number {
  return entries.reduce((total, [score, weight]) => total + score * weight, 0);
}

function rangeScore(
  value: number,
  min: number,
  max: number,
  inRangeScore: number,
  nearRangeScore: number,
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value >= min && value <= max) {
    return inRangeScore;
  }

  const tolerance = Math.max((max - min) * 0.5, 1);
  const lowerBound = min - tolerance;
  const upperBound = max + tolerance;

  if (value >= lowerBound && value <= upperBound) {
    return nearRangeScore;
  }

  return 0;
}

function stepUp(
  value: number,
  thresholds: [number, number, number],
  scores: [number, number, number],
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value >= thresholds[2]) {
    return scores[2];
  }

  if (value >= thresholds[1]) {
    return scores[1];
  }

  if (value >= thresholds[0]) {
    return scores[0];
  }

  return 0;
}

function stepDown(
  value: number,
  thresholds: [number, number, number],
  scores: [number, number, number],
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= thresholds[0]) {
    return scores[0];
  }

  if (value <= thresholds[1]) {
    return scores[1];
  }

  if (value <= thresholds[2]) {
    return scores[2];
  }

  return 0;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}
