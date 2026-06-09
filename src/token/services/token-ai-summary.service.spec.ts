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

  it('buildInput includes contractSafety when persisted', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const analysis = makeAnalysis();
    analysis.qualityMetrics = {
      ...analysis.qualityMetrics,
      contractSafety: {
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
        taxes: { status: 'not_detected', buyTaxPct: null, sellTaxPct: null, transferTaxPct: null, evidence: [] },
        honeypot: { status: 'not_checked', reason: null, evidence: [] },
        flags: [],
        positiveSignals: [],
        unknowns: [],
        limitations: [],
        checkedAt: new Date().toISOString(),
      },
    };

    const input = (service as any).buildInput(analysis);
    expect(input.contractSafetyAvailable).toBe(true);
    expect(input.contractSafetyScore).toBe(88);
    expect(input.contractSafetyRiskLevel).toBe('low');

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).not.toContain('safe');
    expect(fallback.toLowerCase()).toContain('contract permission risk');
  });

  it('fallback avoids no-major-risk wording when renounced blacklist exists', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const input = (service as any).buildInput(makeAnalysis());
    input.contractSafetyAvailable = true;
    input.contractSafetyOwnerRenounced = true;
    input.contractSafetyFlags = ['Blacklist Function Exists'];
    input.contractSafetyRiskLevel = 'moderate';
    input.contractSafetyVerified = true;

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).toContain('ownership appears renounced');
    expect(fallback.toLowerCase()).toContain('blacklist function exists');
    expect(fallback.toLowerCase()).not.toContain('no major contract permission risk');
  });

  it('buildInput includes marketContext when persisted', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const analysis = makeAnalysis();
    analysis.qualityMetrics = {
      ...analysis.qualityMetrics,
      marketContext: {
        status: 'done',
        score: 92,
        riskLevel: 'low',
        maturityTier: 'bluechip',
        verdict: 'Market maturity appears strong based on available market and liquidity data',
        confidence: 'high',
        marketCapUsd: 12_000_000_000,
        fdvUsd: null,
        liquidityUsd: 85_000_000,
        volume24hUsd: 420_000_000,
        priceChange24hPct: null,
        tokenAgeDays: 2555,
        firstSeenAt: '2017-09-19T00:00:00.000Z',
        exchangeContext: {
          cexSignals: {
            exchangeSupplyPct: 30,
            exchangeWalletCount: 12,
            interpretation: 'ok',
          },
          dexSignals: {
            pairCount: 8,
            topPairLiquidityUsd: 45_000_000,
            totalDexLiquidityUsd: 85_000_000,
            mainDex: 'uniswap',
          },
        },
        liquidityRisk: { level: 'low', reason: 'Liquidity depth appears supportive for broader market access' },
        maturitySignals: [],
        riskFlags: [],
        unknowns: [],
        limitations: [],
        checkedAt: new Date().toISOString(),
      },
    };

    const input = (service as any).buildInput(analysis);
    expect(input.marketContextAvailable).toBe(true);
    expect(input.marketContextScore).toBe(92);
    expect(input.marketContextMaturityTier).toBe('bluechip');

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).toContain('market maturity appears strong');
    expect(fallback.toLowerCase()).toContain('partial');
    expect(fallback.toLowerCase()).not.toContain('final trust score');
  });

  it('PEPE-like fallback mentions holder concentration separately from market access', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const input = (service as any).buildInput(makeAnalysis());
    input.marketContextAvailable = true;
    input.marketContextScore = 78;
    input.marketContextRiskLevel = 'moderate';
    input.marketContextMaturityTier = 'established';
    input.marketContextVerdict = 'Market access and liquidity appear supportive, but holder risk remains separate';
    input.marketContextFlags = [];

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).toContain('market access');
    expect(fallback.toLowerCase()).toContain('holder concentration');
  });

  it('buildInput includes offChainCredibility when persisted', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const analysis = makeAnalysis();
    analysis.qualityMetrics = {
      ...analysis.qualityMetrics,
      offChainCredibility: {
        status: 'done',
        score: 92,
        riskLevel: 'low',
        credibilityTier: 'institutional_grade',
        verdict:
          'Off-chain credibility appears strong based on official project, documentation, developer, and infrastructure use-case signals.',
        confidence: 'high',
        discoveredLinks: {
          website: 'https://chain.link/',
          docs: 'https://docs.chain.link/',
          whitepaper: null,
          github: 'https://github.com/smartcontractkit/chainlink',
          twitter: 'https://twitter.com/chainlink',
          telegram: null,
          discord: null,
          blog: null,
        },
        officialLinkConfidence: { level: 'high', reasons: ['Verified'] },
        projectProfile: {
          category: 'infrastructure',
          claimedUseCase: 'Decentralized infrastructure or data services',
          hasClearUseCase: true,
          hasDocs: true,
          hasWhitepaper: false,
          hasGithub: true,
          hasAuditsMentioned: true,
          hasTeamInfo: true,
        },
        credibilitySignals: [],
        riskFlags: [],
        claimChecks: [],
        unknowns: [],
        limitations: [],
        checkedAt: new Date().toISOString(),
      },
    };

    const input = (service as any).buildInput(analysis);
    expect(input.offChainCredibilityAvailable).toBe(true);
    expect(input.offChainCredibilityScore).toBe(92);
    expect(input.offChainCredibilityCategory).toBe('infrastructure');

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).toContain('off-chain credibility');
    expect(fallback.toLowerCase()).toContain('partial');
    expect(fallback.toLowerCase()).not.toContain('final trust score');
    expect(fallback.toLowerCase()).not.toMatch(/\bguaranteed safe\b/);
    expect(fallback.toLowerCase()).not.toContain('scam');
  });

  it('PEPE-like off-chain fallback mentions community-driven credibility', () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as Cache;
    const trust = new TokenTrustReportService();
    const service = new TokenAiSummaryService(config, trust, cache);

    const input = (service as any).buildInput(makeAnalysis());
    input.offChainCredibilityAvailable = true;
    input.offChainCredibilityScore = 58;
    input.offChainCredibilityRiskLevel = 'high';
    input.offChainCredibilityTier = 'limited';
    input.offChainCredibilityCategory = 'meme';
    input.offChainCredibilityVerdict =
      'Off-chain credibility appears community-driven. Official links may exist, but project documentation and utility evidence are limited compared with infrastructure or DeFi protocols.';
    input.offChainCredibilityFlags = [];

    const fallback = (service as any).buildFallbackSummary(input);
    expect(fallback.toLowerCase()).toContain('community-driven');
    expect(fallback.toLowerCase()).toMatch(/verified meme-project|limited documentation/);
  });
});
