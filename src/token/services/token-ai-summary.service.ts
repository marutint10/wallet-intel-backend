import { GoogleGenerativeAI } from '@google/generative-ai';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import type { RiskCallout } from './holder-aggregation.service';
import {
  buildDistributionSummary,
  computeHolderQualityBreakdown,
  computeSmartMoneyPct,
  type RawHolder,
  safeNumber,
  safeNumberOrNull,
  safeString,
} from './dashboard-summary.service';

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

  top10PctOfTotal: number;

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

  riskSignals: string[];
  positiveSignals: string[];
}

type GeminiOnceResult = { text: string; finishReason: string };

const TOKEN_ANALYST_SYSTEM_PROMPT = `You are a professional on-chain token analyst at a crypto intelligence firm.

Your job is to write a concise 4-5 sentence analytical summary of a token's holder health, 
based on structured on-chain intelligence data provided to you.

Your audience is a mix of:
- Token project founders reviewing their own community health
- Venture capitalists conducting token due diligence
- Experienced crypto traders evaluating a token before taking a position

Tone guidelines:
- Professional, precise, and neutral
- Write like a senior analyst, not a marketer
- Do not use hype language ("amazing", "bullish", "promising")
- Do not use fear language ("dump", "rug", "scam")
- If signals are negative, describe them factually and professionally
  (e.g. "elevated concentration risk" not "this will dump")

Hard rules:
- Do NOT predict future price movement
- Do NOT predict what holders will do
- Do NOT use the word "scam" or any variant
- Do NOT give investment advice
- Only describe what the on-chain data currently shows
- Stay strictly factual — do not infer beyond the data

Structure your summary as follows:
1. Open with an overall assessment of holder quality and community strength
2. Describe the supply distribution and concentration profile
3. Describe the community composition (conviction holders, traders, unclassified)
4. Highlight the most significant risk signal OR positive signal from the data
5. Close with a note on team allocation or smart money presence if material

Output format:
- Plain text only
- 4-5 sentences
- No bullet points
- No headers
- No markdown`;

@Injectable()
export class TokenAiSummaryService {
  private static readonly CACHE_PREFIX = 'token:summary:v2:';
  private static readonly CACHE_TTL_SECONDS = 86_400;
  private static readonly FALLBACK_CACHE_TTL_SECONDS = 1_800;
  private static readonly GEMINI_PRIMARY_MODEL = 'gemini-2.5-flash';
  private static readonly GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash-lite'];
  private static readonly GEMINI_MAX_OUTPUT_TOKENS = 1024;
  private static readonly GEMINI_MAX_RETRIES = 2;
  private static readonly GEMINI_BASE_RETRY_DELAY_MS = 600;
  private static readonly MIN_CHARS_PER_SENTENCE = 35;
  private readonly logger = new Logger(TokenAiSummaryService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async generateSummary(analysis: TokenAnalysisEntity): Promise<string> {
    const input = this.buildInput(analysis);
    const cacheKey =
      TokenAiSummaryService.CACHE_PREFIX +
      `${analysis.chain}:${analysis.contractAddress.toLowerCase()}`;
    const fallback = this.buildFallbackSummary(input);

    try {
      const cached = await this.cacheManager.get<string>(cacheKey);
      if (typeof cached === 'string' && cached.trim().length > 0) {
        this.logger.debug(
          `[TokenAISummary] cache hit ${analysis.contractAddress} ${analysis.chain}`,
        );
        return cached;
      }

      const apiKey =
        this.configService.get<string>('GEMINI_API_KEY') ??
        this.configService.get<string>('gemini.apiKey') ??
        '';

      if (apiKey.trim().length === 0) {
        this.logger.warn(
          `[TokenAISummary] GEMINI_API_KEY missing; using fallback for ${analysis.contractAddress}`,
        );
        await this.setCacheSafe(cacheKey, fallback, true);
        return fallback;
      }

      const userPrompt = this.buildUserPrompt(input);
      const text = await this.callGeminiWithRetry(apiKey, userPrompt, analysis);

      if (text.length === 0) {
        this.logger.warn(
          `[TokenAISummary] empty Gemini response; fallback for ${analysis.contractAddress}`,
        );
        await this.setCacheSafe(cacheKey, fallback, true);
        return fallback;
      }

      await this.setCacheSafe(cacheKey, text, false);
      return text;
    } catch (err: unknown) {
      this.logger.warn(
        `[TokenAISummary] generation failed for ${analysis.contractAddress}: ${this.getErrorMessage(err)}`,
      );
      try {
        await this.setCacheSafe(cacheKey, fallback, true);
      } catch {
        // ignore secondary cache errors
      }
      return fallback;
    }
  }

  private buildInput(analysis: TokenAnalysisEntity): TokenSummaryInput {
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

    const { riskSignals, positiveSignals } = this.partitionCalloutTitles(riskCallouts);

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

    const top10PctOfTotal =
      Math.round(((top10PctOfRetail * retailSupplyPct) / 100) * 10) / 10;

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
      top10PctOfTotal,

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

  private buildUserPrompt(input: TokenSummaryInput): string {
    const riskLine =
      input.riskSignals.length > 0
        ? `Risk signals detected: ${input.riskSignals.join(', ')}.`
        : 'No major risk signals detected.';

    const positiveLine =
      input.positiveSignals.length > 0
        ? `Positive signals: ${input.positiveSignals.join(', ')}.`
        : '';

    const sampleSizeNote =
      input.retailHolderCount < 100
        ? `\nNOTE: Only ${input.retailHolderCount} retail wallets were analyzed in the top 100 holders. ` +
          `If top 50 or top 100 retail concentration shows 100%, this is a SAMPLE-SIZE ARTIFACT ` +
          `(there are fewer than 50 or 100 retail wallets in the set), NOT a concentration risk. ` +
          `Do not describe this as concerning.`
        : '';

    const scopeWarning =
      input.scope === 'retail-only'
        ? `
CRITICAL — READ BEFORE WRITING:
- All concentration figures (top 10 / top 50 / top 100) are scoped to RETAIL wallets only.
- Retail wallets hold ${input.retailSupplyPct}% of total supply across ${input.retailHolderCount} addresses.
- The other ${(100 - input.retailSupplyPct).toFixed(1)}% is: exchange custody ${input.exchangeSupplyPct}%, team/treasury ${input.teamSupplyPct}%, burned ${input.burnSupplyPct}%, LP pools ${input.lpSupplyPct}%.
- "Top 10 retail = ${input.top10PctOfRetail}%" means those 10 wallets hold ~${input.top10PctOfTotal}% of TOTAL supply.
- Exchange custody is a NEUTRAL liquidity signal indicating CEX accessibility, NOT a concentration risk.${sampleSizeNote}
`.trim()
        : '';

    return `
${scopeWarning}

Generate a professional analyst summary for the following token:

Token: ${input.tokenName} (${input.tokenSymbol}) on ${input.chain}

SUPPLY COMPOSITION (% of total supply)
- Retail wallets: ${input.retailSupplyPct}% (across ${input.retailHolderCount} addresses)
- Exchange custody: ${input.exchangeSupplyPct}% (neutral signal)
- Team / Treasury: ${input.teamSupplyPct}%
- Burned: ${input.burnSupplyPct}%
- LP pools: ${input.lpSupplyPct}%

HOLDER QUALITY (retail wallets only)
- Average Holder Score: ${input.avgHolderScore}/100 (${input.qualityLabel})
- Smart Money Wallets: ${input.smartMoneyPct}%

COMMUNITY COMPOSITION
- Conviction Holders (Diamond Hands / HODLers): ${input.convictionPct}%
- Active Traders (Swing / Day): ${input.activeTraderPct}%
- Degen / High-Risk: ${input.degenPct}%
- Bots / Automated: ${input.botPct}%
- Passive conviction holders: ${input.convictionHolderArchetypePct}%
- Dormant / no profile: ${input.dormantPct}%

RETAIL CONCENTRATION (within retail-held supply only)
- Top 10 retail wallets: ${input.top10PctOfRetail}% of retail (~${input.top10PctOfTotal}% of total)
- Top 50 retail wallets: ${input.top50PctOfRetail}% of retail
- Top 100 retail wallets: ${input.top100PctOfRetail}% of retail
- Decentralization Score: ${input.decentralizationScore}/100 (retail-only)
- Gini Coefficient: ${input.giniCoefficient} (retail-only)

SIGNALS
${riskLine}
${positiveLine}

Write the 4-5 sentence analyst summary now.
`.trim();
  }

  private buildFallbackSummary(input: TokenSummaryInput): string {
    return (
      `${input.tokenName} (${input.tokenSymbol}) has an average holder score of ` +
      `${input.avgHolderScore}/100 across ${input.retailHolderCount} analyzed retail wallets, ` +
      `classified as ${input.qualityLabel}. ` +
      `The top 10 retail wallets hold ${input.top10PctOfRetail}% of retail-held supply ` +
      `(approximately ${input.top10PctOfTotal}% of total supply). ` +
      `Exchange custody accounts for ${input.exchangeSupplyPct}% of total supply, ` +
      `a neutral liquidity signal.`
    );
  }

  private async callGeminiWithRetry(
    apiKey: string,
    userPrompt: string,
    analysis: TokenAnalysisEntity,
  ): Promise<string> {
    const modelNames = [
      TokenAiSummaryService.GEMINI_PRIMARY_MODEL,
      ...TokenAiSummaryService.GEMINI_FALLBACK_MODELS,
    ];
    const totalAttempts = TokenAiSummaryService.GEMINI_MAX_RETRIES + 1;
    const expectedSentences = 4;

    for (const modelName of modelNames) {
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
          const result = await this.generateGeminiOnce(
            apiKey,
            modelName,
            userPrompt,
          );

          if (this.isSummaryAcceptable(result, expectedSentences)) {
            this.logger.debug(
              `[TokenAISummary] accepted model=${modelName} attempt=${attempt} len=${result.text.length} contract=${analysis.contractAddress}`,
            );
            return result.text;
          }

          const isLastAttempt = attempt >= totalAttempts;
          this.logger.warn(
            `[TokenAISummary] rejected model=${modelName} attempt=${attempt} finish=${result.finishReason} len=${result.text.length}`,
          );

          if (!isLastAttempt) {
            await this.sleep(TokenAiSummaryService.GEMINI_BASE_RETRY_DELAY_MS * attempt);
          }
        } catch (error: unknown) {
          const isLastAttempt = attempt >= totalAttempts;

          if (this.isTransientGeminiError(error) && !isLastAttempt) {
            const delayMs = TokenAiSummaryService.GEMINI_BASE_RETRY_DELAY_MS * attempt;
            this.logger.warn(
              `[TokenAISummary] transient Gemini error; retry in ${delayMs}ms (${modelName})`,
            );
            await this.sleep(delayMs);
            continue;
          }

          this.logger.warn(
            `[TokenAISummary] Gemini error model=${modelName} attempt=${attempt}: ${this.getErrorMessage(error)}`,
          );
          if (!isLastAttempt) {
            await this.sleep(TokenAiSummaryService.GEMINI_BASE_RETRY_DELAY_MS * attempt);
          }
        }
      }
    }

    return '';
  }

  private async generateGeminiOnce(
    apiKey: string,
    modelName: string,
    userPrompt: string,
  ): Promise<GeminiOnceResult> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${TOKEN_ANALYST_SYSTEM_PROMPT}\n\n${userPrompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: TokenAiSummaryService.GEMINI_MAX_OUTPUT_TOKENS,
      },
    });

    return {
      text: result.response.text().trim(),
      finishReason: String(result.response.candidates?.[0]?.finishReason ?? ''),
    };
  }

  private isSummaryAcceptable(
    result: GeminiOnceResult,
    expectedSentenceCount: number,
  ): boolean {
    const normalized = result.text.trim();

    if (normalized.length === 0) {
      return false;
    }

    if (result.finishReason.toUpperCase().includes('MAX_TOKENS')) {
      return false;
    }

    const sentenceMatches = normalized.match(/[^.!?]+[.!?]/g) ?? [];

    if (sentenceMatches.length >= expectedSentenceCount) {
      return true;
    }

    return (
      normalized.length >=
      expectedSentenceCount * TokenAiSummaryService.MIN_CHARS_PER_SENTENCE
    );
  }

  private isTransientGeminiError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('503 service unavailable') ||
      message.includes('high demand') ||
      message.includes('429 too many requests') ||
      message.includes('exceeded your current quota') ||
      message.includes('rate limit') ||
      message.includes('please try again later')
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  private async setCacheSafe(
    cacheKey: string,
    value: string,
    useFallbackTtl: boolean,
  ): Promise<void> {
    try {
      await this.cacheManager.set(
        cacheKey,
        value,
        useFallbackTtl
          ? TokenAiSummaryService.FALLBACK_CACHE_TTL_SECONDS
          : TokenAiSummaryService.CACHE_TTL_SECONDS,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `[TokenAISummary] cache set failed: ${this.getErrorMessage(error)}`,
      );
    }
  }
}
