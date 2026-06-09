import { DashboardSummaryService } from './dashboard-summary.service';
import {
  buildOffChainCredibilityReport,
  TokenOffchainCredibilityService,
  type OffChainCredibilityCollectedData,
} from './token-offchain-credibility.service';
import type { OffchainDiscoveryResult } from './token-offchain-discovery.service';
import type { TokenWebsiteCrawlResult } from './token-web-crawler.service';
import type { TokenOffchainDiscoveryService } from './token-offchain-discovery.service';
import type { TokenOffchainExternalEvidenceService } from './token-offchain-external-evidence.service';
import {
  parseAiClassifierJsonResponse,
  TokenOffchainAiClassifierService,
  type OffchainAiProjectClassification,
} from './token-offchain-ai-classifier.service';
import type { ConfigService } from '@nestjs/config';
import { TokenTrustReportService } from './token-trust-report.service';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';

function makeDiscovery(
  overrides: Partial<OffchainDiscoveryResult> = {},
): OffchainDiscoveryResult {
  return {
    status: 'done',
    discoveryMode: 'not_found',
    discoveredLinks: {
      website: null,
      docs: null,
      whitepaper: null,
      github: null,
      twitter: null,
      telegram: null,
      discord: null,
      blog: null,
    },
    linkSources: {},
    officialLinkConfidence: { level: 'low', reasons: [] },
    sourceUrls: [],
    errors: [],
    hasTrustedOfficialWebsite: false,
    braveOnlyWebsite: false,
    aggregatorWebsiteRejected: false,
    metadataCategories: [],
    trustedDirectoryUrls: [],
    ...overrides,
  };
}

function makeCrawl(overrides: Partial<TokenWebsiteCrawlResult> = {}): TokenWebsiteCrawlResult {
  return {
    status: 'done',
    homepageUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    pagesVisited: ['https://example.com'],
    brokenWebsite: false,
    extractedText: '',
    links: {
      docs: null,
      whitepaper: null,
      github: null,
      twitter: null,
      telegram: null,
      discord: null,
      blog: null,
      tokenomics: null,
      security: null,
      audit: null,
      about: null,
    },
    mentions: { tokenName: false, tokenSymbol: false, contractAddress: false },
    signals: {
      hasDocs: false,
      hasWhitepaper: false,
      hasGithub: false,
      hasAuditsMentioned: false,
      hasTeamInfo: false,
      hasClearUseCase: false,
      suspiciousPhrases: [],
      adoptionClaims: [],
    },
    errors: [],
    ...overrides,
  };
}

function linkLikeData(): OffChainCredibilityCollectedData {
  return {
    tokenName: 'Chainlink',
    tokenSymbol: 'LINK',
    contractAddress: '0x514910771af9ca656af558dff21e3962aa028f2ae',
    discovery: makeDiscovery({
      status: 'done',
      discoveryMode: 'official_verified',
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
      linkSources: {
        website: 'coingecko',
        docs: 'coingecko',
        github: 'coingecko',
        twitter: 'coingecko',
      },
      hasTrustedOfficialWebsite: true,
      officialLinkConfidence: {
        level: 'high',
        reasons: ['Trusted metadata and homepage verification'],
      },
      sourceUrls: ['https://chain.link/', 'https://docs.chain.link/'],
    }),
    crawl: makeCrawl({
      homepageUrl: 'https://chain.link/',
      finalUrl: 'https://chain.link/',
      extractedText:
        'Chainlink LINK decentralized oracle network provides data feeds and infrastructure for DeFi. ' +
        'Our protocol secures smart contracts with reliable off-chain data. Integrated with major ecosystems. ' +
        'Documentation, security, and audit information are available for developers.',
      links: {
        docs: 'https://docs.chain.link/',
        whitepaper: null,
        github: 'https://github.com/smartcontractkit/chainlink',
        twitter: 'https://twitter.com/chainlink',
        telegram: null,
        discord: null,
        blog: null,
        tokenomics: null,
        security: 'https://chain.link/security',
        audit: 'https://chain.link/security',
        about: 'https://chain.link/about',
      },
      mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      signals: {
        hasDocs: true,
        hasWhitepaper: false,
        hasGithub: true,
        hasAuditsMentioned: true,
        hasTeamInfo: true,
        hasClearUseCase: true,
        suspiciousPhrases: [],
        adoptionClaims: ['integrated with', 'ecosystem'],
      },
    }),
    fetchErrors: [],
  };
}

function pepeLikeData(): OffChainCredibilityCollectedData {
  return {
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
    discovery: makeDiscovery({
      status: 'done',
      discoveryMode: 'official_verified',
      discoveredLinks: {
        website: 'https://www.pepe.vip/',
        docs: null,
        whitepaper: null,
        github: null,
        twitter: 'https://twitter.com/pepecoineth',
        telegram: 'https://t.me/pepecoineth',
        discord: null,
        blog: null,
      },
      linkSources: {
        website: 'dexscreener',
        twitter: 'dexscreener',
        telegram: 'dexscreener',
      },
      hasTrustedOfficialWebsite: true,
      officialLinkConfidence: {
        level: 'medium',
        reasons: ['Metadata and homepage mention token identifiers'],
      },
      sourceUrls: ['https://www.pepe.vip/'],
    }),
    crawl: makeCrawl({
      homepageUrl: 'https://www.pepe.vip/',
      finalUrl: 'https://www.pepe.vip/',
      extractedText:
        'Pepe PEPE is the most memeable memecoin in existence. Community token for entertainment and culture. ' +
        'Join the frog community on social channels.',
      links: {
        docs: null,
        whitepaper: null,
        github: null,
        twitter: 'https://twitter.com/pepecoineth',
        telegram: 'https://t.me/pepecoineth',
        discord: null,
        blog: null,
        tokenomics: null,
        security: null,
        audit: null,
        about: null,
      },
      mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      signals: {
        hasDocs: false,
        hasWhitepaper: false,
        hasGithub: false,
        hasAuditsMentioned: false,
        hasTeamInfo: false,
        hasClearUseCase: false,
        suspiciousPhrases: [],
        adoptionClaims: [],
      },
    }),
    fetchErrors: [],
  };
}

function externalEvidenceFixture() {
  return {
    status: 'done' as const,
    evidenceItems: [
      {
        id: 'ev_chainlink_docs',
        sourceType: 'official_docs' as const,
        trustLevel: 'high' as const,
        relevance: 'high' as const,
        url: 'https://docs.chain.link/',
        title: 'Chainlink Documentation',
        snippet: 'Developer docs for Chainlink data feeds, CCIP, automation, and smart contracts.',
        matchedOfficialDomain: true,
        reason: 'Search result matches the verified official documentation domain.',
      },
      {
        id: 'ev_chainlink_github',
        sourceType: 'developer_resource' as const,
        trustLevel: 'medium' as const,
        relevance: 'medium' as const,
        url: 'https://github.com/smartcontractkit/chainlink',
        title: 'smartcontractkit/chainlink',
        snippet: 'Chainlink oracle network and smart contract infrastructure.',
        matchedTokenName: true,
        reason: 'Search result points to a developer resource.',
      },
    ],
    summary: {
      trustedDirectoryCount: 0,
      officialSourceCount: 1,
      externalValidationCount: 2,
      riskWarningCount: 0,
      scamWarningCount: 0,
      unrelatedCount: 0,
    },
  };
}

function ondoEvidenceFixture() {
  return {
    status: 'done' as const,
    evidenceItems: [
      {
        id: 'ev_ondo_docs',
        sourceType: 'official_docs' as const,
        trustLevel: 'high' as const,
        relevance: 'high' as const,
        url: 'https://docs.ondo.foundation/ondo-token',
        title: 'ONDO Token Documentation',
        snippet:
          'Official docs describe ONDO as governance token for Ondo DAO and Flux Finance.',
        matchedOfficialDomain: true,
        reason: 'Search result matches the verified official documentation domain.',
      },
      {
        id: 'ev_ondo_rwa',
        sourceType: 'news' as const,
        trustLevel: 'medium' as const,
        relevance: 'medium' as const,
        url: 'https://example.com/ondo-rwa',
        title: 'Ondo institutional-grade finance and tokenized real-world assets',
        snippet:
          'Open-web evidence mentions tokenized real-world assets and institutional-grade on-chain finance.',
        matchedTokenName: true,
        reason: 'Search result matched token name and project narrative.',
      },
    ],
    summary: {
      trustedDirectoryCount: 0,
      officialSourceCount: 1,
      externalValidationCount: 2,
      riskWarningCount: 0,
      scamWarningCount: 0,
      unrelatedCount: 0,
    },
  };
}

function aiClassification(
  overrides: Partial<OffchainAiProjectClassification> = {},
): OffchainAiProjectClassification {
  return {
    source: 'ai',
    categoryLabel: 'Oracle / smart contract infrastructure',
    normalizedCategory: 'infrastructure',
    categoryConfidence: 'high',
    claimedUseCase: 'Oracle, data feeds, and smart contract infrastructure',
    useCaseConfidence: 'high',
    identityStatus: 'verified',
    evidenceQuality: 'strong',
    possibleNarrative: null,
    hasClearUseCase: true,
    reasoning: 'Official docs and developer resources describe Chainlink oracle infrastructure.',
    evidenceRefs: ['ev_chainlink_docs', 'ev_chainlink_github'],
    warnings: [],
    ...overrides,
  };
}

describe('buildOffChainCredibilityReport', () => {
  it('includes required limitations copy', () => {
    const report = buildOffChainCredibilityReport(linkLikeData());
    expect(
      report.limitations.some((line) =>
        line.includes('not yet merged into the visible on-chain score'),
      ),
    ).toBe(true);
    expect(
      report.limitations.some((line) =>
        line.includes('does not prove investment safety'),
      ),
    ).toBe(true);
    expect(report.verdict.toLowerCase()).not.toMatch(/\b(safe|scam|buy|sell)\b/);
  });

  it('LINK-like project scores high with infrastructure signals', () => {
    const report = buildOffChainCredibilityReport(linkLikeData());

    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.riskLevel).toBe('low');
    expect(['strong', 'institutional_grade']).toContain(report.credibilityTier);
    expect(report.projectProfile.category).toBe('infrastructure');
    expect(report.projectProfile.hasClearUseCase).toBe(true);
    expect(report.projectProfile.hasDocs).toBe(true);
    expect(
      report.credibilitySignals.some((signal) =>
        ['Documentation Available', 'Clear Project Use Case', 'Developer Resources Found'].includes(
          signal.title,
        ),
      ),
    ).toBe(true);
    expect(report.verdict.toLowerCase()).not.toContain('safe');
    expect(report.verdict.toLowerCase()).toContain('strong');
  });

  it('PEPE-like meme project is not severe solely for being a meme', () => {
    const report = buildOffChainCredibilityReport(pepeLikeData());

    expect(report.riskLevel).not.toBe('severe');
    expect(['limited', 'moderate', 'high']).toContain(report.riskLevel);
    expect(report.score).toBeLessThanOrEqual(69);
    expect(report.credibilityTier).toBe('limited');
    expect(report.projectProfile.category).toBe('meme');
    expect(report.projectProfile.hasDocs).toBe(false);
    expect(report.projectProfile.hasGithub).toBe(false);
    expect(report.projectProfile.hasClearUseCase).toBe(false);
    expect(report.verdict.toLowerCase()).toMatch(/community|limited|documentation/);
    expect(
      report.credibilitySignals.some(
        (signal) => signal.title === 'Clear Meme/Community Positioning',
      ),
    ).toBe(true);
    expect(
      report.credibilitySignals.some((signal) => signal.title === 'Clear Project Use Case'),
    ).toBe(false);
  });

  it('PEPE deterministic fallback stays meme when Gemini quota fails', () => {
    const report = buildOffChainCredibilityReport({
      ...pepeLikeData(),
      aiClassification: null,
      aiClassifierDebug: {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        hasApiKey: true,
        evidenceItemCount: 1,
        attempted: true,
        failureReason: '429 Too Many Requests',
        resultSource: 'deterministic',
      },
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_pepe_directory',
            sourceType: 'trusted_directory',
            trustLevel: 'medium',
            relevance: 'high',
            url: 'https://www.coingecko.com/en/coins/pepe',
            title: 'Pepe PEPE meme coin',
            snippet: 'PEPE is a community-driven meme coin with Pepe the Frog positioning.',
            matchedContractAddress: true,
            matchedTokenName: true,
            reason: 'Trusted directory matched contract and meme positioning.',
          },
          {
            id: 'ev_pepe_trading',
            sourceType: 'trusted_directory',
            trustLevel: 'medium',
            relevance: 'high',
            url: 'https://dexscreener.com/ethereum/pepe',
            title: 'PEPE price and liquidity',
            snippet: 'DEX pair trading, liquidity, and price information.',
            matchedContractAddress: true,
            reason: 'Market directory matched contract.',
          },
        ],
        summary: {
          trustedDirectoryCount: 2,
          officialSourceCount: 0,
          externalValidationCount: 2,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
    });

    expect(report.projectUnderstanding?.source).toBe('deterministic');
    expect(report.projectUnderstanding?.category).toBe('meme');
    expect(report.projectUnderstanding?.claimedUseCase).toBe('Community-driven meme token');
    expect(report.projectUnderstanding?.hasClearUseCase).toBe(false);
    expect(report.score).toBeLessThanOrEqual(75);
    expect(report.verdict.toLowerCase()).toContain('community/meme');
    expect(report.verdict.toLowerCase()).not.toContain('decentralized finance protocol');
    expect(report.verdict.toLowerCase()).not.toContain('infrastructure use-case signals');
  });

  it('meme pretending infrastructure utility receives unsupported claim penalty', () => {
    const report = buildOffChainCredibilityReport({
      ...pepeLikeData(),
      crawl: makeCrawl({
        homepageUrl: 'https://www.pepe.vip/',
        extractedText:
          'Pepe PEPE revolutionary AI infrastructure used by major banks globally with enterprise adoption.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: false,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
          hasClearUseCase: false,
          suspiciousPhrases: [],
          adoptionClaims: [],
        },
      }),
    });

    expect(report.claimChecks.some((check) => check.status === 'unsupported')).toBe(true);
    expect(report.riskFlags.some((flag) => flag.title === 'Unsupported Major Claim')).toBe(true);
    expect(report.score).toBeLessThan(60);
  });

  it('Chainlink backed-by claim is not supported by security page alone', () => {
    const data = linkLikeData();
    const report = buildOffChainCredibilityReport({
      ...data,
      crawl: makeCrawl({
        ...data.crawl!,
        extractedText:
          `${data.crawl?.extractedText ?? ''} Chainlink is backed by a secure oracle network.`,
      }),
      externalEvidence: externalEvidenceFixture(),
    });

    const backedBy = report.claimChecks.find((check) => check.claim === 'backed by');
    expect(backedBy?.status).toBe('unsupported');
    expect(backedBy?.sourceUrls).not.toContain('https://chain.link/security');
    expect(report.projectProfile.category).toBe('infrastructure');
  });

  it('Chainlink score is capped below perfect while remaining strong', () => {
    const report = buildOffChainCredibilityReport({
      ...linkLikeData(),
      externalEvidence: externalEvidenceFixture(),
      aiClassification: aiClassification({
        evidenceRefs: ['ev_chainlink_docs', 'ev_chainlink_github'],
      }),
      aiClassifierDebug: {
        enabled: true,
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        hasApiKey: true,
        evidenceItemCount: 2,
        attempted: true,
        resultSource: 'ai',
      },
    });

    expect(report.score).toBeLessThanOrEqual(97);
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.projectUnderstanding?.category).toBe('infrastructure');
    expect(report.verdict.toLowerCase()).toMatch(/oracle|infrastructure/);
  });

  it('FLOYX search-only fallback remains low confidence unknown', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      discovery: makeDiscovery({
        status: 'partial',
        discoveryMode: 'search_only',
        officialLinkConfidence: { level: 'low', reasons: ['No official website discovered'] },
        trustedDirectoryUrls: ['https://phantom.app/tokens/polygon/floyx'],
      }),
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_floyx_phantom',
            sourceType: 'trusted_directory',
            trustLevel: 'medium',
            relevance: 'high',
            url: 'https://phantom.app/tokens/polygon/floyx',
            title: 'FLOYX token page',
            snippet: 'Third-party wallet token directory page for FLOYX.',
            matchedContractAddress: true,
            reason: 'Third-party token or wallet directory page, not official developer proof.',
          },
          {
            id: 'ev_floyx_social',
            sourceType: 'news',
            trustLevel: 'low',
            relevance: 'medium',
            title: 'FLOYX Web3 social platform',
            snippet: 'Weak third-party snippets describe a possible Web3 social platform.',
            matchedTokenName: true,
            reason: 'Search result matched token name.',
          },
        ],
        summary: {
          trustedDirectoryCount: 1,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
      fetchErrors: [],
    });

    expect(report.discoveryMode).toBe('search_only');
    expect(report.discoveredLinks.website).toBeNull();
    expect(report.projectUnderstanding?.category).toBe('unknown');
    expect(report.projectUnderstanding?.hasClearUseCase).toBe(false);
    expect(report.score).toBeLessThanOrEqual(45);
    expect(report.verdict.toLowerCase()).toContain('official identity could not be verified');
  });

  it('ONDO verdict mentions RWA institutional finance', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Ondo',
      tokenSymbol: 'ONDO',
      contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
      discovery: makeDiscovery({
        status: 'done',
        discoveryMode: 'official_verified',
        discoveredLinks: {
          website: 'https://ondo.foundation/',
          docs: 'https://docs.ondo.foundation/ondo-token',
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'coingecko', docs: 'coingecko' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'high', reasons: ['Trusted metadata'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://ondo.foundation/',
        extractedText:
          'Ondo provides tokenized real-world assets and institutional-grade on-chain finance.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: true,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
          hasClearUseCase: true,
          suspiciousPhrases: [],
          adoptionClaims: [],
        },
      }),
      externalEvidence: ondoEvidenceFixture(),
      fetchErrors: [],
    });

    expect(report.projectUnderstanding?.category).toBe('rwa');
    expect(report.verdict.toLowerCase()).toMatch(/rwa|institutional on-chain finance/);
  });

  it('no official website applies penalty and flags', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Unknown',
      tokenSymbol: 'UNK',
      contractAddress: null,
      discovery: makeDiscovery({
        status: 'partial',
        officialLinkConfidence: { level: 'low', reasons: ['No website discovered'] },
      }),
      crawl: null,
      fetchErrors: [],
    });

    expect(['high', 'severe']).toContain(report.riskLevel);
    expect(
      report.riskFlags.some((flag) => flag.title === 'Official Website Not Verified'),
    ).toBe(true);
    expect(report.score).toBeLessThanOrEqual(50);
  });

  it('website mismatch downgrades confidence and verdict', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af558dff21e3962aa028f2ae',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://unrelated-shop.example/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        officialLinkConfidence: {
          level: 'low',
          reasons: ['Homepage did not verify token identifiers'],
        },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://unrelated-shop.example/',
        extractedText: 'Buy shoes online with free shipping worldwide.',
        mentions: { tokenName: false, tokenSymbol: false, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.officialLinkConfidence.level).toBe('low');
    expect(report.riskFlags.some((flag) => flag.title === 'Official Link Mismatch')).toBe(true);
    expect(report.verdict.toLowerCase()).toContain('requires review');
    expect(report.score).toBeLessThanOrEqual(60);
  });

  it('unsupported major claim is penalized', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'TokenX',
      tokenSymbol: 'TKX',
      contractAddress: null,
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://tokenx.example/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'seed' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Website discovered'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://tokenx.example/',
        extractedText:
          'TokenX is used by major banks globally with revolutionary enterprise adoption and no documentation.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: false,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
          hasClearUseCase: false,
          suspiciousPhrases: [],
          adoptionClaims: [],
        },
      }),
      fetchErrors: [],
    });

    expect(
      report.claimChecks.some(
        (check) =>
          check.claim.includes('major banks') &&
          ['unsupported', 'unknown'].includes(check.status),
      ),
    ).toBe(true);
    expect(report.riskFlags.some((flag) => flag.title === 'Unsupported Major Claim')).toBe(true);
    expect(report.score).toBeLessThan(85);
  });

  it('audit claim without audit link requires review', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'AuditToken',
      tokenSymbol: 'AUD',
      contractAddress: null,
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://audit.example/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'seed' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Website discovered'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://audit.example/',
        extractedText: 'AuditToken AUD was audited by a leading security firm.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        links: {
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
          tokenomics: null,
          security: null,
          audit: null,
          about: null,
        },
      }),
      fetchErrors: [],
    });

    expect(
      report.riskFlags.some((flag) => flag.title === 'Audit Claim Requires Review'),
    ).toBe(true);
    expect(report.verdict.toLowerCase()).not.toContain('scam');
  });

  it('rejects CoinMarketCap as PEPE official website', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        status: 'partial',
        discoveredLinks: {
          website: 'https://coinmarketcap.com/currencies/pepe/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'brave' },
        braveOnlyWebsite: true,
        aggregatorWebsiteRejected: true,
        officialLinkConfidence: {
          level: 'low',
          reasons: ['Website discovered primarily from Brave search without trusted metadata confirmation'],
        },
        sourceUrls: ['https://coinmarketcap.com/currencies/pepe/'],
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://coinmarketcap.com/currencies/pepe/',
        extractedText: 'Pepe PEPE DeFi lending yield staking liquidity DEX protocol',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.website).toBeNull();
    expect(
      report.riskFlags.some((flag) => flag.title === 'Official Website Not Verified'),
    ).toBe(true);
    expect(report.score).toBeLessThanOrEqual(64);
    expect(['limited', 'weak', 'credible']).toContain(report.credibilityTier);
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(report.credibilityTier).not.toBe('strong');
    expect(report.projectProfile.category).toBe('meme');
  });

  it('rejects Pepe Unchained docs for PEPE ERC20', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://www.pepe.vip/',
          docs: 'https://guide.pepeunchained.com/',
          whitepaper: null,
          github: null,
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'dexscreener', docs: 'brave', twitter: 'dexscreener' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Trusted metadata website'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme community token',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.docs).toBeNull();
    expect(report.projectProfile.hasDocs).toBe(false);
    expect(
      report.credibilitySignals.some((signal) => signal.title === 'Documentation Available'),
    ).toBe(false);
  });

  it('rejects random GitHub for PEPE', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://www.pepe.vip/',
          docs: null,
          whitepaper: null,
          github: 'https://github.com/MattF42/PePe-core/blob/master/doc/pepeproofofworkstory.md',
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'dexscreener', github: 'brave', twitter: 'dexscreener' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Trusted metadata website'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme community',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.github).toBeNull();
    expect(report.projectProfile.hasGithub).toBe(false);
    expect(
      report.credibilitySignals.some((signal) => signal.title === 'Developer Resources Found'),
    ).toBe(false);
  });

  it('rejects aggregator whitepaper for PEPE', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://www.pepe.vip/',
          docs: null,
          whitepaper: 'https://bitscreener.com/coins/pepe/whitepaper',
          github: null,
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'dexscreener', whitepaper: 'brave', twitter: 'dexscreener' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Trusted metadata website'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme community',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.whitepaper).toBeNull();
    expect(report.projectProfile.hasWhitepaper).toBe(false);
  });

  it('scores PEPE live-bug link bundle as limited meme with capped score', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        status: 'partial',
        discoveredLinks: {
          website: 'https://coinmarketcap.com/currencies/pepe/',
          docs: 'https://guide.pepeunchained.com/',
          whitepaper: 'https://bitscreener.com/coins/pepe/whitepaper',
          github: 'https://github.com/MattF42/PePe-core/blob/master/doc/pepeproofofworkstory.md',
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: {
          website: 'brave',
          docs: 'brave',
          whitepaper: 'brave',
          github: 'brave',
        },
        braveOnlyWebsite: true,
        aggregatorWebsiteRejected: true,
        hasTrustedOfficialWebsite: false,
        officialLinkConfidence: {
          level: 'low',
          reasons: ['Website discovered primarily from Brave search without trusted metadata confirmation'],
        },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://coinmarketcap.com/currencies/pepe/',
        extractedText:
          'Pepe PEPE DeFi lending yield staking liquidity DEX secured by institutional adoption audited by leading firms',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: true,
          hasWhitepaper: true,
          hasGithub: true,
          hasAuditsMentioned: true,
          hasTeamInfo: false,
          hasClearUseCase: true,
          suspiciousPhrases: [],
          adoptionClaims: ['secured by', 'institutional'],
        },
      }),
      fetchErrors: [],
    });

    expect(report.projectProfile.category).toBe('meme');
    expect(report.score).toBeLessThanOrEqual(69);
    expect(['limited', 'weak', 'credible']).toContain(report.credibilityTier);
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(report.credibilityTier).not.toBe('strong');
    expect(report.riskLevel).not.toBe('low');
    expect(report.discoveredLinks.website).toBeNull();
    expect(report.discoveredLinks.docs).toBeNull();
    expect(report.discoveredLinks.github).toBeNull();
    expect(report.discoveredLinks.whitepaper).toBeNull();
    expect(
      report.claimChecks.every((check) => check.status !== 'supported'),
    ).toBe(true);
    expect(report.verdict.toLowerCase()).toMatch(/community|limited|review/);
    expect(report.verdict.toLowerCase()).not.toMatch(/\b(safe|scam|buy|sell|strong)\b/);
  });

  it('rejects Arkham explorer as PEPE docs', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://www.pepe.vip/',
          docs: 'https://intel.arkm.com/explorer/token/pepe',
          whitepaper: null,
          github: null,
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'dexscreener', docs: 'crawl', twitter: 'dexscreener' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'high', reasons: ['Trusted metadata website'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme community token',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        links: {
          docs: 'https://intel.arkm.com/explorer/token/pepe',
          whitepaper: null,
          github: null,
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
          tokenomics: null,
          security: null,
          audit: null,
          about: null,
        },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.docs).toBeNull();
    expect(report.projectProfile.hasDocs).toBe(false);
    expect(report.credibilityTier).not.toBe('strong');
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(report.verdict.toLowerCase()).toMatch(/community|limited/);
  });

  it('caps Brave-only discovery score and tier', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://random-project.example/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'brave' },
        braveOnlyWebsite: true,
        hasTrustedOfficialWebsite: false,
        officialLinkConfidence: {
          level: 'low',
          reasons: ['Website discovered primarily from Brave search without trusted metadata confirmation'],
        },
      }),
      crawl: null,
      fetchErrors: [],
    });

    expect(report.score).toBeLessThanOrEqual(69);
    expect(report.credibilityTier).not.toBe('strong');
    expect(report.credibilityTier).not.toBe('institutional_grade');
  });

  it('search_only mode caps score when directories exist but website is missing', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      discovery: makeDiscovery({
        discoveryMode: 'search_only',
        status: 'partial',
        discoveredLinks: {
          website: null,
          docs: null,
          whitepaper: null,
          github: null,
          twitter: 'https://twitter.com/pepecoineth',
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { twitter: 'coinmarketcap_directory' },
        trustedDirectoryUrls: ['https://coinmarketcap.com/currencies/pepe/'],
        officialLinkConfidence: { level: 'low', reasons: ['No official website discovered'] },
      }),
      crawl: null,
      fetchErrors: [],
      coinGeckoMetadata: { categories: ['Meme'] },
    });

    expect(report.discoveryMode).toBe('search_only');
    expect(report.discoveredLinks.website).toBeNull();
    expect(report.score).toBeLessThanOrEqual(64);
    expect(report.riskLevel).not.toBe('severe');
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(
      report.unknowns.some((item) => item.includes('directory presence')),
    ).toBe(true);
  });

  it('PEPE verified website scoring stays meme-limited', () => {
    const report = buildOffChainCredibilityReport(pepeLikeData());
    expect(report.discoveryMode).toBe('official_verified');
    expect(report.score).toBeGreaterThanOrEqual(45);
    expect(report.score).toBeLessThanOrEqual(69);
    expect(report.projectProfile.category).toBe('meme');
    expect(['limited', 'credible']).toContain(report.credibilityTier);
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(report.projectProfile.hasClearUseCase).toBe(false);
  });

  it('LINK scoring remains strong with verified docs', () => {
    const report = buildOffChainCredibilityReport({
      ...linkLikeData(),
      discovery: makeDiscovery({
        ...linkLikeData().discovery,
        discoveryMode: 'official_verified',
      }),
    });
    expect(report.discoveryMode).toBe('official_verified');
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(['strong', 'institutional_grade']).toContain(report.credibilityTier);
    expect(report.projectProfile.category).toBe('infrastructure');
  });

  it('keeps Chainlink infrastructure even with noisy meme metadata', () => {
    const report = buildOffChainCredibilityReport({
      ...linkLikeData(),
      discovery: makeDiscovery({
        ...linkLikeData().discovery,
        metadataCategories: ['Meme', 'Ethereum Ecosystem'],
        discoveredLinks: {
          ...linkLikeData().discovery.discoveredLinks,
          whitepaper: 'https://research.chain.link/whitepaper-v2.pdf',
          blog: 'https://blog.chain.link/',
        },
        linkSources: {
          ...linkLikeData().discovery.linkSources,
          whitepaper: 'coingecko',
          blog: 'coingecko',
        },
      }),
      coinGeckoMetadata: { categories: ['Meme'] },
      externalEvidence: externalEvidenceFixture(),
    });

    expect(report.pipelineVersion).toBe('offchain-v2-evidence');
    expect(report.projectProfile.category).toBe('infrastructure');
    expect(report.projectProfile.claimedUseCase?.toLowerCase()).toMatch(
      /oracle|data feeds|infrastructure/,
    );
    expect(report.projectProfile.hasClearUseCase).toBe(true);
    expect(report.riskFlags.some((flag) => flag.title === 'No Clear Use Case Found')).toBe(false);
    expect(report.verdict.toLowerCase()).toContain('strong');
    expect(report.verdict.toLowerCase()).not.toContain('community-driven');
  });

  it('does not classify Ethplorer or block explorers as docs', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      discovery: makeDiscovery({
        discoveryMode: 'official_verified',
        discoveredLinks: {
          website: 'https://chain.link/',
          docs: 'https://ethplorer.io/address/0x514910771af9ca656af840dff83e8264ecf986ca',
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'coingecko', docs: 'coingecko' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Website found in trusted metadata'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://chain.link/',
        extractedText: 'Chainlink LINK oracle infrastructure',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
      fetchErrors: [],
    });

    expect(report.discoveredLinks.docs).toBeNull();
    expect(report.projectProfile.hasDocs).toBe(false);
  });

  it('keeps unknown token category unknown with weak evidence', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Unknown Token',
      tokenSymbol: 'UNK',
      contractAddress: '0x0000000000000000000000000000000000000001',
      discovery: makeDiscovery({
        status: 'partial',
        discoveryMode: 'not_found',
        officialLinkConfidence: { level: 'low', reasons: ['No official website discovered'] },
      }),
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_unrelated',
            sourceType: 'unrelated',
            trustLevel: 'low',
            relevance: 'low',
            title: 'Unknown price prediction',
            snippet: 'Generic token price prediction page.',
            reason: 'Search result does not match contract, token name, symbol, or official domain.',
          },
        ],
        summary: {
          trustedDirectoryCount: 0,
          officialSourceCount: 0,
          externalValidationCount: 0,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 1,
        },
      },
      fetchErrors: [],
    });

    expect(report.projectProfile.category).toBe('unknown');
    expect(report.projectProfile.claimedUseCase).toBeNull();
    expect(report.verdict.toLowerCase()).toContain('uncertain');
  });

  it('misleading investment language applies severe penalty without scam wording', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Hype',
      tokenSymbol: 'HYPE',
      contractAddress: null,
      discovery: makeDiscovery({
        discoveredLinks: {
          website: 'https://hype.example/',
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'seed' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'medium', reasons: ['Website discovered'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://hype.example/',
        extractedText:
          'Hype HYPE offers guaranteed profit, risk-free returns, and 1000x passive income guaranteed.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: false,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
          hasClearUseCase: false,
          suspiciousPhrases: ['guaranteed profit', 'risk-free', '1000x'],
          adoptionClaims: [],
        },
      }),
      fetchErrors: [],
    });

    expect(
      report.riskFlags.some((flag) => flag.title === 'Misleading Investment Language'),
    ).toBe(true);
    expect(['high', 'severe']).toContain(report.riskLevel);
    expect(report.verdict.toLowerCase()).not.toContain('scam');
    expect(report.score).toBeLessThanOrEqual(44);
  });
});

describe('dashboard offChainCredibility integration', () => {
  const trust = new TokenTrustReportService();
  const dashboard = new DashboardSummaryService(trust);

  it('returns null when offChainCredibility missing', () => {
    const summary = dashboard.buildDashboardSummary({
      id: '1',
      contractAddress: '0x1',
      chain: 'ethereum',
      tokenName: 'Token',
      tokenSymbol: 'TOK',
      shareId: null,
      totalHolders: 0,
      holdersData: [],
      qualityMetrics: {},
      distribution: {},
      riskCallouts: [],
      status: 'done',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(summary.offChainCredibility).toBeNull();
  });

  it('includes offChainCredibility when persisted', () => {
    const report = buildOffChainCredibilityReport(linkLikeData());
    const summary = dashboard.buildDashboardSummary({
      id: '2',
      contractAddress: '0xlink',
      chain: 'ethereum',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      shareId: null,
      totalHolders: 0,
      holdersData: [],
      qualityMetrics: { offChainCredibility: report },
      distribution: {},
      riskCallouts: [],
      status: 'done',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(summary.offChainCredibility?.credibilityTier).toBeDefined();
    expect(summary.offChainCredibility?.score).toBeGreaterThanOrEqual(85);
  });
});

describe('tokenTrust modules with offChainCredibility', () => {
  const trust = new TokenTrustReportService();

  it('includes off_chain_credibility and clears missingScoreInputs when all modules exist', () => {
    const report = buildOffChainCredibilityReport(linkLikeData());
    const tokenTrust = trust.buildReport({
      id: '1',
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
        contractSafety: { status: 'done', score: 88 },
        marketContext: { status: 'done', score: 95 },
        offChainCredibility: report,
      },
      distribution: {
        decentralizationScore: 76,
        supplyConcentration: { top10Pct: 36 },
        supplyBreakdown: { retail: { pctOfSupply: 16.75 } },
      },
      riskCallouts: [],
      status: 'done',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TokenAnalysisEntity);

    const beforeScore = tokenTrust.trustScore;
    expect(tokenTrust.availableModules).toEqual(
      expect.arrayContaining([
        'holder_structure',
        'contract_safety',
        'market_context',
        'off_chain_credibility',
      ]),
    );
    expect(tokenTrust.missingScoreInputs).toEqual([]);
    expect(tokenTrust.scoreType).toBe('visible_onchain_score');
    expect(tokenTrust.scoreStatus).toBe('partial');
    expect(tokenTrust.trustScore).toBe(beforeScore);
    expect(
      tokenTrust.limitations.some((line) =>
        line.includes('Off-chain credibility is shown separately'),
      ),
    ).toBe(true);
  });
});

describe('TokenOffchainCredibilityService pipeline orchestration', () => {
  it('collects external evidence even when official website is already discovered', async () => {
    const discovery = {
      discoverOfficialLinks: jest.fn().mockResolvedValue(linkLikeData().discovery),
    } as unknown as TokenOffchainDiscoveryService;
    const webCrawler = {
      crawlOfficialWebsite: jest.fn().mockResolvedValue(linkLikeData().crawl),
    } as unknown as { crawlOfficialWebsite: jest.Mock };
    const externalEvidence = {
      collectEvidence: jest.fn().mockResolvedValue(externalEvidenceFixture()),
    } as unknown as TokenOffchainExternalEvidenceService;
    const aiClassifier = {
      classifyWithDebug: jest.fn().mockResolvedValue({
        classification: null,
        debug: {
          attempted: false,
          enabled: false,
          provider: 'anthropic',
          hasApiKey: false,
          evidenceItemCount: 0,
          skippedReason: 'OFFCHAIN_AI_CLASSIFIER_ENABLED is false',
          resultSource: 'deterministic',
        },
      }),
    } as unknown as TokenOffchainAiClassifierService;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'BRAVE_SEARCH_API_KEY') return 'test-key';
        return '';
      }),
    } as unknown as ConfigService;

    const service = new TokenOffchainCredibilityService(
      config,
      discovery,
      webCrawler as unknown as any,
      externalEvidence,
      aiClassifier,
    );

    const report = await service.buildReport({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
    });

    expect(externalEvidence.collectEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenName: 'Chainlink',
        tokenSymbol: 'LINK',
        discoveredLinks: linkLikeData().discovery.discoveredLinks,
      }),
    );
    expect(report.externalEvidence?.status).toBe('done');
    expect(report.projectProfile.category).toBe('infrastructure');
    expect(report.aiClassifierDebug?.resultSource).toBe('deterministic');
  });

  it('applies valid AI classifier result from the service call', async () => {
    const discovery = {
      discoverOfficialLinks: jest.fn().mockResolvedValue(linkLikeData().discovery),
    } as unknown as TokenOffchainDiscoveryService;
    const webCrawler = {
      crawlOfficialWebsite: jest.fn().mockResolvedValue(linkLikeData().crawl),
    } as unknown as { crawlOfficialWebsite: jest.Mock };
    const externalEvidence = {
      collectEvidence: jest.fn().mockResolvedValue(externalEvidenceFixture()),
    } as unknown as TokenOffchainExternalEvidenceService;
    const aiClassifier = {
      classifyWithDebug: jest.fn().mockResolvedValue({
        classification: aiClassification(),
        debug: {
          attempted: true,
          enabled: true,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          hasApiKey: true,
          evidenceItemCount: 2,
          resultSource: 'ai',
        },
      }),
    } as unknown as TokenOffchainAiClassifierService;
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;

    const service = new TokenOffchainCredibilityService(
      config,
      discovery,
      webCrawler as unknown as any,
      externalEvidence,
      aiClassifier,
    );

    const report = await service.buildReport({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
    });

    expect(report.projectUnderstanding?.source).toBe('ai');
    expect(report.aiClassifierDebug?.resultSource).toBe('ai');
    expect(report.projectProfile.category).toBe('infrastructure');
  });
});

describe('TokenOffchainAiClassifierService', () => {
  function makeAiConfig(): ConfigService {
    return {
      get: jest.fn((key: string) => {
        if (key === 'OFFCHAIN_AI_CLASSIFIER_ENABLED') return 'true';
        if (key === 'ANTHROPIC_API_KEY') return 'test-key';
        return '';
      }),
    } as unknown as ConfigService;
  }

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

  it('uses valid AI classification in the off-chain report', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      discovery: makeDiscovery({
        status: 'partial',
        discoveryMode: 'search_only',
        officialLinkConfidence: { level: 'low', reasons: ['No official website discovered'] },
      }),
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_floyx_social',
            sourceType: 'news',
            trustLevel: 'medium',
            relevance: 'medium',
            title: 'FLOYX Web3 social media platform',
            snippet: 'Third-party snippet describes FLOYX as a possible Web3 social media platform.',
            matchedTokenName: true,
            reason: 'Search result matched token name.',
          },
        ],
        summary: {
          trustedDirectoryCount: 0,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
      aiClassification: aiClassification({
        categoryLabel: 'Possible SocialFi / Web3 social platform',
        normalizedCategory: 'socialfi',
        categoryConfidence: 'low',
        claimedUseCase: 'Possible Web3/SocialFi social media platform',
        useCaseConfidence: 'low',
        identityStatus: 'unverified',
        evidenceQuality: 'limited',
        possibleNarrative:
          'Possible Web3/SocialFi social media platform based on third-party snippets',
        hasClearUseCase: false,
        evidenceRefs: ['ev_floyx_social'],
      }),
      fetchErrors: [],
    });

    expect(report.projectUnderstanding?.source).toBe('ai');
    expect(report.projectUnderstanding?.category).toBe('socialfi');
    expect(report.projectUnderstanding?.categoryConfidence).toBe('low');
    expect(report.projectProfile.category).toBe('other');
    expect(report.projectProfile.hasClearUseCase).toBe(false);
  });

  it('returns null so deterministic fallback can run when AI JSON is invalid', async () => {
    const service = new TokenOffchainAiClassifierService(makeAiConfig());
    jest.spyOn(service as any, 'callClaude').mockRejectedValue(new Error('Unexpected token'));

    const result = await service.classifyWithDebug({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
      discoveredLinks: linkLikeData().discovery.discoveredLinks,
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: linkLikeData().crawl,
      externalEvidence: externalEvidenceFixture(),
    });

    expect(result.classification).toBeNull();
    expect(result.debug.attempted).toBe(true);
    expect(result.debug.resultSource).toBe('deterministic');
    expect(result.debug.failureReason).toContain('Unexpected token');
  });

  it('skips cleanly when AI classifier is disabled', async () => {
    const service = new TokenOffchainAiClassifierService({
      get: jest.fn(() => ''),
    } as unknown as ConfigService);

    const result = await service.classifyWithDebug({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
      discoveredLinks: linkLikeData().discovery.discoveredLinks,
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: linkLikeData().crawl,
      externalEvidence: externalEvidenceFixture(),
    });

    expect(result.classification).toBeNull();
    expect(result.debug.enabled).toBe(false);
    expect(result.debug.attempted).toBe(false);
    expect(result.debug.skippedReason).toContain('OFFCHAIN_AI_CLASSIFIER_ENABLED');
  });

  it('downgrades high-confidence AI output when website is missing and discovery is search-only', async () => {
    const service = new TokenOffchainAiClassifierService(makeAiConfig());
    jest.spyOn(service as any, 'callClaude').mockResolvedValue({
      ...aiClassification(),
      evidenceRefs: ['ev_floyx_social'],
    });

    const result = await service.classify({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: makeDiscovery().discoveredLinks,
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_floyx_social',
            sourceType: 'news',
            trustLevel: 'medium',
            relevance: 'medium',
            title: 'FLOYX Web3 social media platform',
            snippet: 'FLOYX Web3 social media platform with token generation and smart contracts.',
            matchedTokenName: true,
            reason: 'Search result matched token name.',
          },
        ],
        summary: {
          trustedDirectoryCount: 0,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
    });

    expect(result?.categoryConfidence).toBe('low');
    expect(result?.normalizedCategory).toBe('unknown');
    expect(result?.hasClearUseCase).toBe(false);
  });

  it('does not allow PEPE to become DeFi from trading/listing evidence only', async () => {
    const service = new TokenOffchainAiClassifierService(makeAiConfig());
    jest.spyOn(service as any, 'callClaude').mockResolvedValue({
      ...aiClassification({
        categoryLabel: 'DeFi token',
        normalizedCategory: 'defi',
        claimedUseCase: 'DeFi trading token',
        evidenceRefs: ['ev_pepe_market'],
      }),
    });

    const result = await service.classify({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      chain: 'ethereum',
      discoveredLinks: pepeLikeData().discovery.discoveredLinks,
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'medium',
      crawl: pepeLikeData().crawl,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_pepe_market',
            sourceType: 'trusted_directory',
            trustLevel: 'medium',
            relevance: 'high',
            title: 'PEPE price and liquidity',
            snippet: 'CoinGecko and Uniswap trading liquidity page for PEPE.',
            matchedContractAddress: true,
            reason: 'Trusted directory market listing.',
          },
        ],
        summary: {
          trustedDirectoryCount: 1,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
    });

    expect(result?.normalizedCategory).not.toBe('defi');
    expect(result?.categoryConfidence).toBe('low');
  });

  it('keeps Chainlink infrastructure from valid mocked Claude classification', async () => {
    const service = new TokenOffchainAiClassifierService(makeAiConfig());
    jest.spyOn(service as any, 'callClaude').mockResolvedValue(aiClassification());

    const result = await service.classify({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
      discoveredLinks: linkLikeData().discovery.discoveredLinks,
      websiteSource: 'coingecko',
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: linkLikeData().crawl,
      externalEvidence: externalEvidenceFixture(),
    });

    expect(result?.normalizedCategory).toBe('infrastructure');
    expect(result?.categoryConfidence).toBe('high');
    expect(result?.hasClearUseCase).toBe(true);
  });

  it('uses Gemini provider valid mocked JSON', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'callGemini').mockResolvedValue(
      aiClassification({
        categoryLabel: 'Possible SocialFi / Web3 social platform',
        normalizedCategory: 'socialfi',
        categoryConfidence: 'low',
        claimedUseCase: 'Possible Web3/SocialFi social media platform',
        useCaseConfidence: 'low',
        identityStatus: 'unverified',
        evidenceQuality: 'limited',
        possibleNarrative:
          'Possible Web3/SocialFi social media platform based on third-party snippets',
        hasClearUseCase: false,
        evidenceRefs: ['ev_floyx_social'],
      }),
    );

    const result = await service.classifyWithDebug({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: makeDiscovery().discoveredLinks,
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_floyx_social',
            sourceType: 'news',
            trustLevel: 'medium',
            relevance: 'medium',
            title: 'FLOYX Web3 social media platform',
            snippet: 'Third-party snippet describes FLOYX as a Web3 social media platform.',
            matchedTokenName: true,
            reason: 'Search result matched token name.',
          },
        ],
        summary: {
          trustedDirectoryCount: 0,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
    });

    expect(result.debug.provider).toBe('gemini');
    expect(result.debug.model).toBe('gemini-2.5-flash-lite');
    expect(result.debug.resultSource).toBe('ai');
    expect(result.classification?.normalizedCategory).toBe('socialfi');
    expect(result.classification?.categoryConfidence).toBe('low');
  });

  it('parses Gemini JSON wrapped in markdown code fence', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'generateGeminiText').mockResolvedValue(
      `\`\`\`json
{
  "source": "ai",
  "categoryLabel": "Tokenized real-world assets / institutional on-chain finance",
  "normalizedCategory": "rwa",
  "categoryConfidence": "high",
  "claimedUseCase": "Tokenized real-world assets and institutional-grade on-chain finance",
  "useCaseConfidence": "high",
  "identityStatus": "verified",
  "evidenceQuality": "strong",
  "possibleNarrative": null,
  "hasClearUseCase": true,
  "reasoning": "Official docs and third-party evidence describe RWA finance.",
  "evidenceRefs": ["ev_ondo_docs"],
  "warnings": []
}
\`\`\``,
    );

    const result = await service.classifyWithDebug({
      tokenName: 'Ondo',
      tokenSymbol: 'ONDO',
      contractAddress: '0xondo',
      chain: 'ethereum',
      discoveredLinks: {
        ...makeDiscovery().discoveredLinks,
        website: 'https://ondo.foundation/',
        docs: 'https://docs.ondo.foundation/ondo-token',
      },
      discoveryMode: 'official_verified',
      officialLinkConfidence: 'high',
      crawl: null,
      externalEvidence: ondoEvidenceFixture(),
    });

    expect(result.classification?.normalizedCategory).toBe('rwa');
    expect(result.debug.resultSource).toBe('ai');
  });

  it('parses Gemini JSON with extra text around the object', async () => {
    const parsed = parseAiClassifierJsonResponse(
      `Here is the classification:
      {
        "source": "ai",
        "categoryLabel": "Meme/community token",
        "normalizedCategory": "meme",
        "categoryConfidence": "medium",
        "claimedUseCase": null,
        "useCaseConfidence": "low",
        "identityStatus": "verified",
        "evidenceQuality": "moderate",
        "possibleNarrative": null,
        "hasClearUseCase": false,
        "reasoning": "Provided evidence positions the project as meme/community.",
        "evidenceRefs": ["ev_pepe"],
        "warnings": [],
      }
      Done.`,
    );

    expect(parsed.normalizedCategory).toBe('meme');
  });

  it('falls back when Gemini returns invalid JSON', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest.spyOn(service as any, 'callGemini').mockRejectedValue(new Error('Unexpected token'));

    const result = await service.classifyWithDebug({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: makeDiscovery().discoveredLinks,
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: externalEvidenceFixture(),
    });

    expect(result.classification).toBeNull();
    expect(result.debug.provider).toBe('gemini');
    expect(result.debug.resultSource).toBe('deterministic');
    expect(result.debug.failureReason).toContain('Unexpected token');
  });

  it('falls back when Gemini quota or rate limit fails', async () => {
    const service = new TokenOffchainAiClassifierService(makeGeminiConfig());
    jest
      .spyOn(service as any, 'callGemini')
      .mockRejectedValue(new Error('429 Too Many Requests: exceeded your current quota'));

    const result = await service.classifyWithDebug({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      chain: 'ethereum',
      discoveredLinks: makeDiscovery().discoveredLinks,
      discoveryMode: 'search_only',
      officialLinkConfidence: 'low',
      crawl: null,
      externalEvidence: externalEvidenceFixture(),
    });

    expect(result.classification).toBeNull();
    expect(result.debug.failureReason).toContain('quota');
    expect(result.debug.resultSource).toBe('deterministic');
  });

  it('deterministic fallback is conservative for FLOYX-style search-only evidence', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'FLOYX',
      tokenSymbol: 'FLOYX',
      contractAddress: '0xf10yx00000000000000000000000000000000000',
      discovery: makeDiscovery({
        status: 'partial',
        discoveryMode: 'search_only',
        officialLinkConfidence: { level: 'low', reasons: ['No official website discovered'] },
      }),
      crawl: null,
      externalEvidence: {
        status: 'done',
        evidenceItems: [
          {
            id: 'ev_floyx_generic',
            sourceType: 'news',
            trustLevel: 'medium',
            relevance: 'medium',
            title: 'FLOYX Web3 social media platform',
            snippet:
              'Third-party snippet mentions Web3, smart contracts, platform, token generation, and decentralized social media.',
            matchedTokenName: true,
            reason: 'Search result matched token name.',
          },
        ],
        summary: {
          trustedDirectoryCount: 0,
          officialSourceCount: 0,
          externalValidationCount: 1,
          riskWarningCount: 0,
          scamWarningCount: 0,
          unrelatedCount: 0,
        },
      },
      fetchErrors: [],
    });

    expect(report.projectUnderstanding?.source).toBe('deterministic');
    expect(report.projectProfile.category).not.toBe('infrastructure');
    expect(report.projectProfile.category).toBe('unknown');
    expect(report.projectProfile.hasClearUseCase).toBe(false);
  });

  it('ONDO deterministic fallback classifies RWA/institutional finance instead of infrastructure', () => {
    const report = buildOffChainCredibilityReport({
      tokenName: 'Ondo',
      tokenSymbol: 'ONDO',
      contractAddress: '0xfab86f8a2d1d0d04',
      discovery: makeDiscovery({
        discoveryMode: 'official_verified',
        discoveredLinks: {
          website: 'https://ondo.foundation/',
          docs: 'https://docs.ondo.foundation/ondo-token',
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        linkSources: { website: 'coingecko', docs: 'coingecko' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: { level: 'high', reasons: ['Website found in trusted metadata'] },
      }),
      crawl: makeCrawl({
        homepageUrl: 'https://ondo.foundation/',
        finalUrl: 'https://ondo.foundation/',
        extractedText:
          'Ondo ONDO is the governance token for Ondo DAO and Flux Finance. ' +
          'Ondo focuses on tokenized real-world assets and institutional-grade on-chain finance.',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        signals: {
          hasDocs: true,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
          hasClearUseCase: true,
          suspiciousPhrases: [],
          adoptionClaims: [],
        },
      }),
      externalEvidence: ondoEvidenceFixture(),
      fetchErrors: [],
    });

    expect(report.projectProfile.category).toBe('rwa');
    expect(report.projectUnderstanding?.category).toBe('rwa');
    expect(report.projectProfile.claimedUseCase).toBe(
      'Tokenized real-world assets and institutional-grade on-chain finance',
    );
    expect(report.projectProfile.hasClearUseCase).toBe(true);
    expect(report.projectProfile.category).not.toBe('infrastructure');
  });
});
