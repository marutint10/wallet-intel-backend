import { ConfigService } from '@nestjs/config';
import {
  TokenWebCrawlerService,
  analyzeSignals,
  detectMentions,
  extractLinksFromHtml,
  extractVisibleText,
  isSafeCrawlUrl,
  MAX_CRAWL_PAGES,
} from './token-web-crawler.service';

const SAMPLE_HTML = `
<html>
  <body>
    <h1>Chainlink</h1>
    <p>LINK is decentralized oracle infrastructure protocol securing data feeds for DeFi.</p>
    <a href="https://chain.link/docs">Documentation</a>
    <a href="https://github.com/smartcontractkit/chainlink">GitHub</a>
    <a href="https://twitter.com/chainlink">Twitter</a>
    <a href="https://chain.link/whitepaper.pdf">Whitepaper</a>
    <a href="https://chain.link/security">Security</a>
    <p>Audit reports are published for review.</p>
    <p>Our team and company leadership support ecosystem integrations.</p>
  </body>
</html>
`;

describe('TokenWebCrawlerService helpers', () => {
  it('extracts links and signals from normal HTML', () => {
    const links = extractLinksFromHtml(SAMPLE_HTML, 'https://chain.link');
    expect(links.docs).toContain('chain.link/docs');
    expect(links.github).toContain('github.com');
    expect(links.twitter).toContain('twitter.com');
    expect(links.whitepaper).toContain('whitepaper');
    expect(links.security).toContain('/security');

    const text = extractVisibleText(SAMPLE_HTML);
    const signals = analyzeSignals(text, links);
    expect(signals.hasDocs).toBe(true);
    expect(signals.hasGithub).toBe(true);
    expect(signals.hasWhitepaper).toBe(true);
    expect(signals.hasAuditsMentioned).toBe(true);
    expect(signals.hasTeamInfo).toBe(true);
    expect(signals.hasClearUseCase).toBe(true);

    const mentions = detectMentions(text, {
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      contractAddress: '0x514910771af9ca656af558dff21e3962aa028f2ae',
    });
    expect(mentions.tokenName).toBe(true);
    expect(mentions.tokenSymbol).toBe(true);
  });

  it('detects suspicious phrases', () => {
    const html = `
      <html><body>
        <p>Join now for guaranteed profit and risk-free 1000x passive income guaranteed.</p>
      </body></html>
    `;
    const text = extractVisibleText(html);
    const signals = analyzeSignals(text, extractLinksFromHtml(html, 'https://example.com'));

    expect(signals.suspiciousPhrases).toEqual(
      expect.arrayContaining(['guaranteed profit', 'risk-free', '1000x']),
    );
  });

  it('rejects unsafe URLs', () => {
    expect(isSafeCrawlUrl('http://localhost/token')).toBe(false);
    expect(isSafeCrawlUrl('https://127.0.0.1/token')).toBe(false);
    expect(isSafeCrawlUrl('https://192.168.1.10/token')).toBe(false);
    expect(isSafeCrawlUrl('https://10.0.0.5/token')).toBe(false);
    expect(isSafeCrawlUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeCrawlUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeCrawlUrl('https://chain.link')).toBe(true);
  });
});

function makeCrawler(configValues: Record<string, string> = {}): TokenWebCrawlerService {
  const config = {
    get: jest.fn((key: string) => configValues[key] ?? ''),
  } as unknown as ConfigService;
  return new TokenWebCrawlerService(config);
}

describe('TokenWebCrawlerService crawlOfficialWebsite', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('handles broken website with partial/error and brokenWebsite true', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const service = makeCrawler();
    const result = await service.crawlOfficialWebsite({
      websiteUrl: 'https://broken.example',
      tokenName: 'Broken',
      tokenSymbol: 'BRK',
    });

    expect(['partial', 'error']).toContain(result.status);
    expect(result.brokenWebsite).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('does not crawl more than 5 pages', async () => {
    const homepage = `
      <html><body>
        <h1>Many Links Token</h1>
        <a href="https://many.example/docs">Docs</a>
        <a href="https://many.example/tokenomics">Tokenomics</a>
        <a href="https://many.example/about">About</a>
        <a href="https://many.example/security">Security</a>
        <a href="https://many.example/audit">Audit</a>
        <a href="https://many.example/blog">Blog</a>
        <a href="https://many.example/team">Team</a>
      </body></html>
    `;
    const subpage = '<html><body><p>Subpage content with enough text to be useful for extraction and analysis in tests.</p></body></html>';

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        status: 200,
        url,
        headers: {
          get: () => 'text/html',
        },
        text: async () => (url.includes('/docs') || url.includes('/tokenomics') ? subpage : homepage),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const service = makeCrawler();
    const result = await service.crawlOfficialWebsite({
      websiteUrl: 'https://many.example',
      tokenName: 'Many',
      tokenSymbol: 'MANY',
      maxPages: MAX_CRAWL_PAGES,
    });

    expect(result.pagesVisited.length).toBeLessThanOrEqual(MAX_CRAWL_PAGES);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('extracts links from fetched homepage', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://chain.link/',
      headers: {
        get: () => 'text/html',
      },
      text: async () => SAMPLE_HTML,
    })) as unknown as typeof fetch;

    const service = makeCrawler();
    const result = await service.crawlOfficialWebsite({
      websiteUrl: 'https://chain.link',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
      maxPages: 1,
    });

    expect(result.status).toBe('done');
    expect(result.links.github).toContain('github.com');
    expect(result.signals.hasClearUseCase).toBe(true);
    expect(result.mentions.tokenName).toBe(true);
    expect(result.mentions.tokenSymbol).toBe(true);
  });

  it('returns partial result when crawling disabled', async () => {
    const service = makeCrawler({ OFFCHAIN_CRAWL_ENABLED: 'false' });
    const result = await service.crawlOfficialWebsite({
      websiteUrl: 'https://chain.link',
      tokenName: 'Chainlink',
      tokenSymbol: 'LINK',
    });

    expect(result.status).toBe('partial');
    expect(result.errors).toContain('Website crawling disabled');
  });

  it('reuses crawl cache for repeated requests', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://cached.example/',
      headers: { get: () => 'text/html' },
      text: async () =>
        '<html><body><h1>Cached Token</h1><p>oracle infrastructure protocol documentation</p></body></html>',
    })) as unknown as typeof fetch;

    const service = makeCrawler();
    const first = await service.crawlOfficialWebsite({
      websiteUrl: 'https://cached.example',
      tokenName: 'Cached',
      tokenSymbol: 'CACHE',
      maxPages: 1,
    });
    const second = await service.crawlOfficialWebsite({
      websiteUrl: 'https://cached.example',
      tokenName: 'Cached',
      tokenSymbol: 'CACHE',
      maxPages: 1,
    });

    expect(first.status).toBe('done');
    expect(second.extractedText).toBe(first.extractedText);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
