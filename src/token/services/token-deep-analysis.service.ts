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
  top10Pct: number;
  top50Pct: number;

  smartMoneyPct: number;
  teamAllocationPct: number;
  exchangeAllocationPct: number;

  riskSignals: string[];
  positiveSignals: string[];
}

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

      const parsed = await this.callClaude(prompt, anthropicApiKey);

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
          errorMessage: null,
          updatedAt: new Date(),
        },
      );
    } catch (err: unknown) {
      const message = this.getErrorMessage(err);
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
      top10Pct: distributionSummary.top10Pct,
      top50Pct: distributionSummary.top50Pct,
      smartMoneyPct,
      teamAllocationPct: safeNumber((teamDetection ?? {}).teamTotalPctOfSupply),
      exchangeAllocationPct: safeNumber(exchangesEntry.pctOfSupply),
      riskSignals,
      positiveSignals,
    };
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

    return `You are a senior crypto investment analyst at a tier-1 venture capital firm.

Analyze this token using both on-chain intelligence and off-chain web research provided below.
Produce a structured investment-grade deep analysis report.

HARD RULES:
- Do NOT predict price movement
- Do NOT say scam, rug pull, or variants — describe concerning signals factually
- Do NOT give investment advice or buy/sell recommendations  
- Do NOT fabricate information not present in the provided data
- If data is insufficient for a section, acknowledge the limitation clearly
- Respond ONLY with a valid JSON object, no markdown, no explanation

=== ON-CHAIN INTELLIGENCE ===
Token: ${tokenName} (${tokenSymbol}) on ${input.chain}
Average Holder Score: ${input.avgHolderScore}/100 (${input.qualityLabel})
Decentralization Score: ${input.decentralizationScore}/100
Gini Coefficient: ${input.giniCoefficient}
Top 10 Holder Concentration: ${input.top10Pct}%
Top 50 Holder Concentration: ${input.top50Pct}%
Team-Linked Supply: ${input.teamAllocationPct}%
Exchange Supply: ${input.exchangeAllocationPct}%
Smart Money Wallets: ${input.smartMoneyPct}%
Conviction Holders (Diamond Hands/HODLers): ${input.convictionPct}%
Active Traders (Swing/Day): ${input.activeTraderPct}%
Degen/High-Risk Holders: ${input.degenPct}%
Passive Conviction Holders: ${input.convictionHolderArchetypePct}%
Dormant / No Profile Holders: ${input.dormantPct}%
Risk Signals: ${input.riskSignals.join(', ') || 'None detected'}
Positive Signals: ${input.positiveSignals.join(', ') || 'None detected'}

=== OFF-CHAIN WEB RESEARCH ===
${offChainBlock}

=== REQUIRED JSON OUTPUT ===
Return exactly this JSON structure with all fields populated:

{
  "overallVerdict": {
    "summary": "2-3 sentence executive summary combining on-chain and off-chain signals",
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
      "summary": "3-5 sentences on team credibility, doxxed status, backers, any red flags",
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
      "summary": "3-5 sentences comparing what the project claims or markets vs what on-chain holder data actually shows",
      "keyPoints": ["<3-5 specific points>"],
      "sentiment": "<positive|neutral|warning|critical>",
      "dataSource": "combined"
    },
    "riskAssessment": {
      "title": "Risk Assessment",
      "summary": "3-5 sentences covering the most significant combined on-chain and off-chain risks",
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
      "title": "Structural Investment Signals",
      "summary": "3-5 sentences on structural quality signals most relevant to VCs and institutional traders",
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
        system:
          'You are a senior crypto investment analyst. Respond only with a valid JSON object. No markdown, no explanation outside the JSON.',
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
}
