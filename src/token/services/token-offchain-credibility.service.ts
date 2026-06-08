import { Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class TokenOffchainCredibilityService {
  private readonly logger = new Logger(TokenOffchainCredibilityService.name);

  constructor(
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
  }): Promise<OffChainCredibilityReport> {
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
      });

      fetchErrors.push(...discovery.errors);

      let crawl: TokenWebsiteCrawlResult | null = null;
      if (discovery.discoveredLinks.website) {
        try {
          crawl = await this.webCrawler.crawlOfficialWebsite({
            websiteUrl: discovery.discoveredLinks.website,
            tokenName: input.tokenName,
            tokenSymbol: input.tokenSymbol,
            contractAddress: input.contractAddress,
            maxPages: 5,
          });
          fetchErrors.push(...crawl.errors);
        } catch (err: unknown) {
          fetchErrors.push(`Website crawl failed: ${getErrorMessage(err)}`);
        }
      }

      return buildOffChainCredibilityReport({
        tokenName: safeString(input.tokenName),
        tokenSymbol: safeString(input.tokenSymbol),
        contractAddress: safeString(input.contractAddress)?.toLowerCase() ?? null,
        discovery,
        crawl,
        fetchErrors,
      });
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
    'This module uses official links, website crawl text, and metadata only; it does not verify every claim independently.',
    'Website content may change and crawl coverage is limited to a small number of pages.',
  ];

  const discoveredLinks = { ...data.discovery.discoveredLinks };
  const officialLinkConfidence = data.discovery.officialLinkConfidence;
  const crawl = data.crawl;
  const combinedText = buildCombinedText(data);
  const categoryMatch = detectProjectCategory(data, combinedText);
  const projectProfile = buildProjectProfile(data, categoryMatch, combinedText);
  const claimChecks = buildClaimChecks(combinedText, data, projectProfile);
  const scoring = scoreOffChainCredibility({
    data,
    projectProfile,
    categoryMatch,
    claimChecks,
    combinedText,
  });

  const credibilitySignals = buildCredibilitySignals(data, projectProfile, categoryMatch);
  const riskFlags = buildRiskFlags(data, projectProfile, claimChecks, scoring);

  if (!discoveredLinks.website) {
    unknowns.push('No official website discovered');
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
    status = 'unknown';
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
    linkMismatch: scoring.linkMismatch,
  });

  return {
    status,
    score: scoring.score,
    riskLevel,
    credibilityTier,
    verdict,
    confidence,
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
  combinedText: string,
): CategoryMatch {
  const haystack = [
    data.tokenName,
    data.tokenSymbol,
    combinedText,
    JSON.stringify(data.discovery.discoveredLinks),
  ]
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

  if (best.score === 0 && combinedText.trim().length > 80) {
    return { category: 'other', score: 1, claimedUseCase: 'General crypto project positioning' };
  }

  return best;
}

export function buildClaimChecks(
  combinedText: string,
  data: OffChainCredibilityCollectedData,
  projectProfile: OffChainCredibilityReport['projectProfile'],
): OffChainCredibilityReport['claimChecks'] {
  const checks: OffChainCredibilityReport['claimChecks'] = [];
  const sourceUrls = collectSourceUrls(data);
  const evidenceText = combinedText.toLowerCase();

  for (const item of MAJOR_CLAIM_PATTERNS) {
    if (!item.pattern.test(combinedText)) {
      continue;
    }

    const evidence: string[] = [];
    const claimSources: string[] = [];

    if (projectProfile.hasDocs) {
      evidence.push('Documentation link detected');
      if (data.discovery.discoveredLinks.docs) {
        claimSources.push(data.discovery.discoveredLinks.docs);
      }
    }
    if (projectProfile.hasAuditsMentioned) {
      evidence.push('Audit or security mention detected on official materials');
      if (data.crawl?.links.audit) {
        claimSources.push(data.crawl.links.audit);
      }
      if (data.crawl?.links.security) {
        claimSources.push(data.crawl.links.security);
      }
    }
    if ((data.crawl?.signals.adoptionClaims.length ?? 0) > 0) {
      evidence.push('Adoption or integration language found near project materials');
    }
    if (item.requiresEvidence && item.requiresEvidence.test(evidenceText)) {
      evidence.push('Nearby audit/security terminology found');
    }

    let status: OffChainCredibilityReport['claimChecks'][number]['status'] = 'unknown';
    if (evidence.length >= 2) {
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
      sourceUrls: [...new Set([...claimSources, ...sourceUrls])].slice(0, 5),
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
}): {
  score: number | null;
  riskLevel: OffChainCredibilityRiskLevel;
  credibilityTier: CredibilityTier;
  linkMismatch: boolean;
} {
  const { data, projectProfile, categoryMatch, claimChecks, combinedText } = input;
  const links = data.discovery.discoveredLinks;
  const crawl = data.crawl;
  const confidence = data.discovery.officialLinkConfidence.level;

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
    score -= 20;
  } else if (confidence === 'high') {
    score += 15;
  } else if (confidence === 'medium') {
    score += 8;
  } else if (confidence === 'low') {
    score -= 5;
    linkMismatch = true;
  }

  if (projectProfile.hasClearUseCase) {
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

  if (!projectProfile.hasDocs && !projectProfile.hasClearUseCase) {
    score -= 15;
  }
  if (crawl?.brokenWebsite) {
    score -= 20;
  }
  if (linkMismatch || (crawl && !hasTokenVerification(crawl, data) && confidence === 'low')) {
    score -= 20;
    linkMismatch = true;
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
  return {
    score,
    riskLevel: resolveRiskLevel(score),
    credibilityTier: resolveCredibilityTier(score, projectProfile, adoptionEvidence),
    linkMismatch,
  };
}

function buildProjectProfile(
  data: OffChainCredibilityCollectedData,
  categoryMatch: CategoryMatch,
  combinedText: string,
): OffChainCredibilityReport['projectProfile'] {
  const crawl = data.crawl;
  const links = data.discovery.discoveredLinks;

  const hasDocs = Boolean(links.docs || crawl?.links.docs || crawl?.signals.hasDocs);
  const hasWhitepaper = Boolean(
    links.whitepaper || crawl?.links.whitepaper || crawl?.signals.hasWhitepaper,
  );
  const hasGithub = Boolean(links.github || crawl?.links.github || crawl?.signals.hasGithub);
  const hasAuditsMentioned = Boolean(
    crawl?.signals.hasAuditsMentioned || crawl?.links.audit || crawl?.links.security,
  );
  const hasTeamInfo = Boolean(crawl?.signals.hasTeamInfo);
  const hasClearUseCase =
    Boolean(crawl?.signals.hasClearUseCase) ||
    categoryMatch.category !== 'unknown' ||
    combinedText.trim().length > 120;

  return {
    category: categoryMatch.category,
    claimedUseCase: categoryMatch.claimedUseCase,
    hasClearUseCase: crawl ? hasClearUseCase : hasClearUseCase ? true : null,
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
): OffChainCredibilityReport['credibilitySignals'] {
  const signals: OffChainCredibilityReport['credibilitySignals'] = [];

  if (projectProfile.hasClearUseCase) {
    signals.push({
      strength: 'high',
      title: 'Clear Project Use Case',
      description: 'Official materials suggest a recognizable project purpose or category.',
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
  if (data.discovery.officialLinkConfidence.level === 'high') {
    signals.push({
      strength: 'high',
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
  if (categoryMatch.category === 'meme') {
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
): OffChainCredibilityReport['riskFlags'] {
  const flags: OffChainCredibilityReport['riskFlags'] = [];
  const crawl = data.crawl;

  if (!data.discovery.discoveredLinks.website) {
    flags.push({
      severity: 'high',
      title: 'Official Website Not Verified',
      description: 'No official website could be discovered from available metadata or search.',
    });
  }
  if (scoring.linkMismatch || data.discovery.officialLinkConfidence.level === 'low') {
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
  linkMismatch: boolean;
}): string {
  if (!input.hasWebsite && input.riskLevel === 'unknown') {
    return 'Off-chain credibility could not be assessed because official project links were unavailable.';
  }
  if (input.linkMismatch || input.officialLinkConfidence.level === 'low') {
    return 'Off-chain credibility requires review because the discovered website or project links could not be confidently matched to the token.';
  }
  if (
    input.credibilityTier === 'institutional_grade' ||
    input.credibilityTier === 'strong' ||
    (input.category === 'infrastructure' && input.riskLevel === 'low')
  ) {
    return 'Off-chain credibility appears strong based on official project, documentation, developer, and infrastructure use-case signals.';
  }
  if (input.category === 'meme' || input.credibilityTier === 'limited') {
    return 'Off-chain credibility appears community-driven. Official links may exist, but project documentation and utility evidence are limited compared with infrastructure or DeFi protocols.';
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

function buildCombinedText(data: OffChainCredibilityCollectedData): string {
  return [
    data.tokenName,
    data.tokenSymbol,
    data.crawl?.extractedText ?? '',
    data.discovery.sourceUrls.join(' '),
  ]
    .filter(Boolean)
    .join('\n');
}

function collectSourceUrls(data: OffChainCredibilityCollectedData): string[] {
  const urls = [
    ...data.discovery.sourceUrls,
    data.discovery.discoveredLinks.website,
    data.discovery.discoveredLinks.docs,
    data.discovery.discoveredLinks.whitepaper,
    data.discovery.discoveredLinks.github,
    data.crawl?.homepageUrl,
    data.crawl?.finalUrl,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(urls)];
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
    officialLinkConfidence: { level: 'low', reasons: ['Discovery unavailable'] },
    sourceUrls: [],
    errors: [],
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
