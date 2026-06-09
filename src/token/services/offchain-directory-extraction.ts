import * as cheerio from 'cheerio';
import type { DiscoveredLinks } from './offchain-discovery-types';
import {
  filterNonAggregatorUrl,
  firstNonAggregatorUrl,
  hasCrossProjectMismatch,
  isAggregatorUrl,
  isBlockedOfficialLink,
} from './offchain-link-validation';

export interface DirectoryIdentityContext {
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
  chain: string | null;
}

export interface DirectoryExtractionResult {
  links: DiscoveredLinks;
  categories: string[];
  identityVerified: boolean;
  directoryUrl: string;
}

const STRONG_DIRECTORY_HOSTS = [
  /(^|\.)coingecko\.com$/i,
  /(^|\.)coinmarketcap\.com$/i,
  /(^|\.)dexscreener\.com$/i,
];

const WEAK_DIRECTORY_HOSTS = [/(^|\.)coindesk\.com$/i, /(^|\.)coinpaprika\.com$/i];

const SOCIAL_HOST_PATTERNS = [
  /twitter\.com/i,
  /x\.com/i,
  /t\.me/i,
  /discord\./i,
  /github\.com/i,
  /medium\.com/i,
  /youtube\.com/i,
  /reddit\.com/i,
];

export function isTrustedDirectoryUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return (
      STRONG_DIRECTORY_HOSTS.some((pattern) => pattern.test(hostname)) ||
      WEAK_DIRECTORY_HOSTS.some((pattern) => pattern.test(hostname))
    );
  } catch {
    return false;
  }
}

export function isStrongTrustedDirectoryUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    return STRONG_DIRECTORY_HOSTS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

export function coinGeckoMetadataMatchesToken(
  metadata: unknown,
  contractAddress: string | null,
): boolean {
  if (!contractAddress) {
    return false;
  }
  const record = asRecord(metadata);
  const target = contractAddress.toLowerCase();
  const platforms = asRecord(record.platforms);
  for (const value of Object.values(platforms)) {
    if (typeof value === 'string' && value.toLowerCase() === target) {
      return true;
    }
  }
  const detailPlatforms = asRecord(record.detail_platforms);
  for (const item of Object.values(detailPlatforms)) {
    const detail = asRecord(item);
    const address = safeString(detail.contract_address);
    if (address?.toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

export function extractCoinGeckoCategories(metadata: unknown): string[] {
  const record = asRecord(metadata);
  const categories = record.categories;
  if (!Array.isArray(categories)) {
    return [];
  }
  return categories.filter((item): item is string => typeof item === 'string');
}

export function extractCoinGeckoDirectoryUrl(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const id = safeString(record.id);
  if (!id) {
    return null;
  }
  return `https://www.coingecko.com/en/coins/${id}`;
}

export function aggregateDexScreenerProfile(pairs: unknown): Record<string, unknown> | null {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  const websites = new Set<string>();
  const socials: Array<{ type: string; url: string }> = [];
  const seenSocial = new Set<string>();

  for (const pair of pairs) {
    const info = asRecord(asRecord(pair).info);
    const pairWebsites = Array.isArray(info.websites) ? info.websites : [];
    for (const website of pairWebsites) {
      const url = safeString(website);
      if (url) {
        websites.add(url);
      }
    }
    const pairSocials = Array.isArray(info.socials) ? info.socials : [];
    for (const social of pairSocials) {
      const item = asRecord(social);
      const type = safeString(item.type) ?? 'unknown';
      const url = safeString(item.url);
      if (!url) {
        continue;
      }
      const key = `${type}:${url}`;
      if (seenSocial.has(key)) {
        continue;
      }
      seenSocial.add(key);
      socials.push({ type, url });
    }
  }

  return {
    info: {
      websites: [...websites],
      socials,
    },
    pairs,
  };
}

export function verifyDirectoryPageIdentity(
  pageText: string,
  html: string,
  context: DirectoryIdentityContext,
): boolean {
  const haystack = `${pageText}\n${html}`.toLowerCase();
  const contract = context.contractAddress?.toLowerCase();
  if (contract) {
    const compact = contract.replace(/^0x/, '');
    if (haystack.includes(contract) || haystack.includes(compact)) {
      return true;
    }
  }

  const name = context.tokenName?.toLowerCase();
  const symbol = context.tokenSymbol?.toLowerCase();
  if (name && symbol && haystack.includes(name) && haystack.includes(symbol)) {
    return true;
  }

  return false;
}

export function extractOutboundLinksFromDirectoryHtml(
  html: string,
  directoryUrl: string,
  context: DirectoryIdentityContext,
): DirectoryExtractionResult {
  const empty = emptyDirectoryResult(directoryUrl);
  const pageText = cheerio.load(html).root().text();
  const identityVerified = verifyDirectoryPageIdentity(pageText, html, context);
  if (!identityVerified) {
    return empty;
  }

  const $ = cheerio.load(html);
  const links = emptyDiscoveredLinks();
  const categories: string[] = [];
  const websiteCandidates: string[] = [];
  const docsCandidates: string[] = [];
  const githubCandidates: string[] = [];

  $('a[href]').each((_, element) => {
    const href = normalizeOutboundUrl($(element).attr('href'), directoryUrl);
    if (!href || isBlockedOfficialLink(href) || isTrustedDirectoryUrl(href)) {
      return;
    }
    if (hasCrossProjectMismatch(href, context.tokenName, context.tokenSymbol, false)) {
      return;
    }

    const label = $(element).text().trim().toLowerCase();
    const combined = `${label} ${href}`.toLowerCase();

    if (isSocialHost(href)) {
      assignSocialLink(links, href, combined);
      return;
    }

    if (/whitepaper|white-paper/.test(combined)) {
      links.whitepaper ??= href;
      return;
    }
    if (/\bdocs?\b|documentation|gitbook|wiki/.test(combined)) {
      if (linkMatchesTokenIdentity(href, context)) {
        docsCandidates.push(href);
      }
      return;
    }
    if (/github\.com/.test(href)) {
      if (linkMatchesTokenIdentity(href, context)) {
        githubCandidates.push(href);
      }
      return;
    }
    if (/blog/.test(combined)) {
      links.blog ??= href;
      return;
    }
    if (/website|official|homepage|home page/.test(combined)) {
      websiteCandidates.unshift(href);
      return;
    }
    if (!isSocialHost(href)) {
      websiteCandidates.push(href);
    }
  });

  links.website =
    firstNonAggregatorUrl(websiteCandidates) ??
    pickWebsiteByTokenSlug(websiteCandidates, context);
  links.docs = firstNonAggregatorUrl(docsCandidates);
  links.github = firstNonAggregatorUrl(githubCandidates);

  $('meta[name="keywords"], meta[name="description"]').each((_, element) => {
    const content = $(element).attr('content');
    if (content) {
      categories.push(...content.split(',').map((item) => item.trim()).filter(Boolean));
    }
  });

  return {
    links: normalizeDiscoveredLinks(links),
    categories,
    identityVerified: true,
    directoryUrl,
  };
}

export function mergeDirectoryExtractions(
  results: DirectoryExtractionResult[],
): { links: DiscoveredLinks; categories: string[] } {
  const merged = emptyDiscoveredLinks();
  const categories = new Set<string>();

  for (const result of results) {
    if (!result.identityVerified) {
      continue;
    }
    for (const category of result.categories) {
      categories.add(category);
    }
    for (const key of Object.keys(merged) as Array<keyof DiscoveredLinks>) {
      merged[key] ??= result.links[key];
    }
  }

  return {
    links: merged,
    categories: [...categories],
  };
}

function pickWebsiteByTokenSlug(
  candidates: string[],
  context: DirectoryIdentityContext,
): string | null {
  const slug = normalizeTokenSlug(context.tokenName, context.tokenSymbol);
  if (!slug) {
    return firstNonAggregatorUrl(candidates);
  }
  for (const candidate of candidates) {
    const host = extractHost(candidate);
    if (host.includes(slug) && filterNonAggregatorUrl(candidate)) {
      return candidate;
    }
  }
  return firstNonAggregatorUrl(candidates);
}

function assignSocialLink(links: DiscoveredLinks, href: string, combined: string): void {
  if (/twitter\.com|x\.com/.test(href)) {
    links.twitter ??= href;
  } else if (/t\.me/.test(href)) {
    links.telegram ??= href;
  } else if (/discord/.test(href)) {
    links.discord ??= href;
  } else if (/github\.com/.test(href)) {
    links.github ??= href;
  } else if (/medium\.com|blog/.test(combined)) {
    links.blog ??= href;
  }
}

function isSocialHost(url: string): boolean {
  return SOCIAL_HOST_PATTERNS.some((pattern) => pattern.test(url));
}

function normalizeOutboundUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
    return null;
  }
  try {
    const parsed = new URL(href, baseUrl);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function emptyDirectoryResult(directoryUrl: string): DirectoryExtractionResult {
  return {
    links: emptyDiscoveredLinks(),
    categories: [],
    identityVerified: false,
    directoryUrl,
  };
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

function normalizeDiscoveredLinks(links: DiscoveredLinks): DiscoveredLinks {
  const normalized = emptyDiscoveredLinks();
  for (const key of Object.keys(normalized) as Array<keyof DiscoveredLinks>) {
    normalized[key] = filterNonAggregatorUrl(links[key]);
  }
  return normalized;
}

function normalizeTokenSlug(tokenName: string | null, tokenSymbol: string | null): string {
  return (tokenName ?? tokenSymbol ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function linkMatchesTokenIdentity(
  url: string,
  context: DirectoryIdentityContext,
): boolean {
  const slug = normalizeTokenSlug(context.tokenName, context.tokenSymbol);
  if (!slug) {
    return false;
  }
  return url.toLowerCase().includes(slug);
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url.toLowerCase();
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
