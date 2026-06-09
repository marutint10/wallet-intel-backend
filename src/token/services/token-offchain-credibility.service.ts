import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveOffchainConfig } from './offchain-config';
import { extractCoinGeckoCategories } from './offchain-directory-extraction';
import {
  applyOffchainScoreCaps,
  buildVerifiedCategoryText,
  capCredibilityTier,
  isAggregatorUrl,
  isLikelyMemeToken,
  isTrustedMetadataSource,
  isVerifiedSecondaryLink,
  sanitizeDiscoveredLinks,
  type LinkProvenanceMap,
} from './offchain-link-validation';
import type { DiscoveryMode, OffchainDiscoveryTrace } from './offchain-discovery-types';
import {
  TokenOffchainDiscoveryService,
  type OffchainDiscoveryResult,
} from './token-offchain-discovery.service';
import {
  TokenWebCrawlerService,
  type TokenWebsiteCrawlResult,
} from './token-web-crawler.service';

export type OffChainCredibilityStatus = 'done' | 'partial' | 'error' | 'unknown';
export type OffChainCredibilityRiskLevel =
  | 'low'
  | 'moderate'
  | 'high'
  | 'severe'
  | 'unknown';
export type OffChainCredibilityConfidence = 'low' | 'medium' | 'high';
export type CredibilityTier =
  | 'weak'
  | 'limited'
  | 'credible'
  | 'strong'
  | 'institutional_grade'
  | 'unknown';
export type ProjectCategory =
  | 'infrastructure'
  | 'defi'
  | 'meme'
  | 'gaming'
  | 'ai'
  | 'rwa'
  | 'stablecoin'
  | 'other'
  | 'unknown';

export interface OffChainCredibilityReport {
  status: OffChainCredibilityStatus;
  score: number | null;
  riskLevel: OffChainCredibilityRiskLevel;
  credibilityTier: CredibilityTier;
  verdict: string;
  confidence: OffChainCredibilityConfidence;
  discoveryMode: DiscoveryMode;
  websiteSource: string | null;

  discoveredLinks: {
    website: string | null;
    docs: string | null;
    whitepaper: string | null;
    github: string | null;
    twitter: string | null;
    telegram: string | null;
    discord: string | null;
    blog: string | null;
  };

  officialLinkConfidence: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };

  projectProfile: {
    category: ProjectCategory;
    claimedUseCase: string | null;
    hasClearUseCase: boolean | null;
    hasDocs: boolean | null;
    hasWhitepaper: boolean | null;
    hasGithub: boolean | null;
    hasAuditsMentioned: boolean | null;
    hasTeamInfo: boolean | null;
  };

  credibilitySignals: Array<{
    strength: 'low' | 'medium' | 'high';
    title: string;
    description: string;
    evidence?: string;
    sourceUrl?: string;
  }>;

  riskFlags: Array<{
    severity: 'low' | 'medium' | 'high' | 'severe';
    title: string;
    description: string;
    evidence?: string;
    sourceUrl?: string;
  }>;

  claimChecks: Array<{
    claim: string;
    status: 'supported' | 'partially_supported' | 'unsupported' | 'unknown';
    evidence: string[];
    sourceUrls: string[];
  }>;

  unknowns: string[];
  limitations: string[];
  checkedAt: string;
}

export interface OffChainCredibilityCollectedData {
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
  discovery: OffchainDiscoveryResult;
  crawl: TokenWebsiteCrawlResult | null;
  fetchErrors: string[];
  runtimeLimitations?: string[];
  coinGeckoMetadata?: unknown;
  debugTrace?: OffchainDiscoveryTrace;
}

interface CategoryMatch {
  category: ProjectCategory;
  score: number;
  claimedUseCase: string | null;
}

const MAJOR_CLAIM_PATTERNS: Array<{
  claim: string;
  pattern: RegExp;
  requiresEvidence?: RegExp;
}> = [
  { claim: 'used by major banks', pattern: /used by major banks|major banks globally/i },
  { claim: 'institutional adoption', pattern: /institutional adoption/i },
  { claim: 'government adoption', pattern: /government adoption|adopted by government/i },
  { claim: 'enterprise adoption', pattern: /enterprise adoption/i },
  { claim: 'official partner of', pattern: /official partner of/i },
  { claim: 'audited by', pattern: /audited by/i, requiresEvidence: /audit|security|certik|trail of bits|openzeppelin/i },
  { claim: 'secured by', pattern: /secured by/i },
  { claim: 'backed by', pattern: /backed by/i },
  { claim: 'guaranteed returns', pattern: /guaranteed returns?|guaranteed profit/i },
  { claim: 'risk-free profit', pattern: /risk[- ]free profit|risk[- ]free returns?/i },
  { claim: 'fixed APY', pattern: /fixed apy|fixed return/i },
  { claim: '1000x potential', pattern: /1000x|10000x/i },
  {
    claim: 'revolutionary AI infrastructure',
    pattern: /revolutionary ai infrastructure|ai infrastructure revolution/i,
  },
  { claim: 'real-world adoption', pattern: /real[- ]world adoption/i },
];

const CATEGORY_RULES: Array<{
  category: ProjectCategory;
  patterns: RegExp[];
  useCase: string;
}> = [
  {
    category: 'infrastructure',
    patterns: [
      /oracle/i,
      /data feeds?/i,
      /interoperability/i,
      /bridge/i,
      /network infrastructure/i,
      /middleware/i,
      /node network/i,
      /decentralized services/i,
      /protocol infrastructure/i,
    ],
    useCase: 'Decentralized infrastructure or data services',
  },
  {
    category: 'defi',
    patterns: [
      /\bdex\b/i,
      /\bamm\b/i,
      /lending/i,
      /borrowing/i,
      /yield/i,
      /liquidity/i,
      /staking/i,
      /derivatives/i,
      /vault/i,
      /money market/i,
      /swap/i,
    ],
    useCase: 'Decentralized finance protocol',
  },
  {
    category: 'meme',
    patterns: [
      /\bmeme\b/i,
      /community token/i,
      /\bpepe\b/i,
      /\bdoge\b/i,
      /\bshib\b/i,
      /frog/i,
      /mascot/i,
      /no intrinsic value/i,
      /entertainment/i,
      /community positioning/i,
    ],
    useCase: 'Community or meme token positioning',
  },
  {
    category: 'gaming',
    patterns: [/gaming/i, /play-to-earn/i, /metaverse/i, /nft game/i, /in-game economy/i],
    useCase: 'Gaming or metaverse economy',
  },
  {
    category: 'ai',
    patterns: [
      /artificial intelligence/i,
      /ai agent/i,
      /machine learning/i,
      /\bmodel\b/i,
      /inference/i,
      /compute/i,
    ],
    useCase: 'AI or compute-related services',
  },
  {
    category: 'rwa',
    patterns: [
      /real-world asset/i,
      /\brwa\b/i,
      /tokenized treasury/i,
      /tokenization/i,
      /real estate/i,
      /commodities/i,
      /bonds/i,
    ],
    useCase: 'Real-world asset tokenization',
  },
  {
    category: 'stablecoin',
    patterns: [/stablecoin/i, /\busd\b/i, /pegged/i, /collateralized/i, /reserve/i],
    useCase: 'Stable value or reserve-backed token',
  },
];

const FUNCTIONAL_CATEGORIES = new Set<ProjectCategory>([
  'infrastructure',
  'defi',
  'rwa',
  'stablecoin',
  'gaming',
  'ai',
  'other',
]);

@Injectable()
export class TokenOffchainCredibilityService {
  private readonly logger = new Logger(TokenOffchainCredibilityService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly discovery: TokenOffchainDiscoveryService,
    private readonly webCrawler: TokenWebCrawlerService,
  ) {}

  async buildReport(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
    chain?: string | null;
    dexScreenerProfile?: unknown;
    coinGeckoMetadata?: unknown;
    explorerMetadata?: unknown;
    existingMetadata?: unknown;
    forceRefresh?: boolean;
    debug?: boolean;
  }): Promise<OffChainCredibilityReport & { debugTrace?: OffchainDiscoveryTrace }> {
    const runtime = resolveOffchainConfig(this.config);
    const runtimeLimitations: string[] = [];

    if (!runtime.credibilityEnabled) {
      return buildOffChainCredibilityReport({
        tokenName: safeString(input.tokenName),
        tokenSymbol: safeString(input.tokenSymbol),
        contractAddress: safeString(input.contractAddress)?.toLowerCase() ?? null,
        discovery: emptyDiscoveryResult(),
        crawl: null,
        fetchErrors: ['Off-chain credibility disabled by configuration'],
        runtimeLimitations: ['Off-chain credibility analysis is disabled by configuration.'],
      });
    }

    const fetchErrors: string[] = [];

    try {
      const discovery = await this.discovery.discoverOfficialLinks({
        tokenName: input.tokenName,
        tokenSymbol: input.tokenSymbol,
        contractAddress: input.contractAddress,
        chain: input.chain,
        dexScreenerProfile: input.dexScreenerProfile,
        coinGeckoMetadata: input.coinGeckoMetadata,
        explorerMetadata: input.explorerMetadata,
        existingMetadata: input.existingMetadata,
        forceRefresh: input.forceRefresh,
        debug: input.debug,
      });

      fetchErrors.push(...discovery.errors);

      if (!runtime.crawlEnabled) {
        runtimeLimitations.push('Website crawling is disabled; report may be metadata-only.');
      }
      if (!runtime.braveEnabled) {
        runtimeLimitations.push('Brave search fallback is disabled.');
      }

      let crawl: TokenWebsiteCrawlResult | null = null;
      if (discovery.discoveredLinks.website && runtime.crawlEnabled) {
        try {
          crawl = await this.webCrawler.crawlOfficialWebsite({
            websiteUrl: discovery.discoveredLinks.website,
            tokenName: input.tokenName,
            tokenSymbol: input.tokenSymbol,
            contractAddress: input.contractAddress,
            maxPages: runtime.maxPages,
            bypassCache: input.forceRefresh,
          });
          fetchErrors.push(...crawl.errors);
        } catch (err: unknown) {
          fetchErrors.push(`Website crawl failed: ${getErrorMessage(err)}`);
        }
      }

      const report = buildOffChainCredibilityReport({
        tokenName: safeString(input.tokenName),
        tokenSymbol: safeString(input.tokenSymbol),
        contractAddress: safeString(input.contractAddress)?.toLowerCase() ?? null,
        discovery,
        crawl,
        fetchErrors,
        runtimeLimitations,
        coinGeckoMetadata: input.coinGeckoMetadata,
        debugTrace: discovery.debugTrace,
      });
      if (input.debug && discovery.debugTrace) {
        return { ...report, debugTrace: discovery.debugTrace };
      }
      return report;
    } catch (err: unknown) {
      this.logger.warn(`Off-chain credibility failed: ${getErrorMessage(err)}`);
      return buildOffChainCredibilityReport({
        tokenName: safeString(input.tokenName),
        tokenSymbol: safeString(input.tokenSymbol),
        contractAddress: safeString(input.contractAddress)?.toLowerCase() ?? null,
        discovery: emptyDiscoveryResult(),
        crawl: null,
        fetchErrors: [getErrorMessage(err)],
      });
    }
  }
}

export function buildOffChainCredibilityReport(
  data: OffChainCredibilityCollectedData,
): OffChainCredibilityReport {
  const checkedAt = new Date().toISOString();
  const unknowns: string[] = [];
  const limitations: string[] = [
    'Off-chain credibility is shown separately and is not yet merged into the visible on-chain score.',
    'Off-chain credibility is based on publicly available project metadata and website signals.',
    'Website crawling may miss content hidden behind scripts, captchas, login pages, or blocked requests.',
    'This module does not prove investment safety.',
    ...(data.runtimeLimitations ?? []),
  ];

  const sanitized = sanitizeDiscoveredLinks({
    links: { ...data.discovery.discoveredLinks },
    provenance: { ...data.discovery.linkSources },
    sourceUrls: [...data.discovery.sourceUrls],
    context: {
      tokenName: data.tokenName,
      tokenSymbol: data.tokenSymbol,
      contractAddress: data.contractAddress,
      provenance: data.discovery.linkSources,
      verifiedOfficialWebsite: data.discovery.hasTrustedOfficialWebsite
        ? data.discovery.discoveredLinks.website
        : null,
      crawlMentionsContract: data.crawl?.mentions.contractAddress ?? false,
    },
  });

  const discoveredLinks = sanitized.links;
  const linkSources = sanitized.provenance;
  const officialLinkConfidence = data.discovery.officialLinkConfidence;
  const crawl = sanitizeCrawlForVerifiedWebsite(data.crawl, discoveredLinks.website, linkSources);
  const verifiedCategoryText = buildVerifiedCategoryText({
    tokenName: data.tokenName,
    tokenSymbol: data.tokenSymbol,
    crawl,
    hasTrustedOfficialWebsite: data.discovery.hasTrustedOfficialWebsite,
    officialWebsite: discoveredLinks.website,
  });
  const combinedText = buildVerifiedCombinedText(data, verifiedCategoryText);
  const categoryMatch = detectProjectCategory(data, verifiedCategoryText, data.discovery.metadataCategories);
  const projectProfile = buildProjectProfile(
    { ...data, discovery: { ...data.discovery, discoveredLinks, linkSources } },
    categoryMatch,
    linkSources,
    crawl,
  );
  const claimChecks = buildClaimChecks(combinedText, crawl, projectProfile, linkSources);
  const discoveryMode = data.discovery.discoveryMode ?? 'not_found';
  const scoring = scoreOffChainCredibility({
    data: { ...data, discovery: { ...data.discovery, discoveredLinks, linkSources } },
    projectProfile,
    categoryMatch,
    claimChecks,
    combinedText,
    crawl,
    discoveryMeta: {
      hasTrustedOfficialWebsite: sanitized.hasTrustedOfficialWebsite,
      braveOnlyWebsite: sanitized.braveOnlyWebsite,
      aggregatorWebsiteRejected: sanitized.aggregatorWebsiteRejected,
      officialLinkConfidence: officialLinkConfidence.level,
      discoveryMode,
      hasTrustedDirectoryPresence: data.discovery.trustedDirectoryUrls.length > 0,
    },
  });

  const credibilitySignals = buildCredibilitySignals(
    { ...data, discovery: { ...data.discovery, discoveredLinks } },
    projectProfile,
    categoryMatch,
    combinedText,
  );
  const riskFlags = buildRiskFlags(
    { ...data, discovery: { ...data.discovery, discoveredLinks } },
    projectProfile,
    claimChecks,
    scoring,
    sanitized.aggregatorWebsiteRejected,
    discoveryMode,
  );

  if (!discoveredLinks.website) {
    if (discoveryMode === 'search_only' && data.discovery.trustedDirectoryUrls.length > 0) {
      unknowns.push(
        'Project has market directory presence, but official website could not be verified.',
      );
    } else {
      unknowns.push('Official website could not be verified');
    }
  }
  if (!crawl || crawl.extractedText.length === 0) {
    unknowns.push('Limited or no website crawl text available');
  }
  if (data.fetchErrors.length > 0) {
    unknowns.push(...data.fetchErrors.slice(0, 3));
  }

  const hasUsableData =
    discoveredLinks.website !== null ||
    discoveredLinks.docs !== null ||
    discoveredLinks.github !== null ||
    (crawl?.extractedText.length ?? 0) > 0;

  let status: OffChainCredibilityStatus = 'done';
  if (!hasUsableData) {
    status = scoring.score === null ? 'unknown' : 'partial';
  } else if (
    data.discovery.status === 'partial' ||
    data.discovery.status === 'error' ||
    crawl?.status === 'partial' ||
    crawl?.status === 'error' ||
    data.fetchErrors.length > 0
  ) {
    status = 'partial';
  }

  const confidence = resolveConfidence(data, officialLinkConfidence.level, crawl);
  const riskLevel =
    scoring.score === null && status === 'unknown' ? 'unknown' : scoring.riskLevel;
  const credibilityTier =
    scoring.score === null && status === 'unknown' ? 'unknown' : scoring.credibilityTier;
  const verdict = resolveOffChainVerdict({
    riskLevel,
    credibilityTier,
    category: projectProfile.category,
    officialLinkConfidence,
    hasWebsite: Boolean(discoveredLinks.website),
    hasTrustedOfficialWebsite: sanitized.hasTrustedOfficialWebsite,
    linkMismatch: scoring.linkMismatch,
  });

  return {
    status,
    score: scoring.score,
    riskLevel,
    credibilityTier,
    verdict,
    confidence,
    discoveryMode,
    websiteSource: linkSources.website ?? null,
    discoveredLinks,
    officialLinkConfidence,
    projectProfile,
    credibilitySignals,
    riskFlags,
    claimChecks,
    unknowns,
    limitations,
    checkedAt,
  };
}

export function detectProjectCategory(
  data: OffChainCredibilityCollectedData,
  verifiedText: string,
  metadataCategories: string[] = [],
): CategoryMatch {
  const categoryHaystack = [
    ...metadataCategories,
    ...extractCoinGeckoCategories(data.coinGeckoMetadata),
  ]
    .join(' ')
    .toLowerCase();

  if (categoryHaystack.includes('meme') || /frog|pepe|doge|shib/i.test(categoryHaystack)) {
    return {
      category: 'meme',
      score: 3,
      claimedUseCase: 'Community or meme token positioning',
    };
  }

  if (isLikelyMemeToken(data.tokenName, data.tokenSymbol)) {
    const functionalOnlyText = verifiedText.toLowerCase();
    const functionalHits = CATEGORY_RULES.filter(
      (rule) => rule.category !== 'meme',
    ).reduce(
      (count, rule) =>
        count + rule.patterns.filter((pattern) => pattern.test(functionalOnlyText)).length,
      0,
    );
    if (functionalHits < 2) {
      return {
        category: 'meme',
        score: 2,
        claimedUseCase: 'Community or meme token positioning',
      };
    }
  }

  const haystack = [data.tokenName, data.tokenSymbol, verifiedText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let best: CategoryMatch = { category: 'unknown', score: 0, claimedUseCase: null };

  for (const rule of CATEGORY_RULES) {
    const hits = rule.patterns.filter((pattern) => pattern.test(haystack)).length;
    if (hits > best.score) {
      best = {
        category: rule.category,
        score: hits,
        claimedUseCase: rule.useCase,
      };
    }
  }

  if (best.score === 0 && verifiedText.trim().length > 80) {
    return { category: 'other', score: 1, claimedUseCase: 'General crypto project positioning' };
  }

  return best;
}

export function buildClaimChecks(
  combinedText: string,
  crawl: TokenWebsiteCrawlResult | null,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  linkSources: LinkProvenanceMap,
): OffChainCredibilityReport['claimChecks'] {
  const checks: OffChainCredibilityReport['claimChecks'] = [];
  const evidenceText = combinedText.toLowerCase();
  const verifiedAuditLink = Boolean(
    crawl?.links.audit &&
      isTrustedMetadataSource(linkSources.website) &&
      projectProfile.hasAuditsMentioned,
  );
  const verifiedSecurityLink = Boolean(
    crawl?.links.security &&
      isTrustedMetadataSource(linkSources.website) &&
      projectProfile.hasAuditsMentioned,
  );

  for (const item of MAJOR_CLAIM_PATTERNS) {
    if (!item.pattern.test(combinedText)) {
      continue;
    }

    const evidence: string[] = [];
    const claimSources: string[] = [];

    if (projectProfile.hasDocs === true) {
      evidence.push('Verified documentation link detected');
    }
    if (verifiedAuditLink || verifiedSecurityLink) {
      evidence.push('Verified audit or security link detected on official materials');
      if (crawl?.links.audit) {
        claimSources.push(crawl.links.audit);
      }
      if (crawl?.links.security) {
        claimSources.push(crawl.links.security);
      }
    }
    if (
      (crawl?.signals.adoptionClaims.length ?? 0) > 0 &&
      projectProfile.hasClearUseCase === true
    ) {
      evidence.push('Adoption language found on verified official materials');
    }
    if (item.requiresEvidence && item.requiresEvidence.test(evidenceText) && verifiedAuditLink) {
      evidence.push('Nearby audit/security terminology found on verified materials');
    }

    let status: OffChainCredibilityReport['claimChecks'][number]['status'] = 'unknown';
    if (item.claim === 'audited by' && !verifiedAuditLink && !verifiedSecurityLink) {
      status = 'unsupported';
    } else if (evidence.length >= 2) {
      status = 'supported';
    } else if (evidence.length === 1) {
      status = 'partially_supported';
    } else if (/guaranteed|1000x|risk[- ]free|fixed apy/i.test(item.claim)) {
      status = 'unsupported';
    } else {
      status = 'unsupported';
    }

    checks.push({
      claim: item.claim,
      status,
      evidence,
      sourceUrls: [...new Set(claimSources)].slice(0, 5),
    });
  }

  return checks;
}

export function scoreOffChainCredibility(input: {
  data: OffChainCredibilityCollectedData;
  projectProfile: OffChainCredibilityReport['projectProfile'];
  categoryMatch: CategoryMatch;
  claimChecks: OffChainCredibilityReport['claimChecks'];
  combinedText: string;
  crawl: TokenWebsiteCrawlResult | null;
  discoveryMeta: {
    hasTrustedOfficialWebsite: boolean;
    braveOnlyWebsite: boolean;
    aggregatorWebsiteRejected: boolean;
    officialLinkConfidence: 'low' | 'medium' | 'high';
    discoveryMode: DiscoveryMode;
    hasTrustedDirectoryPresence: boolean;
  };
}): {
  score: number | null;
  riskLevel: OffChainCredibilityRiskLevel;
  credibilityTier: CredibilityTier;
  linkMismatch: boolean;
} {
  const { data, projectProfile, categoryMatch, claimChecks, combinedText, crawl, discoveryMeta } =
    input;
  const links = data.discovery.discoveredLinks;
  const confidence = discoveryMeta.officialLinkConfidence;

  const hasAnyData =
    links.website ||
    links.docs ||
    links.github ||
    crawl?.extractedText ||
    combinedText.trim().length > 0;

  if (!hasAnyData) {
    return { score: null, riskLevel: 'unknown', credibilityTier: 'unknown', linkMismatch: false };
  }

  let score = 50;
  let linkMismatch = false;

  if (!links.website) {
    if (discoveryMeta.discoveryMode === 'search_only' && discoveryMeta.hasTrustedDirectoryPresence) {
      score -= 8;
    } else {
      score -= 20;
    }
  } else if (confidence === 'high') {
    score += 15;
  } else if (confidence === 'medium') {
    score += 8;
  } else if (confidence === 'low') {
    score -= 5;
    linkMismatch = true;
  }

  if (categoryMatch.category === 'meme') {
    if (hasMemePositioning(combinedText)) {
      score += 5;
    }
  } else if (projectProfile.hasClearUseCase) {
    score += 15;
  }
  if (projectProfile.hasDocs) {
    score += 10;
  }
  if (projectProfile.hasWhitepaper) {
    score += 5;
  }
  if (projectProfile.hasGithub) {
    score += 5;
  }
  if (projectProfile.hasAuditsMentioned) {
    score += 5;
  }

  const adoptionEvidence = (crawl?.signals.adoptionClaims.length ?? 0) > 0;
  if (categoryMatch.category === 'infrastructure' && projectProfile.hasDocs && adoptionEvidence) {
    score += 15;
  } else if (
    categoryMatch.category === 'defi' &&
    projectProfile.hasDocs &&
    projectProfile.hasAuditsMentioned
  ) {
    score += 10;
  } else if (categoryMatch.category === 'meme') {
    const pretendsUtility =
      /infrastructure|oracle|lending|institutional|enterprise|ai infrastructure/i.test(
        combinedText,
      ) && !/meme|community|entertainment|frog|doge|pepe/i.test(combinedText);
    if (pretendsUtility && claimChecks.some((check) => check.status === 'unsupported')) {
      score -= 10;
    }
  }

  if (
    !projectProfile.hasDocs &&
    !projectProfile.hasClearUseCase &&
    categoryMatch.category !== 'meme'
  ) {
    score -= 15;
  } else if (
    categoryMatch.category === 'meme' &&
    !projectProfile.hasDocs &&
    !links.twitter &&
    !links.telegram &&
    !links.discord
  ) {
    score -= 8;
  }
  if (crawl?.brokenWebsite) {
    score -= 20;
  }
  const untrustedWebsite =
    data.discovery.officialLinkConfidence.level === 'low' &&
    Boolean(links.website) &&
    crawl &&
    !hasTokenVerification(crawl, data);

  if (linkMismatch || untrustedWebsite) {
    score -= 20;
    linkMismatch = true;
  } else if (
    crawl &&
    !hasTokenVerification(crawl, data) &&
    confidence === 'medium' &&
    (data.tokenName || data.tokenSymbol)
  ) {
    score -= 8;
  }

  const unsupportedClaims = claimChecks.filter((check) => check.status === 'unsupported');
  score -= Math.min(25, unsupportedClaims.length * 10);

  const misleadingPhrases = crawl?.signals.suspiciousPhrases ?? [];
  if (misleadingPhrases.length > 0) {
    score -= 25;
  }

  const fakeAuditClaim = claimChecks.some(
    (check) => check.claim === 'audited by' && check.status === 'unsupported',
  );
  if (fakeAuditClaim) {
    score -= 20;
  }

  score = clamp(Math.round(score), 0, 100);

  const caps = applyOffchainScoreCaps({
    score,
    officialLinkConfidence: confidence,
    hasTrustedOfficialWebsite: discoveryMeta.hasTrustedOfficialWebsite,
    braveOnlyWebsite: discoveryMeta.braveOnlyWebsite,
    aggregatorWebsiteRejected: discoveryMeta.aggregatorWebsiteRejected,
    hasVerifiedOfficialWebsite: Boolean(links.website),
    discoveryMode: discoveryMeta.discoveryMode,
    hasTrustedDirectoryPresence: discoveryMeta.hasTrustedDirectoryPresence,
  });
  score = caps.score;

  let credibilityTier = resolveCredibilityTier(score, projectProfile, adoptionEvidence);
  credibilityTier = capCredibilityTier(credibilityTier, caps.maxTier);
  if (categoryMatch.category === 'meme') {
    if (projectProfile.hasDocs !== true) {
      score = Math.min(score, 69);
    }
    credibilityTier = capCredibilityTier(credibilityTier, 'credible');
  }

  return {
    score,
    riskLevel: resolveRiskLevel(score),
    credibilityTier,
    linkMismatch,
  };
}

function buildProjectProfile(
  data: OffChainCredibilityCollectedData,
  categoryMatch: CategoryMatch,
  linkSources: LinkProvenanceMap,
  crawl: TokenWebsiteCrawlResult | null,
): OffChainCredibilityReport['projectProfile'] {
  const links = data.discovery.discoveredLinks;
  const validationContext = {
    tokenName: data.tokenName,
    tokenSymbol: data.tokenSymbol,
    contractAddress: data.contractAddress,
    provenance: linkSources,
    verifiedOfficialWebsite: data.discovery.hasTrustedOfficialWebsite ? links.website : null,
  };

  const hasDocs = Boolean(
    (links.docs && isVerifiedSecondaryLink(links.docs, 'docs', validationContext)) ||
      (crawl?.links.docs &&
        isVerifiedSecondaryLink(crawl.links.docs, 'docs', validationContext)),
  );
  const hasWhitepaper = Boolean(
    (links.whitepaper &&
      isVerifiedSecondaryLink(links.whitepaper, 'whitepaper', validationContext)) ||
      (crawl?.links.whitepaper &&
        isVerifiedSecondaryLink(crawl.links.whitepaper, 'whitepaper', validationContext)),
  );
  const hasGithub = Boolean(
    (links.github && isVerifiedSecondaryLink(links.github, 'github', validationContext)) ||
      (crawl?.links.github &&
        isVerifiedSecondaryLink(crawl.links.github, 'github', validationContext)),
  );
  const hasAuditsMentioned = Boolean(
    crawl?.signals.hasAuditsMentioned &&
      ((crawl.links.audit &&
        isVerifiedSecondaryLink(crawl.links.audit, 'docs', validationContext)) ||
        (crawl.links.security &&
          isVerifiedSecondaryLink(crawl.links.security, 'docs', validationContext))),
  );
  const hasTeamInfo = Boolean(crawl?.signals.hasTeamInfo);
  const hasClearUseCase =
    FUNCTIONAL_CATEGORIES.has(categoryMatch.category) &&
    (Boolean(crawl?.signals.hasClearUseCase) ||
      categoryMatch.score > 0 ||
      hasDocs);

  return {
    category: categoryMatch.category,
    claimedUseCase: categoryMatch.claimedUseCase,
    hasClearUseCase:
      categoryMatch.category === 'meme'
        ? false
        : crawl
          ? hasClearUseCase
          : hasClearUseCase
            ? true
            : null,
    hasDocs: hasDocs ? true : crawl ? false : null,
    hasWhitepaper: hasWhitepaper ? true : crawl ? false : null,
    hasGithub: hasGithub ? true : crawl ? false : null,
    hasAuditsMentioned: hasAuditsMentioned ? true : crawl ? false : null,
    hasTeamInfo: hasTeamInfo ? true : crawl ? false : null,
  };
}

function buildCredibilitySignals(
  data: OffChainCredibilityCollectedData,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  categoryMatch: CategoryMatch,
  combinedText: string,
): OffChainCredibilityReport['credibilitySignals'] {
  const signals: OffChainCredibilityReport['credibilitySignals'] = [];

  if (projectProfile.hasClearUseCase) {
    signals.push({
      strength: 'high',
      title: 'Clear Project Use Case',
      description: 'Official materials suggest a recognizable functional project purpose.',
      evidence: categoryMatch.claimedUseCase ?? undefined,
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }
  if (projectProfile.hasDocs) {
    signals.push({
      strength: 'high',
      title: 'Documentation Available',
      description: 'Project documentation link was discovered.',
      sourceUrl: data.discovery.discoveredLinks.docs ?? data.crawl?.links.docs ?? undefined,
    });
  }
  if (projectProfile.hasGithub) {
    signals.push({
      strength: 'medium',
      title: 'Developer Resources Found',
      description: 'GitHub or developer resource link was discovered.',
      sourceUrl: data.discovery.discoveredLinks.github ?? data.crawl?.links.github ?? undefined,
    });
  }
  if (projectProfile.hasAuditsMentioned) {
    signals.push({
      strength: 'medium',
      title: 'Audit/Security Information Found',
      description: 'Audit or security references were found in official materials.',
      sourceUrl: data.crawl?.links.audit ?? data.crawl?.links.security ?? undefined,
    });
  }
  if (
    data.discovery.officialLinkConfidence.level === 'high' ||
    data.discovery.officialLinkConfidence.level === 'medium'
  ) {
    signals.push({
      strength: data.discovery.officialLinkConfidence.level === 'high' ? 'high' : 'medium',
      title: 'Official Links Verified',
      description: 'Official website and metadata showed consistent token matching signals.',
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }
  if ((data.crawl?.signals.adoptionClaims.length ?? 0) > 0) {
    signals.push({
      strength: 'medium',
      title: 'Ecosystem/Integration Evidence Found',
      description: 'Official materials mention partnerships, integrations, or ecosystem usage.',
      evidence: data.crawl?.signals.adoptionClaims.slice(0, 2).join(', '),
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }
  if (categoryMatch.category === 'meme' && hasMemePositioning(combinedText)) {
    signals.push({
      strength: 'low',
      title: 'Clear Meme/Community Positioning',
      description: 'Project positioning appears community or meme-driven rather than infrastructure utility.',
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }

  return signals;
}

function buildRiskFlags(
  data: OffChainCredibilityCollectedData,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  claimChecks: OffChainCredibilityReport['claimChecks'],
  scoring: { linkMismatch: boolean },
  aggregatorWebsiteRejected: boolean,
  discoveryMode: DiscoveryMode,
): OffChainCredibilityReport['riskFlags'] {
  const flags: OffChainCredibilityReport['riskFlags'] = [];
  const crawl = data.crawl;

  if (!data.discovery.discoveredLinks.website || aggregatorWebsiteRejected) {
    const directoryPresence = data.discovery.trustedDirectoryUrls.length > 0;
    flags.push({
      severity:
        discoveryMode === 'search_only' && directoryPresence ? 'medium' : 'high',
      title: 'Official Website Not Verified',
      description: aggregatorWebsiteRejected
        ? 'An aggregator listing page was rejected as the official website.'
        : directoryPresence
          ? 'Project has market directory presence, but official website could not be verified.'
          : 'No official website could be discovered from available metadata or search.',
    });
  }
  if (
    scoring.linkMismatch ||
    (data.discovery.officialLinkConfidence.level === 'low' &&
      data.discovery.officialLinkConfidence.reasons.some((reason) =>
        reason.toLowerCase().includes('verify'),
      ))
  ) {
    flags.push({
      severity: 'high',
      title: 'Official Link Mismatch',
      description:
        'Discovered website or project links could not be confidently matched to the token.',
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }
  if (!projectProfile.hasDocs) {
    flags.push({
      severity: 'medium',
      title: 'Limited Project Documentation',
      description: 'No clear documentation link was found in discovered official materials.',
    });
  }
  if (projectProfile.hasClearUseCase === false) {
    flags.push({
      severity: 'medium',
      title: 'No Clear Use Case Found',
      description: 'Official materials did not provide a clear project use-case signal.',
    });
  }
  if (crawl?.brokenWebsite) {
    flags.push({
      severity: 'severe',
      title: 'Broken Website',
      description: 'The discovered official website could not be fetched reliably.',
      sourceUrl: data.discovery.discoveredLinks.website ?? undefined,
    });
  }

  for (const check of claimChecks.filter((item) => item.status === 'unsupported')) {
    flags.push({
      severity: /guaranteed|1000x|risk[- ]free|fixed apy/i.test(check.claim) ? 'severe' : 'high',
      title: 'Unsupported Major Claim',
      description: `An unverified claim requires review: ${check.claim}.`,
      evidence: check.evidence.join('; ') || undefined,
    });
  }

  if ((crawl?.signals.suspiciousPhrases.length ?? 0) > 0) {
    flags.push({
      severity: 'severe',
      title: 'Misleading Investment Language',
      description:
        'Official materials contain high-risk promotional phrases that require careful review.',
      evidence: crawl?.signals.suspiciousPhrases.join(', '),
    });
  }

  const auditClaim = claimChecks.find((check) => check.claim === 'audited by');
  if (auditClaim && auditClaim.status !== 'supported') {
    flags.push({
      severity: 'medium',
      title: 'Audit Claim Requires Review',
      description: 'Audit-related language was found without strong supporting evidence.',
    });
  }

  if (projectProfile.hasGithub === false && projectProfile.category !== 'meme') {
    flags.push({
      severity: 'low',
      title: 'Limited Developer Transparency',
      description: 'No GitHub or developer repository link was discovered.',
    });
  }

  return flags;
}

function resolveOffChainVerdict(input: {
  riskLevel: OffChainCredibilityRiskLevel;
  credibilityTier: CredibilityTier;
  category: ProjectCategory;
  officialLinkConfidence: OffChainCredibilityReport['officialLinkConfidence'];
  hasWebsite: boolean;
  hasTrustedOfficialWebsite: boolean;
  linkMismatch: boolean;
}): string {
  if (!input.hasWebsite && input.riskLevel === 'unknown') {
    return 'Off-chain credibility could not be assessed because official project links were unavailable.';
  }
  if (input.linkMismatch || input.officialLinkConfidence.level === 'low') {
    return 'Off-chain credibility requires review because the discovered website or project links could not be confidently matched to the token.';
  }
  if (
    input.category === 'meme' &&
    input.hasWebsite &&
    input.hasTrustedOfficialWebsite &&
    (input.officialLinkConfidence.level === 'medium' ||
      input.officialLinkConfidence.level === 'high')
  ) {
    return 'Off-chain credibility appears community-driven. Official website/socials may be verified, but project documentation and functional utility evidence are limited compared with infrastructure or DeFi protocols.';
  }
  if (input.category === 'meme' || input.credibilityTier === 'limited') {
    return 'Off-chain credibility appears community-driven or limited. Official links may exist, but project documentation and utility evidence are limited compared with infrastructure or DeFi protocols.';
  }
  if (
    input.credibilityTier === 'institutional_grade' ||
    input.credibilityTier === 'strong' ||
    (input.category === 'infrastructure' && input.riskLevel === 'low')
  ) {
    return 'Off-chain credibility appears strong based on official project, documentation, developer, and infrastructure use-case signals.';
  }
  if (input.riskLevel === 'high' || input.riskLevel === 'severe' || input.credibilityTier === 'weak') {
    return 'Off-chain credibility is limited because official project links, documentation, or clear use-case evidence could not be verified.';
  }
  return 'Off-chain credibility is mixed and should be reviewed alongside on-chain holder and market context signals.';
}

function resolveCredibilityTier(
  score: number,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  adoptionEvidence: boolean,
): CredibilityTier {
  if (
    score >= 90 &&
    projectProfile.hasClearUseCase === true &&
    projectProfile.hasDocs === true &&
    (projectProfile.category === 'infrastructure' || adoptionEvidence)
  ) {
    return 'institutional_grade';
  }
  if (score >= 80) {
    return 'strong';
  }
  if (score >= 65) {
    return 'credible';
  }
  if (score >= 45) {
    return 'limited';
  }
  return 'weak';
}

function resolveRiskLevel(score: number): OffChainCredibilityRiskLevel {
  if (score >= 85) return 'low';
  if (score >= 70) return 'moderate';
  if (score >= 45) return 'high';
  return 'severe';
}

function resolveConfidence(
  data: OffChainCredibilityCollectedData,
  linkConfidence: 'low' | 'medium' | 'high',
  crawl: TokenWebsiteCrawlResult | null,
): OffChainCredibilityConfidence {
  if (!data.discovery.discoveredLinks.website && !crawl) {
    return 'low';
  }
  if (linkConfidence === 'high' && (crawl?.extractedText.length ?? 0) > 200) {
    return 'high';
  }
  if (linkConfidence === 'medium' || (crawl?.extractedText.length ?? 0) > 80) {
    return 'medium';
  }
  return 'low';
}

function buildVerifiedCombinedText(
  data: OffChainCredibilityCollectedData,
  verifiedCategoryText: string,
): string {
  return [verifiedCategoryText, data.tokenName, data.tokenSymbol].filter(Boolean).join('\n');
}

function sanitizeCrawlForVerifiedWebsite(
  crawl: TokenWebsiteCrawlResult | null,
  officialWebsite: string | null,
  linkSources: LinkProvenanceMap,
): TokenWebsiteCrawlResult | null {
  if (!crawl || !officialWebsite) {
    return null;
  }
  if (isAggregatorUrl(officialWebsite) || isAggregatorUrl(crawl.homepageUrl)) {
    return null;
  }
  if (linkSources.website === 'brave') {
    return null;
  }
  return crawl;
}

function hasTokenVerification(
  crawl: TokenWebsiteCrawlResult,
  data: OffChainCredibilityCollectedData,
): boolean {
  return (
    crawl.mentions.tokenName ||
    crawl.mentions.tokenSymbol ||
    crawl.mentions.contractAddress ||
    (!data.tokenName && !data.tokenSymbol)
  );
}

function emptyDiscoveryResult(): OffchainDiscoveryResult {
  return {
    status: 'unknown',
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
    officialLinkConfidence: { level: 'low', reasons: ['Discovery unavailable'] },
    sourceUrls: [],
    errors: [],
    hasTrustedOfficialWebsite: false,
    braveOnlyWebsite: false,
    aggregatorWebsiteRejected: false,
    metadataCategories: [],
    trustedDirectoryUrls: [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasMemePositioning(text: string): boolean {
  return /meme|community token|pepe|doge|shib|frog|mascot|entertainment|community positioning/i.test(
    text,
  );
}
