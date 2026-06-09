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
import {
  TokenOffchainExternalEvidenceService,
  type OffchainEvidenceItem,
  type OffchainExternalEvidenceResult,
} from './token-offchain-external-evidence.service';
import {
  TokenOffchainAiClassifierService,
  type OffchainAiClassifierDebug,
  type OffchainAiProjectClassification,
} from './token-offchain-ai-classifier.service';

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
  pipelineVersion?: string;
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
  externalEvidence?: OffchainExternalEvidenceResult;
  projectUnderstanding?: {
    source: 'deterministic' | 'ai' | 'ai_with_fallback';
    category: string;
    categoryLabel?: string;
    categoryConfidence?: 'high' | 'medium' | 'low';
    claimedUseCase: string | null;
    hasClearUseCase: boolean | null;
    useCaseConfidence?: 'high' | 'medium' | 'low' | 'unknown';
    identityStatus?: 'verified' | 'partially_verified' | 'unverified' | 'unknown';
    evidenceQuality?: 'strong' | 'moderate' | 'weak' | 'limited';
    possibleNarrative?: string | null;
    externalValidation: 'strong' | 'moderate' | 'weak' | 'none';
    communitySignal: 'strong' | 'moderate' | 'weak' | 'unknown';
    negativeRiskEvidence: 'none_found' | 'low' | 'medium' | 'high';
    evidenceRefs: string[];
    warnings?: string[];
  };
  aiClassifierDebug?: OffchainAiClassifierDebug;
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
  externalEvidence?: OffchainExternalEvidenceResult;
  aiClassification?: OffchainAiProjectClassification | null;
  aiClassifierDebug?: OffchainAiClassifierDebug;
}

interface CategoryMatch {
  category: ProjectCategory;
  score: number;
  claimedUseCase: string | null;
  evidenceRefs?: string[];
  externalValidation?: 'strong' | 'moderate' | 'weak' | 'none';
  communitySignal?: 'strong' | 'moderate' | 'weak' | 'unknown';
  negativeRiskEvidence?: 'none_found' | 'low' | 'medium' | 'high';
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
      /\bccip\b/i,
      /automation/i,
      /smart contracts?/i,
      /developer docs?/i,
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
      /\bamm\b/i,
      /lending/i,
      /borrowing/i,
      /yield/i,
      /staking/i,
      /derivatives/i,
      /vault/i,
      /money market/i,
      /dex protocol/i,
      /swap protocol/i,
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
      /real world asset/i,
      /\brwa\b/i,
      /tokenized treasury/i,
      /tokenized real[- ]world assets?/i,
      /tokenized funds?/i,
      /institutional[- ]grade finance/i,
      /institutional on-chain finance/i,
      /on-chain finance/i,
      /\bondo\b/i,
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
    private readonly externalEvidence: TokenOffchainExternalEvidenceService,
    private readonly aiClassifier: TokenOffchainAiClassifierService,
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
      if (!runtime.externalEvidenceEnabled) {
        runtimeLimitations.push('External open-web evidence collection is disabled.');
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

      let externalEvidence: OffchainExternalEvidenceResult | undefined;
      try {
        externalEvidence = await this.externalEvidence.collectEvidence({
          tokenName: input.tokenName,
          tokenSymbol: input.tokenSymbol,
          contractAddress: input.contractAddress,
          chain: input.chain,
          discoveredLinks: discovery.discoveredLinks,
          forceRefresh: input.forceRefresh,
        });
        if (externalEvidence.status === 'partial' || externalEvidence.status === 'failed') {
          fetchErrors.push(...(externalEvidence.errors ?? ['External evidence collection incomplete']));
        }
      } catch (err: unknown) {
        externalEvidence = {
          status: 'failed',
          evidenceItems: [],
          summary: {
            trustedDirectoryCount: 0,
            officialSourceCount: 0,
            externalValidationCount: 0,
            riskWarningCount: 0,
            scamWarningCount: 0,
            unrelatedCount: 0,
          },
          errors: [getErrorMessage(err)],
        };
        fetchErrors.push(`External evidence failed: ${getErrorMessage(err)}`);
      }

      const aiClassifierResult = await this.aiClassifier.classifyWithDebug({
        tokenName: input.tokenName,
        tokenSymbol: input.tokenSymbol,
        contractAddress: input.contractAddress,
        chain: input.chain,
        discoveredLinks: discovery.discoveredLinks,
        websiteSource: discovery.linkSources.website ?? null,
        discoveryMode: discovery.discoveryMode,
        officialLinkConfidence: discovery.officialLinkConfidence.level,
        crawl,
        externalEvidence,
        metadataCategories: discovery.metadataCategories,
        forceRefresh: input.forceRefresh,
      });
      this.logger.log(
        `Off-chain AI classifier selected source=${aiClassifierResult.debug.resultSource} ` +
          `enabled=${aiClassifierResult.debug.enabled} attempted=${aiClassifierResult.debug.attempted} ` +
          `skip=${aiClassifierResult.debug.skippedReason ?? 'none'} ` +
          `failure=${aiClassifierResult.debug.failureReason ?? 'none'}`,
      );

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
        externalEvidence,
        aiClassification: aiClassifierResult.classification,
        aiClassifierDebug: aiClassifierResult.debug,
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
  const rawDeterministicCategoryMatch = detectProjectCategory(
    { ...data, discovery: { ...data.discovery, discoveredLinks, linkSources } },
    verifiedCategoryText,
    data.discovery.metadataCategories,
    { externalEvidence: data.externalEvidence, crawl, discoveredLinks },
  );
  const deterministicCategoryMatch = applyWeakIdentityDeterministicGuard(
    rawDeterministicCategoryMatch,
    {
      discoveredLinks,
      discoveryMode: data.discovery.discoveryMode,
      officialLinkConfidence: officialLinkConfidence.level,
      externalEvidence: data.externalEvidence,
      crawl,
    },
  );
  const categoryMatch = data.aiClassification
    ? applyAiCategoryMatch(deterministicCategoryMatch, data.aiClassification)
    : deterministicCategoryMatch;
  const projectProfile = buildProjectProfile(
    { ...data, discovery: { ...data.discovery, discoveredLinks, linkSources } },
    categoryMatch,
    linkSources,
    crawl,
    data.externalEvidence,
  );
  const finalProjectProfile = applyAiProjectProfile(projectProfile, data.aiClassification);
  const projectUnderstanding = buildProjectUnderstanding(
    categoryMatch,
    finalProjectProfile,
    data.externalEvidence,
    data.aiClassification,
  );
  const claimChecks = buildClaimChecks(
    combinedText,
    crawl,
    finalProjectProfile,
    linkSources,
    data.externalEvidence,
  );
  const discoveryMode = data.discovery.discoveryMode ?? 'not_found';
  const scoring = scoreOffChainCredibility({
    data: { ...data, discovery: { ...data.discovery, discoveredLinks, linkSources } },
    projectProfile: finalProjectProfile,
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
    externalEvidence: data.externalEvidence,
  });

  const credibilitySignals = buildCredibilitySignals(
    { ...data, discovery: { ...data.discovery, discoveredLinks } },
    finalProjectProfile,
    categoryMatch,
    combinedText,
    data.externalEvidence,
  );
  const riskFlags = buildRiskFlags(
    { ...data, discovery: { ...data.discovery, discoveredLinks } },
    finalProjectProfile,
    claimChecks,
    scoring,
    sanitized.aggregatorWebsiteRejected,
    discoveryMode,
    data.externalEvidence,
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
  if (data.externalEvidence?.status === 'failed') {
    unknowns.push('External open-web evidence collection failed');
  } else if (data.externalEvidence?.status === 'partial') {
    unknowns.push('External open-web evidence collection was partial');
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
    category: finalProjectProfile.category,
    officialLinkConfidence,
    hasWebsite: Boolean(discoveredLinks.website),
    hasTrustedOfficialWebsite: sanitized.hasTrustedOfficialWebsite,
    linkMismatch: scoring.linkMismatch,
    hasClearUseCase: finalProjectProfile.hasClearUseCase,
    hasDocs: finalProjectProfile.hasDocs,
    hasGithub: finalProjectProfile.hasGithub,
    externalValidation: projectUnderstanding.externalValidation,
    negativeRiskEvidence: projectUnderstanding.negativeRiskEvidence,
  });

  return {
    pipelineVersion: 'offchain-v2-evidence',
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
    projectProfile: finalProjectProfile,
    credibilitySignals,
    riskFlags,
    claimChecks,
    unknowns,
    limitations,
    checkedAt,
    externalEvidence: data.externalEvidence,
    projectUnderstanding,
    aiClassifierDebug: data.aiClassifierDebug
      ? {
          ...data.aiClassifierDebug,
          resultSource: data.aiClassification ? 'ai' : 'deterministic',
        }
      : undefined,
  };
}

export function detectProjectCategory(
  data: OffChainCredibilityCollectedData,
  verifiedText: string,
  metadataCategories: string[] = [],
  signals?: {
    externalEvidence?: OffchainExternalEvidenceResult;
    crawl?: TokenWebsiteCrawlResult | null;
    discoveredLinks?: OffChainCredibilityReport['discoveredLinks'];
  },
): CategoryMatch {
  const metadataText = [
    ...metadataCategories,
    ...extractCoinGeckoCategories(data.coinGeckoMetadata),
  ]
    .join(' ')
    .toLowerCase();

  const links = signals?.discoveredLinks ?? data.discovery.discoveredLinks;
  const externalEvidence = signals?.externalEvidence;
  const evidenceText = buildExternalEvidenceText(externalEvidence);
  const linkText = Object.values(links).filter(Boolean).join(' ');
  const crawlText = signals?.crawl?.extractedText ?? '';
  const haystack = [data.tokenName, data.tokenSymbol, verifiedText, crawlText, linkText, evidenceText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const scores = new Map<ProjectCategory, number>();
  const evidenceRefs: string[] = [];
  const addScore = (category: ProjectCategory, amount: number) => {
    scores.set(category, (scores.get(category) ?? 0) + amount);
  };

  for (const rule of CATEGORY_RULES) {
    const verifiedHits = rule.patterns.filter((pattern) => pattern.test(verifiedText)).length;
    const crawlHits = rule.patterns.filter((pattern) => pattern.test(crawlText)).length;
    const externalHits = rule.patterns.filter((pattern) => pattern.test(evidenceText)).length;
    const metadataHits = rule.patterns.filter((pattern) => pattern.test(metadataText)).length;
    addScore(rule.category, verifiedHits * 3 + crawlHits * 2 + externalHits + metadataHits);
  }

  if (hasInfrastructureLinkEvidence(links, externalEvidence)) {
    addScore('infrastructure', 5);
    evidenceRefs.push(...collectEvidenceRefs(externalEvidence, ['developer_resource', 'official_docs', 'official_security', 'official_whitepaper']));
  }
  if (/docs\.chain\.link|smartcontractkit|chainlink|ccip|data feeds?|oracle|automation|proof of reserve/i.test(haystack)) {
    addScore('infrastructure', 4);
  }
  if (/github|developer api|rpc|middleware|node service|validator|indexing/i.test(linkText)) {
    addScore('infrastructure', 2);
  }
  if (
    /ondo\.foundation|docs\.ondo\.foundation|tokenized real[- ]world assets?|institutional[- ]grade finance|institutional on-chain finance|ondao|ondo dao|flux finance|governance token/i.test(
      haystack,
    )
  ) {
    addScore('rwa', 6);
  }

  const memeMetadataHints = /\bmeme|memecoin|frog|pepe|doge|shib/i.test(metadataText) ? 1 : 0;
  const memeNameHint = isLikelyMemeToken(data.tokenName, data.tokenSymbol) ? 2 : 0;
  const memeOfficialHits = /\bmeme\b|memecoin|community token|no intrinsic value|frog|mascot|entertainment/i.test(
    `${verifiedText} ${crawlText}`,
  )
    ? 3
    : 0;
  const memeExternalHits = externalEvidence
    ? externalEvidence.evidenceItems.filter(
        (item) =>
          item.relevance !== 'low' &&
          /meme|memecoin|community token|frog|pepe|doge|shib/i.test(
            `${item.title ?? ''} ${item.snippet ?? ''}`,
          ),
      ).length
    : 0;
  const memeScore = memeNameHint + memeOfficialHits + memeExternalHits + memeMetadataHints;
  if (memeScore > 0) {
    addScore('meme', memeScore);
  }

  const functionalBest = [...scores.entries()]
    .filter(([category]) => category !== 'meme' && category !== 'unknown')
    .sort((left, right) => right[1] - left[1])[0];
  const meme = scores.get('meme') ?? 0;
  const defiIsMarketOnly =
    functionalBest?.[0] === 'defi' && !hasDefiProtocolEvidence(haystack);

  if (meme >= 4 && (defiIsMarketOnly || !functionalBest || functionalBest[1] < 3)) {
    return {
      category: 'meme',
      score: meme,
      claimedUseCase: 'Community-driven meme token',
      evidenceRefs: collectEvidenceRefs(externalEvidence, ['community_social', 'trusted_directory', 'official_website']),
      externalValidation: resolveExternalValidation(externalEvidence),
      communitySignal: resolveCommunitySignal(externalEvidence, haystack),
      negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
    };
  }

  if (functionalBest && functionalBest[1] >= Math.max(3, meme + 2) && !defiIsMarketOnly) {
    return {
      category: functionalBest[0],
      score: functionalBest[1],
      claimedUseCase: resolveClaimedUseCase(functionalBest[0], haystack),
      evidenceRefs,
      externalValidation: resolveExternalValidation(externalEvidence),
      communitySignal: resolveCommunitySignal(externalEvidence, haystack),
      negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
    };
  }

  if (meme >= 4 && (!functionalBest || functionalBest[1] < 3)) {
    return {
      category: 'meme',
      score: meme,
      claimedUseCase: 'Community-driven meme token',
      evidenceRefs: collectEvidenceRefs(externalEvidence, ['community_social', 'trusted_directory']),
      externalValidation: resolveExternalValidation(externalEvidence),
      communitySignal: resolveCommunitySignal(externalEvidence, haystack),
      negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
    };
  }

  let best: CategoryMatch = { category: 'unknown', score: 0, claimedUseCase: null };

  for (const rule of CATEGORY_RULES.filter((rule) => rule.category !== 'meme')) {
    const hits = scores.get(rule.category) ?? 0;
    if (hits > best.score && hits >= 2) {
      best = {
        category: rule.category,
        score: hits,
        claimedUseCase: resolveClaimedUseCase(rule.category, haystack),
        evidenceRefs,
        externalValidation: resolveExternalValidation(externalEvidence),
        communitySignal: resolveCommunitySignal(externalEvidence, haystack),
        negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
      };
    }
  }

  if (best.score === 0 && verifiedText.trim().length > 160) {
    return {
      category: 'other',
      score: 1,
      claimedUseCase: 'General crypto project positioning',
      externalValidation: resolveExternalValidation(externalEvidence),
      communitySignal: resolveCommunitySignal(externalEvidence, haystack),
      negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
    };
  }

  return {
    ...best,
    externalValidation: resolveExternalValidation(externalEvidence),
    communitySignal: resolveCommunitySignal(externalEvidence, haystack),
    negativeRiskEvidence: resolveNegativeRiskEvidence(externalEvidence),
  };
}

function hasDefiProtocolEvidence(text: string): boolean {
  return /lending|borrowing|amm|dex protocol|swap protocol|vault|yield protocol|money market|staking protocol|derivatives protocol/i.test(
    text,
  );
}

function buildExternalEvidenceText(externalEvidence?: OffchainExternalEvidenceResult): string {
  return (
    externalEvidence?.evidenceItems
      .filter((item) => item.relevance !== 'low')
      .map((item) => `${item.title ?? ''} ${item.snippet ?? ''} ${item.url ?? ''}`)
      .join('\n') ?? ''
  );
}

function hasInfrastructureLinkEvidence(
  links: OffChainCredibilityReport['discoveredLinks'],
  externalEvidence?: OffchainExternalEvidenceResult,
): boolean {
  if (links.github || /chain\.link|smartcontractkit/i.test(Object.values(links).filter(Boolean).join(' '))) {
    return true;
  }
  return Boolean(
    externalEvidence?.evidenceItems.some(
      (item) =>
        item.relevance !== 'low' &&
        ['developer_resource', 'official_github'].includes(
          item.sourceType,
        ),
    ),
  );
}

function collectEvidenceRefs(
  externalEvidence: OffchainExternalEvidenceResult | undefined,
  sourceTypes: string[],
): string[] {
  return (
    externalEvidence?.evidenceItems
      .filter((item) => sourceTypes.includes(item.sourceType) && item.relevance !== 'low')
      .map((item) => item.id)
      .slice(0, 8) ?? []
  );
}

function resolveClaimedUseCase(category: ProjectCategory, text: string): string | null {
  if (category === 'infrastructure') {
    if (/oracle|data feeds?/i.test(text)) {
      return 'Oracle, data feeds, and smart contract infrastructure';
    }
    if (/ccip|interoperability|bridge/i.test(text)) {
      return 'Cross-chain interoperability and protocol infrastructure';
    }
    if (/automation|security|developer docs?/i.test(text)) {
      return 'Developer and protocol infrastructure services';
    }
    return 'Decentralized infrastructure or data services';
  }
  if (category === 'rwa') {
    if (/ondo|tokenized real[- ]world assets?|institutional[- ]grade finance|institutional on-chain finance|flux finance/i.test(text)) {
      return 'Tokenized real-world assets and institutional-grade on-chain finance';
    }
    return 'Real-world asset tokenization';
  }
  return CATEGORY_RULES.find((rule) => rule.category === category)?.useCase ?? null;
}

function resolveExternalValidation(
  externalEvidence?: OffchainExternalEvidenceResult,
): 'strong' | 'moderate' | 'weak' | 'none' {
  if (!externalEvidence || externalEvidence.status === 'skipped') {
    return 'none';
  }
  const highValue = externalEvidence.evidenceItems.filter(
    (item) =>
      item.relevance === 'high' &&
      ['official_website', 'official_docs', 'developer_resource', 'trusted_directory', 'news', 'audit_report'].includes(
        item.sourceType,
      ),
  ).length;
  const mediumValue = externalEvidence.evidenceItems.filter(
    (item) =>
      item.relevance !== 'low' &&
      ['trusted_directory', 'developer_resource', 'news', 'security_report', 'audit_report'].includes(
        item.sourceType,
      ),
  ).length;
  if (highValue >= 2 || externalEvidence.summary.externalValidationCount >= 4) {
    return 'strong';
  }
  if (highValue >= 1 || mediumValue >= 2) {
    return 'moderate';
  }
  return mediumValue > 0 ? 'weak' : 'none';
}

function resolveCommunitySignal(
  externalEvidence: OffchainExternalEvidenceResult | undefined,
  text: string,
): 'strong' | 'moderate' | 'weak' | 'unknown' {
  const socialCount =
    externalEvidence?.evidenceItems.filter((item) => item.sourceType === 'community_social').length ?? 0;
  const memeText = /meme|memecoin|community token|frog|pepe|doge|shib/i.test(text);
  if (socialCount >= 3 || (socialCount >= 1 && memeText)) {
    return 'strong';
  }
  if (socialCount >= 1 || memeText) {
    return 'moderate';
  }
  return externalEvidence ? 'weak' : 'unknown';
}

function resolveNegativeRiskEvidence(
  externalEvidence?: OffchainExternalEvidenceResult,
): 'none_found' | 'low' | 'medium' | 'high' {
  if (!externalEvidence) {
    return 'none_found';
  }
  const contractMatched = externalEvidence.evidenceItems.filter(
    (item) =>
      (item.sourceType === 'scam_warning' || item.sourceType === 'risk_warning') &&
      item.matchedContractAddress,
  ).length;
  if (contractMatched > 0 || externalEvidence.summary.scamWarningCount >= 2) {
    return 'high';
  }
  if (externalEvidence.summary.scamWarningCount > 0 || externalEvidence.summary.riskWarningCount > 1) {
    return 'medium';
  }
  if (externalEvidence.summary.riskWarningCount > 0) {
    return 'low';
  }
  return 'none_found';
}

function buildProjectUnderstanding(
  categoryMatch: CategoryMatch,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  externalEvidence?: OffchainExternalEvidenceResult,
  aiClassification?: OffchainAiProjectClassification | null,
): NonNullable<OffChainCredibilityReport['projectUnderstanding']> {
  if (aiClassification) {
    return {
      source: 'ai',
      category: aiClassification.normalizedCategory,
      categoryLabel: aiClassification.categoryLabel,
      categoryConfidence: aiClassification.categoryConfidence,
      claimedUseCase: aiClassification.claimedUseCase,
      hasClearUseCase: aiClassification.hasClearUseCase,
      useCaseConfidence: aiClassification.useCaseConfidence,
      identityStatus: aiClassification.identityStatus,
      evidenceQuality: aiClassification.evidenceQuality,
      possibleNarrative: aiClassification.possibleNarrative,
      externalValidation: categoryMatch.externalValidation ?? resolveExternalValidation(externalEvidence),
      communitySignal: categoryMatch.communitySignal ?? resolveCommunitySignal(externalEvidence, ''),
      negativeRiskEvidence:
        categoryMatch.negativeRiskEvidence ?? resolveNegativeRiskEvidence(externalEvidence),
      evidenceRefs: aiClassification.evidenceRefs,
      warnings: aiClassification.warnings,
    };
  }

  return {
    source: 'deterministic',
    category: projectProfile.category,
    claimedUseCase: projectProfile.claimedUseCase,
    hasClearUseCase: projectProfile.hasClearUseCase,
    externalValidation: categoryMatch.externalValidation ?? resolveExternalValidation(externalEvidence),
    communitySignal: categoryMatch.communitySignal ?? resolveCommunitySignal(externalEvidence, ''),
    negativeRiskEvidence:
      categoryMatch.negativeRiskEvidence ?? resolveNegativeRiskEvidence(externalEvidence),
    evidenceRefs: categoryMatch.evidenceRefs ?? collectEvidenceRefs(externalEvidence, [
      'official_website',
      'official_docs',
      'developer_resource',
      'trusted_directory',
      'news',
    ]),
  };
}

function applyAiCategoryMatch(
  fallback: CategoryMatch,
  aiClassification: OffchainAiProjectClassification,
): CategoryMatch {
  const mappedCategory = mapAiCategoryToProjectCategory(aiClassification.normalizedCategory);
  const score =
    aiClassification.categoryConfidence === 'high'
      ? 6
      : aiClassification.categoryConfidence === 'medium'
        ? 3
        : 1;
  return {
    ...fallback,
    category: mappedCategory,
    score,
    claimedUseCase: aiClassification.claimedUseCase,
    evidenceRefs: aiClassification.evidenceRefs,
  };
}

function applyWeakIdentityDeterministicGuard(
  categoryMatch: CategoryMatch,
  input: {
    discoveredLinks: OffChainCredibilityReport['discoveredLinks'];
    discoveryMode: DiscoveryMode;
    officialLinkConfidence: 'high' | 'medium' | 'low';
    externalEvidence?: OffchainExternalEvidenceResult;
    crawl: TokenWebsiteCrawlResult | null;
  },
): CategoryMatch {
  const weakIdentity =
    !input.discoveredLinks.website ||
    input.discoveryMode === 'search_only' ||
    input.officialLinkConfidence === 'low';
  if (!weakIdentity) {
    return categoryMatch;
  }
  if (categoryMatch.category !== 'infrastructure' && categoryMatch.category !== 'defi') {
    return categoryMatch;
  }

  const text = [
    input.crawl?.extractedText ?? '',
    ...(input.externalEvidence?.evidenceItems
      .filter((item) => item.relevance !== 'low')
      .map((item) => `${item.title ?? ''} ${item.snippet ?? ''} ${item.url ?? ''}`) ?? []),
  ].join('\n');

  const hasSpecificInfrastructure =
    /oracle|data feeds?|ccip|interoperability|bridge|rpc|indexing|validator|node service|middleware|developer api|protocol infrastructure|automation/i.test(
      text,
    );
  const hasDefiProtocol =
    /lending|borrowing|amm|dex protocol|vault|yield protocol|money market|staking protocol/i.test(
      text,
    );

  if (categoryMatch.category === 'infrastructure' && hasSpecificInfrastructure) {
    return categoryMatch;
  }
  if (categoryMatch.category === 'defi' && hasDefiProtocol) {
    return categoryMatch;
  }

  return {
    ...categoryMatch,
    category: 'unknown',
    score: 0,
    claimedUseCase: null,
    evidenceRefs: [],
  };
}

function applyAiProjectProfile(
  projectProfile: OffChainCredibilityReport['projectProfile'],
  aiClassification?: OffchainAiProjectClassification | null,
): OffChainCredibilityReport['projectProfile'] {
  if (!aiClassification) {
    return projectProfile;
  }

  return {
    ...projectProfile,
    category: mapAiCategoryToProjectCategory(aiClassification.normalizedCategory),
    claimedUseCase: aiClassification.claimedUseCase,
    hasClearUseCase: aiClassification.hasClearUseCase,
  };
}

function mapAiCategoryToProjectCategory(
  category: OffchainAiProjectClassification['normalizedCategory'],
): ProjectCategory {
  if (
    category === 'meme' ||
    category === 'defi' ||
    category === 'infrastructure' ||
    category === 'gaming' ||
    category === 'ai' ||
    category === 'rwa' ||
    category === 'stablecoin' ||
    category === 'unknown'
  ) {
    return category;
  }
  return 'other';
}

export function buildClaimChecks(
  combinedText: string,
  crawl: TokenWebsiteCrawlResult | null,
  projectProfile: OffChainCredibilityReport['projectProfile'],
  linkSources: LinkProvenanceMap,
  externalEvidence?: OffchainExternalEvidenceResult,
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

    if (item.claim === 'audited by' && (verifiedAuditLink || verifiedSecurityLink)) {
      evidence.push('Verified audit or security link detected on official materials');
      if (crawl?.links.audit) {
        claimSources.push(crawl.links.audit);
      }
      if (crawl?.links.security) {
        claimSources.push(crawl.links.security);
      }
    }
    if (
      item.claim === 'secured by' &&
      verifiedSecurityLink &&
      /secured by|security|staking|cryptoeconomic security|proof of reserve|decentralized oracle network/i.test(
        evidenceText,
      )
    ) {
      evidence.push('Official security material contains security or cryptoeconomic-security language');
      if (crawl?.links.security) {
        claimSources.push(crawl.links.security);
      }
    }
    if (
      isAdoptionClaim(item.claim) &&
      (crawl?.signals.adoptionClaims.length ?? 0) > 0 &&
      projectProfile.hasClearUseCase === true
    ) {
      evidence.push('Adoption language found on verified official materials');
    }
    if (item.claim === 'audited by' && item.requiresEvidence && item.requiresEvidence.test(evidenceText) && verifiedAuditLink) {
      evidence.push('Nearby audit/security terminology found on verified materials');
    }

    const matchingExternalEvidence = findExternalEvidenceForClaim(item.claim, externalEvidence);
    for (const evidenceItem of matchingExternalEvidence) {
      evidence.push(`External evidence ${evidenceItem.id}: ${evidenceItem.reason}`);
      if (evidenceItem.url) {
        claimSources.push(evidenceItem.url);
      }
    }

    let status: OffChainCredibilityReport['claimChecks'][number]['status'] = 'unknown';
    if (item.claim === 'audited by' && !verifiedAuditLink && !verifiedSecurityLink) {
      status = 'unsupported';
    } else if (item.claim === 'backed by' && matchingExternalEvidence.length === 0) {
      status = 'unsupported';
    } else if (item.claim === 'secured by' && evidence.length === 0) {
      status = 'unsupported';
    } else if (isAdoptionClaim(item.claim) && evidence.length === 0) {
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

function isAdoptionClaim(claim: string): boolean {
  return /institutional|enterprise|partner|real-world adoption|used by major banks|government adoption|official partner/i.test(
    claim,
  );
}

function findExternalEvidenceForClaim(
  claim: string,
  externalEvidence?: OffchainExternalEvidenceResult,
): OffchainEvidenceItem[] {
  if (!externalEvidence) {
    return [];
  }
  const items = externalEvidence.evidenceItems.filter((item) => item.relevance !== 'low');
  if (/audited by/i.test(claim)) {
    return items
      .filter((item) => item.sourceType === 'audit_report' || item.sourceType === 'official_security')
      .slice(0, 2);
  }
  if (/institutional|enterprise|partner|real-world adoption|used by major banks/i.test(claim)) {
    return items
      .filter(
        (item) =>
          ['news', 'trusted_directory', 'official_website', 'official_docs'].includes(item.sourceType) &&
          /partner|integration|integrated|enterprise|institution|used by|adoption/i.test(
            `${item.title ?? ''} ${item.snippet ?? ''}`,
          ),
      )
      .slice(0, 2);
  }
  if (/backed by/i.test(claim)) {
    return items
      .filter(
        (item) =>
          ['news', 'trusted_directory'].includes(item.sourceType) &&
          /backed by|funding|investor|raised|venture|capital/i.test(
            `${item.title ?? ''} ${item.snippet ?? ''}`,
          ),
      )
      .slice(0, 2);
  }
  return [];
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
  externalEvidence?: OffchainExternalEvidenceResult;
}): {
  score: number | null;
  riskLevel: OffChainCredibilityRiskLevel;
  credibilityTier: CredibilityTier;
  linkMismatch: boolean;
} {
  const { data, projectProfile, categoryMatch, claimChecks, combinedText, crawl, discoveryMeta, externalEvidence } =
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
  if (projectProfile.hasClearUseCase && categoryMatch.category === 'meme') {
    score += 5;
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

  const externalValidation = resolveExternalValidation(externalEvidence);
  if (externalValidation === 'strong') {
    score += 10;
  } else if (externalValidation === 'moderate') {
    score += 6;
  } else if (externalValidation === 'weak') {
    score += 2;
  }

  const negativeRiskEvidence = resolveNegativeRiskEvidence(externalEvidence);
  if (negativeRiskEvidence === 'high') {
    score -= 30;
  } else if (negativeRiskEvidence === 'medium') {
    score -= 18;
  } else if (negativeRiskEvidence === 'low') {
    score -= 8;
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

  if (
    categoryMatch.category === 'unknown' &&
    !links.website &&
    externalValidation === 'none' &&
    !projectProfile.hasClearUseCase
  ) {
    score = Math.min(score, 44);
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

  const hasDocs = projectProfile.hasDocs === true;
  const hasGithub = projectProfile.hasGithub === true;
  const hasWhitepaper = projectProfile.hasWhitepaper === true;
  const noDeepProjectMaterials = !hasDocs && !hasGithub && !hasWhitepaper;
  if (score >= 100) {
    score = 97;
  }
  if (confidence === 'low') {
    score = Math.min(score, 55);
  }
  if (data.discovery.status === 'partial') {
    score = Math.min(score, 85);
  }
  if (unsupportedClaims.length > 0) {
    score = Math.min(score, 90);
  }
  if (noDeepProjectMaterials) {
    score = Math.min(score, 78);
  }
  if (categoryMatch.category === 'meme' && noDeepProjectMaterials) {
    score = Math.min(score, 75);
  }
  if (discoveryMeta.discoveryMode === 'search_only' || confidence === 'low') {
    score = Math.min(score, 45);
  }
  if (
    data.aiClassifierDebug?.enabled &&
    data.aiClassifierDebug.provider === 'gemini' &&
    data.aiClassifierDebug.resultSource === 'deterministic'
  ) {
    score = Math.min(score, categoryMatch.category === 'meme' ? 75 : 85);
  }

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
  externalEvidence?: OffchainExternalEvidenceResult,
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
  const hasExternalUseCase = Boolean(
    externalEvidence?.evidenceItems.some(
      (item) =>
        item.relevance !== 'low' &&
        ['developer_resource', 'official_docs', 'official_security', 'official_whitepaper', 'news'].includes(
          item.sourceType,
        ) &&
        /oracle|data feeds?|infrastructure|protocol|interoperability|ccip|automation|smart contracts?|developer|docs?|defi|security|bridge/i.test(
          `${item.title ?? ''} ${item.snippet ?? ''} ${item.url ?? ''}`,
        ),
    ),
  );
  const hasClearUseCase =
    FUNCTIONAL_CATEGORIES.has(categoryMatch.category) &&
    (Boolean(crawl?.signals.hasClearUseCase) ||
      categoryMatch.score > 0 ||
      hasDocs ||
      hasGithub ||
      hasWhitepaper ||
      hasAuditsMentioned ||
      hasExternalUseCase);

  return {
    category: categoryMatch.category,
    claimedUseCase: categoryMatch.claimedUseCase,
    hasClearUseCase: crawl || externalEvidence ? hasClearUseCase : hasClearUseCase ? true : null,
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
  externalEvidence?: OffchainExternalEvidenceResult,
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
  const externalValidation = resolveExternalValidation(externalEvidence);
  if (externalValidation === 'strong' || externalValidation === 'moderate') {
    signals.push({
      strength: externalValidation === 'strong' ? 'high' : 'medium',
      title: 'External Evidence Corroboration',
      description: 'Open-web evidence corroborates official identity or project resources.',
      evidence: collectEvidenceRefs(externalEvidence, [
        'official_website',
        'official_docs',
        'developer_resource',
        'trusted_directory',
        'news',
      ]).join(', ') || undefined,
      sourceUrl: externalEvidence?.evidenceItems.find((item) => item.relevance === 'high')?.url,
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
  externalEvidence?: OffchainExternalEvidenceResult,
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

  const negativeRiskEvidence = resolveNegativeRiskEvidence(externalEvidence);
  if (negativeRiskEvidence === 'high' || negativeRiskEvidence === 'medium') {
    const warning = externalEvidence?.evidenceItems.find(
      (item) => item.sourceType === 'scam_warning' || item.sourceType === 'risk_warning',
    );
    flags.push({
      severity: negativeRiskEvidence === 'high' ? 'high' : 'medium',
      title: 'External Risk Warning Found',
      description:
        'Open-web evidence contains scam, exploit, hack, or risk-warning language that should be reviewed.',
      evidence: warning ? `${warning.id}: ${warning.reason}` : undefined,
      sourceUrl: warning?.url,
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
  hasClearUseCase: boolean | null;
  hasDocs: boolean | null;
  hasGithub: boolean | null;
  externalValidation: 'strong' | 'moderate' | 'weak' | 'none';
  negativeRiskEvidence: 'none_found' | 'low' | 'medium' | 'high';
}): string {
  if (!input.hasWebsite && input.riskLevel === 'unknown') {
    return 'Off-chain credibility could not be assessed because official project links were unavailable.';
  }
  if (input.negativeRiskEvidence === 'high') {
    return 'Off-chain credibility requires review because external evidence contains material scam, exploit, or risk-warning signals.';
  }
  if (!input.hasWebsite && input.externalValidation !== 'strong') {
    return 'Official identity could not be verified. Evidence is limited to weak third-party/search results, so off-chain credibility remains uncertain.';
  }
  if (input.linkMismatch || input.officialLinkConfidence.level === 'low') {
    return 'Off-chain credibility requires review because the discovered website or project links could not be confidently matched to the token.';
  }
  if (
    input.category === 'infrastructure' &&
    input.hasWebsite &&
    input.hasTrustedOfficialWebsite &&
    input.hasClearUseCase &&
    (input.hasDocs || input.hasGithub) &&
    (input.externalValidation === 'strong' || input.externalValidation === 'moderate')
  ) {
    return 'Off-chain credibility appears strong. Official website, documentation, GitHub or security resources, and external evidence support a clear oracle/infrastructure use case.';
  }
  if (
    input.category === 'rwa' &&
    input.hasWebsite &&
    input.hasTrustedOfficialWebsite &&
    (input.externalValidation === 'strong' || input.externalValidation === 'moderate')
  ) {
    return 'Off-chain credibility appears strong. Official links and external evidence support an RWA / institutional on-chain finance project.';
  }
  if (
    input.category === 'meme' &&
    input.hasWebsite &&
    input.hasTrustedOfficialWebsite &&
    input.negativeRiskEvidence === 'none_found'
  ) {
    return 'Official identity appears verified, but this is primarily a community/meme token with limited documentation, developer resources, or functional utility evidence.';
  }
  if (input.credibilityTier === 'limited') {
    return 'Off-chain credibility appears limited. Official links may exist, but documentation, utility evidence, or external validation remain incomplete.';
  }
  if (
    input.credibilityTier === 'institutional_grade' ||
    input.credibilityTier === 'strong' ||
    (input.category === 'infrastructure' && input.riskLevel === 'low')
  ) {
    if (input.category === 'infrastructure') {
      return 'Off-chain credibility appears strong. Official links and external evidence support a clear oracle/infrastructure use case.';
    }
    if (input.category === 'rwa') {
      return 'Off-chain credibility appears strong. Official links and external evidence support an RWA / institutional on-chain finance project.';
    }
    return 'Off-chain credibility appears strong based on verified official identity, project materials, and external corroboration.';
  }
  if (input.riskLevel === 'high' || input.riskLevel === 'severe' || input.credibilityTier === 'weak') {
    if (!input.hasWebsite) {
      return 'Official identity could not be verified. Evidence is limited to weak third-party/search results, so off-chain credibility remains uncertain.';
    }
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
