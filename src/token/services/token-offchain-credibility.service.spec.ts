import { DashboardSummaryService } from './dashboard-summary.service';
import {
  buildOffChainCredibilityReport,
  type OffChainCredibilityCollectedData,
} from './token-offchain-credibility.service';
import type { OffchainDiscoveryResult } from './token-offchain-discovery.service';
import type { TokenWebsiteCrawlResult } from './token-web-crawler.service';
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
