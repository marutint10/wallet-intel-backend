import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { TokenAnalysisEntity } from './entities/token-analysis.entity';
import { LEGACY_DEEP_ANALYSIS_DISABLED_RESPONSE } from './services/token-deep-analysis.service';
import { TokenController } from './token.controller';

const CONTRACT = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

function makeEntity(): TokenAnalysisEntity {
  return {
    id: 'analysis-1',
    contractAddress: CONTRACT,
    chain: 'ethereum',
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    shareId: 'share-pepe',
    totalHolders: 100,
    holdersData: [],
    qualityMetrics: {},
    distribution: {},
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as TokenAnalysisEntity;
}

function makeController(overrides: {
  tokenAnalysis?: Record<string, jest.Mock>;
  dashboardSummary?: Record<string, jest.Mock>;
  tokenAiSummary?: Record<string, jest.Mock>;
  finalReportService?: Record<string, jest.Mock>;
} = {}): TokenController {
  const tokenAnalysis = {
    findByShareId: jest.fn(),
    getResult: jest.fn(),
    ...overrides.tokenAnalysis,
  };
  const dashboardSummary = {
    buildDashboardSummary: jest.fn(),
    ...overrides.dashboardSummary,
  };
  const tokenAiSummary = {
    generateSummary: jest.fn(),
    ...overrides.tokenAiSummary,
  };
  const finalReportService = {
    buildFinalReport: jest.fn(),
    ...overrides.finalReportService,
  };

  return new TokenController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    tokenAnalysis as never,
    dashboardSummary as never,
    tokenAiSummary as never,
    { getChart: jest.fn() } as never,
    finalReportService as never,
  );
}

describe('TokenController legacy deep analysis deprecation', () => {
  it('returns disabled response from trigger without invoking TokenDeepAnalysisService', async () => {
    const controller = makeController();

    const response = await controller.triggerTokenDeepAnalysis(CONTRACT, 'ethereum');

    expect(response).toEqual(LEGACY_DEEP_ANALYSIS_DISABLED_RESPONSE);
  });

  it('returns disabled response from read endpoint without invoking TokenDeepAnalysisService', async () => {
    const controller = makeController();

    const response = await controller.getTokenDeepAnalysis(CONTRACT, 'ethereum');

    expect(response).toEqual(LEGACY_DEEP_ANALYSIS_DISABLED_RESPONSE);
  });

  it('rejects invalid contract address on deprecated deep-analysis routes', async () => {
    const controller = makeController();

    await expect(controller.triggerTokenDeepAnalysis('not-an-address')).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(controller.getTokenDeepAnalysis('not-an-address')).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe('TokenController share report', () => {
  it('includes finalReport and null deepAnalysis without legacy deep-analysis lookup', async () => {
    const entity = makeEntity();
    const dashboardBase = {
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
      tokenTrust: { verdict: 'test' },
      contractSafety: null,
      marketContext: null,
      offChainCredibility: null,
      holderTable: { total: 0, rows: [] },
      riskCallouts: [],
    };
    const finalReport = {
      overall: { score: 55, riskLevel: 'high', verdict: 'Test verdict' },
    };

    const tokenAnalysis = {
      findByShareId: jest.fn().mockResolvedValue(entity),
    };
    const dashboardSummary = {
      buildDashboardSummary: jest.fn().mockReturnValue(dashboardBase),
    };
    const tokenAiSummary = {
      generateSummary: jest.fn().mockResolvedValue('AI summary text'),
    };
    const finalReportService = {
      buildFinalReport: jest.fn().mockReturnValue(finalReport),
    };

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
      { getChart: jest.fn() } as never,
      finalReportService as never,
    );

    const json = jest.fn();
    const res = { json, status: jest.fn().mockReturnThis() } as unknown as Response;

    await controller.getSharedReport('share-pepe', res);

    expect(finalReportService.buildFinalReport).toHaveBeenCalledWith({
      analysis: entity,
      dashboard: dashboardBase,
    });
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSummary: 'AI summary text',
        finalReport,
        deepAnalysis: null,
        shareId: 'share-pepe',
        contractAddress: CONTRACT,
        chain: 'ethereum',
        tokenTrust: expect.objectContaining({ verdict: 'test' }),
      }),
    );
  });
});
