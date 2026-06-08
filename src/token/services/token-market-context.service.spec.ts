import {
  buildMarketContextReport,
  type MarketContextCollectedData,
} from './token-market-context.service';
import { DashboardSummaryService } from './dashboard-summary.service';
import { TokenTrustReportService } from './token-trust-report.service';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';

function makeCollected(
  overrides: Partial<MarketContextCollectedData> = {},
): MarketContextCollectedData {
  return {
    contractAddress: '0xtoken',
    chain: 'ethereum',
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    priceChange24hPct: null,
    tokenAgeDays: null,
    firstSeenAt: null,
    exchangeSupplyPct: null,
    exchangeWalletCount: null,
    pairCount: null,
    topPairLiquidityUsd: null,
    totalDexLiquidityUsd: null,
    mainDex: null,
    fetchError: null,
    ...overrides,
  };
}

function linkLikeCollected(): MarketContextCollectedData {
  return makeCollected({
    marketCapUsd: 12_000_000_000,
    fdvUsd: 12_500_000_000,
    liquidityUsd: 85_000_000,
    volume24hUsd: 420_000_000,
    priceChange24hPct: -1.2,
    tokenAgeDays: 365 * 7,
    firstSeenAt: '2017-09-19T00:00:00.000Z',
    exchangeSupplyPct: 30,
    exchangeWalletCount: 12,
    pairCount: 8,
    topPairLiquidityUsd: 45_000_000,
    totalDexLiquidityUsd: 85_000_000,
    mainDex: 'uniswap',
  });
}

function pepeLikeCollected(): MarketContextCollectedData {
  return makeCollected({
    marketCapUsd: 4_200_000_000,
    fdvUsd: 4_200_000_000,
    liquidityUsd: 62_000_000,
    volume24hUsd: 280_000_000,
    priceChange24hPct: 3.5,
    tokenAgeDays: 780,
    firstSeenAt: '2023-04-17T00:00:00.000Z',
    exchangeSupplyPct: 45,
    exchangeWalletCount: 18,
    pairCount: 12,
    topPairLiquidityUsd: 28_000_000,
    totalDexLiquidityUsd: 62_000_000,
    mainDex: 'uniswap',
  });
}

function newLowLiquidityCollected(): MarketContextCollectedData {
  return makeCollected({
    marketCapUsd: 8_500_000,
    fdvUsd: 25_000_000,
    liquidityUsd: 120_000,
    volume24hUsd: 15_000,
    tokenAgeDays: 12,
    firstSeenAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    exchangeSupplyPct: 1.5,
    pairCount: 1,
    topPairLiquidityUsd: 120_000,
    totalDexLiquidityUsd: 120_000,
    mainDex: 'uniswap',
  });
}

describe('buildMarketContextReport', () => {
  it('LINK-like mature token: high score, bluechip/established, low risk', () => {
    const report = buildMarketContextReport(linkLikeCollected());

    expect(report.status).toBe('done');
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(['bluechip', 'established']).toContain(report.maturityTier);
    expect(report.riskLevel).toBe('low');
    expect(report.marketCapUsd).toBeGreaterThanOrEqual(10_000_000_000);
    expect(report.tokenAgeDays).toBeGreaterThanOrEqual(365 * 5);
    expect(report.liquidityUsd).toBeGreaterThanOrEqual(50_000_000);
    expect(
      report.maturitySignals.some((signal) => signal.title === 'Large Market Cap'),
    ).toBe(true);
    expect(report.verdict.toLowerCase()).not.toContain('safe');
  });

  it('new low-liquidity token: low score, high/severe risk, liquidity + new flags', () => {
    const report = buildMarketContextReport(newLowLiquidityCollected());

    expect(report.score).toBeLessThanOrEqual(44);
    expect(['high', 'severe']).toContain(report.riskLevel);
    expect(report.maturityTier).toBe('new');
    expect(report.riskFlags.some((flag) => flag.title === 'Low Liquidity')).toBe(true);
    expect(report.riskFlags.some((flag) => flag.title === 'New Token')).toBe(true);
    expect(report.riskFlags.some((flag) => flag.title === 'Thin Market Depth')).toBe(true);
  });

  it('missing market data: partial/unknown status, null score, missing data unknowns', () => {
    const report = buildMarketContextReport(makeCollected());

    expect(['partial', 'unknown']).toContain(report.status);
    expect(report.score).toBeNull();
    expect(report.riskLevel).toBe('unknown');
    expect(report.unknowns).toEqual(
      expect.arrayContaining([
        'Missing market cap, liquidity, or volume data',
        'Token age unavailable',
      ]),
    );
    expect(report.riskFlags.some((flag) => flag.title === 'Missing Market Data')).toBe(
      true,
    );
  });

  it('PEPE-like: strong liquidity/volume, not severe; does not change tokenTrust holder risk', () => {
    const marketReport = buildMarketContextReport(pepeLikeCollected());
    expect(['low', 'moderate']).toContain(marketReport.riskLevel);
    expect(marketReport.riskLevel).not.toBe('severe');
    expect(['established', 'early', 'bluechip']).toContain(marketReport.maturityTier);
    expect(marketReport.liquidityUsd).toBeGreaterThanOrEqual(10_000_000);

    const trust = new TokenTrustReportService();
    const holderReport = trust.buildReport({
      id: '1',
      contractAddress: '0xpepe',
      chain: 'ethereum',
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      shareId: null,
      totalHolders: 100,
      holdersData: [
        {
          walletAddress: '0xwhale0000000000000000000000000000000001',
          walletLabel: 'eoa',
          isTeamLinked: false,
          balance: '6700000',
          usdValue: 2_500_000,
        },
        ...Array.from({ length: 9 }).map((_, index) => ({
          walletAddress: `0x${String(index + 2).padStart(40, '2')}`,
          walletLabel: 'eoa',
          isTeamLinked: false,
          balance: '500000',
          usdValue: 50_000,
        })),
      ],
      qualityMetrics: {
        avgScore: 35,
        classifiableRetailCount: 78,
        totalAnalyzedEOAs: 78,
        totalSupply: '100000000',
        pnlAggregation: { holdersWithPnlData: 0 },
        teamDetection: { teamTotalPctOfSupply: 1.2, riskLevel: 'low' },
        marketContext: marketReport,
      },
      distribution: {
        decentralizationScore: 41,
        supplyConcentration: { top10Pct: 66, top50Pct: 91, top100Pct: 100 },
        supplyBreakdown: {
          retail: { pctOfSupply: 28.5 },
          exchange: { pctOfSupply: 45 },
          team: { pctOfSupply: 1.2 },
          contract: { pctOfSupply: 1.8 },
          lp: { pctOfSupply: 0 },
        },
      },
      riskCallouts: [],
      status: 'done',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TokenAnalysisEntity);

    expect(holderReport.riskLevel).toBe('high');
    expect(holderReport.trustScore).toBeLessThanOrEqual(60);
    expect(holderReport.availableModules).toContain('market_maturity');
  });
});

describe('dashboard marketContext integration', () => {
  const trust = new TokenTrustReportService();
  const dashboard = new DashboardSummaryService(trust);

  it('includes marketContext and updates tokenTrust modules', () => {
    const marketContext = buildMarketContextReport(linkLikeCollected());
    const contractSafety = {
      status: 'done',
      score: 88,
      riskLevel: 'low',
      verdict: 'No major contract permission risks detected from available contract data',
      confidence: 'high',
      verifiedSource: true,
      sourceProvider: 'etherscan',
      contractType: 'erc20',
      isProxy: false,
      proxyType: null,
      implementationAddress: null,
      proxyAdminAddress: null,
      owner: {
        ownerAddress: null,
        isRenounced: true,
        ownerType: null,
        adminAddresses: [],
      },
      permissions: {},
      taxes: {
        status: 'not_detected',
        buyTaxPct: null,
        sellTaxPct: null,
        transferTaxPct: null,
        evidence: [],
      },
      honeypot: { status: 'not_checked', reason: null, evidence: [] },
      flags: [],
      positiveSignals: [],
      unknowns: [],
      limitations: [],
      checkedAt: new Date().toISOString(),
    };

    const analysis: TokenAnalysisEntity = {
      id: 'link',
      contractAddress: '0xlink',
      chain: 'ethereum',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      shareId: null,
      totalHolders: 100,
      holdersData: [],
      qualityMetrics: {
        avgScore: 65,
        classifiableRetailCount: 70,
        totalAnalyzedEOAs: 70,
        contractSafety,
        marketContext,
      },
      distribution: {
        decentralizationScore: 76,
        supplyConcentration: { top10Pct: 36 },
        supplyBreakdown: {
          retail: { pctOfSupply: 16.75 },
          exchange: { pctOfSupply: 30 },
        },
      },
      riskCallouts: [],
      status: 'done',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = dashboard.buildDashboardSummary(analysis);

    expect(summary.marketContext).not.toBeNull();
    expect(summary.marketContext?.riskLevel).toBe('low');
    expect(summary.tokenTrust.availableModules).toEqual(
      expect.arrayContaining(['holder_structure', 'contract_safety', 'market_maturity']),
    );
    expect(summary.tokenTrust.missingScoreInputs).not.toContain('market_maturity');
    expect(summary.tokenTrust.missingScoreInputs).not.toContain('liquidity_depth');
    expect(summary.tokenTrust.missingScoreInputs).toContain('off_chain_credibility');
    expect(summary.tokenTrust.scoreStatus).toBe('partial');
    expect(
      summary.tokenTrust.limitations.some((line) =>
        line.includes('Market maturity and liquidity context are shown separately'),
      ),
    ).toBe(true);
  });
});
