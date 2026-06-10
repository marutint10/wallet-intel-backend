import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
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
    sourceName?: string;
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

interface GeminiFlatOffchainClassificationOutput {
  category: string;
  categoryLabel: string;
  categoryConfidence: 'high' | 'medium' | 'low';
  claimedUseCase: string | null;
  useCaseConfidence: 'high' | 'medium' | 'low' | 'unknown';
  identityStatus: 'verified' | 'partially_verified' | 'unverified' | 'unknown';
  evidenceQuality: 'strong' | 'moderate' | 'weak' | 'limited';
  hasClearUseCase: boolean | null;
  reasoning: string;
  warningSummary: string;
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
- Return one valid JSON object only.
- Do not return markdown.
- Do not return code fences.
- Do not include comments.
- Do not include trailing commas.
- All property names must use double quotes.
- All string values must use double quotes.`;

const GEMINI_FLAT_PROMPT = `Classify this crypto token project using only the evidence below.

Return exactly one tiny flat JSON object with these keys only:
category, categoryLabel, categoryConfidence, claimedUseCase, useCaseConfidence, identityStatus, evidenceQuality, hasClearUseCase, reasoning, warningSummary.

Rules:
- No token object.
- No classification object.
- No nested objects.
- No arrays.
- No evidenceRefs.
- No markdown.
- No code fences.
- No comments.
- No trailing commas.
- category must be one of: meme, defi, infrastructure, socialfi, gaming, ai, rwa, stablecoin, utility, unknown, other.
- categoryConfidence must be high, medium, or low.
- useCaseConfidence must be high, medium, low, or unknown.
- identityStatus must be verified, partially_verified, unverified, or unknown.
- evidenceQuality must be strong, moderate, weak, or limited.
- claimedUseCase may be null.
- hasClearUseCase may be true, false, or null.
- reasoning must be one string under 220 characters.
- warningSummary must be one string under 160 characters. Use an empty string if there are no warnings.

Definitions:
- Infrastructure requires specific oracle, data feed, bridge, interoperability, RPC, indexing, validator, node, middleware, developer API, or protocol infrastructure evidence.
- Generic Web3/blockchain/platform language is not infrastructure.
- DEX trading, price pages, exchange pages, market cap pages, and liquidity pages do not make a token DeFi.
- Use rwa for tokenized real-world assets, institutional on-chain finance, tokenized treasuries, or Ondo-style RWA evidence.
- Use unknown when evidence is insufficient or identity is not verified.`;

const GEMINI_FLAT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    categoryLabel: { type: 'string' },
    categoryConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    claimedUseCase: { type: 'string', nullable: true },
    useCaseConfidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    identityStatus: {
      type: 'string',
      enum: ['verified', 'partially_verified', 'unverified', 'unknown'],
    },
    evidenceQuality: { type: 'string', enum: ['strong', 'moderate', 'weak', 'limited'] },
    hasClearUseCase: { type: 'boolean', nullable: true },
    reasoning: { type: 'string' },
    warningSummary: { type: 'string' },
  },
  required: [
    'category',
    'categoryLabel',
    'categoryConfidence',
    'claimedUseCase',
    'useCaseConfidence',
    'identityStatus',
    'evidenceQuality',
    'hasClearUseCase',
    'reasoning',
    'warningSummary',
  ],
};

@Injectable()
export class TokenOffchainAiClassifierService {
  private static readonly geminiBackoffUntilByModel = new Map<string, Date>();
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
    const evidenceHash = buildEvidenceHash(packet);
    const prompt =
      provider === 'gemini'
        ? this.buildGeminiFlatPrompt(packet, runtime.aiClassifierMaxInputChars)
        : JSON.stringify(packet, null, 2).slice(0, runtime.aiClassifierMaxInputChars);
    const cacheKey = buildAiClassifierCacheKey({
      chain: input.chain,
      contractAddress: input.contractAddress,
      tokenName: input.tokenName,
      tokenSymbol: input.tokenSymbol,
      provider,
      model: runtime.aiClassifierModel,
      evidenceHash,
    });

    const cached = this.classifierCache.get(cacheKey);
    if (cached && (provider === 'gemini' || !input.forceRefresh)) {
      this.logger.log(
        `Off-chain AI classifier cache hit provider=${provider} model=${runtime.aiClassifierModel}`,
      );
      return {
        classification: cached,
        debug: { ...baseDebug, attempted: false, resultSource: 'ai' },
      };
    }

    const geminiBackoffKey = buildGeminiBackoffKey(runtime.aiClassifierModel);
    const geminiBackoffUntil =
      provider === 'gemini'
        ? TokenOffchainAiClassifierService.geminiBackoffUntilByModel.get(geminiBackoffKey)
        : undefined;
    if (provider === 'gemini' && geminiBackoffUntil && Date.now() < geminiBackoffUntil.getTime()) {
      this.logger.warn(
        `Off-chain AI classifier skipped: gemini_quota_backoff key=${geminiBackoffKey} until=${geminiBackoffUntil.toISOString()}`,
      );
      return {
        classification: null,
        debug: { ...baseDebug, attempted: false, skippedReason: 'gemini_quota_backoff' },
      };
    }

    try {
      const attemptedDebug = { ...baseDebug, attempted: true };
      const parsed = await withTimeout(
        provider === 'gemini'
          ? this.callGemini(prompt, apiKey, runtime.aiClassifierModel)
          : this.callClaude(prompt, apiKey, runtime.aiClassifierModel),
        runtime.aiClassifierTimeoutMs,
      );
      const normalized =
        provider === 'gemini' ? normalizeGeminiClassificationOutput(parsed) : parsed;
      const validated = validateClassification(
        normalized,
        packet.externalEvidence.map((item) => item.id),
        { allowImplicitEvidenceRefs: provider === 'gemini' },
      );
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
      if (provider === 'gemini' && isGeminiQuotaError(failureReason)) {
        TokenOffchainAiClassifierService.geminiBackoffUntilByModel.set(
          geminiBackoffKey,
          new Date(Date.now() + resolveGeminiRetryDelayMs(failureReason)),
        );
      }
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
      sourceName: item.sourceName,
      url: item.url,
      title: item.title,
      snippet: truncate(item.snippet ?? null, 220) ?? undefined,
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

  private buildGeminiFlatPrompt(input: OffchainAiClassifierInput, maxChars: number): string {
    const officialText = truncate(
      input.officialSourceText?.homepageText ?? null,
      Math.min(2_000, Math.max(500, Math.floor(maxChars / 4))),
    );
    const signals = input.officialSourceText?.extractedUseCaseSignals ?? [];
    const evidenceLines = input.externalEvidence
      .map((item) =>
        [
          `id=${item.id}`,
          `sourceType=${item.sourceType}`,
          `trustLevel=${item.trustLevel}`,
          `relevance=${item.relevance}`,
          `sourceName=${item.sourceName ?? ''}`,
          `url=${item.url ?? ''}`,
          `title=${truncate(item.title ?? '', 180) ?? ''}`,
          `snippet=${truncate(item.snippet ?? '', 220) ?? ''}`,
        ].join(' | '),
      )
      .slice(0, 8)
      .join('\n');

    return [
      GEMINI_FLAT_PROMPT,
      '',
      `Token name: ${input.token.name}`,
      `Token symbol: ${input.token.symbol}`,
      `Chain: ${input.token.chain}`,
      `Contract address: ${input.token.contractAddress}`,
      `Official website: ${input.identity.website ?? 'none'}`,
      `Website source: ${input.identity.websiteSource ?? 'none'}`,
      `Discovery mode: ${input.identity.discoveryMode}`,
      `Official link confidence: ${input.identity.officialLinkConfidence}`,
      `Discovered links: ${compactDiscoveredLinks(input.identity.discoveredLinks)}`,
      `Metadata categories: ${input.deterministicHints.metadataCategories?.join(', ') || 'none'}`,
      `Deterministic previous category: ${input.deterministicHints.previousCategory ?? 'none'}`,
      `Crawler signals: ${signals.join(', ') || 'none'}`,
      `Official source excerpt: ${officialText ?? 'none'}`,
      'External evidence lines:',
      evidenceLines || 'none',
      '',
      'Return only the flat JSON object now.',
    ]
      .join('\n')
      .slice(0, maxChars);
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
    return parseAiClassifierJsonResponse(text, (preview) =>
      this.logger.warn(`Invalid AI classifier JSON preview: ${preview}`),
    );
  }

  private async callGemini(
    prompt: string,
    apiKey: string,
    modelName: string,
  ): Promise<Record<string, unknown>> {
    const text = await this.generateGeminiText(prompt, apiKey, modelName);
    return parseAiClassifierJsonResponse(text, (preview) =>
      this.logger.warn(`Invalid Gemini classifier JSON preview: ${preview}`),
    );
  }

  private async generateGeminiText(
    prompt: string,
    apiKey: string,
    modelName: string,
  ): Promise<string> {
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
                'Classify this token project. Return strict JSON matching the requested schema only. ' +
                'Return one JSON object only, with no markdown, no code fences, no comments, and no trailing commas.\n\n' +
                prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 700,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_FLAT_RESPONSE_SCHEMA,
      } as never,
    });

    return result.response.text().trim();
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
    if (isKnownUnrelatedClassifierEvidence(item)) {
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

  return selected.sort(compareClassifierEvidenceQuality).slice(0, 8);
}

function compareClassifierEvidenceQuality(
  left: OffchainEvidenceItem,
  right: OffchainEvidenceItem,
): number {
  return evidencePriority(left) - evidencePriority(right);
}

function evidencePriority(item: OffchainEvidenceItem): number {
  if (item.sourceType === 'official_docs') return 0;
  if (item.sourceType === 'official_security') return 1;
  if (item.sourceType === 'official_website') return 2;
  if (item.sourceType === 'official_github') return 3;
  if (item.sourceType === 'official_whitepaper') return 4;
  if (item.matchedOfficialDomain) return 5;
  if (item.sourceType === 'trusted_directory' && (item.matchedTokenName || item.matchedTokenSymbol)) {
    return 6;
  }
  if (item.sourceType === 'news') return 7;
  if (item.sourceType === 'audit_report' || item.sourceType === 'security_report') return 8;
  if (item.sourceType === 'explorer_identity') return 10;
  if (/dexscreener|geckoterminal|uniswap|price|trading|liquidity/i.test(`${item.url ?? ''} ${item.title ?? ''}`)) {
    return 11;
  }
  return 9;
}

function isKnownUnrelatedClassifierEvidence(item: OffchainEvidenceItem): boolean {
  const text = `${item.url ?? ''} ${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
  if (
    text.includes('ondo.com') ||
    text.includes('ondostate.gov.ng') ||
    text.includes('ondo.neocities.org') ||
    text.includes('ondo-official.com')
  ) {
    return !(item.matchedContractAddress || item.matchedOfficialDomain);
  }
  if (
    String(item.sourceType) === 'dex_pair' &&
    !item.matchedContractAddress &&
    !item.matchedOfficialDomain
  ) {
    return true;
  }
  if (
    /dexscreener|geckoterminal|uniswap|dextools/i.test(`${item.url ?? ''} ${item.title ?? ''}`) &&
    !item.matchedOfficialDomain
  ) {
    return true;
  }
  return false;
}

function validateClassification(
  raw: Record<string, unknown>,
  validEvidenceIds: string[],
  options?: { allowImplicitEvidenceRefs?: boolean },
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
    evidenceRefs: resolveEvidenceRefs(raw.evidenceRefs, validEvidenceIds, options),
    warnings: arrayOfStrings(raw.warnings),
  };
}

function normalizeGeminiClassificationOutput(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.normalizedCategory === 'string' && typeof raw.categoryLabel === 'string') {
    return raw;
  }
  const normalized = hasOldNestedGeminiShape(raw)
    ? normalizeOldNestedGeminiClassificationOutput(raw)
    : raw;
  const flat = normalized as Partial<GeminiFlatOffchainClassificationOutput> &
    Record<string, unknown>;

  return {
    source: 'ai',
    categoryLabel:
      typeof flat.categoryLabel === 'string' && flat.categoryLabel.trim().length > 0
        ? flat.categoryLabel
        : categoryLabelFromCategory(flat.category),
    normalizedCategory: normalizeCategoryValue(flat.category),
    categoryConfidence: flat.categoryConfidence,
    claimedUseCase: flat.claimedUseCase,
    useCaseConfidence: flat.useCaseConfidence,
    identityStatus: flat.identityStatus,
    evidenceQuality: flat.evidenceQuality,
    possibleNarrative: null,
    hasClearUseCase: flat.hasClearUseCase,
    reasoning: truncate(typeof flat.reasoning === 'string' ? flat.reasoning : null, 220),
    evidenceRefs: [],
    warnings:
      typeof flat.warningSummary === 'string' && flat.warningSummary.trim().length > 0
        ? [truncate(flat.warningSummary.trim(), 160)]
        : [],
  };
}

function hasOldNestedGeminiShape(raw: Record<string, unknown>): boolean {
  return isRecord(raw.token) || isRecord(raw.classification);
}

function normalizeOldNestedGeminiClassificationOutput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const classification = isRecord(raw.classification) ? raw.classification : {};
  return {
    category: classification.category,
    categoryLabel:
      typeof classification.category === 'string'
        ? categoryLabelFromCategory(classification.category)
        : undefined,
    categoryConfidence: classification.confidence,
    claimedUseCase: null,
    useCaseConfidence: classification.confidence ?? 'unknown',
    identityStatus: 'unknown',
    evidenceQuality: 'limited',
    hasClearUseCase: null,
    reasoning: classification.reasoning,
    warningSummary: 'Gemini returned old nested schema; normalized safely.',
  };
}

function resolveEvidenceRefs(
  value: unknown,
  validEvidenceIds: string[],
  options?: { allowImplicitEvidenceRefs?: boolean },
): string[] {
  const explicit = arrayOfStrings(value).filter((id) => validEvidenceIds.includes(id));
  if (explicit.length > 0 || !options?.allowImplicitEvidenceRefs) {
    return explicit;
  }
  return validEvidenceIds.slice(0, 3);
}

function normalizeCategoryValue(value: unknown): OffchainAiProjectClassification['normalizedCategory'] {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.toLowerCase().trim();
  if (/\brwa\b|real world asset|tokenized asset|tokenized treasury|institutional/.test(normalized)) {
    return 'rwa';
  }
  if (/socialfi|social/.test(normalized)) return 'socialfi';
  if (/infrastructure|oracle|data feed|interoperability|rpc|indexing/.test(normalized)) {
    return 'infrastructure';
  }
  if (/defi|decentralized finance|lending|borrowing|yield/.test(normalized)) return 'defi';
  if (/meme|community/.test(normalized)) return 'meme';
  if (/gaming|gamefi/.test(normalized)) return 'gaming';
  if (/stablecoin|stable coin/.test(normalized)) return 'stablecoin';
  if (/utility/.test(normalized)) return 'utility';
  if (/^ai$|artificial intelligence/.test(normalized)) return 'ai';
  if (/unknown|insufficient/.test(normalized)) return 'unknown';
  if (/other/.test(normalized)) return 'other';
  return 'unknown';
}

function categoryLabelFromCategory(value: unknown): string {
  const category = normalizeCategoryValue(value);
  switch (category) {
    case 'rwa':
      return 'Tokenized real-world assets / institutional on-chain finance';
    case 'socialfi':
      return 'SocialFi or Web3 social project';
    case 'infrastructure':
      return 'Crypto infrastructure project';
    case 'defi':
      return 'DeFi protocol or finance application';
    case 'meme':
      return 'Meme or community token';
    case 'unknown':
      return 'Unknown or weakly supported project category';
    default:
      return category;
  }
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

  const officialIdentityStrong =
    Boolean(input.identity.website) &&
    input.identity.officialLinkConfidence !== 'low' &&
    input.identity.discoveryMode === 'official_verified';

  if (
    !officialIdentityStrong &&
    guarded.identityStatus === 'unverified' &&
    guarded.hasClearUseCase === true &&
    strongContractEvidence < 2
  ) {
    guarded.hasClearUseCase = false;
    guarded.useCaseConfidence = 'low';
    if (guarded.normalizedCategory === 'meme') {
      guarded.warnings.push(
        'Functional utility evidence is limited because this is primarily a meme/community token.',
      );
    } else {
      guarded.warnings.push('Clear use case downgraded because identity is unverified.');
    }
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

function compactDiscoveredLinks(links: Partial<DiscoveredLinks>): string {
  return Object.entries(links)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .slice(0, 10)
    .join(' | ') || 'none';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAiClassifierJsonResponse(
  value: string,
  onInvalidPreview?: (preview: string) => void,
): Record<string, unknown> {
  const attempts = buildJsonParseAttempts(value);
  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Record<string, unknown>;
    } catch (err: unknown) {
      lastError = err;
    }
  }

  onInvalidPreview?.(previewInvalidJson(value));
  throw lastError instanceof Error ? lastError : new Error('Invalid JSON response');
}

function buildJsonParseAttempts(value: string): string[] {
  const trimmed = stripMarkdownCodeFence(value.trim());
  const extracted = extractFirstJsonObject(trimmed);
  const candidates = [trimmed, extracted].filter((item): item is string => Boolean(item));
  const repaired = candidates.map((candidate) => repairCommonJsonMistakes(candidate));
  return [...new Set([...candidates, ...repaired])];
}

function stripMarkdownCodeFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(value: string): string | null {
  const start = value.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  const end = value.lastIndexOf('}');
  return end > start ? value.slice(start, end + 1) : null;
}

function repairCommonJsonMistakes(value: string): string {
  return value.replace(/,\s*([}\]])/g, '$1');
}

function previewInvalidJson(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
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

function isGeminiQuotaError(message: string): boolean {
  return /429|too many requests|quota|rate limit/i.test(message);
}

function resolveGeminiRetryDelayMs(message: string): number {
  const secondsMatch =
    message.match(/retryDelay["']?\s*[:=]\s*["']?(\d+)s/i) ??
    message.match(/retry(?:\s|-)?after["']?\s*[:=]\s*["']?(\d+)/i);
  if (secondsMatch) {
    const seconds = Number.parseInt(secondsMatch[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1_000, 60 * 60 * 1_000);
    }
  }
  return 60 * 1_000;
}

function buildGeminiBackoffKey(model: string): string {
  return `offchain-ai-backoff:gemini:${model}`;
}

function buildEvidenceHash(input: OffchainAiClassifierInput): string {
  const evidence = input.externalEvidence.map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    trustLevel: item.trustLevel,
    relevance: item.relevance,
    url: item.url,
    title: item.title,
    snippet: item.snippet,
    matchedContractAddress: item.matchedContractAddress,
    matchedOfficialDomain: item.matchedOfficialDomain,
  }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        chain: input.token.chain,
        contractAddress: input.token.contractAddress.toLowerCase(),
        officialWebsite: input.identity.website,
        discoveredLinks: input.identity.discoveredLinks,
        evidence,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

function buildAiClassifierCacheKey(input: {
  chain?: string | null;
  contractAddress?: string | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  provider: 'anthropic' | 'gemini';
  model: string;
  evidenceHash: string;
}): string {
  return `${buildDiscoveryCacheKey(input)}:ai-classifier:${input.provider}:${input.model}:${input.evidenceHash}`;
}
