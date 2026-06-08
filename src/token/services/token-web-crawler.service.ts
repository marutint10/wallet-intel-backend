import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

export const MAX_CRAWL_PAGES = 5;
export const PAGE_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MIN_USEFUL_TEXT_CHARS = 180;

export interface TokenWebsiteCrawlResult {
  status: 'done' | 'partial' | 'error';
  homepageUrl: string;
  finalUrl: string | null;
  pagesVisited: string[];
  brokenWebsite: boolean;

  extractedText: string;

  links: {
    docs: string | null;
    whitepaper: string | null;
    github: string | null;
    twitter: string | null;
    telegram: string | null;
    discord: string | null;
    blog: string | null;
    tokenomics: string | null;
    security: string | null;
    audit: string | null;
    about: string | null;
  };

  mentions: {
    tokenName: boolean;
    tokenSymbol: boolean;
    contractAddress: boolean;
  };

  signals: {
    hasDocs: boolean;
    hasWhitepaper: boolean;
    hasGithub: boolean;
    hasAuditsMentioned: boolean;
    hasTeamInfo: boolean;
    hasClearUseCase: boolean;
    suspiciousPhrases: string[];
    adoptionClaims: string[];
  };

  errors: string[];
}

export interface CrawlPageContent {
  html: string;
  finalUrl: string;
  method: 'fetch' | 'playwright';
}

export type CrawlLinkMap = TokenWebsiteCrawlResult['links'];

const SUSPICIOUS_PHRASES = [
  'guaranteed profit',
  'risk-free',
  'no risk',
  'presale bonus',
  'limited time bonus',
  'celebrity endorsement',
  'unrealistic apy',
  'fixed return',
  '1000x',
  '10000x',
  'guaranteed returns',
  'passive income guaranteed',
];

const USE_CASE_TERMS = [
  'oracle',
  'infrastructure',
  'protocol',
  'lending',
  'borrowing',
  'exchange',
  'staking',
  'restaking',
  'governance',
  'gaming',
  'payments',
  'stablecoin',
  'rwa',
  'tokenization',
  'data feeds',
  'interoperability',
  'bridge',
  'security',
  'liquidity',
  'derivatives',
];

const ADOPTION_CLAIM_PATTERNS = [
  'integrated with',
  'partners',
  'partnership',
  'ecosystem',
  'used by',
  'secures',
  'supports',
  'deployed on',
  'live on',
  'integrations',
];

const TEAM_INFO_PATTERNS = [
  'team',
  'about us',
  'foundation',
  'company',
  'contributors',
  'leadership',
  'developers',
];

const LOGIN_PATH_PATTERN =
  /\/(login|signin|sign-in|auth|signup|sign-up|register)(\/|$)/i;

const PAGE_PRIORITY: Array<keyof CrawlLinkMap> = [
  'docs',
  'tokenomics',
  'about',
  'security',
  'audit',
  'whitepaper',
  'blog',
];

@Injectable()
export class TokenWebCrawlerService {
  private readonly logger = new Logger(TokenWebCrawlerService.name);

  async crawlOfficialWebsite(input: {
    websiteUrl: string;
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
    maxPages?: number;
  }): Promise<TokenWebsiteCrawlResult> {
    const errors: string[] = [];
    const maxPages = Math.min(input.maxPages ?? MAX_CRAWL_PAGES, MAX_CRAWL_PAGES);
    const homepageUrl = normalizeHttpUrl(input.websiteUrl);

    if (!homepageUrl || !isSafeCrawlUrl(homepageUrl)) {
      return emptyCrawlResult(input.websiteUrl, {
        status: 'error',
        brokenWebsite: true,
        errors: ['Unsafe or invalid website URL'],
      });
    }

    if (isLoginPageUrl(homepageUrl)) {
      return emptyCrawlResult(homepageUrl, {
        status: 'error',
        brokenWebsite: true,
        errors: ['Login page URLs are not crawled'],
      });
    }

    const pagesVisited: string[] = [];
    const textChunks: string[] = [];
    const mergedLinks = emptyLinkMap();
    let finalUrl: string | null = null;
    let homepageFailed = false;

    const homepage = await this.fetchPageContent(homepageUrl);
    if (!homepage) {
      homepageFailed = true;
      errors.push(`Failed to fetch homepage: ${homepageUrl}`);
    } else {
      finalUrl = homepage.finalUrl;
      pagesVisited.push(homepage.finalUrl);
      textChunks.push(extractVisibleText(homepage.html));
      mergeLinkMaps(mergedLinks, extractLinksFromHtml(homepage.html, homepage.finalUrl));
    }

    if (!homepageFailed) {
      const queue = buildInternalPageQueue(homepageUrl, mergedLinks, pagesVisited, maxPages);
      for (const pageUrl of queue) {
        if (pagesVisited.length >= maxPages) {
          break;
        }
        if (pagesVisited.includes(pageUrl)) {
          continue;
        }
        if (!isSafeCrawlUrl(pageUrl) || isLoginPageUrl(pageUrl)) {
          continue;
        }

        const page = await this.fetchPageContent(pageUrl);
        if (!page) {
          errors.push(`Failed to fetch page: ${pageUrl}`);
          continue;
        }

        pagesVisited.push(page.finalUrl);
        textChunks.push(extractVisibleText(page.html));
        mergeLinkMaps(mergedLinks, extractLinksFromHtml(page.html, page.finalUrl));
      }
    }

    const extractedText = normalizeWhitespace(textChunks.join('\n\n')).slice(0, 50_000);
    const mentions = detectMentions(extractedText, input);
    const signals = analyzeSignals(extractedText, mergedLinks);

    let status: TokenWebsiteCrawlResult['status'] = 'done';
    let brokenWebsite = false;

    if (homepageFailed) {
      status = pagesVisited.length > 0 ? 'partial' : 'error';
      brokenWebsite = true;
    } else if (errors.length > 0 || extractedText.length < MIN_USEFUL_TEXT_CHARS / 4) {
      status = 'partial';
    }

    return {
      status,
      homepageUrl,
      finalUrl,
      pagesVisited,
      brokenWebsite,
      extractedText,
      links: mergedLinks,
      mentions,
      signals,
      errors,
    };
  }

  async fetchPageContent(url: string): Promise<CrawlPageContent | null> {
    const fetchResult = await this.fetchWithHttp(url);
    if (fetchResult && isUsefulHtml(fetchResult.html)) {
      return fetchResult;
    }

    const playwrightResult = await this.fetchWithPlaywright(url);
    if (playwrightResult) {
      return playwrightResult;
    }

    return fetchResult;
  }

  private async fetchWithHttp(url: string): Promise<CrawlPageContent | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'WalletIntelBot/1.0 (+https://walletintel.io; token-research)',
        },
      });

      if (!response.ok) {
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }

      const raw = await response.text();
      const html = raw.slice(0, MAX_RESPONSE_BYTES);
      const finalUrl = response.url || url;

      if (!isSafeCrawlUrl(finalUrl)) {
        return null;
      }

      return { html, finalUrl, method: 'fetch' };
    } catch (err: unknown) {
      this.logger.debug(`HTTP fetch failed for ${url}: ${getErrorMessage(err)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWithPlaywright(url: string): Promise<CrawlPageContent | null> {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_TIMEOUT_MS,
        });
        const finalUrl = page.url();
        if (!isSafeCrawlUrl(finalUrl)) {
          return null;
        }
        const html = (await page.content()).slice(0, MAX_RESPONSE_BYTES);
        return { html, finalUrl, method: 'playwright' };
      } finally {
        await browser.close();
      }
    } catch (err: unknown) {
      this.logger.debug(`Playwright fetch failed for ${url}: ${getErrorMessage(err)}`);
      return null;
    }
  }
}

export function isSafeCrawlUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    if (isPrivateOrReservedHost(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function isLoginPageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return LOGIN_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

export function extractVisibleText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  return normalizeWhitespace($('body').text() || $.root().text());
}

export function extractLinksFromHtml(html: string, baseUrl: string): CrawlLinkMap {
  const links = emptyLinkMap();
  const $ = cheerio.load(html);
  const seen = new Set<string>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) {
      return;
    }
    const absolute = resolveUrl(href, baseUrl);
    if (!absolute || !isSafeCrawlUrl(absolute) || seen.has(absolute)) {
      return;
    }
    seen.add(absolute);

    const lowerHref = absolute.toLowerCase();
    const anchorText = normalizeWhitespace($(element).text()).toLowerCase();
    const combined = `${lowerHref} ${anchorText}`;

    assignLink(links, 'github', absolute, () => lowerHref.includes('github.com'));
    assignLink(links, 'twitter', absolute, () =>
      lowerHref.includes('twitter.com') || lowerHref.includes('x.com'),
    );
    assignLink(links, 'telegram', absolute, () =>
      lowerHref.includes('t.me/') || lowerHref.includes('telegram.me/'),
    );
    assignLink(links, 'discord', absolute, () =>
      lowerHref.includes('discord.gg') || lowerHref.includes('discord.com'),
    );
    assignLink(
      links,
      'whitepaper',
      absolute,
      () =>
        combined.includes('whitepaper') ||
        combined.includes('white-paper') ||
        (lowerHref.endsWith('.pdf') && combined.includes('paper')),
    );
    assignLink(links, 'docs', absolute, () =>
      /(^|[/.-])docs([/.-]|$)/i.test(lowerHref) ||
      combined.includes('documentation') ||
      combined.includes('developer docs'),
    );
    assignLink(links, 'blog', absolute, () => /\/blog(\/|$)/i.test(lowerHref));
    assignLink(links, 'tokenomics', absolute, () => combined.includes('tokenomics'));
    assignLink(links, 'security', absolute, () => /\/security(\/|$)/i.test(lowerHref));
    assignLink(links, 'audit', absolute, () => combined.includes('audit'));
    assignLink(links, 'about', absolute, () =>
      /\/(about|team|company|foundation)(\/|$)/i.test(lowerHref) ||
      combined.includes('about us') ||
      combined.includes('our team'),
    );
  });

  return links;
}

export function analyzeSignals(
  text: string,
  links: CrawlLinkMap,
): TokenWebsiteCrawlResult['signals'] {
  const lower = text.toLowerCase();

  const suspiciousPhrases = SUSPICIOUS_PHRASES.filter((phrase) => lower.includes(phrase));
  const adoptionClaims = ADOPTION_CLAIM_PATTERNS.filter((phrase) => lower.includes(phrase));
  const hasTeamInfo = TEAM_INFO_PATTERNS.some((phrase) => lower.includes(phrase));
  const hasClearUseCase = USE_CASE_TERMS.some((term) => lower.includes(term));
  const hasAuditsMentioned =
    /\baudit(s|ed|ing)?\b/i.test(text) || links.audit !== null || links.security !== null;

  return {
    hasDocs: links.docs !== null || /\bdocs?\b/i.test(text),
    hasWhitepaper: links.whitepaper !== null || lower.includes('whitepaper'),
    hasGithub: links.github !== null,
    hasAuditsMentioned,
    hasTeamInfo,
    hasClearUseCase,
    suspiciousPhrases,
    adoptionClaims,
  };
}

export function detectMentions(
  text: string,
  input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
  },
): TokenWebsiteCrawlResult['mentions'] {
  const lower = text.toLowerCase();
  const tokenName = input.tokenName?.trim();
  const tokenSymbol = input.tokenSymbol?.trim().toUpperCase();
  const contractAddress = input.contractAddress?.trim().toLowerCase();

  return {
    tokenName: tokenName ? lower.includes(tokenName.toLowerCase()) : false,
    tokenSymbol: tokenSymbol
      ? new RegExp(`\\b${escapeRegExp(tokenSymbol)}\\b`, 'i').test(text)
      : false,
    contractAddress: contractAddress ? lower.includes(contractAddress) : false,
  };
}

export function buildInternalPageQueue(
  homepageUrl: string,
  links: CrawlLinkMap,
  alreadyVisited: string[],
  maxPages: number,
): string[] {
  const homepageHost = getHostname(homepageUrl);
  if (!homepageHost) {
    return [];
  }

  const queue: string[] = [];
  const seen = new Set(alreadyVisited);

  for (const key of PAGE_PRIORITY) {
    const candidate = links[key];
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    if (getHostname(candidate) !== homepageHost) {
      continue;
    }
    queue.push(candidate);
    seen.add(candidate);
    if (queue.length >= maxPages - alreadyVisited.length) {
      break;
    }
  }

  return queue;
}

function emptyLinkMap(): CrawlLinkMap {
  return {
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
  };
}

function mergeLinkMaps(target: CrawlLinkMap, source: CrawlLinkMap): void {
  for (const key of Object.keys(target) as Array<keyof CrawlLinkMap>) {
    if (!target[key] && source[key]) {
      target[key] = source[key];
    }
  }
}

function assignLink(
  links: CrawlLinkMap,
  key: keyof CrawlLinkMap,
  url: string,
  matcher: () => boolean,
): void {
  if (!links[key] && matcher()) {
    links[key] = url;
  }
}

function emptyCrawlResult(
  homepageUrl: string,
  overrides: Partial<TokenWebsiteCrawlResult>,
): TokenWebsiteCrawlResult {
  return {
    status: 'error',
    homepageUrl,
    finalUrl: null,
    pagesVisited: [],
    brokenWebsite: true,
    extractedText: '',
    links: emptyLinkMap(),
    mentions: {
      tokenName: false,
      tokenSymbol: false,
      contractAddress: false,
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
    errors: [],
    ...overrides,
  };
}

function normalizeHttpUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveUrl(href: string, baseUrl: string): string | null {
  if (/^(javascript:|data:|mailto:|tel:|ftp:)/i.test(href)) {
    return null;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isUsefulHtml(html: string): boolean {
  const text = extractVisibleText(html);
  if (text.length >= MIN_USEFUL_TEXT_CHARS) {
    return true;
  }
  const lower = html.toLowerCase();
  const shellMarkers = ['id="root"', 'id="__next"', 'id="app"', 'data-reactroot'];
  const looksJsRendered = shellMarkers.some((marker) => lower.includes(marker));
  return !looksJsRendered && text.length > 0;
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function isPrivateOrReservedHost(hostname: string): boolean {
  if (hostname === '::1') {
    return true;
  }

  if (hostname.includes(':')) {
    const lower = hostname.toLowerCase();
    return (
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower === '::1'
    );
  }

  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
