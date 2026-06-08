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

function pepeLikeAnalysis(): TokenAnalysisEntity {
  return makeAnalysis({
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    qualityMetrics: {
      avgScore: 35,
      classifiableRetailCount: 78,
      totalAnalyzedEOAs: 78,
      totalSupply: '100000000',
      pnlAggregation: { holdersWithPnlData: 0 },
      teamDetection: { teamTotalPctOfSupply: 1.2, riskLevel: 'low' },
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
  });
}

function linkLikeAnalysis(): TokenAnalysisEntity {
  return makeAnalysis({
    tokenName: 'Chainlink',
    tokenSymbol: 'LINK',
    qualityMetrics: {
      avgScore: 65,
      classifiableRetailCount: 70,
      totalAnalyzedEOAs: 70,
      totalSupply: '100000000',
      pnlAggregation: { holdersWithPnlData: 0 },
      teamDetection: { teamTotalPctOfSupply: 18.7, riskLevel: 'medium' },
    },
    distribution: {
      decentralizationScore: 76,
      supplyConcentration: { top10Pct: 36, top50Pct: 72, top100Pct: 100 },
      supplyBreakdown: {
        retail: { pctOfSupply: 16.75 },
        exchange: { pctOfSupply: 30 },
        team: { pctOfSupply: 18.7 },
        contract: { pctOfSupply: 4 },
        lp: { pctOfSupply: 2 },
      },
    },
    holdersData: [
      {
        walletAddress: '0xretail00000000000000000000000000000001',
        walletLabel: 'eoa',
        isTeamLinked: false,
        balance: '500000',
        usdValue: 1_200_000,
      },
      {
        walletAddress: '0xtreasury00000000000000000000000000001',
        walletLabel: 'treasury',
        isTeamLinked: false,
        balance: '18700000',
        usdValue: 50_000_000,
      },
    ],
  });
}

describe('TokenTrustReportService', () => {
  let service: TokenTrustReportService;

  beforeEach(() => {
    service = new TokenTrustReportService();
  });

  it('PEPE-like: high risk, not severe from retail-scope alone', () => {
    const report = service.buildReport(pepeLikeAnalysis());

    expect(report.concentrationContext.top10RetailPctOfRetail).toBe(66);
    expect(report.concentrationContext.retailSupplyPct).toBe(28.5);
    expect(report.concentrationContext.top10RetailPctOfTotal).toBeCloseTo(18.8, 1);
    expect(report.riskLevel).toBe('high');
    expect(report.riskLevel).not.toBe('severe');
    expect(report.trustScore).toBeGreaterThanOrEqual(45);
    expect(report.trustScore).toBeLessThanOrEqual(60);
    expect(report.verdict.toLowerCase()).toMatch(/meme|concentration|exit/);
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
    expect(report.verdict.toLowerCase()).not.toContain('healthy');
  });

  it('LINK-like: moderate risk with treasury review, score 68-78', () => {
    const report = service.buildReport(linkLikeAnalysis());

    expect(report.concentrationContext.top10RetailPctOfRetail).toBe(36);
    expect(report.concentrationContext.retailSupplyPct).toBe(16.75);
    expect(report.concentrationContext.top10RetailPctOfTotal).toBeCloseTo(6, 1);
    expect(report.riskLevel).toBe('moderate');
    expect(report.trustScore).toBeGreaterThanOrEqual(68);
    expect(report.trustScore).toBeLessThanOrEqual(78);
    expect(report.verdict.toLowerCase()).toMatch(/established|treasury|review|moderate/);
    expect(
      report.positiveSignals.some((signal) => signal.title === 'Strong Holder Strength'),
    ).toBe(true);
    expect(
      report.positiveSignals.some(
        (signal) => signal.title === 'Strong Retail Decentralization',
      ),
    ).toBe(true);

    const concentrationFlag = report.redFlags.find(
      (flag) => flag.title === 'High Retail Concentration',
    );
    if (concentrationFlag) {
      expect(['low', 'medium']).toContain(concentrationFlag.severity);
    }

    const teamFlag = report.redFlags.find((flag) =>
      flag.title.includes('Treasury'),
    );
    expect(teamFlag).toBeDefined();
    expect(teamFlag?.severity).toBe('medium');
  });

  it('does not mark severe for 66% retail-scope with 18.8% total impact', () => {
    const report = service.buildReport(pepeLikeAnalysis());
    expect(report.concentrationContext.top10RetailPctOfTotal).toBeCloseTo(18.8, 1);
    expect(report.riskLevel).not.toBe('severe');
  });

  it('marks low total-supply impact for 36% retail-scope with 6% total impact', () => {
    const report = service.buildReport(linkLikeAnalysis());
    expect(report.concentrationContext.top10RetailPctOfTotal).toBeCloseTo(6, 1);
    expect(report.riskLevel).toBe('moderate');
  });

  it('severe team only when deployer/owner EOA exposure is very high', () => {
    const treasuryOnly = service.buildReport(
      makeAnalysis({
        qualityMetrics: {
          avgScore: 55,
          classifiableRetailCount: 60,
          totalAnalyzedEOAs: 60,
          totalSupply: '100000000',
          teamDetection: { teamTotalPctOfSupply: 23, riskLevel: 'medium' },
        },
        distribution: {
          decentralizationScore: 62,
          supplyConcentration: { top10Pct: 30 },
          supplyBreakdown: {
            team: { pctOfSupply: 23 },
            retail: { pctOfSupply: 50 },
          },
        },
        holdersData: [
          {
            walletAddress: '0xtreasury00000000000000000000000000001',
            walletLabel: 'treasury',
            balance: '23000000',
          },
        ],
      }),
    );

    expect(['moderate', 'high']).toContain(treasuryOnly.riskLevel);
    expect(treasuryOnly.riskLevel).not.toBe('severe');

    const suspiciousEoa = service.buildReport(
      makeAnalysis({
        qualityMetrics: {
          avgScore: 50,
          classifiableRetailCount: 60,
          totalAnalyzedEOAs: 60,
          totalSupply: '100000000',
          teamDetection: { teamTotalPctOfSupply: 25, riskLevel: 'high' },
        },
        distribution: {
          decentralizationScore: 50,
          supplyConcentration: { top10Pct: 40 },
          supplyBreakdown: {
            team: { pctOfSupply: 25 },
            retail: { pctOfSupply: 45 },
          },
        },
        holdersData: [
          {
            walletAddress: '0xdeployer00000000000000000000000000001',
            walletLabel: 'deployer',
            balance: '22000000',
          },
        ],
      }),
    );

    expect(['high', 'severe']).toContain(suspiciousEoa.riskLevel);
    expect(
      suspiciousEoa.redFlags.some((flag) =>
        flag.title.includes('Suspicious Team'),
      ),
    ).toBe(true);
  });

  it('returns low confidence for small retail sample', () => {
    const report = service.buildReport(
      makeAnalysis({
        qualityMetrics: {
          avgScore: 52,
          classifiableRetailCount: 12,
          totalAnalyzedEOAs: 12,
          pnlAggregation: { holdersWithPnlData: 0 },
        },
        distribution: {
          decentralizationScore: 80,
          supplyConcentration: { top10Pct: 25 },
          supplyBreakdown: { retail: { pctOfSupply: 40 } },
        },
      }),
    );

    expect(report.confidence).toBe('low');
    expect(
      report.limitations.some((limitation) =>
        limitation.toLowerCase().includes('contract safety'),
      ),
    ).toBe(true);
    expect(report.trustScore).toBeLessThanOrEqual(82);
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
