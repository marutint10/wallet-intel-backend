import { TokenController } from './token.controller';
import { TokenAnalysisEntity } from './entities/token-analysis.entity';

function makeEntity(): TokenAnalysisEntity {
  return {
    id: 'analysis-1',
    contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
    chain: 'ethereum',
    tokenName: 'Ondo',
    tokenSymbol: 'ONDO',
    shareId: 'share123',
    totalHolders: 0,
    holdersData: [],
    qualityMetrics: {
      offChainCredibility: { score: 91, projectUnderstanding: { source: 'ai' } },
    },
    distribution: {},
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as TokenAnalysisEntity;
}

describe('TokenController recomputeOffchainOnly', () => {
  it('returns updated dashboard without AI summary, deep analysis, or chart refresh', async () => {
    const entity = makeEntity();
    const tokenAnalysis = {
      recomputeOffchainOnly: jest.fn().mockResolvedValue({
        entity,
        offChainCredibility: entity.qualityMetrics?.offChainCredibility,
      }),
    };
    const dashboardSummary = {
      buildDashboardSummary: jest.fn().mockReturnValue({
        token: {
          contractAddress: entity.contractAddress,
          chain: entity.chain,
          tokenName: entity.tokenName,
          tokenSymbol: entity.tokenSymbol,
        },
        aiSummary: null,
        summaryCards: [],
        holderQuality: {},
        holderQualityBreakdown: {},
        distribution: {},
        tokenTrust: {},
        contractSafety: null,
        marketContext: null,
        offChainCredibility: entity.qualityMetrics?.offChainCredibility,
        holderTable: { total: 0, rows: [] },
        riskCallouts: [],
      }),
    };
    const tokenAiSummary = { generateSummary: jest.fn() };
    const tokenDeepAnalysis = { getDeepAnalysis: jest.fn() };
    const tokenChart = { getChart: jest.fn() };
    const finalReportService = { buildFinalReport: jest.fn() };

    const controller = new TokenController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tokenAnalysis as never,
      dashboardSummary as never,
      tokenAiSummary as never,
      tokenDeepAnalysis as never,
      tokenChart as never,
      finalReportService as never,
    );

    const response = await controller.recomputeOffchainOnly(
      'ethereum',
      entity.contractAddress,
    );

    expect(tokenAnalysis.recomputeOffchainOnly).toHaveBeenCalledWith(
      entity.contractAddress,
      'ethereum',
      { debug: false },
    );
    expect(dashboardSummary.buildDashboardSummary).toHaveBeenCalledWith(entity);
    expect(tokenAiSummary.generateSummary).not.toHaveBeenCalled();
    expect(tokenDeepAnalysis.getDeepAnalysis).not.toHaveBeenCalled();
    expect(tokenChart.getChart).not.toHaveBeenCalled();
    expect(finalReportService.buildFinalReport).not.toHaveBeenCalled();
    expect(response.aiSummary).toBeNull();
    expect(response.offChainCredibility).toEqual(entity.qualityMetrics?.offChainCredibility);
    expect(response.shareId).toBe('share123');
  });
});
