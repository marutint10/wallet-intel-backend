import {
  coinGeckoMetadataMatchesToken,
  extractOutboundLinksFromDirectoryHtml,
  verifyDirectoryPageIdentity,
} from './offchain-directory-extraction';
import { extractCoinGeckoLinks } from './token-offchain-discovery.service';
import { buildOffChainCredibilityReport } from './token-offchain-credibility.service';
import type { OffchainDiscoveryResult } from './token-offchain-discovery.service';

const PEPE_CONTRACT = '0x6982508145454ce325ddbe47a25d4ec3d2311933';

describe('offchain-directory-extraction', () => {
  it('verifies directory page identity by contract address', () => {
    const verified = verifyDirectoryPageIdentity(
      `Pepe PEPE token contract ${PEPE_CONTRACT} on ethereum`,
      '',
      { tokenName: 'Pepe', tokenSymbol: 'PEPE', contractAddress: PEPE_CONTRACT, chain: 'ethereum' },
    );
    expect(verified).toBe(true);
  });

  it('extracts pepe.vip from CoinMarketCap-style directory HTML', () => {
    const html = `
      <html><body>
        <h1>Pepe (PEPE)</h1>
        <p>Contract: ${PEPE_CONTRACT}</p>
        <a href="https://www.pepe.vip/" rel="nofollow">Website</a>
        <a href="https://twitter.com/pepecoineth">Twitter</a>
        <a href="https://guide.pepeunchained.com/">Docs</a>
        <a href="https://github.com/MattF42/PePe-core/">GitHub</a>
      </body></html>
    `;

    const result = extractOutboundLinksFromDirectoryHtml(
      html,
      'https://coinmarketcap.com/currencies/pepe/',
      {
        tokenName: 'Pepe',
        tokenSymbol: 'PEPE',
        contractAddress: PEPE_CONTRACT,
        chain: 'ethereum',
      },
    );

    expect(result.identityVerified).toBe(true);
    expect(result.links.website).toContain('pepe.vip');
    expect(result.links.twitter).toContain('pepecoineth');
    expect(result.links.docs).toBeNull();
    expect(result.links.github).toBeNull();
  });
});

describe('PEPE metadata enrichment', () => {
  function makeDiscovery(overrides: Partial<OffchainDiscoveryResult> = {}): OffchainDiscoveryResult {
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

  it('accepts official website from CoinGecko metadata', () => {
    const links = extractCoinGeckoLinks({
      links: {
        homepage: ['https://www.pepe.vip/'],
        twitter_screen_name: 'pepecoineth',
      },
      platforms: { ethereum: PEPE_CONTRACT },
    });

    expect(links.website).toContain('pepe.vip');
    expect(links.twitter).toContain('pepecoineth');

    const report = buildOffChainCredibilityReport({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      contractAddress: PEPE_CONTRACT,
      coinGeckoMetadata: {
        categories: ['Meme', 'Ethereum Ecosystem'],
        platforms: { ethereum: PEPE_CONTRACT },
      },
      discovery: makeDiscovery({
        discoveryMode: 'official_verified',
        discoveredLinks: links,
        linkSources: { website: 'coingecko', twitter: 'coingecko' },
        hasTrustedOfficialWebsite: true,
        officialLinkConfidence: {
          level: 'medium',
          reasons: ['Website found in trusted metadata'],
        },
        metadataCategories: ['Meme', 'Ethereum Ecosystem'],
      }),
      crawl: {
        status: 'done',
        homepageUrl: 'https://www.pepe.vip/',
        finalUrl: 'https://www.pepe.vip/',
        pagesVisited: ['https://www.pepe.vip/'],
        brokenWebsite: false,
        extractedText: 'Pepe PEPE meme community token frog entertainment',
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
      },
      fetchErrors: [],
    });

    expect(report.discoveredLinks.website).toContain('pepe.vip');
    expect(report.projectProfile.category).toBe('meme');
    expect(report.score).toBeGreaterThan(35);
    expect(report.score).toBeLessThanOrEqual(69);
    expect(['limited', 'credible', 'weak']).toContain(report.credibilityTier);
    expect(report.credibilityTier).not.toBe('institutional_grade');
    expect(report.projectProfile.hasDocs).toBe(false);
    expect(report.projectProfile.hasGithub).toBe(false);
    expect(report.projectProfile.hasWhitepaper).toBe(false);
  });

  it('coinGecko metadata matches PEPE contract', () => {
    expect(
      coinGeckoMetadataMatchesToken(
        { platforms: { ethereum: PEPE_CONTRACT } },
        PEPE_CONTRACT,
      ),
    ).toBe(true);
  });
});
