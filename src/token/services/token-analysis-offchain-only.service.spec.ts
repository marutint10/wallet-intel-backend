import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { TokenAnalysisService } from './token-analysis.service';

function makeEntity(overrides: Partial<TokenAnalysisEntity> = {}): TokenAnalysisEntity {
  return {
    id: 'analysis-1',
    contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
    chain: 'ethereum',
    tokenName: 'Ondo',
    tokenSymbol: 'ONDO',
    shareId: 'share123',
    totalHolders: 100,
    holdersData: [{ walletAddress: '0xholder', balance: '1' }],
    qualityMetrics: {
      avgScore: 70,
      holderModule: { unchanged: true },
      offChainCredibility: { score: 10, old: true },
    },
    distribution: { decentralizationScore: 80 },
    riskCallouts: [{ title: 'Existing callout' }],
    status: 'done',
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as TokenAnalysisEntity;
}

function makeService(deps: {
  repo: {
    findOne: jest.Mock;
    update: jest.Mock;
  };
  intelligence?: { getOffchainMetadataProfiles: jest.Mock };
  offChainCredibility?: { buildReport: jest.Mock };
  chainbase?: { getTopHolders: jest.Mock };
}) {
  return new TokenAnalysisService(
    deps.repo as never,
    (deps.chainbase ?? { getTopHolders: jest.fn() }) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (deps.intelligence ??
      {
        getOffchainMetadataProfiles: jest.fn().mockResolvedValue({
          dexScreenerProfile: null,
          coinGeckoMetadata: null,
          explorerMetadata: null,
        }),
      }) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (deps.offChainCredibility ??
      {
        buildReport: jest.fn().mockResolvedValue({ score: 88, projectUnderstanding: { source: 'ai' } }),
      }) as never,
    {} as never,
  );
}

describe('TokenAnalysisService.recomputeOffchainOnly', () => {
  it('updates only qualityMetrics.offChainCredibility and does not fetch holders', async () => {
    const existing = makeEntity();
    const report = { score: 91, projectUnderstanding: { source: 'ai' } };
    const updated = makeEntity({
      qualityMetrics: {
        ...(existing.qualityMetrics ?? {}),
        offChainCredibility: report,
      },
    });
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const chainbase = { getTopHolders: jest.fn() };
    const intelligence = {
      getOffchainMetadataProfiles: jest.fn().mockResolvedValue({
        dexScreenerProfile: { info: 'dex' },
        coinGeckoMetadata: { id: 'ondo' },
        explorerMetadata: null,
      }),
    };
    const offChainCredibility = {
      buildReport: jest.fn().mockResolvedValue(report),
    };
    const service = makeService({ repo, chainbase, intelligence, offChainCredibility });

    const result = await service.recomputeOffchainOnly(existing.contractAddress, existing.chain);

    expect(chainbase.getTopHolders).not.toHaveBeenCalled();
    expect(intelligence.getOffchainMetadataProfiles).toHaveBeenCalledWith(
      existing.contractAddress,
      existing.chain,
    );
    expect(offChainCredibility.buildReport).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenName: 'Ondo',
        tokenSymbol: 'ONDO',
        contractAddress: existing.contractAddress,
        chain: existing.chain,
        forceRefresh: true,
      }),
    );
    expect(repo.update).toHaveBeenCalledWith(
      { contractAddress: existing.contractAddress, chain: existing.chain },
      expect.objectContaining({
        qualityMetrics: expect.objectContaining({
          avgScore: 70,
          holderModule: { unchanged: true },
          offChainCredibility: report,
        }),
      }),
    );
    expect(result.entity.holdersData).toEqual(existing.holdersData);
    expect(result.entity.distribution).toEqual(existing.distribution);
    expect(result.offChainCredibility).toEqual(report);
  });

  it('returns clear error when full analysis is missing', async () => {
    const service = makeService({
      repo: {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });

    await expect(
      service.recomputeOffchainOnly('0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3', 'ethereum'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects incomplete saved analysis', async () => {
    const service = makeService({
      repo: {
        findOne: jest.fn().mockResolvedValue(makeEntity({ status: 'processing' })),
        update: jest.fn(),
      },
    });

    await expect(
      service.recomputeOffchainOnly('0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3', 'ethereum'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
