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

function emptyBraveLinks() {
  return {
    website: null,
    docs: null,
    whitepaper: null,
    github: null,
    twitter: null,
    telegram: null,
    discord: null,
    blog: null,
  };
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
      links: emptyBraveLinks(),
      directoryCandidates: [],
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
    expect(result.discoveredLinks.website).toBeNull();
    expect(result.braveOnlyWebsite).toBe(false);
    expect(result.officialLinkConfidence.level).toBe('low');
  });

  it('missing BRAVE_SEARCH_API_KEY does not throw', async () => {
    const service = makeDiscoveryService();

    const result = await service.discoverOfficialLinks({
      tokenName: 'Unknown',
      tokenSymbol: 'UNK',
    });

    expect(['partial', 'unknown']).toContain(result.status);
    expect(result.errors.some((error) => error.toLowerCase().includes('brave search api key'))).toBe(
      true,
    );
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
      links: emptyBraveLinks(),
      directoryCandidates: [],
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

  it('extracts pepe.vip from trusted directory page instead of using directory URL', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: emptyBraveLinks(),
      directoryCandidates: ['https://coinmarketcap.com/currencies/pepe/'],
      errors: [],
    });
    jest.spyOn(service['webCrawler'], 'fetchPageContent').mockResolvedValue({
      html: `
        <html><body>
          <h1>Pepe (PEPE)</h1>
          <p>${'0x6982508145454ce325ddbe47a25d4ec3d2311933'}</p>
          <a href="https://www.pepe.vip/">Website</a>
          <a href="https://twitter.com/pepecoineth">Twitter</a>
        </body></html>
      `,
      finalUrl: 'https://coinmarketcap.com/currencies/pepe/',
      method: 'fetch',
    });
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue({
      status: 'done',
      homepageUrl: 'https://www.pepe.vip/',
      finalUrl: 'https://www.pepe.vip/',
      pagesVisited: ['https://www.pepe.vip/'],
      brokenWebsite: false,
      extractedText: 'Pepe PEPE meme community',
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
      errors: [],
    });

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      bypassCache: true,
    });

    expect(result.discoveredLinks.website).toContain('pepe.vip');
    expect(result.discoveredLinks.website).not.toContain('coinmarketcap.com');
    expect(['medium', 'high']).toContain(result.officialLinkConfidence.level);
    expect(result.linkSources.website).toBe('coinmarketcap_directory');
    expect(result.discoveryMode).toBe('directory_verified');
  });

  it('rejects CoinMarketCap as official website from Brave', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: emptyBraveLinks(),
      directoryCandidates: ['https://coinmarketcap.com/currencies/pepe/'],
      errors: [],
    });
    jest.spyOn(service['webCrawler'], 'fetchPageContent').mockResolvedValue(null);

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      bypassCache: true,
    });

    expect(result.discoveredLinks.website).toBeNull();
    expect(result.discoveredLinks.docs).toBeNull();
    expect(result.discoveredLinks.github).toBeNull();
    expect(result.discoveredLinks.whitepaper).toBeNull();
    expect(result.aggregatorWebsiteRejected).toBe(true);
    expect(result.sourceUrls.some((url) => url.includes('coinmarketcap.com'))).toBe(true);
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

describe('two-lane discovery modes', () => {
  const PEPE_CONTRACT = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('selects pepe.vip from CoinGecko contract metadata without Brave', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    const braveSpy = jest.spyOn(service as any, 'discoverWithBrave');
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult({
        homepageUrl: 'https://www.pepe.vip/',
        finalUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme community',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: PEPE_CONTRACT,
      coinGeckoMetadata: {
        id: 'pepe',
        categories: ['Meme'],
        platforms: { ethereum: PEPE_CONTRACT },
        links: {
          homepage: ['https://www.pepe.vip/'],
          twitter_screen_name: 'pepecoineth',
        },
      },
      bypassCache: true,
      debug: true,
    });

    expect(result.discoveredLinks.website).toContain('pepe.vip');
    expect(result.linkSources.website).toBe('coingecko');
    expect(result.discoveryMode).toBe('official_verified');
    expect(braveSpy).not.toHaveBeenCalled();
    expect(result.debugTrace?.structuredMetadata.coinGeckoContractMatched).toBe(true);
  });

  it('selects pepe.vip from DexScreener metadata', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(
      makeCrawlResult({
        homepageUrl: 'https://www.pepe.vip/',
        finalUrl: 'https://www.pepe.vip/',
        extractedText: 'Pepe PEPE meme',
        mentions: { tokenName: true, tokenSymbol: true, contractAddress: false },
      }),
    );

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: PEPE_CONTRACT,
      dexScreenerProfile: {
        info: {
          websites: ['https://www.pepe.vip/'],
          socials: [{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }],
        },
      },
      bypassCache: true,
    });

    expect(result.discoveredLinks.website).toContain('pepe.vip');
    expect(result.linkSources.website).toBe('dexscreener');
    expect(result.discoveryMode).toBe('official_verified');
  });

  it('rejects pepeunchained.com clone candidates', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: {
        ...emptyBraveLinks(),
        website: 'https://pepeunchained.com/',
      },
      directoryCandidates: [],
      errors: [],
    });

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: PEPE_CONTRACT,
      bypassCache: true,
      debug: true,
    });

    expect(result.discoveredLinks.website).toBeNull();
    expect(
      result.debugTrace?.candidates.some(
        (candidate) =>
          candidate.url.includes('pepeunchained') &&
          candidate.action === 'rejected' &&
          candidate.reason === 'cross_project_or_clone',
      ),
    ).toBe(true);
  });

  it('enters search_only when trusted directories exist but website is missing', async () => {
    const service = makeDiscoveryService({ BRAVE_SEARCH_API_KEY: 'test-key' });
    jest.spyOn(service as any, 'discoverWithBrave').mockResolvedValue({
      links: emptyBraveLinks(),
      directoryCandidates: ['https://coinmarketcap.com/currencies/pepe/'],
      errors: [],
    });
    jest.spyOn(service['webCrawler'], 'fetchPageContent').mockResolvedValue({
      html: `<html><body><h1>Pepe (PEPE)</h1><p>${PEPE_CONTRACT}</p></body></html>`,
      finalUrl: 'https://coinmarketcap.com/currencies/pepe/',
      method: 'fetch',
    });

    const result = await service.discoverOfficialLinks({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: PEPE_CONTRACT,
      bypassCache: true,
    });

    expect(result.discoveryMode).toBe('search_only');
    expect(result.discoveredLinks.website).toBeNull();
    expect(result.trustedDirectoryUrls.length).toBeGreaterThan(0);
  });

  it('debug trace includes structured metadata and final selection without secrets', async () => {
    const service = makeDiscoveryService();
    jest.spyOn(service['webCrawler'], 'crawlOfficialWebsite').mockResolvedValue(makeCrawlResult());

    const result = await service.discoverOfficialLinks({
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      seedLinks: { website: 'https://chain.link' },
      bypassCache: true,
      debug: true,
    });

    const traceJson = JSON.stringify(result.debugTrace ?? {});
    expect(result.debugTrace?.candidates.length).toBeGreaterThan(0);
    expect(result.debugTrace?.finalSelection.website).toContain('chain.link');
    expect(traceJson.toLowerCase()).not.toMatch(/api[_-]?key|subscription-token|bearer/);
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
