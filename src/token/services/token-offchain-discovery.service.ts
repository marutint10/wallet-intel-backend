import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildDiscoveryCacheKey,
  OffchainMemoryCache,
} from './offchain-memory-cache';
import { resolveOffchainConfig } from './offchain-config';
import {
  TokenWebCrawlerService,
  type TokenWebsiteCrawlResult,
} from './token-web-crawler.service';

export interface DiscoveredLinks {
  website: string | null;
  docs: string | null;
  whitepaper: string | null;
  github: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  blog: string | null;
}

export interface OffchainDiscoveryResult {
  status: 'done' | 'partial' | 'error' | 'unknown';
  discoveredLinks: DiscoveredLinks;
  officialLinkConfidence: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  sourceUrls: string[];
  errors: string[];
}

export interface BraveSearchHit {
  title: string;
  url: string;
  description: string;
}

type MetadataSource = 'seed' | 'dexscreener' | 'coingecko' | 'explorer' | 'existing' | 'brave';

interface LinkProvenance {
  website?: MetadataSource;
  docs?: MetadataSource;
  whitepaper?: MetadataSource;
  github?: MetadataSource;
  twitter?: MetadataSource;
  telegram?: MetadataSource;
  discord?: MetadataSource;
  blog?: MetadataSource;
}

const TRUSTED_SOURCES = new Set<MetadataSource>([
  'seed',
  'dexscreener',
  'coingecko',
  'explorer',
  'existing',
]);

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_BRAVE_QUERIES = 4;
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BRAVE_RESULTS = 5;

export interface BraveSearchResponse {
  hits: BraveSearchHit[];
  error: string | null;
  rateLimited: boolean;
  timedOut: boolean;
}

@Injectable()
export class TokenOffchainDiscoveryService {
  private readonly logger = new Logger(TokenOffchainDiscoveryService.name);
  private readonly discoveryCache = new OffchainMemoryCache<OffchainDiscoveryResult>(
    200,
    DISCOVERY_CACHE_TTL_MS,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly webCrawler: TokenWebCrawlerService,
  ) {}

  clearDiscoveryCache(): void {
    this.discoveryCache.clear();
  }

  async discoverOfficialLinks(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
    chain?: string | null;
    seedLinks?: Partial<DiscoveredLinks>;
    dexScreenerProfile?: unknown;
    coinGeckoMetadata?: unknown;
    explorerMetadata?: unknown;
    existingMetadata?: unknown;
    bypassCache?: boolean;
  }): Promise<OffchainDiscoveryResult> {
    const runtime = resolveOffchainConfig(this.config);
    const cacheKey = buildDiscoveryCacheKey(input);
    if (!input.bypassCache) {
      const cached = this.discoveryCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const errors: string[] = [];
    const sourceUrls: string[] = [];
    const provenance: LinkProvenance = {};

    const discoveredLinks = emptyDiscoveredLinks();
    const tokenName = safeString(input.tokenName);
    const tokenSymbol = safeString(input.tokenSymbol);
    const contractAddress = safeString(input.contractAddress)?.toLowerCase() ?? null;

    mergeDiscoveredLinks(
      discoveredLinks,
      provenance,
      extractSeedLinks(input.seedLinks),
      'seed',
      sourceUrls,
    );
    mergeDiscoveredLinks(
      discoveredLinks,
      provenance,
      extractDexScreenerLinks(input.dexScreenerProfile),
      'dexscreener',
      sourceUrls,
    );
    mergeDiscoveredLinks(
      discoveredLinks,
      provenance,
      extractCoinGeckoLinks(input.coinGeckoMetadata),
      'coingecko',
      sourceUrls,
    );
    mergeDiscoveredLinks(
      discoveredLinks,
      provenance,
      extractExplorerLinks(input.explorerMetadata),
      'explorer',
      sourceUrls,
    );
    mergeDiscoveredLinks(
      discoveredLinks,
      provenance,
      extractExistingMetadataLinks(input.existingMetadata),
      'existing',
      sourceUrls,
    );

    const braveApiKey = this.getBraveApiKey();
    const needsBrave = shouldUseBraveFallback(discoveredLinks);

    let braveUsed = false;
    if (needsBrave) {
      if (!runtime.braveEnabled) {
        errors.push('Brave search fallback disabled');
      } else if (!braveApiKey) {
        errors.push('BRAVE_SEARCH_API_KEY missing; Brave fallback skipped');
      } else if (tokenName || tokenSymbol || contractAddress) {
        braveUsed = true;
        const braveLinks = await this.discoverWithBrave(
          braveApiKey,
          tokenName,
          tokenSymbol,
          contractAddress,
          discoveredLinks,
          runtime.braveTimeoutMs,
        );
        mergeDiscoveredLinks(discoveredLinks, provenance, braveLinks.links, 'brave', sourceUrls);
        errors.push(...braveLinks.errors);
      }
    }

    let crawlResult: TokenWebsiteCrawlResult | null = null;
    if (discoveredLinks.website && runtime.crawlEnabled) {
      try {
        crawlResult = await this.webCrawler.crawlOfficialWebsite({
          websiteUrl: discoveredLinks.website,
          tokenName,
          tokenSymbol,
          contractAddress,
          maxPages: 1,
        });
        mergeDiscoveredLinks(
          discoveredLinks,
          provenance,
          mapCrawlLinksToDiscovered(crawlResult.links),
          provenance.website ?? 'seed',
          sourceUrls,
        );
        if (crawlResult.errors.length > 0) {
          errors.push(...crawlResult.errors);
        }
        if (crawlResult.brokenWebsite) {
          errors.push('Official website could not be validated from homepage crawl');
        }
      } catch (err: unknown) {
        errors.push(`Website validation crawl failed: ${getErrorMessage(err)}`);
      }
    } else if (discoveredLinks.website && !runtime.crawlEnabled) {
      errors.push('Website crawling disabled; homepage validation skipped');
    }

    const officialLinkConfidence = resolveOfficialLinkConfidence({
      discoveredLinks,
      provenance,
      crawlResult,
      braveUsed,
      tokenName,
      tokenSymbol,
      contractAddress,
    });

    let status: OffchainDiscoveryResult['status'] = 'done';
    if (!discoveredLinks.website && Object.values(discoveredLinks).every((value) => !value)) {
      status = braveApiKey ? 'partial' : 'unknown';
    } else if (errors.length > 0 || officialLinkConfidence.level === 'low') {
      status = discoveredLinks.website ? 'partial' : 'partial';
    }

    const result: OffchainDiscoveryResult = {
      status,
      discoveredLinks,
      officialLinkConfidence,
      sourceUrls: [...new Set(sourceUrls)],
      errors,
    };

    if (result.status === 'done' || result.status === 'partial') {
      this.discoveryCache.set(cacheKey, result);
    }

    return result;
  }

  private getBraveApiKey(): string {
    return (
      this.config.get<string>('BRAVE_SEARCH_API_KEY') ??
      this.config.get<string>('brave.searchApiKey') ??
      ''
    ).trim();
  }

  private async discoverWithBrave(
    apiKey: string,
    tokenName: string | null,
    tokenSymbol: string | null,
    contractAddress: string | null,
    current: DiscoveredLinks,
    timeoutMs: number,
  ): Promise<{ links: DiscoveredLinks; errors: string[] }> {
    const errors: string[] = [];
    const links = emptyDiscoveredLinks();
    const label = [tokenName, tokenSymbol].filter(Boolean).join(' ').trim();

    const queries: string[] = [];
    if (!current.website && label) {
      queries.push(`${label} official website crypto`);
    }
    if (!current.docs && label) {
      queries.push(`${label} docs`);
    }
    if (!current.whitepaper && label) {
      queries.push(`${label} whitepaper`);
    }
    if (!current.github && label) {
      queries.push(`${label} github`);
    }
    if (!current.website && tokenName && contractAddress) {
      queries.push(`${tokenName} ${contractAddress}`);
    }

    const limitedQueries = queries.slice(0, MAX_BRAVE_QUERIES);
    for (const query of limitedQueries) {
      const response = await searchBraveWeb(apiKey, query, timeoutMs);
      if (response.rateLimited) {
        errors.push('Brave Search rate limit reached');
        break;
      }
      if (response.timedOut) {
        errors.push(`Brave search timed out for: ${query}`);
        continue;
      }
      if (response.error) {
        errors.push(response.error);
      }
      if (response.hits.length === 0) {
        errors.push(`Brave search returned no results for: ${query}`);
        continue;
      }

      for (const hit of response.hits.slice(0, MAX_BRAVE_RESULTS)) {
        assignBraveHit(links, hit, current);
      }
    }

    return { links, errors };
  }
}

export function shouldUseBraveFallback(links: DiscoveredLinks): boolean {
  if (!links.website) {
    return true;
  }

  const hasSocialOrDocs = Boolean(
    links.docs ||
      links.github ||
      links.twitter ||
      links.telegram ||
      links.discord,
  );

  return !hasSocialOrDocs;
}

export async function searchBraveWeb(
  apiKey: string,
  query: string,
  timeoutMs = 8_000,
): Promise<BraveSearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(BRAVE_API_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(MAX_BRAVE_RESULTS));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      return {
        hits: [],
        error: 'Brave Search rate limit reached',
        rateLimited: true,
        timedOut: false,
      };
    }

    if (!response.ok) {
      return {
        hits: [],
        error: `Brave search HTTP ${response.status}`,
        rateLimited: false,
        timedOut: false,
      };
    }

    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    const hits = (body.web?.results ?? [])
      .map((result) => ({
        title: safeString(result.title) ?? '',
        url: safeString(result.url) ?? '',
        description: safeString(result.description) ?? '',
      }))
      .filter((result) => result.url.length > 0);

    return { hits, error: null, rateLimited: false, timedOut: false };
  } catch (err: unknown) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      hits: [],
      error: timedOut ? 'Brave search timed out' : 'Brave search failed',
      rateLimited: false,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractSeedLinks(seed?: Partial<DiscoveredLinks>): DiscoveredLinks {
  return normalizeDiscoveredLinks(seed ?? {});
}

export function extractCoinGeckoLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const links = asRecord(record.links);
  const repos = asRecord(links.repos_url);
  const githubRepos = Array.isArray(repos.github) ? repos.github : [];

  const homepage = firstUrl(links.homepage);
  const twitterHandle = safeString(links.twitter_screen_name);
  const telegram = safeString(links.telegram_channel_identifier);

  return normalizeDiscoveredLinks({
    website: homepage,
    docs: firstUrlMatching(links.homepage, /docs/i) ?? firstUrl(links.blockchain_site),
    whitepaper: firstUrlMatching(links.homepage, /whitepaper|white-paper/i),
    github: firstUrl(githubRepos),
    twitter: twitterHandle ? `https://twitter.com/${twitterHandle}` : null,
    telegram: telegram ? `https://t.me/${telegram}` : firstUrl(links.chat_url),
    discord: firstUrlMatching(links.chat_url, /discord/i),
    blog: firstUrlMatching(links.homepage, /blog/i),
  });
}

export function extractDexScreenerLinks(profile: unknown): DiscoveredLinks {
  const record = asRecord(profile);
  const info = asRecord(record.info ?? record);
  const websites = Array.isArray(info.websites) ? info.websites : [];
  const socials = Array.isArray(info.socials) ? info.socials : [];

  const links = emptyDiscoveredLinks();
  links.website = firstUrl(websites);

  for (const social of socials) {
    const item = asRecord(social);
    const type = safeString(item.type)?.toLowerCase() ?? '';
    const url = safeString(item.url);
    if (!url) {
      continue;
    }
    if (type.includes('twitter') || type === 'x') {
      links.twitter ??= url;
    } else if (type.includes('telegram')) {
      links.telegram ??= url;
    } else if (type.includes('discord')) {
      links.discord ??= url;
    } else if (type.includes('github')) {
      links.github ??= url;
    }
  }

  return normalizeDiscoveredLinks(links);
}

export function extractExplorerLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const rawResult = record.result;
  const firstResult =
    Array.isArray(rawResult) && rawResult.length > 0 ? asRecord(rawResult[0]) : asRecord(rawResult);
  const result = Object.keys(firstResult).length > 0 ? firstResult : record;
  const tokenInfo = asRecord(result.tokenInfo ?? result);

  return normalizeDiscoveredLinks({
    website: safeString(tokenInfo.website) ?? safeString(result.website),
    twitter: safeString(tokenInfo.twitter) ?? safeString(result.twitter),
    github: safeString(tokenInfo.github) ?? safeString(result.github),
    telegram: safeString(tokenInfo.telegram) ?? safeString(result.telegram),
    discord: safeString(tokenInfo.discord) ?? safeString(result.discord),
  });
}

export function extractExistingMetadataLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const social = asRecord(record.social ?? record.socials ?? record.links);

  return normalizeDiscoveredLinks({
    website:
      safeString(record.website) ??
      safeString(record.homepage) ??
      safeString(social.website),
    docs: safeString(record.docs) ?? safeString(social.docs),
    whitepaper: safeString(record.whitepaper) ?? safeString(social.whitepaper),
    github: safeString(record.github) ?? safeString(social.github),
    twitter: safeString(record.twitter) ?? safeString(social.twitter),
    telegram: safeString(record.telegram) ?? safeString(social.telegram),
    discord: safeString(record.discord) ?? safeString(social.discord),
    blog: safeString(record.blog) ?? safeString(social.blog),
  });
}

export function resolveOfficialLinkConfidence(input: {
  discoveredLinks: DiscoveredLinks;
  provenance: LinkProvenance;
  crawlResult: TokenWebsiteCrawlResult | null;
  braveUsed: boolean;
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
}): OffchainDiscoveryResult['officialLinkConfidence'] {
  const reasons: string[] = [];
  const { discoveredLinks, provenance, crawlResult, braveUsed, tokenName, tokenSymbol, contractAddress } =
    input;

  if (!discoveredLinks.website) {
    return {
      level: 'low',
      reasons: ['No official website discovered'],
    };
  }

  const websiteSource = provenance.website;
  const trustedWebsite = websiteSource ? TRUSTED_SOURCES.has(websiteSource) : false;
  const mentions = crawlResult?.mentions;
  const verifiedOnSite =
    Boolean(mentions?.tokenName || mentions?.tokenSymbol || mentions?.contractAddress);
  const socialAgreement = countSocialAgreement(discoveredLinks, crawlResult);

  if (trustedWebsite && verifiedOnSite) {
    reasons.push('Website found in trusted metadata and homepage mentions token identifiers');
    if (socialAgreement > 0) {
      reasons.push('Homepage crawl links align with known social metadata');
    }
    return { level: 'high', reasons };
  }

  if (trustedWebsite && (socialAgreement > 0 || crawlResult?.signals.hasClearUseCase)) {
    reasons.push('Trusted metadata provides website with consistent supporting links or use-case signals');
    return { level: 'high', reasons };
  }

  if (trustedWebsite) {
    reasons.push('Website found in trusted metadata');
    if (!verifiedOnSite && (tokenName || tokenSymbol || contractAddress)) {
      reasons.push('Official website could not be fully verified from homepage text');
      if (socialAgreement > 0) {
        reasons.push('Supporting social or docs links appear consistent with trusted metadata');
        return { level: 'medium', reasons };
      }
      return { level: 'medium', reasons };
    }
    return { level: 'medium', reasons };
  }

  if (braveUsed && !trustedWebsite) {
    reasons.push('Website discovered primarily from Brave search without trusted metadata confirmation');
    if (!verifiedOnSite) {
      reasons.push('Homepage content did not verify token name, symbol, or contract');
      return { level: 'low', reasons };
    }
    return { level: 'medium', reasons };
  }

  if (
    crawlResult &&
    !verifiedOnSite &&
    (tokenName || tokenSymbol || contractAddress) &&
    !trustedWebsite
  ) {
    reasons.push('Website could not be verified against token identifiers');
    return { level: 'low', reasons };
  }

  reasons.push('Limited metadata agreement for official links');
  return { level: 'medium', reasons };
}

function countSocialAgreement(
  discovered: DiscoveredLinks,
  crawlResult: TokenWebsiteCrawlResult | null,
): number {
  if (!crawlResult) {
    return 0;
  }
  let matches = 0;
  if (discovered.github && crawlResult.links.github && sameUrlHost(discovered.github, crawlResult.links.github)) {
    matches += 1;
  }
  if (discovered.twitter && crawlResult.links.twitter && sameUrlHost(discovered.twitter, crawlResult.links.twitter)) {
    matches += 1;
  }
  if (discovered.telegram && crawlResult.links.telegram && sameUrlHost(discovered.telegram, crawlResult.links.telegram)) {
    matches += 1;
  }
  if (discovered.docs && crawlResult.links.docs && sameUrlHost(discovered.docs, crawlResult.links.docs)) {
    matches += 1;
  }
  return matches;
}

function assignBraveHit(
  target: DiscoveredLinks,
  hit: BraveSearchHit,
  current: DiscoveredLinks,
): void {
  const lowerUrl = hit.url.toLowerCase();
  const combined = `${hit.title} ${hit.description} ${hit.url}`.toLowerCase();

  if (!current.website && !target.website && looksLikeWebsiteHit(combined, lowerUrl)) {
    target.website = hit.url;
    return;
  }
  if (!current.docs && !target.docs && combined.includes('doc')) {
    target.docs = hit.url;
    return;
  }
  if (!current.whitepaper && !target.whitepaper && combined.includes('whitepaper')) {
    target.whitepaper = hit.url;
    return;
  }
  if (!current.github && !target.github && lowerUrl.includes('github.com')) {
    target.github = hit.url;
  }
}

function looksLikeWebsiteHit(combined: string, lowerUrl: string): boolean {
  if (
    lowerUrl.includes('twitter.com') ||
    lowerUrl.includes('x.com') ||
    lowerUrl.includes('github.com') ||
    lowerUrl.includes('t.me/') ||
    lowerUrl.includes('discord.')
  ) {
    return false;
  }
  return combined.includes('official') || !lowerUrl.includes('coingecko.com');
}

function mapCrawlLinksToDiscovered(links: TokenWebsiteCrawlResult['links']): DiscoveredLinks {
  return normalizeDiscoveredLinks({
    docs: links.docs,
    whitepaper: links.whitepaper,
    github: links.github,
    twitter: links.twitter,
    telegram: links.telegram,
    discord: links.discord,
    blog: links.blog,
  });
}

function mergeDiscoveredLinks(
  target: DiscoveredLinks,
  provenance: LinkProvenance,
  incoming: DiscoveredLinks,
  source: MetadataSource,
  sourceUrls: string[],
): void {
  for (const key of Object.keys(target) as Array<keyof DiscoveredLinks>) {
    const value = incoming[key];
    if (!value) {
      continue;
    }
    if (!target[key]) {
      target[key] = value;
      provenance[key] = source;
      sourceUrls.push(value);
    }
  }
}

function emptyDiscoveredLinks(): DiscoveredLinks {
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

function normalizeDiscoveredLinks(links: Partial<DiscoveredLinks>): DiscoveredLinks {
  const normalized = emptyDiscoveredLinks();
  for (const key of Object.keys(normalized) as Array<keyof DiscoveredLinks>) {
    const value = safeString(links[key]);
    normalized[key] = value ? normalizeHttpUrl(value) : null;
  }
  return normalized;
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const parsed = new URL(withProtocol);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return safeString(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrl(item);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function firstUrlMatching(value: unknown, pattern: RegExp): string | null {
  if (typeof value === 'string' && pattern.test(value)) {
    return safeString(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrlMatching(item, pattern);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function sameUrlHost(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname.replace(/^www\./i, '') === b.hostname.replace(/^www\./i, '');
  } catch {
    return left === right;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
