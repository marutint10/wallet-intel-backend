import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import {
  WalletDeepAnalysis,
  WalletIntelligence,
  WalletScorePath,
  WalletTriageDeepAnalysis,
} from '../wallet.types';
import {
  DEFAULT_SUPPORTED_CHAIN,
  SupportedChain,
} from '../../shared/constants/chains';

type SummaryPromptPath = 'trader_or_holder' | 'triage';
type GeminiSummaryResult = {
  text: string;
  finishReason: string;
};

@Injectable()
export class WalletAiService {
  private static readonly AI_SUMMARY_CACHE_PREFIX = 'ai_summary:';
  private static readonly DEEP_ANALYSIS_CACHE_PREFIX = 'ai_analysis:';
  private static readonly CACHE_TTL_SECONDS = 86_400;
  private static readonly FALLBACK_CACHE_TTL_SECONDS = 1_800;
  private static readonly GEMINI_PRIMARY_SUMMARY_MODEL = 'gemini-2.5-flash';
  private static readonly GEMINI_FALLBACK_SUMMARY_MODELS = [
    'gemini-2.5-flash-lite',
  ];
  private static readonly GEMINI_SUMMARY_MAX_OUTPUT_TOKENS = 1024;
  private static readonly GEMINI_MAX_RETRIES = 2;
  private static readonly GEMINI_BASE_RETRY_DELAY_MS = 600;
  private static readonly SUMMARY_MIN_CHARS_PER_SENTENCE = 35;
  private readonly logger = new Logger(WalletAiService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async generateSummary(
    address: string,
    payload: WalletIntelligence,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<string | null> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey =
      WalletAiService.AI_SUMMARY_CACHE_PREFIX + `${chain}:${normalizedAddress}`;
    const promptPath = this.resolvePromptPath(payload);
    const fallbackSummary = this.buildDeterministicSummary(payload, promptPath);

    try {
      const cached = await this.cacheManager.get<string>(cacheKey);

      if (typeof cached === 'string' && cached.trim().length > 0) {
        this.logger.debug(`[AISummary] Cache hit for ${address}`);
        return cached;
      }

      this.logger.debug(`[AISummary] Cache miss for ${address} - calling Gemini`);

      const apiKey =
        this.configService.get<string>('GEMINI_API_KEY') ??
        this.configService.get<string>('gemini.apiKey') ??
        '';

      if (apiKey.trim().length === 0) {
        this.logger.warn(
          `[AISummary] Gemini API key missing for ${address}; using deterministic fallback summary`,
        );
        await this.setCacheSafe(
          cacheKey,
          fallbackSummary,
          address,
          'AISummary',
          true,
        );
        return fallbackSummary;
      }

      const systemMessage =
        'You are a crypto wallet analyst writing intelligence reports. Be direct and specific. Use the actual numbers provided. Do not use generic phrases. Do not start sentences with "This wallet". Write as if describing the wallet to someone researching it.';
      const userMessage =
        promptPath === 'triage'
          ? this.buildPath2Message(address, payload)
          : this.buildPath1Message(address, payload);
      const expectedSentenceCount = promptPath === 'triage' ? 2 : 3;

      const text = await this.generateGeminiSummaryWithRetry(
        apiKey,
        systemMessage,
        userMessage,
        address,
        expectedSentenceCount,
      );

      if (text.length === 0) {
        this.logger.warn(
          `[AISummary] No acceptable Gemini response for ${address}; using deterministic fallback summary`,
        );
        await this.setCacheSafe(
          cacheKey,
          fallbackSummary,
          address,
          'AISummary',
          true,
        );
        return fallbackSummary;
      }

      await this.setCacheSafe(cacheKey, text, address, 'AISummary');

      return text;
    } catch (error) {
      this.logger.warn(
        `[AISummary] Gemini summary generation failed for ${address}; returning deterministic fallback summary`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.setCacheSafe(
        cacheKey,
        fallbackSummary,
        address,
        'AISummary',
        true,
      );
      return fallbackSummary;
    }
  }

  private async generateGeminiSummaryWithRetry(
    apiKey: string,
    systemMessage: string,
    userMessage: string,
    address: string,
    expectedSentenceCount: number,
  ): Promise<string> {
    const modelNames = [
      WalletAiService.GEMINI_PRIMARY_SUMMARY_MODEL,
      ...WalletAiService.GEMINI_FALLBACK_SUMMARY_MODELS,
    ];
    const totalAttempts = WalletAiService.GEMINI_MAX_RETRIES + 1;

    for (const modelName of modelNames) {
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        try {
          const result = await this.generateGeminiSummaryOnce(
            apiKey,
            modelName,
            systemMessage,
            userMessage,
          );

          if (
            this.isSummarySufficient(
              result.text,
              expectedSentenceCount,
              result.finishReason,
            )
          ) {
            this.logger.debug(
              `[AISummary] Accepted Gemini output for ${address} using ${modelName} (attempt ${attempt}/${totalAttempts}, finishReason=${result.finishReason}, len=${result.text.length})`,
            );
            return result.text;
          }

          const isLastAttempt = attempt >= totalAttempts;
          this.logger.warn(
            `[AISummary] Rejected Gemini output for ${address} using ${modelName} (attempt ${attempt}/${totalAttempts}, finishReason=${result.finishReason}, len=${result.text.length})`,
          );

          if (isLastAttempt) {
            break;
          }

          const delayMs = WalletAiService.GEMINI_BASE_RETRY_DELAY_MS * attempt;
          await this.sleep(delayMs);
        } catch (error) {
          const isLastAttempt = attempt >= totalAttempts;

          if (this.isTransientGeminiError(error) && !isLastAttempt) {
            const delayMs = WalletAiService.GEMINI_BASE_RETRY_DELAY_MS * attempt;
            this.logger.warn(
              `[AISummary] Gemini transient error for ${address} using ${modelName} (attempt ${attempt}/${totalAttempts}). Retrying in ${delayMs}ms.`,
            );
            await this.sleep(delayMs);
            continue;
          }

          this.logger.warn(
            `[AISummary] Gemini model ${modelName} failed for ${address} on attempt ${attempt}/${totalAttempts}: ${this.getErrorMessage(error)}`,
          );
          break;
        }
      }
    }

    return '';
  }

  private async generateGeminiSummaryOnce(
    apiKey: string,
    modelName: string,
    systemMessage: string,
    userMessage: string,
  ): Promise<GeminiSummaryResult> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemMessage}\n\n${userMessage}` }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: WalletAiService.GEMINI_SUMMARY_MAX_OUTPUT_TOKENS,
      },
    });

    return {
      text: result.response.text().trim(),
      finishReason: String(result.response.candidates?.[0]?.finishReason ?? ''),
    };
  }

  private isSummarySufficient(
    text: string,
    expectedSentenceCount: number,
    finishReason: string,
  ): boolean {
    const normalized = text.trim();

    if (normalized.length === 0) {
      return false;
    }

    if (finishReason.toUpperCase().includes('MAX_TOKENS')) {
      return false;
    }

    const sentenceMatches = normalized.match(/[^.!?]+[.!?]/g) ?? [];

    if (sentenceMatches.length >= expectedSentenceCount) {
      return true;
    }

    return (
      normalized.length >=
      expectedSentenceCount * WalletAiService.SUMMARY_MIN_CHARS_PER_SENTENCE
    );
  }

  async generateDeepAnalysis(
    address: string,
    payload: any,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletDeepAnalysis | WalletTriageDeepAnalysis | null> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey =
      WalletAiService.DEEP_ANALYSIS_CACHE_PREFIX + `${chain}:${normalizedAddress}`;
    const isTriage = this.isTriagePayload(payload);
    const fallbackDeepAnalysis = this.buildFallbackDeepAnalysis(payload, isTriage);

    try {
      const cached = await this.cacheManager.get<
        WalletDeepAnalysis | WalletTriageDeepAnalysis
      >(cacheKey);

      if (cached) {
        this.logger.debug(`[DeepAnalysis] Cache hit for ${address}`);
        return cached;
      }

      this.logger.debug(
        `[DeepAnalysis] Cache miss for ${address} — calling Claude`,
      );

      const apiKey =
        this.configService.get<string>('ANTHROPIC_API_KEY') ??
        this.configService.get<string>('anthropic.apiKey') ??
        '';

      if (apiKey.trim().length === 0) {
        this.logger.warn(
          `[DeepAnalysis] Anthropic API key missing for ${address}; using deterministic fallback analysis`,
        );
        await this.setCacheSafe(
          cacheKey,
          fallbackDeepAnalysis,
          address,
          'DeepAnalysis',
          true,
        );
        return fallbackDeepAnalysis;
      }

      const systemMessage = `You are a senior on-chain analyst at a crypto intelligence firm. A client has asked you to evaluate this wallet and tell them what they would miss by just looking at the dashboard. Your job is to find the real story — the patterns, contradictions, hidden risks, and behavioral edges that raw numbers don't immediately reveal.

You must be direct, specific, and analytical. Use actual numbers from the data. Never be generic. If the data is insufficient to draw a conclusion, say so explicitly rather than speculating.

Respond in valid JSON format only. No markdown, no backticks, no explanation outside the JSON.`;
      const userMessage = this.buildDeepAnalysisUserMessage(
        address,
        payload,
        isTriage,
      );

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        temperature: 0.4,
        system: systemMessage,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (text.length === 0) {
        this.logger.warn(
          `[DeepAnalysis] Empty Claude response for ${address}; using deterministic fallback analysis`,
        );
        await this.setCacheSafe(
          cacheKey,
          fallbackDeepAnalysis,
          address,
          'DeepAnalysis',
          true,
        );
        return fallbackDeepAnalysis;
      }

      const parsed = this.parseDeepAnalysisJson<
        WalletDeepAnalysis | WalletTriageDeepAnalysis
      >(text);

      if (!parsed) {
        const snippet = JSON.stringify(text.slice(0, 200));
        this.logger.warn(
          `[DeepAnalysis] Failed to parse Claude response as JSON for ${address}; snippet=${snippet}. Using deterministic fallback analysis`,
        );
        await this.setCacheSafe(
          cacheKey,
          fallbackDeepAnalysis,
          address,
          'DeepAnalysis',
          true,
        );
        return fallbackDeepAnalysis;
      }

      await this.setCacheSafe(cacheKey, parsed, address, 'DeepAnalysis');

      return parsed;
    } catch (error) {
      this.logger.warn(
        `[DeepAnalysis] Claude deep analysis generation failed for ${address}; returning deterministic fallback analysis`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.setCacheSafe(
        cacheKey,
        fallbackDeepAnalysis,
        address,
        'DeepAnalysis',
        true,
      );
      return fallbackDeepAnalysis;
    }
  }

  private buildDeterministicSummary(
    payload: WalletIntelligence,
    promptPath: SummaryPromptPath,
  ): string {
    if (promptPath === 'triage') {
      return this.buildDeterministicTriageSummary(payload);
    }

    return this.buildDeterministicTraderSummary(payload);
  }

  private buildDeterministicTraderSummary(payload: WalletIntelligence): string {
    const primaryType =
      'primaryType' in payload.classification && payload.classification.primaryType
        ? payload.classification.primaryType
        : 'Unclassified wallet';
    const riskProfile =
      'riskProfile' in payload.classification &&
      typeof payload.classification.riskProfile === 'string' &&
      payload.classification.riskProfile.length > 0
        ? payload.classification.riskProfile
        : 'neutral';
    const topHolding = this.getTop3Holdings(payload)[0];
    const topHoldingText = topHolding
      ? `${topHolding.symbol} (${this.formatUsd(this.parseUsdValue(topHolding.usdValue))})`
      : 'no dominant holding';

    const sentence1 =
      `${primaryType} profile centered on low-frequency execution and concentrated positioning.`;
    const sentence2 =
      `Recorded ${payload.summary.total_swaps} swaps, realized PnL ${this.formatUsd(payload.summary.totalRealizedPnL)}, average win rate ${this.formatPercent(payload.summary.avgWinRate)}, and median trade ROI ${this.formatPercent(payload.metrics.medianTradeRoi)}.`;
    const sentence3 =
      `Current posture appears ${riskProfile}, with ${this.formatUsd(payload.metrics.portfolioTotalValueUsd)} in visible holdings led by ${topHoldingText}.`;

    return `${sentence1} ${sentence2} ${sentence3}`;
  }

  private buildDeterministicTriageSummary(payload: WalletIntelligence): string {
    const walletType =
      'walletType' in payload.score && payload.score.walletType
        ? payload.score.walletType
        : 'On-chain entity';
    const walletSubtype =
      'walletSubtype' in payload.score && payload.score.walletSubtype
        ? payload.score.walletSubtype
        : '';
    const totalTransactions = payload.summary.total_transactions;
    const totalTransfers = payload.summary.total_transfers;
    const transferShare =
      totalTransactions > 0
        ? this.formatPercent((totalTransfers / totalTransactions) * 100)
        : '0.0%';
    const topHolding = this.getTop3Holdings(payload)[0];
    const topHoldingText = topHolding
      ? `${topHolding.symbol} (${this.formatUsd(this.parseUsdValue(topHolding.usdValue))})`
      : 'no significant holdings';

    const sentence1 =
      `${walletType}${walletSubtype ? ` (${walletSubtype})` : ''} activity looks operational, with ${totalTransactions} total transactions and ${transferShare} transfers.`;
    const sentence2 =
      `Current holdings are concentrated in ${topHoldingText}, with visible portfolio value near ${this.formatUsd(payload.metrics.portfolioTotalValueUsd)}.`;

    return `${sentence1} ${sentence2}`;
  }

  private buildFallbackDeepAnalysis(
    payload: any,
    isTriage: boolean,
  ): WalletDeepAnalysis | WalletTriageDeepAnalysis {
    if (isTriage) {
      const walletType =
        typeof payload?.score?.walletType === 'string'
          ? payload.score.walletType
          : 'Entity';
      const walletSubtype =
        typeof payload?.score?.walletSubtype === 'string'
          ? payload.score.walletSubtype
          : '';
      const totalTransactions = Number(payload?.summary?.total_transactions ?? 0);
      const totalTransfers = Number(payload?.summary?.total_transfers ?? 0);
      const transferShare =
        totalTransactions > 0
          ? this.formatPercent((totalTransfers / totalTransactions) * 100)
          : '0.0%';
      const portfolioValue = Number(payload?.metrics?.portfolioTotalValueUsd ?? 0);
      const topHoldings = this.getTop10Holdings(payload)
        .slice(0, 3)
        .map((holding) => holding.token)
        .filter((token): token is string => typeof token === 'string');
      const topHoldingText =
        topHoldings.length > 0 ? topHoldings.join(', ') : 'no material holdings';

      return {
        entityDiagnosis: `${walletType}${walletSubtype ? ` (${walletSubtype})` : ''} behavior is dominated by operational transfers rather than active trading, with ${totalTransactions} total transactions recorded.`,
        holdingAssessment: `Current holdings are small and concentrated (${topHoldingText}) with approximately ${this.formatUsd(portfolioValue)} visible value, so balance-sheet risk is mostly concentration and liquidity quality.`,
        notablePattern: `Transfers represent ${transferShare} of observed activity, which is more consistent with routing or treasury movement than discretionary trading.`,
        oneSentenceTruth: `${walletType} profile with ${this.formatUsd(portfolioValue)} currently visible and limited evidence of active alpha-seeking behavior.`,
      };
    }

    const totalSwaps = Number(payload?.summary?.total_swaps ?? 0);
    const realizedPnL = Number(
      payload?.summary?.totalRealizedPnL ?? payload?.metrics?.realizedPnL ?? 0,
    );
    const avgWinRate = Number(payload?.summary?.avgWinRate ?? 0);
    const medianRoi = Number(payload?.metrics?.medianTradeRoi ?? 0);
    const portfolioValue = Number(payload?.metrics?.portfolioTotalValueUsd ?? 0);
    const concentrationRisk = Number(payload?.features?.risk?.concentrationRisk ?? 0);
    const primaryType =
      typeof payload?.classification?.primaryType === 'string'
        ? payload.classification.primaryType
        : 'Unclassified wallet';
    const verdict = this.deriveSkillVerdict(totalSwaps, realizedPnL, avgWinRate);

    const hiddenRisks: string[] = [];

    if (totalSwaps < 10) {
      hiddenRisks.push(
        `Small sample size (${totalSwaps} swaps) raises variance risk for any skill conclusion.`,
      );
    }

    if (concentrationRisk > 0) {
      hiddenRisks.push(
        `Concentration risk is ${concentrationRisk.toFixed(2)}, indicating dependence on a narrow set of holdings.`,
      );
    }

    if (portfolioValue < 1_000) {
      hiddenRisks.push(
        `Visible deployable capital is ${this.formatUsd(portfolioValue)}, so observed execution may not scale linearly.`,
      );
    }

    if (hiddenRisks.length === 0) {
      hiddenRisks.push(
        `Median trade ROI of ${this.formatPercent(medianRoi)} can still be noisy without a larger independent sample.`,
      );
    }

    const recommendation: WalletDeepAnalysis['copyTradeVerdict']['recommendation'] =
      totalSwaps >= 30 && realizedPnL > 0 && avgWinRate >= 55 ? 'watch' : 'avoid';

    return {
      strategyDiagnosis: `${primaryType} behavior appears selective and low-frequency, with ${totalSwaps} swaps and realized PnL of ${this.formatUsd(realizedPnL)}. Position sizing remains small relative to outcomes, so conviction appears tactical rather than systematic.`,
      skillVsLuck: {
        verdict,
        confidence: totalSwaps >= 30 ? 'medium' : 'low',
        reasoning: `Observed win rate is ${this.formatPercent(avgWinRate)} with median trade ROI ${this.formatPercent(medianRoi)} across ${totalSwaps} swaps; this supports directional edge signals but not high-confidence repeatability.`,
      },
      hiddenRisks: hiddenRisks.slice(0, 3),
      copyTradeVerdict: {
        recommendation,
        reasoning: `Track for consistency first: sample depth (${totalSwaps} swaps) and current deployable capital (${this.formatUsd(portfolioValue)}) are not yet strong enough for direct copy-trading.`,
      },
      behavioralEdge:
        totalSwaps >= 20
          ? 'Selective timing and drawdown control suggest some discipline, but edge persistence is still unproven.'
          : 'No clear behavioral edge detected from currently available structured metrics.',
      oneSentenceTruth: `${primaryType} profile with ${totalSwaps} swaps and ${this.formatUsd(portfolioValue)} visible capital should be treated as a watchlist signal, not a high-conviction copy target.`,
    };
  }

  private deriveSkillVerdict(
    totalSwaps: number,
    realizedPnL: number,
    avgWinRate: number,
  ): WalletDeepAnalysis['skillVsLuck']['verdict'] {
    if (totalSwaps < 5) {
      return realizedPnL > 0 ? 'mixed' : 'lucky';
    }

    if (realizedPnL > 0 && avgWinRate >= 60) {
      return 'skilled';
    }

    if (realizedPnL > 0) {
      return 'mixed';
    }

    return 'unskilled';
  }

  private formatUsd(value: number): string {
    const normalized = Number.isFinite(value) ? value : 0;

    return `$${normalized.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private formatPercent(value: number): string {
    const normalized = Number.isFinite(value) ? value : 0;

    return `${normalized.toFixed(1)}%`;
  }

  private resolvePromptPath(payload: WalletIntelligence): SummaryPromptPath {
    const triageScorePaths = new Set<WalletScorePath>([
      'triage_contract',
      'triage_operational',
    ]);
    const scorePath = payload.score.scorePath;
    const traderEligible =
      'traderEligible' in payload.score ? payload.score.traderEligible : undefined;

    if (traderEligible === false || triageScorePaths.has(scorePath)) {
      return 'triage';
    }

    return 'trader_or_holder';
  }

  private buildPath1Message(address: string, payload: WalletIntelligence): string {
    const messagePayload = {
      address,
      classificationType:
        'primaryType' in payload.classification
          ? payload.classification.primaryType
          : null,
      scoreBand: 'band' in payload.score ? payload.score.band : payload.score.scoreBand,
      scoreValue: payload.score.score,
      totalRealizedPnL: payload.summary.totalRealizedPnL,
      avgWinRate: payload.summary.avgWinRate,
      bestTrade: payload.summary.bestTrade,
      worstTrade: payload.summary.worstTrade,
      totalSwaps: payload.summary.total_swaps,
      medianTradeRoi: payload.metrics.medianTradeRoi,
      profitFactor: payload.features.risk.profitFactor,
      maxDrawdown: payload.features.risk.maxDrawdown,
      riskProfile:
        'riskProfile' in payload.classification
          ? payload.classification.riskProfile
          : null,
      secondaryTypes:
        'secondaryTypes' in payload.classification
          ? payload.classification.secondaryTypes
          : [],
      traits:
        'traits' in payload.classification ? payload.classification.traits : [],
      top3Holdings: this.getTop3Holdings(payload),
    };

    return `${JSON.stringify(messagePayload, null, 2)}\n\nWrite exactly 3 sentences. Sentence 1: what type of trader this is and their primary behavior. Sentence 2: their performance using specific numbers. Sentence 3: their current risk posture or most notable portfolio characteristic. Return only the 3 sentences, nothing else.`;
  }

  private buildPath2Message(address: string, payload: WalletIntelligence): string {
    const totalTransactions = payload.summary.total_transactions;
    const transferShare =
      totalTransactions > 0
        ? `${((payload.summary.total_transfers / totalTransactions) * 100).toFixed(1)}%`
        : '0.0%';
    const messagePayload = {
      address,
      walletType: 'walletType' in payload.score ? payload.score.walletType : null,
      walletSubtype:
        'walletSubtype' in payload.score ? payload.score.walletSubtype : null,
      portfolioValue: payload.metrics.portfolioTotalValueUsd,
      totalTransactions: payload.summary.total_transactions,
      transferShare,
      top3Holdings: this.getTop3Holdings(payload),
    };

    return `${JSON.stringify(messagePayload, null, 2)}\n\nWrite exactly 2 sentences. Sentence 1: what type of entity this is and what it does on-chain. Sentence 2: what it currently holds. Return only the 2 sentences, nothing else.`;
  }

  private buildDeepAnalysisUserMessage(
    address: string,
    payload: any,
    isTriage: boolean,
  ): string {
    const messagePayload: Record<string, unknown> = { address };

    this.assignIfDefined(
      messagePayload,
      'classificationType',
      payload?.classification?.primaryType,
    );
    this.assignIfDefined(
      messagePayload,
      'classificationDescription',
      payload?.classification?.description,
    );
    this.assignIfDefined(messagePayload, 'scoreBand', payload?.score?.band);
    this.assignIfDefined(messagePayload, 'scoreValue', payload?.score?.score);
    this.assignIfDefined(messagePayload, 'scorePath', payload?.score?.scorePath);
    this.assignIfDefined(
      messagePayload,
      'scoreBreakdown',
      payload?.score?.breakdown,
    );
    this.assignIfDefined(
      messagePayload,
      'totalRealizedPnL',
      payload?.summary?.totalRealizedPnL,
    );
    this.assignIfDefined(messagePayload, 'avgWinRate', payload?.summary?.avgWinRate);
    this.assignIfDefined(messagePayload, 'bestTrade', payload?.summary?.bestTrade);
    this.assignIfDefined(
      messagePayload,
      'worstTrade',
      payload?.summary?.worstTrade,
    );
    this.assignIfDefined(
      messagePayload,
      'totalSwaps',
      payload?.summary?.total_swaps,
    );
    this.assignIfDefined(
      messagePayload,
      'totalTransactions',
      payload?.summary?.total_transactions,
    );
    this.assignIfDefined(
      messagePayload,
      'totalTransfers',
      payload?.summary?.total_transfers,
    );
    this.assignIfDefined(
      messagePayload,
      'tokensInteracted',
      payload?.summary?.tokens_interacted,
    );
    this.assignIfDefined(
      messagePayload,
      'profitableTokens',
      payload?.summary?.profitableTokens,
    );
    this.assignIfDefined(
      messagePayload,
      'losingTokens',
      payload?.summary?.losingTokens,
    );
    this.assignIfDefined(
      messagePayload,
      'averageTradeRoi',
      payload?.metrics?.averageTradeRoi,
    );
    this.assignIfDefined(
      messagePayload,
      'medianTradeRoi',
      payload?.metrics?.medianTradeRoi,
    );
    this.assignIfDefined(
      messagePayload,
      'realizedRoi',
      payload?.metrics?.realizedRoi,
    );
    this.assignIfDefined(
      messagePayload,
      'unrealizedRoi',
      payload?.metrics?.unrealizedRoi,
    );
    this.assignIfDefined(
      messagePayload,
      'realizedPnL',
      payload?.metrics?.realizedPnL,
    );
    this.assignIfDefined(
      messagePayload,
      'unrealizedPnL',
      payload?.metrics?.unrealizedPnL,
    );
    this.assignIfDefined(messagePayload, 'netPnL', payload?.metrics?.netPnL);
    this.assignIfDefined(
      messagePayload,
      'profitFactor',
      payload?.features?.risk?.profitFactor,
    );
    this.assignIfDefined(
      messagePayload,
      'maxDrawdown',
      payload?.features?.risk?.maxDrawdown,
    );
    this.assignIfDefined(
      messagePayload,
      'returnStdDev',
      payload?.features?.risk?.returnStdDev,
    );
    this.assignIfDefined(
      messagePayload,
      'concentrationRisk',
      payload?.features?.risk?.concentrationRisk,
    );
    this.assignIfDefined(
      messagePayload,
      'avgHoldHours',
      payload?.features?.holdTime?.avgHoldHours,
    );
    this.assignIfDefined(
      messagePayload,
      'medianHoldHours',
      payload?.features?.holdTime?.medianHoldHours,
    );
    this.assignIfDefined(
      messagePayload,
      'holdBuckets',
      payload?.features?.holdTime?.holdBuckets,
    );
    this.assignIfDefined(
      messagePayload,
      'tradesPerActiveDay',
      payload?.features?.activity?.tradesPerActiveDay,
    );
    this.assignIfDefined(
      messagePayload,
      'burstinessScore',
      payload?.features?.activity?.burstinessScore,
    );
    this.assignIfDefined(
      messagePayload,
      'tradingSpanRatio',
      payload?.features?.activity?.tradingSpanRatio,
    );
    this.assignIfDefined(
      messagePayload,
      'riskProfile',
      payload?.classification?.riskProfile,
    );
    this.assignIfDefined(
      messagePayload,
      'secondaryTypes',
      payload?.classification?.secondaryTypes,
    );
    this.assignIfDefined(messagePayload, 'traits', payload?.classification?.traits);
    this.assignIfDefined(
      messagePayload,
      'allClassificationScores',
      payload?.classification?.allScores,
    );
    this.assignIfDefined(
      messagePayload,
      'lifetimeTradeVolumeUsd',
      payload?.metrics?.lifetimeTradeVolumeUsd,
    );
    this.assignIfDefined(
      messagePayload,
      'portfolioTotalValueUsd',
      payload?.metrics?.portfolioTotalValueUsd,
    );

    const top10Holdings = this.getTop10Holdings(payload);

    if (Array.isArray(payload?.visiblePortfolio)) {
      messagePayload.top10Holdings = top10Holdings;
    }

    const instruction = isTriage
      ? `Analyze this entity and return a JSON object with exactly this structure:
{
  "entityDiagnosis": "2-3 sentences explaining what this entity actually is and its likely purpose on-chain",
  "holdingAssessment": "1-2 sentences assessing the quality and risk of what it currently holds",
  "notablePattern": "1 sentence describing anything unusual about its transfer patterns or behavior",
  "oneSentenceTruth": "The single most important thing to know about this entity"
}
Return only the JSON, nothing else.`
      : `Analyze this wallet and return a JSON object with exactly this structure:
{
  "strategyDiagnosis": "2-3 sentences explaining what this wallet is actually doing at a strategic level beyond the classification label. Describe the real behavioral pattern you see.",
  "skillVsLuck": {
    "verdict": "skilled" or "lucky" or "mixed" or "unskilled",
    "confidence": "high" or "medium" or "low",
    "reasoning": "2-3 sentences explaining why, citing specific metric contradictions or confirmations"
  },
  "hiddenRisks": ["each string is one specific risk backed by a number from the data, maximum 3 items"],
  "copyTradeVerdict": {
    "recommendation": "follow" or "watch" or "avoid",
    "reasoning": "2-3 sentences explaining why someone should or should not copy this wallet's trades"
  },
  "behavioralEdge": "1-2 sentences describing any detectable edge or advantage, or 'No clear behavioral edge detected' if none exists",
  "oneSentenceTruth": "The single most important thing to know about this wallet"
}
Return only the JSON, nothing else.`;

    return `${JSON.stringify(messagePayload, null, 2)}\n\n${instruction}`;
  }

  private getTop3Holdings(payload: WalletIntelligence): Array<{
    symbol: string;
    usdValue: string | null;
  }> {
    return [...payload.visiblePortfolio]
      .sort(
        (left, right) =>
          this.parseUsdValue(right.usdValue) - this.parseUsdValue(left.usdValue),
      )
      .slice(0, 3)
      .map((item) => ({
        symbol: item.token,
        usdValue: item.usdValue,
      }));
  }

  private getTop10Holdings(payload: any): Array<{
    token: string;
    usdValue: string | null;
    pnl: string | null;
    roi: string | null;
    holdingDays: number | null;
    priceSources?: string[];
  }> {
    if (!Array.isArray(payload?.visiblePortfolio)) {
      return [];
    }

    return [...payload.visiblePortfolio]
      .sort(
        (left: any, right: any) =>
          this.parseUsdValue(right?.usdValue) - this.parseUsdValue(left?.usdValue),
      )
      .slice(0, 10)
      .map((item: any) => ({
        token: item?.token,
        usdValue: item?.usdValue ?? null,
        pnl: item?.pnl ?? null,
        roi: item?.roi ?? null,
        holdingDays: item?.holdingDays ?? null,
        priceSources: Array.isArray(item?.priceSources)
          ? item.priceSources
          : undefined,
      }));
  }

  private isTriagePayload(payload: any): boolean {
    const scorePath =
      typeof payload?.score?.scorePath === 'string' ? payload.score.scorePath : '';

    return payload?.score?.traderEligible === false || scorePath.includes('triage');
  }

  private assignIfDefined(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void {
    if (value !== undefined) {
      target[key] = value;
    }
  }

  private parseUsdValue(value: unknown): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
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

  private parseDeepAnalysisJson<T>(responseText: string): T | null {
    const normalized = responseText.trim();

    const candidates = [
      normalized,
      this.stripMarkdownCodeFence(normalized),
      this.extractFirstJsonObject(normalized),
    ].filter((candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
    );

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Keep trying fallback parse candidates.
      }
    }

    return null;
  }

  private stripMarkdownCodeFence(value: string): string {
    return value
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  private extractFirstJsonObject(value: string): string | null {
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          startIndex = index;
        }

        depth += 1;
        continue;
      }

      if (char === '}') {
        if (depth === 0) {
          continue;
        }

        depth -= 1;

        if (depth === 0 && startIndex >= 0) {
          return value.slice(startIndex, index + 1);
        }
      }
    }

    return null;
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
    value: unknown,
    address: string,
    namespace: 'AISummary' | 'DeepAnalysis',
    useFallbackTtl = false,
  ): Promise<void> {
    try {
      await this.cacheManager.set(
        cacheKey,
        value,
        useFallbackTtl
          ? WalletAiService.FALLBACK_CACHE_TTL_SECONDS
          : WalletAiService.CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `[${namespace}] Failed to cache response for ${address}: ${this.getErrorMessage(error)}`,
      );
    }
  }
}