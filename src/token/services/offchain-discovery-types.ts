import type { MetadataSource } from './offchain-link-validation';

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

export type DiscoveryMode =
  | 'official_verified'
  | 'directory_verified'
  | 'search_only'
  | 'not_found';

export type OffchainLinkKind =
  | 'website'
  | 'docs'
  | 'whitepaper'
  | 'github'
  | 'twitter'
  | 'telegram'
  | 'discord'
  | 'blog'
  | 'directory'
  | 'evidence';

export type OffchainCandidateSource =
  | 'seed'
  | 'dexscreener'
  | 'coingecko'
  | 'coinmarketcap_directory'
  | 'coingecko_directory'
  | 'dexscreener_directory'
  | 'explorer'
  | 'existing'
  | 'brave'
  | 'directory_outbound'
  | 'search_evidence';

export type OffchainLinkCandidate = {
  url: string;
  kind: OffchainLinkKind;
  source: OffchainCandidateSource;
  confidenceHint: 'high' | 'medium' | 'low';
  sourceUrl?: string;
  evidence?: string;
};

export type CandidateAction =
  | 'accepted'
  | 'rejected'
  | 'queued_directory_extraction'
  | 'evidence_only';

export type OffchainDiscoveryTrace = {
  token: {
    name: string;
    symbol: string;
    contractAddress: string;
    chain: string;
  };

  structuredMetadata: {
    dexScreenerWebsitesFound: string[];
    dexScreenerSocialsFound: string[];
    dexScreenerPairCount: number | null;

    coinGeckoHomepageFound: string[];
    coinGeckoTwitterFound: string | null;
    coinGeckoGithubFound: string[];
    coinGeckoCategories: string[];
    coinGeckoPlatforms: Record<string, string>;
    coinGeckoContractMatched: boolean | null;

    explorerWebsiteFound: string | null;
  };

  candidates: Array<{
    url: string;
    kind: string;
    source: string;
    confidenceHint: string;
    action: CandidateAction;
    reason: string;
  }>;

  directoryExtraction: Array<{
    directoryUrl: string;
    identityVerified: boolean;
    outboundLinksFound: string[];
    acceptedOutboundLinks: string[];
    rejectedOutboundLinks: Array<{ url: string; reason: string }>;
  }>;

  brave: {
    enabled: boolean;
    called: boolean;
    queries: string[];
    resultUrls: string[];
    errors: string[];
  };

  finalSelection: {
    discoveryMode: DiscoveryMode;
    website: string | null;
    websiteSource: string | null;
    docs: string | null;
    github: string | null;
    twitter: string | null;
    telegram: string | null;
    discord: string | null;
  };

  cache: {
    discoveryCacheHit: boolean;
    crawlCacheHit: boolean;
    persistedReportUsed: boolean;
    forceRecompute: boolean;
    cacheVersion: string;
  };
};

export function directorySourceFromUrl(url: string): OffchainCandidateSource {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    if (host.includes('coingecko.com')) {
      return 'coingecko_directory';
    }
    if (host.includes('coinmarketcap.com')) {
      return 'coinmarketcap_directory';
    }
    if (host.includes('dexscreener.com')) {
      return 'dexscreener_directory';
    }
  } catch {
    // fall through
  }
  return 'directory_outbound';
}

export function toMetadataSource(source: OffchainCandidateSource): MetadataSource {
  if (source === 'search_evidence') {
    return 'search_evidence';
  }
  return source as MetadataSource;
}

export function isTrustedCandidateSource(source: OffchainCandidateSource): boolean {
  return source !== 'brave' && source !== 'search_evidence';
}

export function emptyDiscoveryTrace(input: {
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
  chain: string | null;
  forceRecompute?: boolean;
}): OffchainDiscoveryTrace {
  return {
    token: {
      name: input.tokenName ?? '',
      symbol: input.tokenSymbol ?? '',
      contractAddress: input.contractAddress ?? '',
      chain: input.chain ?? 'unknown',
    },
    structuredMetadata: {
      dexScreenerWebsitesFound: [],
      dexScreenerSocialsFound: [],
      dexScreenerPairCount: null,
      coinGeckoHomepageFound: [],
      coinGeckoTwitterFound: null,
      coinGeckoGithubFound: [],
      coinGeckoCategories: [],
      coinGeckoPlatforms: {},
      coinGeckoContractMatched: null,
      explorerWebsiteFound: null,
    },
    candidates: [],
    directoryExtraction: [],
    brave: {
      enabled: false,
      called: false,
      queries: [],
      resultUrls: [],
      errors: [],
    },
    finalSelection: {
      discoveryMode: 'not_found',
      website: null,
      websiteSource: null,
      docs: null,
      github: null,
      twitter: null,
      telegram: null,
      discord: null,
    },
    cache: {
      discoveryCacheHit: false,
      crawlCacheHit: false,
      persistedReportUsed: false,
      forceRecompute: Boolean(input.forceRecompute),
      cacheVersion: 'v4',
    },
  };
}

export function resolveDiscoveryMode(input: {
  website: string | null;
  websiteSource: MetadataSource | undefined;
  hasTrustedDirectoryPresence: boolean;
  hasSearchEvidence: boolean;
}): DiscoveryMode {
  if (!input.website) {
    if (input.hasTrustedDirectoryPresence || input.hasSearchEvidence) {
      return 'search_only';
    }
    return 'not_found';
  }

  const source = input.websiteSource;
  if (
    source === 'coingecko' ||
    source === 'dexscreener' ||
    source === 'explorer' ||
    source === 'seed' ||
    source === 'existing'
  ) {
    return 'official_verified';
  }

  if (
    source === 'coingecko_directory' ||
    source === 'coinmarketcap_directory' ||
    source === 'dexscreener_directory' ||
    source === 'directory_outbound' ||
    source === 'directory'
  ) {
    return 'directory_verified';
  }

  if (source === 'brave' || source === 'search_evidence') {
    return 'search_only';
  }

  return 'official_verified';
}

export type EvidenceDiscovery = {
  directoryUrls: string[];
  descriptions: string[];
  categories: string[];
  warnings: string[];
};

export function mergeEvidenceIntoLinks(
  target: DiscoveredLinks,
  evidence: Partial<DiscoveredLinks>,
): void {
  for (const key of Object.keys(target) as Array<keyof DiscoveredLinks>) {
    if (!target[key] && evidence[key]) {
      target[key] = evidence[key];
    }
  }
}
