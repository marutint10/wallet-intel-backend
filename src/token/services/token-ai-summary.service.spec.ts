import { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { TokenTrustReportService } from './token-trust-report.service';
import { TokenAiSummaryService } from './token-ai-summary.service';

function makeAnalysis(): TokenAnalysisEntity {
  return {
    id: 'a',
    contractAddress: '0xtoken',
    chain: 'ethereum',
    tokenName: 'Token',
    tokenSymbol: 'TOK',
    shareId: 'abc123def456',
    totalHolders: 100,
    holdersData: [],
    qualityMetrics: {
      avgScore: 40,
      classifiableRetailCount: 40,
      totalAnalyzedEOAs: 40,
      pnlAggregation: { holdersWithPnlData: 0 },
      teamDetection: { teamTotalPctOfSupply: 2, riskLevel: 'low' },
    },
    distribution: {
      decentralizationScore: 55,
      retailHolderCount: 40,
      supplyConcentration: { top10Pct: 45, top50Pct: 80, top100Pct: 100 },
      supplyBreakdown: {
        retail: { pctOfSupply: 60 },
        exchange: { pctOfSupply: 25 },
        team: { pctOfSupply: 2 },
        burn: { pctOfSupply: 1 },
        lp: { pctOfSupply: 2 },
      },
    },
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('TokenAiSummaryService', () => {
  it('buildInput includes tokenTrust fields', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const input = (service as any).buildInput(makeAnalysis());
    expect(input.tokenTrustScore).toBeGreaterThanOrEqual(0);
    expect(['low', 'moderate', 'high', 'severe', 'unknown']).toContain(
      input.tokenTrustRiskLevel,
    );
    expect(typeof input.tokenTrustVerdict).toBe('string');
    expect(Array.isArray(input.tokenTrustRedFlags)).toBe(true);
    expect(typeof input.whoCanDumpSummary).toBe('string');
    expect(typeof input.concentrationContextExplanation).toBe('string');
    expect(input.concentrationContextExplanation.length).toBeGreaterThan(0);
    expect(input.scoreLabel).toBe('Visible On-chain Score');
    expect(input.hasRealizedPnl).toBe(false);
    expect(input.qualityLabel).not.toContain('Community');
  });
});
