import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildDiscoveryCacheKey, OffchainMemoryCache } from './offchain-memory-cache';
import { resolveOffchainConfig } from './offchain-config';
import type { DiscoveredLinks, DiscoveryMode } from './offchain-discovery-types';
import type {
  OffchainEvidenceItem,
  OffchainExternalEvidenceResult,
} from './token-offchain-external-evidence.service';
import type { TokenWebsiteCrawlResult } from './token-web-crawler.service';

export interface OffchainAiClassifierInput {
  token: {
    name: string;
    symbol: string;
    chain: string;
    contractAddress: string;
  };
  identity: {
    website: string | null;
    websiteSource: string | null;
    discoveryMode: string;
    officialLinkConfidence: 'high' | 'medium' | 'low';
    discoveredLinks: Partial<DiscoveredLinks>;
  };
  officialSourceText?: {
    homepageText?: string | null;
    docsText?: string | null;
    whitepaperText?: string | null;
    extractedUseCaseSignals?: string[];
  };
  externalEvidence: Array<{
    id: string;
    sourceType: string;
    trustLevel: string;
    relevance: string;
    url?: string;
    title?: string;
    snippet?: string;
    matchedContractAddress?: boolean;
    matchedTokenName?: boolean;
    matchedTokenSymbol?: boolean;
    matchedOfficialDomain?: boolean;
    reason?: string;
  }>;
  deterministicHints: {
    previousCategory?: string | null;
    metadataCategories?: string[];
    riskFlags?: string[];
    unknowns?: string[];
  };
}

export interface OffchainAiProjectClassification {
  source: 'ai';
  categoryLabel: string;
  normalizedCategory:
    | 'meme'
    | 'defi'
    | 'infrastructure'
    | 'socialfi'
    | 'gaming'
    | 'ai'
    | 'rwa'
    | 'stablecoin'
    | 'utility'
    | 'unknown'
    | 'other';
  categoryConfidence: 'high' | 'medium' | 'low';
  claimedUseCase: string | null;
  useCaseConfidence: 'high' | 'medium' | 'low' | 'unknown';
  identityStatus: 'verified' | 'partially_verified' | 'unverified' | 'unknown';
  evidenceQuality: 'strong' | 'moderate' | 'weak' | 'limited';
  possibleNarrative: string | null;
  hasClearUseCase: boolean | null;
  reasoning: string;
  evidenceRefs: string[];
  warnings: string[];
}

export interface OffchainAiClassifierDebug {
  attempted: boolean;
  enabled: boolean;
  provider: 'anthropic' | 'gemini';
  model?: string;
  hasApiKey: boolean;
  evidenceItemCount: number;
  skippedReason?: string;
  failureReason?: string;
  resultSource: 'ai' | 'deterministic';
}

const SYSTEM_PROMPT = `You are classifying a crypto token project from provided evidence.

Rules:
- Use only the provided evidence.
- Do not invent facts, docs, GitHub, team, audits, partnerships, or website status.
- If official website is not verified, be conservative.
- If evidence is only search snippets, classify with low confidence.
- If evidence suggests a narrative but does not verify official identity, use possibleNarrative.
- Do not force a project into a limited category if evidence is weak.
- Use unknown when evidence is insufficient.
- DEX trading, Uniswap, price pages, exchange pages, market cap pages, and liquidity pages do not make a token DeFi.
- Generic words like "Web3", "blockchain", "smart contract", "platform", "token", and "decentralized" do not automatically mean infrastructure.
- Infrastructure requires evidence of infrastructure product functionality such as oracle, data feeds, bridge/interoperability, RPC, indexing, validator/node services, middleware, developer APIs, or protocol infrastructure.
- SocialFi/Web3 social evidence should classify as socialfi or other, not infrastructure.
- Meme/community evidence should classify as meme when project positioning is meme/community and no functional product evidence exists.
- Return JSON only.`;

@Injectable()
export class TokenOffchainAiClassifierService {
  private readonly logger = new Logger(TokenOffchainAiClassifierService.name);
  private anthropicClient: Anthropic | null = null;
  private readonly classifierCache = new OffchainMemoryCache<OffchainAiProjectClassification>(
    200,
    24 * 60 * 60 * 1000,
  );

  constructor(private readonly config: ConfigService) {}

  async classify(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    chain?: string | null;
    contractAddress?: string | null;
    discoveredLinks: DiscoveredLinks;
    websiteSource?: string | null;
    discoveryMode: DiscoveryMode;
    officialLinkConfidence: 'high' | 'medium' | 'low';
    crawl: TokenWebsiteCrawlResult | null;
    externalEvidence?: OffchainExternalEvidenceResult;
    metadataCategories?: string[];
    deterministicCategory?: string | null;
    unknowns?: string[];
    riskFlags?: string[];
    forceRefresh?: boolean;
  }): Promise<OffchainAiProjectClassification | null> {
    return (await this.classifyWithDebug(input)).classification;
  }

  async classifyWithDebug(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    chain?: string | null;
    contractAddress?: string | null;
    discoveredLinks: DiscoveredLinks;
    websiteSource?: string | null;
    discoveryMode: DiscoveryMode;
    officialLinkConfidence: 'high' | 'medium' | 'low';
    crawl: TokenWebsiteCrawlResult | null;
    externalEvidence?: OffchainExternalEvidenceResult;
    metadataCategories?: string[];
    deterministicCategory?: string | null;
    unknowns?: string[];
    riskFlags?: string[];
    forceRefresh?: boolean;
  }): Promise<{
    classification: OffchainAiProjectClassification | null;
    debug: OffchainAiClassifierDebug;
  }> {
    const runtime = resolveOffchainConfig(this.config);
    const provider = runtime.aiClassifierProvider;
    const apiKey = this.getApiKey(provider);
    const evidenceItemCount = selectClassifierEvidence(input.externalEvidence).length;
    const baseDebug: OffchainAiClassifierDebug = {
      attempted: false,
      enabled: runtime.aiClassifierEnabled,
      provider,
      model: runtime.aiClassifierModel,
      hasApiKey: apiKey.length > 0,
      evidenceItemCount,
      resultSource: 'deterministic',
    };

    this.logger.log(
      `Off-chain AI classifier considered enabled=${baseDebug.enabled} provider=${provider} ` +
        `model=${runtime.aiClassifierModel} hasApiKey=${baseDebug.hasApiKey} ` +
        `evidenceItemCount=${evidenceItemCount}`,
    );

    if (!runtime.aiClassifierEnabled) {
      const skippedReason = !runtime.aiClassifierEnabled
        ? 'OFFCHAIN_AI_CLASSIFIER_ENABLED is false'
        : `Unsupported provider: ${runtime.aiClassifierProvider}`;
      this.logger.log(`Off-chain AI classifier skipped: ${skippedReason}`);
      return {
        classification: null,
        debug: { ...baseDebug, skippedReason },
      };
    }

    if (!apiKey) {
      const skippedReason =
        provider === 'gemini' ? 'GEMINI_API_KEY missing' : 'ANTHROPIC_API_KEY missing';
      this.logger.log(`Off-chain AI classifier skipped: ${skippedReason}`);
      return {
        classification: null,
        debug: { ...baseDebug, skippedReason },
      };
    }

    const packet = this.buildInputPacket(input, runtime.aiClassifierMaxInputChars);
    const prompt = JSON.stringify(packet, null, 2).slice(0, runtime.aiClassifierMaxInputChars);
    const cacheKey = buildAiClassifierCacheKey({
      chain: input.chain,
      contractAddress: input.contractAddress,
      tokenName: input.tokenName,
      tokenSymbol: input.tokenSymbol,
      provider,
      model: runtime.aiClassifierModel,
    });

    if (!input.forceRefresh) {
      const cached = this.classifierCache.get(cacheKey);
      if (cached) {
        this.logger.log(
          `Off-chain AI classifier cache hit provider=${provider} model=${runtime.aiClassifierModel}`,
        );
        return {
          classification: cached,
          debug: { ...baseDebug, attempted: false, resultSource: 'ai' },
        };
      }
    }

    try {
      const attemptedDebug = { ...baseDebug, attempted: true };
      const parsed = await withTimeout(
        provider === 'gemini'
          ? this.callGemini(prompt, apiKey, runtime.aiClassifierModel)
          : this.callClaude(prompt, apiKey, runtime.aiClassifierModel),
        runtime.aiClassifierTimeoutMs,
      );
      const validated = validateClassification(parsed, packet.externalEvidence.map((item) => item.id));
      const guarded = applyAiSafetyGuards(validated, packet);
      this.logger.log(
        `Off-chain AI classifier succeeded category=${guarded.normalizedCategory} ` +
          `confidence=${guarded.categoryConfidence} evidenceRefs=${guarded.evidenceRefs.length}`,
      );
      this.classifierCache.set(cacheKey, guarded);
      return {
        classification: guarded,
        debug: { ...attemptedDebug, resultSource: 'ai' },
      };
    } catch (err: unknown) {
      const failureReason = getErrorMessage(err);
      this.logger.warn(`Off-chain AI classifier failed: ${failureReason}`);
      return {
        classification: null,
        debug: { ...baseDebug, attempted: true, failureReason },
      };
    }
  }

  private buildInputPacket(
    input: Parameters<TokenOffchainAiClassifierService['classify']>[0],
    maxChars: number,
  ): OffchainAiClassifierInput {
    const externalEvidence = selectClassifierEvidence(input.externalEvidence).map((item) => ({
      id: item.id,
      sourceType: item.sourceType,
      trustLevel: item.trustLevel,
      relevance: item.relevance,
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      matchedContractAddress: item.matchedContractAddress,
      matchedTokenName: item.matchedTokenName,
      matchedTokenSymbol: item.matchedTokenSymbol,
      matchedOfficialDomain: item.matchedOfficialDomain,
      reason: item.reason,
    }));

    return {
      token: {
        name: input.tokenName ?? '',
        symbol: input.tokenSymbol ?? '',
        chain: input.chain ?? '',
        contractAddress: input.contractAddress ?? '',
      },
      identity: {
        website: input.discoveredLinks.website,
        websiteSource: input.websiteSource ?? null,
        discoveryMode: input.discoveryMode,
        officialLinkConfidence: input.officialLinkConfidence,
        discoveredLinks: input.discoveredLinks,
      },
      officialSourceText: {
        homepageText: truncate(input.crawl?.extractedText ?? null, Math.min(12_000, maxChars)),
        docsText: null,
        whitepaperText: null,
        extractedUseCaseSignals: extractUseCaseSignals(input.crawl),
      },
      externalEvidence,
      deterministicHints: {
        previousCategory: input.deterministicCategory ?? null,
        metadataCategories: input.metadataCategories ?? [],
        riskFlags: input.riskFlags ?? [],
        unknowns: input.unknowns ?? [],
      },
    };
  }

  private async callClaude(
    prompt: string,
    apiKey: string,
    model: string,
  ): Promise<Record<string, unknown>> {
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({ apiKey });
    }
    const response = await this.anthropicClient.messages.create({
      model,
      max_tokens: 1_200,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            'Classify this token project. Return strict JSON matching the requested schema only.\n\n' +
            prompt,
        },
      ],
    });

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }
    return JSON.parse(stripMarkdownCodeFence(text.trim())) as Record<string, unknown>;
  }

  private async callGemini(
    prompt: string,
    apiKey: string,
    modelName: string,
  ): Promise<Record<string, unknown>> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `${SYSTEM_PROMPT}\n\n` +
                'Classify this token project. Return strict JSON matching the requested schema only.\n\n' +
                prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1_200,
      },
    });

    return JSON.parse(stripMarkdownCodeFence(result.response.text().trim())) as Record<
      string,
      unknown
    >;
  }

  private getApiKey(provider: 'anthropic' | 'gemini'): string {
    if (provider === 'gemini') {
      return (
        this.config.get<string>('GEMINI_API_KEY') ??
        this.config.get<string>('gemini.apiKey') ??
        ''
      ).trim();
    }
    return (
      this.config.get<string>('ANTHROPIC_API_KEY') ??
      this.config.get<string>('anthropic.apiKey') ??
      ''
    ).trim();
  }
}

export function selectClassifierEvidence(
  externalEvidence?: OffchainExternalEvidenceResult,
): OffchainEvidenceItem[] {
  if (!externalEvidence) {
    return [];
  }

  const selected = externalEvidence.evidenceItems.filter((item) => {
    if (['unrelated', 'spam_or_seo'].includes(item.sourceType)) {
      return false;
    }
    if (item.matchedContractAddress || item.matchedOfficialDomain) {
      return true;
    }
    if (item.relevance === 'high') {
      return true;
    }
    if (
      [
        'trusted_directory',
        'official_website',
        'official_docs',
        'official_github',
        'official_whitepaper',
        'official_security',
        'developer_resource',
        'news',
        'security_report',
        'audit_report',
        'risk_warning',
        'scam_warning',
      ].includes(item.sourceType)
    ) {
      return item.relevance !== 'low';
    }
    return false;
  });

  return selected.slice(0, 24);
}

function validateClassification(
  raw: Record<string, unknown>,
  validEvidenceIds: string[],
): OffchainAiProjectClassification {
  const normalizedCategory = oneOf(raw.normalizedCategory, [
    'meme',
    'defi',
    'infrastructure',
    'socialfi',
    'gaming',
    'ai',
    'rwa',
    'stablecoin',
    'utility',
    'unknown',
    'other',
  ]);

  return {
    source: 'ai',
    categoryLabel: requiredString(raw.categoryLabel, 'categoryLabel'),
    normalizedCategory,
    categoryConfidence: oneOf(raw.categoryConfidence, ['high', 'medium', 'low']),
    claimedUseCase: nullableString(raw.claimedUseCase),
    useCaseConfidence: oneOf(raw.useCaseConfidence, ['high', 'medium', 'low', 'unknown']),
    identityStatus: oneOf(raw.identityStatus, [
      'verified',
      'partially_verified',
      'unverified',
      'unknown',
    ]),
    evidenceQuality: oneOf(raw.evidenceQuality, ['strong', 'moderate', 'weak', 'limited']),
    possibleNarrative: nullableString(raw.possibleNarrative),
    hasClearUseCase: nullableBoolean(raw.hasClearUseCase),
    reasoning: requiredString(raw.reasoning, 'reasoning'),
    evidenceRefs: arrayOfStrings(raw.evidenceRefs).filter((id) => validEvidenceIds.includes(id)),
    warnings: arrayOfStrings(raw.warnings),
  };
}

function applyAiSafetyGuards(
  classification: OffchainAiProjectClassification,
  input: OffchainAiClassifierInput,
): OffchainAiProjectClassification {
  const guarded: OffchainAiProjectClassification = {
    ...classification,
    evidenceRefs: [...classification.evidenceRefs],
    warnings: [...classification.warnings],
  };
  const strongContractEvidence = input.externalEvidence.filter(
    (item) =>
      item.relevance === 'high' &&
      item.trustLevel !== 'low' &&
      (item.matchedContractAddress || item.matchedOfficialDomain),
  ).length;
  const identityWeak =
    !input.identity.website ||
    input.identity.officialLinkConfidence === 'low' ||
    input.identity.discoveryMode === 'search_only';

  if (identityWeak && guarded.categoryConfidence === 'high' && strongContractEvidence < 2) {
    guarded.categoryConfidence = strongContractEvidence === 1 ? 'medium' : 'low';
    guarded.warnings.push('Category confidence downgraded because official identity is weak.');
  }

  if (guarded.identityStatus === 'unverified' && guarded.hasClearUseCase === true && strongContractEvidence < 2) {
    guarded.hasClearUseCase = false;
    guarded.useCaseConfidence = 'low';
    guarded.warnings.push('Clear use case downgraded because identity is unverified.');
  }

  if (guarded.normalizedCategory === 'infrastructure' && hasOnlyGenericInfrastructureLanguage(input)) {
    guarded.normalizedCategory = 'unknown';
    guarded.categoryLabel = 'Unknown or weakly supported project category';
    guarded.categoryConfidence = 'low';
    guarded.hasClearUseCase = false;
    guarded.useCaseConfidence = 'low';
    guarded.warnings.push('Infrastructure classification rejected because evidence only used generic Web3 language.');
  }

  if (guarded.normalizedCategory === 'defi' && hasOnlyTradingOrMarketEvidence(input)) {
    guarded.normalizedCategory = 'unknown';
    guarded.categoryLabel = 'Unknown or market-listed token';
    guarded.categoryConfidence = 'low';
    guarded.hasClearUseCase = false;
    guarded.useCaseConfidence = 'low';
    guarded.warnings.push('DeFi classification rejected because evidence only showed trading/listing pages.');
  }

  if (guarded.evidenceRefs.length === 0) {
    guarded.categoryConfidence = 'low';
    guarded.warnings.push('Category confidence downgraded because no valid evidence references were provided.');
  }

  return guarded;
}

function hasOnlyGenericInfrastructureLanguage(input: OffchainAiClassifierInput): boolean {
  const text = evidenceText(input);
  const hasSpecificInfrastructure =
    /oracle|data feeds?|ccip|interoperability|bridge|rpc|indexing|validator|node service|middleware|developer api|protocol infrastructure|automation/i.test(
      text,
    );
  const hasGeneric =
    /web3|blockchain|smart contracts?|platform|token|decentralized|token generation/i.test(text);
  return hasGeneric && !hasSpecificInfrastructure;
}

function hasOnlyTradingOrMarketEvidence(input: OffchainAiClassifierInput): boolean {
  const text = evidenceText(input);
  const hasProtocolEvidence = /lending|borrowing|amm|dex protocol|vault|yield protocol|money market|staking protocol/i.test(
    text,
  );
  const hasOnlyMarket =
    /uniswap|price|market cap|dexscreener|coingecko|coinmarketcap|liquidity|pair|trading/i.test(text);
  return hasOnlyMarket && !hasProtocolEvidence;
}

function evidenceText(input: OffchainAiClassifierInput): string {
  return [
    input.officialSourceText?.homepageText ?? '',
    ...input.externalEvidence.map(
      (item) => `${item.title ?? ''} ${item.snippet ?? ''} ${item.url ?? ''} ${item.reason ?? ''}`,
    ),
  ].join('\n');
}

function extractUseCaseSignals(crawl: TokenWebsiteCrawlResult | null): string[] {
  if (!crawl) {
    return [];
  }
  const signals: string[] = [];
  if (crawl.signals.hasClearUseCase) signals.push('crawler_has_clear_use_case');
  if (crawl.signals.hasDocs) signals.push('crawler_has_docs');
  if (crawl.signals.hasGithub) signals.push('crawler_has_github');
  if (crawl.signals.hasWhitepaper) signals.push('crawler_has_whitepaper');
  if (crawl.signals.hasAuditsMentioned) signals.push('crawler_has_security_or_audit');
  signals.push(...crawl.signals.adoptionClaims.map((claim) => `adoption:${claim}`));
  return signals;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AI classifier response missing ${field}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(`AI classifier response invalid enum value: ${String(value)}`);
}

function stripMarkdownCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function truncate(value: string | null, max: number): string | null {
  if (!value) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('AI classifier timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildAiClassifierCacheKey(input: {
  chain?: string | null;
  contractAddress?: string | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  provider: 'anthropic' | 'gemini';
  model: string;
}): string {
  return `${buildDiscoveryCacheKey(input)}:ai-classifier:${input.provider}:${input.model}`;
}
