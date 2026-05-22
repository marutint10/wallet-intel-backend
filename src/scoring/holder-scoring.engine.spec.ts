import {
  buildHolderScoringInputFromLite,
  scoreHolderCapitalScale,
  scoreHolderWallet,
  resolveHolderScoreBand,
} from './holder-scoring.engine';

describe('holder-scoring.engine', () => {
  const institutionalWhale = {
    totalPortfolioUsd: 8_000_000,
    trackedTokenWeight: 35,
    walletAgeDays: 1200,
    daysSinceLastActivity: 14,
    activityConsistencyScore: 82,
    portfolioDiversificationScore: 78,
    portfolioConcentrationScore: 42,
    qualityAssetPercent: 72,
    categoryDiversity: 5,
    uniqueTokenCount: 12,
    memecoinHoldingPercent: 4,
    blueChipHoldingPercent: 38,
    stablecoinHoldingPercent: 22,
    defiHoldingPercent: 18,
    infrastructureHoldingPercent: 8,
    avgHoldingDays: 420,
    longestHoldDays: 900,
    holdingsInProfitPercent: 65,
    avgUnrealizedRoi: 28,
    nonDustCount: 10,
    hasNativeExposure: true,
    portfolioRiskSignal: 'balanced' as const,
    applyConvictionFloor: false,
  };

  it('allows elite passive holders to reach Institutional band', () => {
    const result = scoreHolderWallet(institutionalWhale);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.band).toBe('Institutional');
  });

  it('caps meme-heavy conviction without quality', () => {
    const result = scoreHolderWallet({
      ...institutionalWhale,
      totalPortfolioUsd: 250_000,
      memecoinHoldingPercent: 75,
      qualityAssetPercent: 18,
      blueChipHoldingPercent: 5,
    });
    expect(result.score).toBeLessThan(75);
    expect(result.dimensions.conviction).toBeLessThanOrEqual(12);
  });

  it('does not let capital scale alone dominate', () => {
    const richLowQuality = scoreHolderWallet({
      ...institutionalWhale,
      totalPortfolioUsd: 15_000_000,
      qualityAssetPercent: 12,
      memecoinHoldingPercent: 55,
      blueChipHoldingPercent: 3,
      stablecoinHoldingPercent: 2,
      defiHoldingPercent: 1,
      infrastructureHoldingPercent: 0,
      categoryDiversity: 1,
      uniqueTokenCount: 2,
      avgHoldingDays: 10,
      longestHoldDays: 20,
    });
    expect(scoreHolderCapitalScale(15_000_000)).toBe(10);
    expect(richLowQuality.score).toBeLessThan(70);
  });

  it('maps lite features into holder scoring input', () => {
    const input = buildHolderScoringInputFromLite({
      totalPortfolioUsd: 2_000_000,
      trackedTokenWeight: 60,
      walletAgeDays: 400,
      daysSinceLastActivity: 20,
      activityConsistencyScore: 70,
      portfolioDiversificationScore: 65,
      portfolioConcentrationScore: 70,
      memecoinPercent: 8,
      blueChipPercent: 25,
      stablecoinPercent: 15,
      uniqueTokens: 7,
      holdingCategoryMix: {
        bluechip: 25,
        defi: 12,
        stablecoin: 15,
        infrastructure: 5,
        meme: 8,
        other: 35,
      },
      portfolioRiskSignal: 'balanced',
    });
    const result = scoreHolderWallet(input);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(resolveHolderScoreBand(result.score)).toBe(result.band);
  });
});
