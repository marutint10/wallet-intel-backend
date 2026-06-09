import { ConfigService } from '@nestjs/config';
import {
  parseAiClassifierJsonResponse,
  selectClassifierEvidence,
  TokenOffchainAiClassifierService,
} from './token-offchain-ai-classifier.service';
import type { DiscoveredLinks } from './offchain-discovery-types';
import type { OffchainExternalEvidenceResult } from './token-offchain-external-evidence.service';

function makeGeminiConfig(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'OFFCHAIN_AI_CLASSIFIER_ENABLED') return 'true';
      if (key === 'OFFCHAIN_AI_CLASSIFIER_PROVIDER') return 'gemini';
      if (key === 'GEMINI_API_KEY') return 'test-key';
      return '';
    }),
  } as unknown as ConfigService;
}

function links(overrides: Partial<DiscoveredLinks> = {}): DiscoveredLinks {
  return {
    website: null,
    docs: null,
    github: null,
    whitepaper: null,
    twitter: null,
    telegram: null,
    discord: null,
    blog: null,
    ...overrides,
  };
}

function evidence(items: OffchainExternalEvidenceResult['evidenceItems']): OffchainExternalEvidenceResult {
  return {
    status: 'done',
    evidenceItems: items,
    summary: {
      trustedDirectoryCount: 1,
      officialSourceCount: 1,
      externalValidationCount: items.length,
      riskWarningCount: 0,
      scamWarningCount: 0,
      unrelatedCount: 0,
    },
  };
}

describe('TokenOffchainAiClassifierService Gemini flat output', () => {
  it('parses Gemini flat valid JSON and uses AI result source', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'generateGeminiText').mockResolvedValue(
      JSON.stringify({
        category: 'rwa',
        categoryLabel: 'Tokenized real-world assets / institutional on-chain finance',
        categoryConfidence: 'high',
        claimedUseCase: 'Tokenized real-world assets and institutional-grade on-chain finance',
        useCaseConfidence: 'high',
        identityStatus: 'verified',
        evidenceQuality: 'strong',
        hasClearUseCase: true,
        reasoning: 'Official website/docs and trusted directories support ONDO as an RWA project.',
        warningSummary: '',
      }),
    );

    const result = await service.classifyWithDebug({
      tokenName: 'Ondo',
      tokenSymbol: 'ONDO',
      contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
      chain: 'ethereum',
      discoveredLinks: links({
        website: 'https://ondo.foundation/',
        docs: 'https://docs.ondo.foundation/',
      }),
      websiteSource: 'coingecko',
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: null,
      externalEvidence: evidence([
        {
          id: 'ev_ondo_docs',
          sourceType: 'official_docs',
          trustLevel: 'high',
          relevance: 'high',
          sourceName: 'Ondo docs',
          url: 'https://docs.ondo.foundation/',
          title: 'Ondo Finance Docs',
          snippet: 'Ondo provides tokenized real-world assets and institutional-grade finance.',
          matchedOfficialDomain: true,
          reason: 'Official docs matched.',
        },
      ]),
    });

    expect(result.debug.provider).toBe('gemini');
    expect(result.debug.resultSource).toBe('ai');
    expect(result.classification?.normalizedCategory).toBe('rwa');
    expect(result.classification?.warnings).toEqual([]);
  });

  it('normalizes old nested token/classification Gemini output safely', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'generateGeminiText').mockResolvedValue(
      JSON.stringify({
        token: {
          name: 'Ondo',
          symbol: 'ONDO',
          chain: 'ethereum',
          contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
        },
        classification: {
          category: 'Real World Assets (RWA)',
          subCategory: 'Tokenized Assets',
          confidence: 'high',
          reasoning: 'Official docs and trusted directories support RWA classification.',
        },
      }),
    );

    const result = await service.classifyWithDebug({
      tokenName: 'Ondo',
      tokenSymbol: 'ONDO',
      contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
      chain: 'ethereum',
      discoveredLinks: links({ website: 'https://ondo.foundation/' }),
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: null,
      externalEvidence: evidence([
        {
          id: 'ev_ondo_directory',
          sourceType: 'trusted_directory',
          trustLevel: 'high',
          relevance: 'high',
          title: 'Ondo RWA token',
          snippet: 'ONDO is associated with tokenized real-world assets.',
          matchedContractAddress: true,
          reason: 'Trusted directory matched contract.',
        },
      ]),
    });

    expect(result.classification?.normalizedCategory).toBe('rwa');
    expect(result.classification?.warnings).toContain(
      'Gemini returned old nested schema; normalized safely.',
    );
  });

  it('does not require arrays in Gemini output', () => {
    const parsed = parseAiClassifierJsonResponse(`{
      "category": "unknown",
      "categoryLabel": "Unknown or weakly supported project category",
      "categoryConfidence": "low",
      "claimedUseCase": null,
      "useCaseConfidence": "unknown",
      "identityStatus": "unverified",
      "evidenceQuality": "limited",
      "hasClearUseCase": false,
      "reasoning": "Search snippets do not verify an official project identity.",
      "warningSummary": "Identity is not verified."
    }`);

    expect(parsed.category).toBe('unknown');
    expect(Array.isArray(parsed.warnings)).toBe(false);
  });

  it('accepts FLOYX flat Gemini output as conservative unknown', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'generateGeminiText').mockResolvedValue(
      JSON.stringify({
        category: 'unknown',
        categoryLabel: 'Unknown or weakly supported project category',
        categoryConfidence: 'low',
        claimedUseCase: null,
        useCaseConfidence: 'unknown',
        identityStatus: 'unverified',
        evidenceQuality: 'limited',
        hasClearUseCase: false,
        reasoning: 'Search snippets suggest a project narrative but do not verify identity.',
        warningSummary: 'Official identity is not verified.',
      }),
    );

    const result = await service.classifyWithDebug({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: links(),
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: evidence([
        {
          id: 'ev_floyx_social',
          sourceType: 'news',
          trustLevel: 'medium',
          relevance: 'medium',
          title: 'FLOYX Web3 social media platform',
          snippet: 'Third-party snippet describes FLOYX as a possible Web3 social platform.',
          matchedTokenName: true,
          reason: 'Search result matched token name.',
        },
      ]),
    });

    expect(result.classification?.normalizedCategory).toBe('unknown');
    expect(result.classification?.categoryConfidence).toBe('low');
    expect(result.classification?.hasClearUseCase).toBe(false);
  });

  it('falls back to deterministic when Gemini returns invalid JSON', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'generateGeminiText').mockResolvedValue('{ invalid json');

    const result = await service.classifyWithDebug({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: links(),
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: evidence([]),
    });

    expect(result.classification).toBeNull();
    expect(result.debug.provider).toBe('gemini');
    expect(result.debug.resultSource).toBe('deterministic');
    expect(result.debug.failureReason).toBeDefined();
  });

  it('backs off Gemini after quota errors in the same session', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    const geminiSpy = jest
      .spyOn(service as any, 'generateGeminiText')
      .mockRejectedValueOnce(new Error('429 Too Many Requests: quotaValue: 20 retryDelay: 30s'));

    const input = {
      tokenName: 'PEPE',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      chain: 'ethereum',
      discoveredLinks: links({ website: 'https://www.pepe.vip/' }),
      discoveryMode: 'official_verified' as const,
      officialLinkConfidence: 'medium' as const,
      crawl: null,
      externalEvidence: evidence([]),
      forceRefresh: true,
    };

    const first = await service.classifyWithDebug(input);
    const second = await service.classifyWithDebug(input);

    expect(first.debug.attempted).toBe(true);
    expect(first.debug.failureReason).toContain('429');
    expect(second.debug.attempted).toBe(false);
    expect(second.debug.skippedReason).toBe('gemini_quota_backoff');
    expect(second.debug.resultSource).toBe('deterministic');
    expect(geminiSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers official evidence over explorer and trading evidence refs', async () => {
    const selected = selectClassifierEvidence(
      evidence([
        {
          id: 'ev_dex',
          sourceType: 'trusted_directory',
          trustLevel: 'medium',
          relevance: 'high',
          url: 'https://dexscreener.com/ethereum/chainlink',
          title: 'Chainlink price and liquidity',
          snippet: 'Trading and liquidity page.',
          matchedContractAddress: true,
          reason: 'Market directory matched.',
        },
        {
          id: 'ev_docs',
          sourceType: 'official_docs',
          trustLevel: 'high',
          relevance: 'high',
          url: 'https://docs.chain.link/',
          title: 'Chainlink Docs',
          snippet: 'Data feeds and oracle documentation.',
          matchedOfficialDomain: true,
          reason: 'Official docs.',
        },
        {
          id: 'ev_explorer',
          sourceType: 'explorer_identity',
          trustLevel: 'medium',
          relevance: 'high',
          url: 'https://etherscan.io/token/0x5149',
          title: 'LINK Token',
          snippet: 'Explorer identity page.',
          matchedContractAddress: true,
          reason: 'Explorer identity.',
        },
      ]),
    );

    expect(selected.map((item) => item.id)).toEqual(['ev_docs', 'ev_explorer']);
  });
});
