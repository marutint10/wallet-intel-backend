import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenDeepAnalysisEntity } from '../entities/token-deep-analysis.entity';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import {
  buildDistributionSummary,
  computeHolderQualityBreakdown,
  computeSmartMoneyPct,
  type RawHolder,
  safeNumber,
  safeNumberOrNull,
  safeString,
} from './dashboard-summary.service';
import type { RiskCallout } from './holder-aggregation.service';

/** Same shape as TokenAiSummaryService input (dashboard-derived). */
export interface TokenSummaryInput {
  tokenName: string;
  tokenSymbol: string;
  chain: string;

  avgHolderScore: number;
  qualityLabel: string;
  totalAnalyzedHolders: number;

  convictionPct: number;
  activeTraderPct: number;
  degenPct: number;
  botPct: number;
  dormantPct: number;
  convictionHolderArchetypePct: number;

  decentralizationScore: number;
  giniCoefficient: number;

  top10PctOfRetail: number;
  top50PctOfRetail: number;
  top100PctOfRetail: number;
  /** Top-10 retail wallets' share of total supply (derived). */
  top10RetailShareOfTotalSupply: number;

  rawTop10PctOfTotal: number;
  rawTop50PctOfTotal: number;
  rawGini: number;

  retailSupplyPct: number;
  retailHolderCount: number;
  exchangeSupplyPct: number;
  teamSupplyPct: number;
  burnSupplyPct: number;
  lpSupplyPct: number;

  scope: 'retail-only' | 'all-holder';

  smartMoneyPct: number;
  teamAllocationPct: number;
  exchangeAllocationPct: number;

  classificationBreakdown: Record<string, number>;
  classifiableRetailCount: number;

  riskSignals: string[];
  positiveSignals: string[];
}

const CLAUDE_SYSTEM_PROMPT = `You are a senior crypto investment analyst. Respond only with a valid JSON object.

NUMERIC FIDELITY RULES:
- Every percentage you cite must match EXACTLY a number provided in the on-chain data block.
- Do not round, interpolate, or recombine numbers. If the data says 67%, write 67%, not 69% or "roughly 70%".
- For every concentration figure, you MUST clarify scope inline: write "67% of retail-held supply" or "69% of total supply", never bare "67%".
- Exchange custody is a neutral liquidity signal, never a concentration risk.
- If a number is not in the data block, do not cite it. Say "data not available" instead of fabricating.
- Do not invent "unclassified" holder percentages — use the HOLDER CLASSIFICATION BREAKDOWN counts only.

OFF-CHAIN RULES:
- For factual claims about the project (team names, funding, dates, partnerships, buybacks), only use information in the WEB RESEARCH block.
- Cite the source inline as (Source N) where N matches [Source N] in the web block.
- If a claim cannot be supported by the provided sources, omit it. Do not infer.

Never mention internal implementation terms (e.g. FAST_MODE, legacy PnL, composite holder signal).

No markdown, no explanation outside the JSON.`;

export interface TavilySearchResult {
  query: string;
  title: string;
  url: string;
  content: string;
}

export interface DeepSection {
  title: string;
  summary: string;
  keyPoints: string[];
  sentiment: 'positive' | 'neutral' | 'warning' | 'critical';
  dataSource: 'onchain' | 'offchain' | 'combined';
}

export interface CompetitorEntry {
  name: string;
  edge: string;
  weakness: string;
}

export interface CompetitorSection extends DeepSection {
  competitors: CompetitorEntry[];
}

export interface RiskEntry {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: 'onchain' | 'offchain';
}

export interface RiskSection extends DeepSection {
  risks: RiskEntry[];
}

export interface DeepAnalysisResult {
  contractAddress: string;
  chain: string;
  tokenName: string;
  tokenSymbol: string;
  generatedAt: string;
  dataFreshness: string;
  overallVerdict: {
    summary: string;
    strengthScore: number;
    confidenceLevel: 'low' | 'medium' | 'high';
  };
  sections: {
    projectOverview: DeepSection;
    teamAndLegitimacy: DeepSection;
    marketPosition: DeepSection;
    competitorComparison: CompetitorSection;
    communityAndSocial: DeepSection;
    onChainVsOffChain: DeepSection;
    riskAssessment: RiskSection;
    investmentSignals: DeepSection;
  };
  disclaimer: string;
}

export interface DeepAnalysisStatusResponse {
  status: 'not_started' | 'pending' | 'processing' | 'done' | 'error';
  result?: DeepAnalysisResult;
  errorMessage?: string;
  generatedAt?: string;
}

@Injectable()
export class TokenDeepAnalysisService {
  private static readonly TAVILY_API_URL = 'https://api.tavily.com/search';
  private static readonly TAVILY_MAX_RESULTS = 3;
  private static readonly TAVILY_SEARCH_DEPTH = 'basic';
  private static readonly CLAUDE_MODEL = 'claude-sonnet-4-6';
  private static readonly CLAUDE_MAX_TOKENS = 4000;
  private static readonly CACHE_TTL_MS = 48 * 60 * 60 * 1000;
  private static readonly PROMPT_VERSION = 3;

  private static readonly FORBIDDEN_OUTPUT_TERMS = [
    /FAST_MODE/gi,
    /legacy PnL/gi,
    /PnL-proven/gi,
    /composite holder signal/gi,
  ];
  private readonly logger = new Logger(TokenDeepAnalysisService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TokenDeepAnalysisEntity)
    private readonly deepAnalysisRepo: Repository<TokenDeepAnalysisEntity>,
    @InjectRepository(TokenAnalysisEntity)
    private readonly tokenAnalysisRepo: Repository<TokenAnalysisEntity>,
  ) {}

  async triggerDeepAnalysis(
    contractAddress: string,
    chain: string,
  ): Promise<{ status: string }> {
    const normalized = contractAddress.toLowerCase();

    try {
      const existing = await this.deepAnalysisRepo.findOne({
        where: { contractAddress: normalized, chain },
      });

      if (
        existing?.status === 'done' &&
        (existing.promptVersion ?? 1) >= TokenDeepAnalysisService.PROMPT_VERSION &&
        Date.now() - existing.updatedAt.getTime() <
          TokenDeepAnalysisService.CACHE_TTL_MS
      ) {
        return { status: 'cached' };
      }

      await this.deepAnalysisRepo.upsert(
        {
          contractAddress: normalized,
          chain,
          status: 'pending',
          errorMessage: null,
          result: null,
          tavilyQueries: null,
          updatedAt: new Date(),
        },
        ['contractAddress', 'chain'],
      );

      void this.runDeepAnalysis(normalized, chain).catch((err: unknown) => {
        this.logger.error(
          `[TokenDeepAnalysis] background run failed ${normalized} ${chain}: ${this.getErrorMessage(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      });

      return { status: 'queued' };
    } catch (err: unknown) {
      this.logger.error(
        `[TokenDeepAnalysis] trigger failed ${normalized}: ${this.getErrorMessage(err)}`,
      );
      return { status: 'error' };
    }
  }

  async getDeepAnalysis(
    contractAddress: string,
    chain: string,
  ): Promise<DeepAnalysisStatusResponse> {
    const normalized = contractAddress.toLowerCase();
    const row = await this.deepAnalysisRepo.findOne({
      where: { contractAddress: normalized, chain },
    });

    if (!row) {
      return { status: 'not_started' };
    }

    if (row.status === 'pending' || row.status === 'processing') {
      return { status: row.status as 'pending' | 'processing' };
    }

    if (row.status === 'error') {
      return {
        status: 'error',
        errorMessage: row.errorMessage ?? undefined,
      };
    }

    if (row.status === 'done' && row.result) {
      return {
        status: 'done',
        result: row.result as unknown as DeepAnalysisResult,
        generatedAt: row.updatedAt.toISOString(),
      };
    }

    if (row.status === 'done') {
      return {
        status: 'error',
        errorMessage: 'Analysis completed without stored result',
      };
    }

    return { status: 'not_started' };
  }

  private async runDeepAnalysis(
    contractAddress: string,
    chain: string,
  ): Promise<void> {
    const normalized = contractAddress.toLowerCase();

    try {
      await this.deepAnalysisRepo.update(
        { contractAddress: normalized, chain },
        { status: 'processing', errorMessage: null, updatedAt: new Date() },
      );

      const analysis = await this.tokenAnalysisRepo.findOne({
        where: { contractAddress: normalized, chain, status: 'done' },
      });

      if (!analysis) {
        throw new Error('Token analysis not found or not complete');
      }

      const summaryInput = this.buildSummaryInput(analysis);

      const tokenName = safeString(analysis.tokenName, 'Unknown');
      const tokenSymbol = safeString(analysis.tokenSymbol, '');

      const queries = [
        `${tokenName} ${tokenSymbol} crypto project overview what does it do`,
        `${tokenName} ${tokenSymbol} team founders investors funding`,
        `${tokenName} ${tokenSymbol} latest news updates 2025`,
        `${tokenName} ${tokenSymbol} security audit smart contract`,
        `${tokenName} ${tokenSymbol} competitors alternatives`,
        `${tokenName} crypto competitors similar projects 2024 2025`,
        `${tokenName} ${tokenSymbol} community twitter discord activity`,
      ];

      const tavilyApiKey =
        this.configService.get<string>('TAVILY_API_KEY') ??
        this.configService.get<string>('tavily.apiKey') ??
        '';

      let webResults: TavilySearchResult[] = [];

      if (!tavilyApiKey.trim()) {
        this.logger.warn(
          `[TokenDeepAnalysis] TAVILY_API_KEY missing; continuing without web search for ${normalized}`,
        );
      } else {
        const settled = await Promise.allSettled(
          queries.map((q) => this.searchTavily(q, tavilyApiKey)),
        );

        webResults = settled
          .filter((r): r is PromiseFulfilledResult<TavilySearchResult> => r.status === 'fulfilled')
          .map((r) => r.value);

        const failed = settled.filter((r) => r.status === 'rejected').length;
        if (failed > 0) {
          this.logger.warn(
            `[TokenDeepAnalysis] ${failed} Tavily search(es) failed for ${normalized}`,
          );
        }

        if (webResults.length === 0 && queries.length > 0) {
          this.logger.warn(
            `[TokenDeepAnalysis] all Tavily searches empty or failed for ${normalized}`,
          );
        }
      }

      const tavilyQueriesPayload: Record<string, unknown> = {
        queries,
        results: webResults,
      };

      const anthropicApiKey =
        this.configService.get<string>('ANTHROPIC_API_KEY') ??
        this.configService.get<string>('anthropic.apiKey') ??
        '';

      if (!anthropicApiKey.trim()) {
        throw new Error('ANTHROPIC_API_KEY not configured');
      }

      const prompt = this.buildClaudePrompt(
        summaryInput,
        webResults,
        tokenName,
        tokenSymbol,
      );

      const parsed = this.sanitizeDeepAnalysisOutput(
        await this.callClaude(prompt, anthropicApiKey),
        normalized,
      );

      const dataFreshness = `Web data searched on ${new Date().toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })}`;

      const result: DeepAnalysisResult = {
        contractAddress: normalized,
        chain,
        tokenName,
        tokenSymbol: safeString(analysis.tokenSymbol, ''),
        generatedAt: new Date().toISOString(),
        dataFreshness,
        overallVerdict: parsed.overallVerdict as DeepAnalysisResult['overallVerdict'],
        sections: parsed.sections as DeepAnalysisResult['sections'],
        disclaimer:
          'This analysis is based on publicly available on-chain data and web research at the time of generation. It does not constitute investment advice.',
      };

      await this.deepAnalysisRepo.update(
        { contractAddress: normalized, chain },
        {
          status: 'done',
          result: result as object,
          tavilyQueries: tavilyQueriesPayload as object,
          promptVersion: TokenDeepAnalysisService.PROMPT_VERSION,
          errorMessage: null,
          updatedAt: new Date(),
        },
      );
    } catch (err: unknown) {
      const message = this.getErrorMessage(err);
      if (this.isAnthropicBillingError(err)) {
        this.logger.warn(
          `[TokenDeepAnalysis] skipped ${normalized} ${chain}: Anthropic billing/credit limit`,
        );
        await this.deepAnalysisRepo.update(
          { contractAddress: normalized, chain },
          {
            status: 'skipped',
            errorMessage:
              'Deep analysis skipped because Anthropic billing credits are unavailable.',
            updatedAt: new Date(),
          },
        );
        return;
      }
      this.logger.error(
        `[TokenDeepAnalysis] run failed ${normalized} ${chain}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.deepAnalysisRepo.update(
        { contractAddress: normalized, chain },
        {
          status: 'error',
          errorMessage: message,
          updatedAt: new Date(),
        },
      );
    }
  }

  /** Mirrors TokenAiSummaryService.buildInput + partitionCalloutTitles. */
  private buildSummaryInput(analysis: TokenAnalysisEntity): TokenSummaryInput {
    const quality = (analysis.qualityMetrics ?? {}) as Record<string, unknown>;
    const distribution = (analysis.distribution ?? {}) as Record<string, unknown>;
    const rawHolders = Array.isArray(analysis.holdersData)
      ? (analysis.holdersData as RawHolder[])
      : [];
    const riskCallouts = Array.isArray(analysis.riskCallouts)
      ? (analysis.riskCallouts as RiskCallout[])
      : [];

    const distributionSummary = buildDistributionSummary(distribution);
    const holderQualityBreakdown = computeHolderQualityBreakdown(rawHolders);

    const breakdown = (quality.breakdown ?? {}) as Record<string, unknown>;
    const pnlAggregation = (quality.pnlAggregation ?? {}) as Record<string, unknown>;
    const categoryConcentration = (quality.categoryConcentration ?? {}) as Record<
      string,
      unknown
    >;
    const teamDetection = (quality.teamDetection ?? null) as Record<
      string,
      unknown
    > | null;

    const totalAnalyzedEOAs = safeNumber(quality.totalAnalyzedEOAs);
    const smartMoneyCount = safeNumber(pnlAggregation.smartMoneyCount);
    const portfolioSmartMoneyCount = safeNumber(
      pnlAggregation.portfolioSmartMoneyCount,
    );
    const smartMoneyPct = computeSmartMoneyPct(
      smartMoneyCount,
      portfolioSmartMoneyCount,
      totalAnalyzedEOAs,
      rawHolders,
    );

    const avgScoreRaw = safeNumberOrNull(quality.avgScore);
    const avgHolderScore =
      avgScoreRaw !== null && Number.isFinite(avgScoreRaw)
        ? Math.round(avgScoreRaw)
        : 0;

    const eoaCount = rawHolders.filter((h) => h && h.walletLabel === 'eoa').length;
    const totalAnalyzedHolders =
      totalAnalyzedEOAs > 0 ? totalAnalyzedEOAs : eoaCount > 0 ? eoaCount : rawHolders.length;

    const exchangesEntry = (categoryConcentration.exchanges ?? {}) as Record<
      string,
      unknown
    >;

    const { riskSignals, positiveSignals } =
      this.partitionCalloutTitles(riskCallouts);

    const supplyBreakdown = (distribution.supplyBreakdown ?? {}) as Record<
      string,
      { pctOfSupply?: number }
    >;
    const supplyConcentration = (distribution.supplyConcentration ?? {}) as Record<
      string,
      unknown
    >;

    const retailSupplyPct = safeNumber(supplyBreakdown.retail?.pctOfSupply);
    const exchangeSupplyPct = safeNumber(supplyBreakdown.exchange?.pctOfSupply);
    const teamSupplyPct = safeNumber(supplyBreakdown.team?.pctOfSupply);
    const burnSupplyPct = safeNumber(supplyBreakdown.burn?.pctOfSupply);
    const lpSupplyPct = safeNumber(supplyBreakdown.lp?.pctOfSupply);
    const retailHolderCount = safeNumber(distribution.retailHolderCount);

    const top10PctOfRetail = safeNumber(supplyConcentration.top10Pct);
    const top50PctOfRetail = safeNumber(supplyConcentration.top50Pct);
    const top100PctOfRetail = safeNumber(supplyConcentration.top100Pct);
    const top10RetailShareOfTotalSupply =
      Math.round(((top10PctOfRetail * retailSupplyPct) / 100) * 10) / 10;

    const rawTop10PctOfTotal = distributionSummary.raw.top10PctOfTotal;
    const rawTop50PctOfTotal = distributionSummary.raw.top50PctOfTotal;
    const rawGini = distributionSummary.raw.giniCoefficient;

    const classificationBreakdown =
      (quality.classificationBreakdown as Record<string, number>) ?? {};
    const classifiableRetailCount = safeNumber(quality.classifiableRetailCount);

    const scope: 'retail-only' | 'all-holder' =
      distribution.scope === 'retail-only' ? 'retail-only' : 'all-holder';

    return {
      tokenName: safeString(analysis.tokenName, 'Unknown'),
      tokenSymbol: safeString(analysis.tokenSymbol, 'N/A'),
      chain: safeString(analysis.chain, 'ethereum'),
      avgHolderScore,
      qualityLabel: safeString(quality.qualityLabel, 'Unknown'),
      totalAnalyzedHolders,
      convictionPct:
        holderQualityBreakdown.convictionHolders +
        holderQualityBreakdown.diamondHands +
        holderQualityBreakdown.accumulators,
      activeTraderPct: safeNumber(breakdown.activeTraders),
      degenPct: safeNumber(breakdown.riskDegen),
      botPct: safeNumber(breakdown.bots),
      dormantPct: holderQualityBreakdown.dormant,
      convictionHolderArchetypePct: holderQualityBreakdown.convictionHolders,
      decentralizationScore: distributionSummary.decentralizationScore,
      giniCoefficient: distributionSummary.giniCoefficient,

      top10PctOfRetail,
      top50PctOfRetail,
      top100PctOfRetail,
      top10RetailShareOfTotalSupply,

      rawTop10PctOfTotal,
      rawTop50PctOfTotal,
      rawGini,

      retailSupplyPct,
      retailHolderCount,
      exchangeSupplyPct,
      teamSupplyPct,
      burnSupplyPct,
      lpSupplyPct,
      scope,

      smartMoneyPct,
      teamAllocationPct: safeNumber((teamDetection ?? {}).teamTotalPctOfSupply),
      exchangeAllocationPct: safeNumber(exchangesEntry.pctOfSupply),
      classificationBreakdown,
      classifiableRetailCount,
      riskSignals: riskSignals.map((s) => this.scrubInternalTerms(s)),
      positiveSignals: positiveSignals.map((s) => this.scrubInternalTerms(s)),
    };
  }

  private scrubInternalTerms(text: string): string {
    return text
      .replace(/FAST_MODE/gi, '')
      .replace(/legacy PnL/gi, '')
      .replace(/PnL-proven/gi, '')
      .replace(/composite holder signal/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private formatClassificationBreakdownBlock(input: TokenSummaryInput): string {
    const entries = Object.entries(input.classificationBreakdown)
      .filter(([, count]) => safeNumber(count) > 0)
      .sort((a, b) => safeNumber(b[1]) - safeNumber(a[1]));

    const lines =
      entries.length > 0
        ? entries.map(([label, count]) => `- ${label}: ${safeNumber(count)} wallets`)
        : ['- No classification counts available'];

    const totalClassified = entries.reduce(
      (sum, [, count]) => sum + safeNumber(count),
      0,
    );
    const retailTotal =
      input.classifiableRetailCount > 0
        ? input.classifiableRetailCount
        : input.retailHolderCount;

    return [
      'HOLDER CLASSIFICATION BREAKDOWN (wallet counts — use these, not invented percentages)',
      ...lines,
      `- Total classified: ${totalClassified} of ${retailTotal} retail wallets`,
      '',
      'DO NOT claim any holders are "unclassified" — every retail wallet above has a classification label.',
      'DO NOT invent trader/degen/unclassified percentage breakdowns.',
    ].join('\n');
  }

  private sanitizeDeepAnalysisOutput(
    parsed: Record<string, unknown>,
    contractAddress: string,
  ): Record<string, unknown> {
    let json = JSON.stringify(parsed);
    for (const pattern of TokenDeepAnalysisService.FORBIDDEN_OUTPUT_TERMS) {
      if (pattern.test(json)) {
        this.logger.warn(
          `[TokenDeepAnalysis] scrubbing internal term in output for ${contractAddress}`,
        );
        json = json.replace(pattern, '');
      }
    }
    return JSON.parse(json) as Record<string, unknown>;
  }

  private partitionCalloutTitles(callouts: RiskCallout[]): {
    riskSignals: string[];
    positiveSignals: string[];
  } {
    const positiveSignals = callouts
      .filter((c) => c.type === 'positive')
      .map((c) => c.title.trim())
      .filter((t) => t.length > 0);

    const riskSignals = callouts
      .filter((c) => c.type !== 'positive')
      .map((c) => c.title.trim())
      .filter((t) => t.length > 0 && t !== 'Standard Distribution');

    return { riskSignals, positiveSignals };
  }

  private async searchTavily(
    query: string,
    apiKey: string,
  ): Promise<TavilySearchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(TokenDeepAnalysisService.TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: TokenDeepAnalysisService.TAVILY_SEARCH_DEPTH,
          max_results: TokenDeepAnalysisService.TAVILY_MAX_RESULTS,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `[TokenDeepAnalysis] Tavily HTTP ${response.status} for query="${query.slice(0, 80)}"`,
        );
        return { query, title: '', url: '', content: '' };
      }

      const body = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
        }>;
      };

      const first = Array.isArray(body.results) ? body.results[0] : undefined;
      if (!first) {
        return { query, title: '', url: '', content: '' };
      }

      return {
        query,
        title: first.title ?? '',
        url: first.url ?? '',
        content: (first.content ?? '').slice(0, 500),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `[TokenDeepAnalysis] Tavily search failed: ${this.getErrorMessage(err)}`,
      );
      return { query, title: '', url: '', content: '' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildClaudePrompt(
    input: TokenSummaryInput,
    webResults: TavilySearchResult[],
    tokenName: string,
    tokenSymbol: string,
  ): string {
    const offChainBlock =
      webResults.length === 0
        ? 'No web search results available. Base analysis on on-chain data only and acknowledge this limitation.'
        : webResults
            .map(
              (r, i) =>
                `[Source ${i + 1}] Query: "${r.query}"\nTitle: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`,
            )
            .join('\n\n---\n\n');

    const sampleSizeNote =
      input.retailHolderCount < 100
        ? `\n- Only ${input.retailHolderCount} retail wallets exist in the top 100. ` +
          `If top-50 or top-100 retail figures show 100%, that is a SAMPLE-SIZE ARTIFACT, not concentration risk. ` +
          `Never frame it as a concentration signal.`
        : '';

    const classificationBlock = this.formatClassificationBreakdownBlock(input);

    const scopeBlock =
      input.scope === 'retail-only'
        ? `
=== METRIC SCOPE — CRITICAL, READ BEFORE WRITING ANY SECTION ===
Two concentration scopes are provided. Never mix them without labeling:
- RETAIL-SCOPED: % of supply held by retail wallets only (retail = ${input.retailSupplyPct}% of total).
- ALL-HOLDER: % of TOTAL supply held by top N wallets regardless of bucket.
- Exchange custody (${input.exchangeSupplyPct}% of total) is NEUTRAL (CEX accessibility), not concentration risk.
- Team/treasury: ${input.teamSupplyPct}%. Burned: ${input.burnSupplyPct}%. LP pools: ${input.lpSupplyPct}%.${sampleSizeNote}

For overallVerdict, riskAssessment, and onChainVsOffChain: cite ALL-HOLDER figures for concentration.
`.trim()
        : '';

    return `You are a senior crypto token-risk analyst.

Analyze this token using both on-chain intelligence and off-chain web research provided below.
Produce a structured risk-focused token trust research report.

HARD RULES:
- Do NOT predict price movement
- Do NOT say scam, rug pull, or variants — describe concerning signals factually
- Do NOT give investment advice or buy/sell recommendations  
- Do NOT fabricate information not present in the provided data
- Every on-chain percentage must match EXACTLY a number below — no rounding or guessing
- If data is insufficient for a section, acknowledge the limitation clearly
- Respond ONLY with a valid JSON object, no markdown, no explanation
- Off-chain facts (team names, funding, dates, buybacks) must appear in WEB RESEARCH and be cited as (Source N), or omitted

${scopeBlock}

=== ON-CHAIN INTELLIGENCE ===
Token: ${tokenName} (${tokenSymbol}) on ${input.chain}

SUPPLY COMPOSITION (% of total supply — cite these exact figures only)
- Retail wallets: ${input.retailSupplyPct}% (${input.retailHolderCount} addresses)
- Exchange custody: ${input.exchangeSupplyPct}% [neutral liquidity signal]
- Team / Treasury: ${input.teamSupplyPct}%
- Burned: ${input.burnSupplyPct}%
- LP pools: ${input.lpSupplyPct}%

HOLDER QUALITY (retail wallets only)
- Average Holder Score: ${input.avgHolderScore}/100 (${input.qualityLabel})
- Smart Money wallets: ${input.smartMoneyPct}% of analyzed retail EOAs
- Team-linked supply (quality metrics): ${input.teamAllocationPct}% of total supply

${classificationBlock}

RETAIL CONCENTRATION (within retail-held supply only — retail = ${input.retailSupplyPct}% of total)
- Top 10 retail wallets: ${input.top10PctOfRetail}% of retail-held supply
- Top 50 retail wallets: ${input.top50PctOfRetail}% of retail-held supply
- Top 100 retail wallets: ${input.top100PctOfRetail}% of retail-held supply
- Top 10 retail share of total supply (derived): ${input.top10RetailShareOfTotalSupply}% of total supply
- Decentralization Score: ${input.decentralizationScore}/100 (retail-only)
- Gini Coefficient: ${input.giniCoefficient} (retail-only)

ALL-HOLDER CONCENTRATION (% of TOTAL supply — use for overall verdict)
- Top 10 holders (all buckets): ${input.rawTop10PctOfTotal}% of total supply
- Top 50 holders (all buckets): ${input.rawTop50PctOfTotal}% of total supply
- Gini Coefficient: ${input.rawGini} (all-holder)

SIGNALS (titles only — do not invent additional metrics)
- Risk: ${input.riskSignals.join(', ') || 'None detected'}
- Positive: ${input.positiveSignals.join(', ') || 'None detected'}

=== OFF-CHAIN WEB RESEARCH ===
${offChainBlock}

=== REQUIRED JSON OUTPUT ===
Return exactly this JSON structure with all fields populated:

{
  "overallVerdict": {
    "summary": "2-3 sentence risk summary. For concentration, cite ALL-HOLDER figures (e.g. top 10 = ${input.rawTop10PctOfTotal}% of total supply). Off-chain claims must cite (Source N).",
    "strengthScore": <integer 0-100>,
    "confidenceLevel": "<low|medium|high>"
  },
  "sections": {
    "projectOverview": {
      "title": "Project Overview",
      "summary": "3-5 sentences on what the project does, mission, category, launch timeline",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined"
    },
    "teamAndLegitimacy": {
      "title": "Team & Legitimacy",
      "summary": "3-5 sentences on team credibility, doxxed status, backers, any red flags. Cite (Source N) for every named person or funding claim.",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "offchain"
    },
    "marketPosition": {
      "title": "Market Position",
      "summary": "3-5 sentences on the project's standing in its sector and total addressable market",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined"
    },
    "competitorComparison": {
      "title": "Competitor Comparison",
      "summary": "3-5 sentences comparing to main competitors launched in similar timeframe or sector",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "offchain",
      "competitors": [
        {
          "name": "<competitor name>",
          "edge": "<where competitor leads this project>",
          "weakness": "<where this project leads or competitor lacks>"
        }
      ]
    },
    "communityAndSocial": {
      "title": "Community & Social Health",
      "summary": "3-5 sentences on Twitter/X presence, Discord/Telegram activity, community quality vs on-chain holder behavior",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "offchain"
    },
    "onChainVsOffChain": {
      "title": "On-Chain vs Off-Chain Alignment",
      "summary": "3-5 sentences comparing marketing claims vs on-chain data. Use ALL-HOLDER concentration (${input.rawTop10PctOfTotal}% top-10 of total supply). Cite (Source N) for off-chain claims.",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined"
    },
    "riskAssessment": {
      "title": "Risk Assessment",
      "summary": "3-5 sentences covering the most significant combined on-chain and off-chain risks. Do not flag exchange custody as risk. Do not flag sample-size artifacts as risk.",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined",
      "risks": [
        {
          "title": "<risk name>",
          "description": "<factual description of the risk>",
          "severity": "<low|medium|high|critical>",
          "source": "<onchain|offchain>"
        }
      ]
    },
    "investmentSignals": {
      "title": "Structural Trust Signals",
      "summary": "3-5 sentences on structural trust and risk signals relevant to retail users",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined"
    }
  },
  "disclaimer": "This analysis is based on publicly available on-chain data and web research at the time of generation. It does not constitute investment advice."
}`;
  }

  private async callClaude(
    prompt: string,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    try {
      this.logger.debug(
        `[DeepAnalysis] API key length: ${apiKey.length}, model: ${TokenDeepAnalysisService.CLAUDE_MODEL}`,
      );
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: TokenDeepAnalysisService.CLAUDE_MODEL,
        max_tokens: TokenDeepAnalysisService.CLAUDE_MAX_TOKENS,
        temperature: 0,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      let text = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
      text = text.trim();

      const stripped = this.stripMarkdownCodeFence(text);
      const parsed = JSON.parse(stripped) as Record<string, unknown>;

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('overallVerdict' in parsed) ||
        !('sections' in parsed)
      ) {
        throw new Error('Claude response missing required fields');
      }

      return parsed;
    } catch (err: unknown) {
      this.logger.error(
        `[TokenDeepAnalysis] callClaude failed: ${this.getErrorMessage(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }

  private stripMarkdownCodeFence(value: string): string {
    return value
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private isAnthropicBillingError(error: unknown): boolean {
    const message = this.getErrorMessage(error).toLowerCase();
    return (
      message.includes('credit balance is too low') ||
      message.includes('billing') ||
      message.includes('insufficient credits') ||
      message.includes('payment required')
    );
  }
}
