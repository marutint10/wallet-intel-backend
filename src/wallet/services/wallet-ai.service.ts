import Anthropic from '@anthropic-ai/sdk';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { WalletIntelligence, WalletScorePath } from '../wallet.types';

type SummaryPromptPath = 'trader_or_holder' | 'triage';

@Injectable()
export class WalletAiService {
  private static readonly CACHE_PREFIX = 'ai_summary:';
  private static readonly CACHE_TTL_SECONDS = 86_400;
  private readonly logger = new Logger(WalletAiService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async generateSummary(
    address: string,
    payload: WalletIntelligence,
  ): Promise<string | null> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = WalletAiService.CACHE_PREFIX + normalizedAddress;

    try {
      const cached = await this.cacheManager.get<string>(cacheKey);

      if (typeof cached === 'string' && cached.trim().length > 0) {
        this.logger.debug(`[AISummary] Cache hit for ${address}`);
        return cached;
      }

      this.logger.debug(`[AISummary] Cache miss for ${address} - calling Claude`);

      const apiKey =
        this.configService.get<string>('ANTHROPIC_API_KEY') ??
        this.configService.get<string>('anthropic.apiKey') ??
        '';

      if (!apiKey) {
        this.logger.warn('[AISummary] ANTHROPIC_API_KEY is not configured');
        return null;
      }

      const systemMessage =
        'You are a crypto wallet analyst writing intelligence reports. Be direct and specific. Use the actual numbers provided. Do not use generic phrases. Do not start sentences with "This wallet". Write as if describing the wallet to someone researching it.';
      const promptPath = this.resolvePromptPath(payload);
      const userMessage =
        promptPath === 'triage'
          ? this.buildPath2Message(address, payload)
          : this.buildPath1Message(address, payload);

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        temperature: 0.3,
        system: systemMessage,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      if (text.length === 0) {
        this.logger.warn(`[AISummary] Empty Claude response for ${address}`);
        return null;
      }

      await this.cacheManager.set(
        cacheKey,
        text,
        WalletAiService.CACHE_TTL_SECONDS,
      );

      return text;
    } catch (error) {
      this.logger.warn(
        `[AISummary] Claude summary generation failed for ${address}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
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

  private parseUsdValue(value: string | null): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }
}