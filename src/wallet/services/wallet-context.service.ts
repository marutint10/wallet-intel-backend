import { Injectable } from '@nestjs/common';
import {
  WalletActivityMetricsResponse,
  WalletContextResponse,
  WalletSubtype,
  WalletSummaryResponse,
  WalletTriageResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletTriageService } from './wallet-triage.service';
import {
  DEFAULT_SUPPORTED_CHAIN,
  SupportedChain,
} from '../../shared/constants/chains';

@Injectable()
export class WalletContextService {
  constructor(
    private readonly walletPnlService: WalletPnlService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
    private readonly walletTriageService: WalletTriageService,
  ) {}

  async getWalletContext(
    address: string,
    input: {
      summary?: WalletSummaryResponse;
      activity?: WalletActivityMetricsResponse;
      triage?: WalletTriageResponse | null;
    } = {},
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletContextResponse> {
    const summary = input.summary
      ? input.summary
      : await this.walletPnlService.getWalletSummary(address, chain);
    const triage =
      input.triage !== undefined
        ? input.triage
        : await this.walletTriageService.getWalletTriage(address, {
            summary,
          }, chain);

    if (triage) {
      return {
        walletType: triage.walletType,
        walletSubtype: triage.walletSubtype,
        isTraderWallet: false,
        classificationConfidence: this.roundDecimal(
          triage.confidenceScore / 100,
          2,
        ),
        reasoning: [
          ...triage.reasoning,
          `Trader qualification is false because triage path '${triage.scorePath}' is non-trader.`,
        ],
      };
    }

    const activity = input.activity
      ? input.activity
      : await this.walletAnalyticsService.getActivityMetrics(address, chain);
    const walletSubtype = this.resolveEoaSubtype({
      tradesPerActiveDay: activity.tradesPerActiveDay,
      avgTradeGapHours: activity.avgTradeGapHours,
    });
    const isTraderWallet = summary.total_swaps >= 3;
    const isBotLike = walletSubtype === 'Automated/Bot-like';
    const reasoning = [
      'No triage override was triggered, so wallet is treated as EOA for context classification.',
      `Trader qualification is ${isTraderWallet ? 'true' : 'false'} because total swaps = ${summary.total_swaps}.`,
    ];

    if (isBotLike) {
      reasoning.push(
        `Automated/Bot-like heuristic matched: tradesPerActiveDay=${activity.tradesPerActiveDay}, avgTradeGapHours=${activity.avgTradeGapHours}.`,
      );
    }

    if (!isBotLike) {
      reasoning.push('No specialized bot-like subtype heuristic was triggered.');
    }

    return {
      walletType: 'EOA',
      walletSubtype,
      isTraderWallet,
      classificationConfidence: this.computeClassificationConfidence({
        isBotLike,
        isTraderWallet,
      }),
      reasoning,
    };
  }

  private resolveEoaSubtype(input: {
    tradesPerActiveDay: number;
    avgTradeGapHours: number;
  }): WalletSubtype {
    if (input.tradesPerActiveDay > 20 && input.avgTradeGapHours < 1) {
      return 'Automated/Bot-like';
    }

    return null;
  }

  private computeClassificationConfidence(input: {
    isBotLike: boolean;
    isTraderWallet: boolean;
  }): number {
    let confidence = 0.65;

    if (input.isBotLike) {
      confidence += 0.15;
    }

    if (input.isTraderWallet) {
      confidence += 0.05;
    }

    return this.roundDecimal(Math.min(confidence, 1), 2);
  }

  private roundDecimal(value: number, decimals = 12): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }
}