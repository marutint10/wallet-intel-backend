import type { DiscoveredLinks } from './offchain-discovery-types';

export type MetadataSource =
  | 'seed'
  | 'dexscreener'
  | 'coingecko'
  | 'explorer'
  | 'existing'
  | 'coingecko_directory'
  | 'coinmarketcap_directory'
  | 'dexscreener_directory'
  | 'directory_outbound'
  | 'directory'
  | 'brave'
  | 'search_evidence'
  | 'crawl';

export type LinkField = keyof DiscoveredLinks;

export interface LinkProvenanceMap {
  website?: MetadataSource;
  docs?: MetadataSource;
  whitepaper?: MetadataSource;
  github?: MetadataSource;
  twitter?: MetadataSource;
  telegram?: MetadataSource;
  discord?: MetadataSource;
  blog?: MetadataSource;
}

const TRUSTED_METADATA_SOURCES = new Set<MetadataSource>([
  'seed',
  'dexscreener',
  'coingecko',
  'explorer',
  'existing',
  'coingecko_directory',
  'coinmarketcap_directory',
  'dexscreener_directory',
  'directory_outbound',
  'directory',
]);

const AGGREGATOR_HOST_PATTERNS: RegExp[] = [
  /(^|\.)coinmarketcap\.com$/i,
  /(^|\.)coingecko\.com$/i,
  /(^|\.)dexscreener\.com$/i,
  /(^|\.)dextools\.io$/i,
  /(^|\.)etherscan\.io$/i,
  /(^|\.)bscscan\.com$/i,
  /(^|\.)polygonscan\.com$/i,
  /(^|\.)basescan\.org$/i,
  /(^|\.)arbiscan\.io$/i,
  /(^|\.)optimistic\.etherscan\.io$/i,
  /(^|\.)bitscreener\.com$/i,
  /(^|\.)coinpaprika\.com$/i,
  /(^|\.)cryptorank\.io$/i,
  /(^|\.)coindesk\.com$/i,
];

const BLOCK_EXPLORER_HOST_PATTERNS: RegExp[] = [
  /(^|\.)etherscan\.io$/i,
  /(^|\.)ethplorer\.io$/i,
  /(^|\.)bscscan\.com$/i,
  /(^|\.)polygonscan\.com$/i,
  /(^|\.)basescan\.org$/i,
  /(^|\.)arbiscan\.io$/i,
  /(^|\.)optimistic\.etherscan\.io$/i,
  /(^|\.)snowtrace\.io$/i,
  /(^|\.)ftmscan\.com$/i,
  /(^|\.)gnosisscan\.io$/i,
  /(^|\.)celoscan\.io$/i,
  /(^|\.)moonscan\.io$/i,
  /(^|\.)cronoscan\.com$/i,
  /(^|\.)blockscout\.com$/i,
];

const AGGREGATOR_PATH_PATTERNS: Array<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)coinbase\.com$/i, path: /\/price\b/i },
  { host: /(^|\.)binance\.com$/i, path: /\/en\/price\b/i },
  { host: /(^|\.)kraken\.com$/i, path: /\/prices\b/i },
];

const THIRD_PARTY_ANALYTICS_HOST_PATTERNS: RegExp[] = [
  /(^|\.)arkm\.com$/i,
  /(^|\.)arkham\.com$/i,
  /(^|\.)nansen\.ai$/i,
  /(^|\.)debank\.com$/i,
  /(^|\.)zapper\.xyz$/i,
  /(^|\.)bubblemaps\.io$/i,
  /(^|\.)holder\.io$/i,
];

const PROJECT_VARIANT_MODIFIERS = [
  'unchained',
  '2.0',
  '2-0',
  'v2',
  'inu',
  'ai',
  'chain',
  'sol',
  'base',
  'bsc',
  'pro',
  'classic',
  'new',
];

const MEME_NAME_PATTERN =
  /\b(pepe|doge|shib|floki|bonk|wojak|meme|mog|brett|popcat|neiro)\b/i;

export interface LinkValidationContext {
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
  provenance: LinkProvenanceMap;
  verifiedOfficialWebsite: string | null;
  crawlMentionsContract?: boolean;
}

export interface SanitizedLinksResult {
  links: DiscoveredLinks;
  provenance: LinkProvenanceMap;
  sourceUrls: string[];
  rejectedUrls: string[];
  hasTrustedOfficialWebsite: boolean;
  braveOnlyWebsite: boolean;
  aggregatorWebsiteRejected: boolean;
}

export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

export function isThirdPartyAnalyticsUrl(url: string): boolean {
  const hostname = extractHostname(url);
  if (!hostname) {
    return false;
  }
  if (THIRD_PARTY_ANALYTICS_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return /\/explorer\/token\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isBlockedOfficialLink(url: string): boolean {
  return isAggregatorUrl(url) || isThirdPartyAnalyticsUrl(url);
}

export function isPlatformDirectorySocialUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    /t\.me\/coinmarketcapannouncements\b/i.test(lower) ||
    /t\.me\/coingecko\b/i.test(lower) ||
    /twitter\.com\/coinmarketcap\b/i.test(lower) ||
    /x\.com\/coinmarketcap\b/i.test(lower) ||
    /twitter\.com\/coingecko\b/i.test(lower) ||
    /x\.com\/coingecko\b/i.test(lower) ||
    /discord\.(gg|com)\/(coinmarketcap|coingecko)\b/i.test(lower)
  );
}

export function isAggregatorUrl(url: string): boolean {
  const hostname = extractHostname(url);
  if (!hostname) {
    return false;
  }

  if (AGGREGATOR_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return AGGREGATOR_PATH_PATTERNS.some(
      (rule) => rule.host.test(hostname) && rule.path.test(parsed.pathname),
    );
  } catch {
    return false;
  }
}

export function isExplorerUrl(url: string): boolean {
  const hostname = extractHostname(url);
  if (!hostname) {
    return false;
  }
  return BLOCK_EXPLORER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function isTrustedMetadataSource(source: MetadataSource | undefined): boolean {
  return source ? TRUSTED_METADATA_SOURCES.has(source) : false;
}

export function isSameOfficialDomain(url: string, officialWebsite: string | null): boolean {
  const left = extractHostname(url);
  const right = extractHostname(officialWebsite ?? '');
  if (!left || !right) {
    return false;
  }
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

export function hasCrossProjectMismatch(
  url: string,
  tokenName: string | null,
  tokenSymbol: string | null,
  trustedMetadataConfirmed: boolean,
): boolean {
  if (trustedMetadataConfirmed) {
    return false;
  }

  const host = (extractHostname(url) ?? url).toLowerCase();
  const tokenSlug = normalizeTokenSlug(tokenName, tokenSymbol);
  if (!tokenSlug) {
    return false;
  }

  if (
    (tokenSymbol?.toUpperCase() === 'PEPE' || tokenName?.toLowerCase() === 'pepe') &&
    /pepeunchained|pepe-unchained|pepeunchain/i.test(host)
  ) {
    return true;
  }

  for (const modifier of PROJECT_VARIANT_MODIFIERS) {
    if (tokenSlug.includes(modifier.replace(/[.-]/g, ''))) {
      continue;
    }
    const compact = `${tokenSlug}${modifier}`.replace(/[.\s-]/g, '');
    const dashed = `${tokenSlug}-${modifier}`;
    if (host.includes(compact) || host.includes(dashed)) {
      return true;
    }
  }

  return false;
}

export function isLikelyMemeToken(tokenName: string | null, tokenSymbol: string | null): boolean {
  return MEME_NAME_PATTERN.test(`${tokenName ?? ''} ${tokenSymbol ?? ''}`);
}

export function isVerifiedSecondaryLink(
  url: string,
  field: LinkField,
  context: LinkValidationContext,
): boolean {
  if (
    (field === 'telegram' || field === 'twitter' || field === 'discord') &&
    isPlatformDirectorySocialUrl(url)
  ) {
    return false;
  }

  if (field === 'docs' && isExplorerUrl(url)) {
    return false;
  }

  if (isBlockedOfficialLink(url)) {
    return false;
  }

  const source = context.provenance[field];
  const trustedMetadataConfirmed = isTrustedMetadataSource(source);

  if (
    hasCrossProjectMismatch(
      url,
      context.tokenName,
      context.tokenSymbol,
      trustedMetadataConfirmed,
    )
  ) {
    return false;
  }

  if (trustedMetadataConfirmed) {
    return true;
  }

  if (context.verifiedOfficialWebsite && isSameOfficialDomain(url, context.verifiedOfficialWebsite)) {
    return true;
  }

  if (field === 'github' && /^https?:\/\/(www\.)?github\.com\//i.test(url)) {
    return trustedMetadataConfirmed;
  }

  if (source === 'crawl' && context.verifiedOfficialWebsite) {
    return isSameOfficialDomain(url, context.verifiedOfficialWebsite);
  }

  if (source === 'brave' || source === 'search_evidence') {
    return false;
  }

  return false;
}

export function sanitizeDiscoveredLinks(input: {
  links: DiscoveredLinks;
  provenance: LinkProvenanceMap;
  sourceUrls: string[];
  context: LinkValidationContext;
}): SanitizedLinksResult {
  const links = emptyLinks();
  const provenance: LinkProvenanceMap = {};
  const sourceUrls = new Set(input.sourceUrls);
  const rejectedUrls: string[] = [];
  let aggregatorWebsiteRejected = false;

  const pushRejected = (url: string) => {
    rejectedUrls.push(url);
    sourceUrls.add(url);
  };

  let verifiedOfficialWebsite: string | null = null;
  const websiteUrl = input.links.website;
  const websiteSource = input.provenance.website;

  if (websiteUrl) {
    sourceUrls.add(websiteUrl);
    const trustedWebsite = isTrustedMetadataSource(websiteSource);
    const aggregator = isAggregatorUrl(websiteUrl);
    const mismatch = hasCrossProjectMismatch(
      websiteUrl,
      input.context.tokenName,
      input.context.tokenSymbol,
      trustedWebsite,
    );

    if (aggregator || isThirdPartyAnalyticsUrl(websiteUrl)) {
      aggregatorWebsiteRejected = true;
      pushRejected(websiteUrl);
    } else if (mismatch) {
      pushRejected(websiteUrl);
    } else if (websiteSource === 'brave' && !trustedWebsite) {
      pushRejected(websiteUrl);
    } else {
      links.website = websiteUrl;
      provenance.website = websiteSource;
      if (trustedWebsite || websiteSource === 'seed') {
        verifiedOfficialWebsite = websiteUrl;
      }
    }
  }

  const validationContext: LinkValidationContext = {
    ...input.context,
    provenance: input.provenance,
    verifiedOfficialWebsite,
  };

  for (const field of SECONDARY_LINK_FIELDS) {
    const url = input.links[field];
    if (!url) {
      continue;
    }
    sourceUrls.add(url);

    if (!isVerifiedSecondaryLink(url, field, validationContext)) {
      pushRejected(url);
      continue;
    }

    links[field] = url;
    provenance[field] = input.provenance[field];
  }

  const hasTrustedOfficialWebsite = Boolean(
    links.website && isTrustedMetadataSource(provenance.website),
  );
  const braveOnlyWebsite = Boolean(
    links.website && provenance.website === 'brave' && !hasTrustedOfficialWebsite,
  );

  return {
    links,
    provenance,
    sourceUrls: [...sourceUrls],
    rejectedUrls,
    hasTrustedOfficialWebsite,
    braveOnlyWebsite,
    aggregatorWebsiteRejected,
  };
}

export function filterNonAggregatorUrl(value: string | null): string | null {
  if (!value || isAggregatorUrl(value)) {
    return null;
  }
  return value;
}

export function firstNonAggregatorUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return filterNonAggregatorUrl(value.trim().length > 0 ? value.trim() : null);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstNonAggregatorUrl(item);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

export function firstNonAggregatorUrlMatching(value: unknown, pattern: RegExp): string | null {
  if (typeof value === 'string' && pattern.test(value)) {
    return filterNonAggregatorUrl(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstNonAggregatorUrlMatching(item, pattern);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

export function buildVerifiedCategoryText(
  data: {
    tokenName: string | null;
    tokenSymbol: string | null;
    crawl: { extractedText: string; mentions: { tokenName: boolean; tokenSymbol: boolean; contractAddress: boolean } } | null;
    hasTrustedOfficialWebsite: boolean;
    officialWebsite: string | null;
  },
): string {
  const parts: string[] = [];
  if (data.tokenName) {
    parts.push(data.tokenName);
  }
  if (data.tokenSymbol) {
    parts.push(data.tokenSymbol);
  }

  if (data.crawl && data.hasTrustedOfficialWebsite && data.officialWebsite) {
  const verified =
      data.crawl.mentions.tokenName ||
      data.crawl.mentions.tokenSymbol ||
      data.crawl.mentions.contractAddress;
    if (verified) {
      parts.push(data.crawl.extractedText);
    }
  }

  return parts.join('\n');
}

export interface OffchainScoreCaps {
  score: number;
  maxTier: 'weak' | 'limited' | 'credible' | 'strong' | 'institutional_grade';
}

export function applyOffchainScoreCaps(input: {
  score: number;
  officialLinkConfidence: 'low' | 'medium' | 'high';
  hasTrustedOfficialWebsite: boolean;
  braveOnlyWebsite: boolean;
  aggregatorWebsiteRejected: boolean;
  hasVerifiedOfficialWebsite: boolean;
  discoveryMode?: 'official_verified' | 'directory_verified' | 'search_only' | 'not_found';
  hasTrustedDirectoryPresence?: boolean;
}): OffchainScoreCaps {
  let score = input.score;
  let maxTier: OffchainScoreCaps['maxTier'] = 'institutional_grade';

  if (input.discoveryMode === 'search_only') {
    const cap = input.hasTrustedDirectoryPresence ? 64 : 54;
    score = Math.min(score, cap);
    maxTier = minTier(maxTier, 'limited');
  }

  if (
    input.officialLinkConfidence === 'low' ||
    input.braveOnlyWebsite ||
    input.aggregatorWebsiteRejected
  ) {
    score = Math.min(score, 69);
    maxTier = 'credible';
  }

  if (!input.hasTrustedOfficialWebsite || !input.hasVerifiedOfficialWebsite) {
    score = Math.min(score, 64);
    maxTier = minTier(maxTier, 'limited');
  }

  if (input.discoveryMode === 'not_found') {
    score = Math.min(score, 54);
    maxTier = minTier(maxTier, 'weak');
  }

  return { score, maxTier };
}

export function capCredibilityTier(
  tier: 'weak' | 'limited' | 'credible' | 'strong' | 'institutional_grade' | 'unknown',
  maxTier: OffchainScoreCaps['maxTier'],
): 'weak' | 'limited' | 'credible' | 'strong' | 'institutional_grade' | 'unknown' {
  if (tier === 'unknown') {
    return tier;
  }
  return minTier(tier, maxTier);
}

const SECONDARY_LINK_FIELDS: Array<Exclude<LinkField, 'website'>> = [
  'docs',
  'whitepaper',
  'github',
  'twitter',
  'telegram',
  'discord',
  'blog',
];

function emptyLinks(): DiscoveredLinks {
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

function normalizeTokenSlug(tokenName: string | null, tokenSymbol: string | null): string {
  const raw = (tokenName ?? tokenSymbol ?? '').toLowerCase();
  return raw.replace(/[^a-z0-9]/g, '');
}

const TIER_RANK: Record<string, number> = {
  weak: 0,
  limited: 1,
  credible: 2,
  strong: 3,
  institutional_grade: 4,
};

function minTier<T extends OffchainScoreCaps['maxTier']>(left: T, right: T): T {
  return (TIER_RANK[left] <= TIER_RANK[right] ? left : right) as T;
}
