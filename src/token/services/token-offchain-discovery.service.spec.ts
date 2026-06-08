import { ConfigService } from '@nestjs/config';
import * as discoveryModule from './token-offchain-discovery.service';
import {
  extractCoinGeckoLinks,
  resolveOfficialLinkConfidence,
  shouldUseBraveFallback,
  TokenOffchainDiscoveryService,
} from './token-offchain-discovery.service';
import {
  TokenWebCrawlerService,
  type TokenWebsiteCrawlResult,
} from './token-web-crawler.service';

function makeCrawlResult(
  overrides: Partial<TokenWebsiteCrawlResult> = {},
): TokenWebsiteCrawlResult {
  return {
    status: 'done',
    homepageUrl: 'https://chain.link',
    finalUrl: 'https://chain.link',
    pagesVisited: ['https://chain.link'],
    brokenWebsite: false,
    extractedText: 'Chainlink LINK oracle infrastructure protocol',
    links: {
      docs: 'https://docs.chain.link',
      whitepaper: null,
      github: 'https://github.com/smartcontractkit/chainlink',
      twitter: 'https://twitter.com/chainlink',
      telegram: null,
      discord: null,
      blog: null,
      tokenomics: null,
      security: null,
      audit: null,
      about: null,
    },
    mentions: {
      tokenName: true,
      tokenSymbol: true,
      contractAddress: false,
    },
    signals: {
      hasDocs: true,
      hasWhitepaper: false,
      hasGithub: true,
      hasAuditsMentioned: false,
      hasTeamInfo: true,
      hasClearUseCase: true,
      suspiciousPhrases: [],
      adoptionClaims: ['ecosystem'],
    },
    errors: [],
    ...overrides,
  };
}

describe('TokenOffchainDiscoveryService metadata extraction', () => {
  it('shouldUseBraveFallback is false when trusted metadata is complete', () => {
    expect(
      shouldUseBraveFallback({
        website: 'https://chain.link/',
        docs: 'https://docs.chain.link/',
        whitepaper: null,
        github: 'https://github.com/smartcontractkit/chainlink',
        twitter: 'https://twitter.com/chainlink',
        telegram: null,
        discord: null,
        blog: null,
      }),
    ).toBe(false);
  });

  it('extracts CoinGecko links', () => {
    const links = extractCoinGeckoLinks({
      links: {
        homepage: ['https://chain.link', 'https://docs.chain.link'],
        twitter_screen_name: 'chainlink',
        repos_url: {
          github: ['https://github.com/smartcontractkit/chainlink'],
        },
      },
    });

    expect(links.website).toBe('https://chain.link/');
    expect(links.docs).toBe('https://docs.chain.link/');
    expect(links.github).toContain('github.com');
    expect(links.twitter).toContain('chainlink');
  });
});

function makeCrawler(): TokenWebCrawlerService {
  const config = { get: jest.fn(() => '') } as unknown as ConfigService;
  return new TokenWebCrawlerService(config);
}

function makeDiscoveryService(
  configValues: Record<string, string> = {},
): TokenOffchainDiscoveryService {
  const config = {
    get: jest.fn((key: string) => configValues[key] ?? ''),
  } as unknown as ConfigService;
  return new TokenOffchainDiscoveryService(config, makeCrawler());
}

describe('TokenOffchainDiscoveryService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses seed/CoinGecko metadata before Brave', async () => {
    const service = makeDiscoveryService();
    const braveSpy = jest.spyOn(service as any, 'discoverWithBrave');
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(makeCrawlResult());

    const result = await service.discoverOfficialLinks({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      seedLinks: {
        website: 'https://chain.link',
        docs: 'https://docs.chain.link',
      },
      coinGeckoMetadata: {
        links: {
          homepage: ['https://chain.link'],
          twitter_screen_name: 'chainlink',
        },
      },
    });

    expect(result.discoveredLinks.website).toContain('chain.link');
    expect(['medium', 'high']).toContain(result.officialLinkConfidence.level);
    expect(braveSpy).not.toHaveBeenCalled();
  });

  it('uses Brave fallback when website missing', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });

    const braveSpy = jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: {
        website: 'https://www.pepe.vip/',
        docs: null,
        whitepaper: null,
        github: null,
        twitter: 'https://twitter.com/pepecoineth',
        telegram: null,
        discord: null,
        blog: null,
      },
      errors: [],
    });

    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult({
        homepageUrl: 'https://www.pepe.vip/',
        finalUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme token',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
        links: {
          docs: null,
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
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
    });

    expect(braveSpy).toHaveBeenCalled();
    expect(result.discoveredLinks.website).toContain('pepe.vip');
    expect(result.officialLinkConfidence.level).toBe('medium');
  });

  it('missing BRAVE_SEARCH_API_KEY does not throw', async () => {
    const service = makeDiscoveryService();

    const result = await service.discoverOfficialLinks({
      tokenName: 'Unknown',
      tokenSymbol: 'UNK',
    });

    expect(['partial', 'unknown']).toContain(result.status);
    expect(result.errors.some((error) => error.includes('BRAVE_SEARCH_API_KEY'))).toBe(true);
  });

  it('website mismatch downgrades confidence', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult({
        extractedText: 'Unrelated shopping website content only',
        mentions: { tokenName: false, tokenSymbol: false, contractAddress: false },
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
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      seedLinks: { website: 'https://chain.link' },
    });

    expect(result.officialLinkConfidence.level).toBe('medium');
    expect(
      result.officialLinkConfidence.reasons.some((reason) =>
        reason.toLowerCase().includes('could not be fully verified'),
      ),
    ).toBe(true);
  });

  it('LINK-like discovery returns high confidence with website and docs', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(makeCrawlResult());

    const result = await service.discoverOfficialLinks({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af558dff21e3962aa028f2ae',
      seedLinks: {
        website: 'https://chain.link',
        docs: 'https://docs.chain.link',
      },
      coinGeckoMetadata: {
        links: {
          homepage: ['https://chain.link'],
          twitter_screen_name: 'chainlink',
          repos_url: { github: ['https://github.com/smartcontractkit/chainlink'] },
        },
      },
    });

    expect(result.discoveredLinks.website).toContain('chain.link');
    expect(result.discoveredLinks.docs).toContain('docs.chain.link');
    expect(result.officialLinkConfidence.level).toBe('high');
  });

  it('PEPE-like discovery returns medium/high without requiring docs/github', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(discoveryModule, 'searchBraveWeb').mockResolvedValue({
      hits: [],
      error: null,
      rateLimited: false,
      timedOut: false,
    });
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult({
        homepageUrl: 'https://www.pepe.vip/',
        finalUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme token community',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
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
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      seedLinks: {
        website: 'https://www.pepe.vip/',
        twitter: 'https://twitter.com/pepecoineth',
        telegram: 'https://t.me/pepecoineth',
      },
      dexScreenerProfile: {
        info: {
          websites: ['https://www.pepe.vip/'],
          socials: [{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }],
        },
      },
    });

    expect(result.discoveredLinks.website).toContain('pepe.vip');
    expect(result.discoveredLinks.docs).toBeNull();
    expect(result.discoveredLinks.github).toBeNull();
    expect(['medium', 'high']).toContain(result.officialLinkConfidence.level);
  });

  it('passes DexScreener and CoinGecko metadata without calling Brave', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    const braveSpy = jest.spyOn(service as any, 'discoverWithBrave');
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult(),
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      coinGeckoMetadata: {
        links: {
          homepage: ['https://chain.link'],
          twitter_screen_name: 'chainlink',
          repos_url: { github: ['https://github.com/smartcontractkit/chainlink'] },
        },
      },
      dexScreenerProfile: {
        info: {
          websites: ['https://chain.link'],
          socials: [{ type: 'twitter', url: 'https://twitter.com/chainlink' }],
        },
      },
      bypassCache: true,
    });

    expect(result.discoveredLinks.website).toContain('chain.link');
    expect(braveSpy).not.toHaveBeenCalled();
  });

  it('does not call Brave when OFFCHAIN_BRAVE_ENABLED=false', async () => {
    const service = makeDiscoveryService({
      OFFCHAIN_BRAVE_ENABLED: 'false',
      BRAVE_SEARCH_API_KEY: 'test-key',
    });
    const braveSpy = jest.spyOn(discoveryModule, 'searchBraveWeb');

    const result = await service.discoverOfficialLinks({
      tokenName: 'Unknown',
      tokenSymbol: 'UNK',
      bypassCache: true,
    });

    expect(braveSpy).not.toHaveBeenCalled();
    expect(result.errors.some((error) => error.includes('Brave search fallback disabled'))).toBe(
      true,
    );
  });

  it('handles Brave 429 without throwing', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: {
        website: null,
        docs: null,
        whitepaper: null,
        github: null,
        twitter: null,
        telegram: null,
        discord: null,
        blog: null,
      },
      errors: ['Brave Search rate limit reached'],
    });

    const result = await service.discoverOfficialLinks({
      tokenName: 'Unknown',
      tokenSymbol: 'UNK',
      bypassCache: true,
    });

    expect(result.errors.some((error) => error.includes('rate limit'))).toBe(true);
    expect(['partial', 'unknown']).toContain(result.status);
  });

  it('reuses discovery cache for repeated requests', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(makeCrawlResult());

    const input = {
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0xlink',
      chain: 'ethereum',
      coinGeckoMetadata: {
        links: {
          homepage: ['https://chain.link'],
          twitter_screen_name: 'chainlink',
        },
      },
    };

    const first = await service.discoverOfficialLinks(input);
    const second = await service.discoverOfficialLinks(input);

    expect(first.discoveredLinks.website).toContain('chain.link');
    expect(second.discoveredLinks.website).toBe(first.discoveredLinks.website);
    expect(service['webCrawler'].crawlOfficialWebsite).toHaveBeenCalledTimes(1);
  });
});

describe('searchBraveWeb', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns rate limit response on HTTP 429 without throwing', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 429,
      ok: false,
    } as Response);

    const response = await discoveryModule.searchBraveWeb('test-key', 'Pepe official website', 1000);

    expect(fetchMock).toHaveBeenCalled();
    expect(response.rateLimited).toBe(true);
    expect(response.error).toContain('rate limit');
    expect(response.hits).toEqual([]);
  });
});

describe('resolveOfficialLinkConfidence', () => {
  it('returns low when Brave-only website is not verified', () => {
    const confidence = resolveOfficialLinkConfidence({
      discoveredLinks: {
        website: 'https://random.example',
        docs: null,
        whitepaper: null,
        github: null,
        twitter: null,
        telegram: null,
        discord: null,
        blog: null,
      },
      provenance: { website: 'brave' },
      crawlResult: makeCrawlResult({
        mentions: { tokenName: false, tokenSymbol: false, contractAddress: false },
      }),
      braveUsed: true,
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: null,
    });

    expect(confidence.level).toBe('low');
    expect(confidence.reasons.join(' ').toLowerCase()).toMatch(/brave|verify|mention/);
  });
});
