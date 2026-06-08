import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { mapHolderTypeForRetail } from './dashboard-summary.service';
import { TokenTrustReportService } from './token-trust-report.service';

function makeAnalysis(
  overrides: Partial<TokenAnalysisEntity> = {},
): TokenAnalysisEntity {
  return {
    id: 'test-id',
    contractAddress: '0xtoken',
    chain: 'ethereum',
    tokenName: 'Token',
    tokenSymbol: 'TOK',
    shareId: 'abc123def456',
    totalHolders: 100,
    holdersData: [],
    qualityMetrics: {},
    distribution: {},
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TokenTrustReportService', () => {
  let service: TokenTrustReportService;

  beforeEach(() => {
    service = new TokenTrustReportService();
  });

  it('flags PEPE-like concentration as high/severe and never healthy', () => {
    const analysis = makeAnalysis({
      qualityMetrics: {
        avgScore: 35,
        classifiableRetailCount: 78,
        totalAnalyzedEOAs: 78,
        pnlAggregation: { holdersWithPnlData: 0 },
        teamDetection: { teamTotalPctOfSupply: 1.2, riskLevel: 'low' },
      },
      distribution: {
        decentralizationScore: 41,
        supplyConcentration: { top10Pct: 67, top50Pct: 91, top100Pct: 100 },
        supplyBreakdown: {
          retail: { pctOfSupply: 52 },
          exchange: { pctOfSupply: 45 },
          team: { pctOfSupply: 1.2 },
          contract: { pctOfSupply: 1.8 },
          lp: { pctOfSupply: 0 },
        },
      },
      holdersData: Array.from({ length: 20 }).map((_, index) => ({
        walletAddress: `0x${String(index).padStart(40, '1')}`,
        walletLabel: 'eoa',
        isTeamLinked: false,
        balance: index === 0 ? '12000000' : '500000',
        usdValue: index === 0 ? 2_500_000 : 50_000,
      })),
    });

    const report = service.buildReport(analysis);
    expect(['high', 'severe']).toContain(report.riskLevel);
    expect(report.verdict.toLowerCase()).toContain('risk');
    expect(report.verdict.toLowerCase()).not.toContain('healthy');
    expect(
      report.redFlags.some((flag) => flag.title === 'High Retail Concentration'),
    ).toBe(true);
    expect(
      report.positiveSignals.some(
        (signal) => signal.title === 'Low Detected Team Allocation',
      ),
    ).toBe(true);
    expect(
      report.positiveSignals.some((signal) => signal.title === 'Broad Exchange Access'),
    ).toBe(true);
  });

  it('returns moderate risk for LINK-like profile', () => {
    const analysis = makeAnalysis({
      qualityMetrics: {
        avgScore: 66,
        classifiableRetailCount: 70,
        totalAnalyzedEOAs: 70,
        totalSupply: '100000000',
        pnlAggregation: { holdersWithPnlData: 0 },
        teamDetection: { teamTotalPctOfSupply: 6, riskLevel: 'medium' },
      },
      distribution: {
        decentralizationScore: 76,
        supplyConcentration: { top10Pct: 36, top50Pct: 72, top100Pct: 100 },
        supplyBreakdown: {
          retail: { pctOfSupply: 58 },
          exchange: { pctOfSupply: 30 },
          team: { pctOfSupply: 6 },
          contract: { pctOfSupply: 4 },
          lp: { pctOfSupply: 2 },
        },
      },
      holdersData: [
        {
          walletAddress: '0x1234000000000000000000000000000000000000',
          walletLabel: 'eoa',
          isTeamLinked: false,
          balance: '1000000',
          usdValue: 1_200_000,
        },
      ],
    });

    const report = service.buildReport(analysis);
    expect(report.riskLevel).toBe('moderate');
    expect(report.verdict.toLowerCase()).toContain('moderate');
    expect(report.whoCanDump.summary.length).toBeGreaterThan(0);
  });

  it('raises risk when team-linked allocation is severe', () => {
    const analysis = makeAnalysis({
      qualityMetrics: {
        avgScore: 55,
        classifiableRetailCount: 60,
        totalAnalyzedEOAs: 60,
        pnlAggregation: { holdersWithPnlData: 0 },
        teamDetection: { teamTotalPctOfSupply: 23, riskLevel: 'high' },
      },
      distribution: {
        decentralizationScore: 62,
        supplyConcentration: { top10Pct: 42 },
        supplyBreakdown: { team: { pctOfSupply: 23 }, retail: { pctOfSupply: 50 } },
      },
    });

    const report = service.buildReport(analysis);
    expect(['high', 'severe']).toContain(report.riskLevel);
    expect(
      report.redFlags.some((flag) => flag.title === 'Team-Linked Supply Detected'),
    ).toBe(true);
  });

  it('returns low confidence for small retail sample', () => {
    const analysis = makeAnalysis({
      qualityMetrics: {
        avgScore: 52,
        classifiableRetailCount: 12,
        totalAnalyzedEOAs: 12,
        pnlAggregation: { holdersWithPnlData: 0 },
      },
      distribution: {
        decentralizationScore: 80,
        supplyConcentration: { top10Pct: 25 },
      },
    });

    const report = service.buildReport(analysis);
    expect(report.confidence).toBe('low');
    expect(
      report.limitations.some((limitation) =>
        limitation.toLowerCase().includes('contract safety'),
      ),
    ).toBe(true);
  });
});

describe('mapHolderTypeForRetail', () => {
  it('maps conviction holder to concentrated holder', () => {
    const mapped = mapHolderTypeForRetail('Conviction Holder', {
      walletLabel: 'eoa',
      percentSupply: 1.2,
      trackedTokenWeight: 92,
    });
    expect(mapped.retailType).toBe('Concentrated Holder');
    expect(mapped.retailRiskLabel).toBe('High Exit Risk');
  });
});
