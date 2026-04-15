import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonRpcProvider } from 'ethers';
import {
  WalletContextResponse,
  WalletSubtype,
  WalletType,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletPnlService } from './wallet-pnl.service';

@Injectable()
export class WalletContextService {
  private readonly logger = new Logger(WalletContextService.name);
  private readonly rpcProviders: JsonRpcProvider[];

  constructor(
    private readonly configService: ConfigService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
  ) {
    const configuredRpcUrl =
      this.configService.get<string>('rpc.url') ??
      'https://ethereum-rpc.publicnode.com';
    const fallbackRpcUrls = [
      configuredRpcUrl,
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com',
    ];
    const uniqueRpcUrls = Array.from(
      new Set(fallbackRpcUrls.filter((url) => Boolean(url?.trim()))),
    );

    this.rpcProviders = uniqueRpcUrls.map(
      (url) => new JsonRpcProvider(url, undefined, { staticNetwork: true }),
    );
  }

  async getWalletContext(address: string): Promise<WalletContextResponse> {
    const [bytecode, summary, activity] = await Promise.all([
      this.fetchBytecode(address),
      this.walletPnlService.getWalletSummary(address),
      this.walletAnalyticsService.getActivityMetrics(address),
    ]);
    const reasoning: string[] = [];
    const walletType: WalletType = this.hasBytecode(bytecode) ? 'Contract' : 'EOA';
    const isSafeMultisig = this.detectSafeProxy(bytecode);
    const walletSubtype = this.resolveWalletSubtype({
      isSafeMultisig,
      totalTransactions: summary.total_transactions,
      totalTransfers: summary.total_transfers,
      totalSwaps: summary.total_swaps,
      tradesPerActiveDay: activity.tradesPerActiveDay,
      avgTradeGapHours: activity.avgTradeGapHours,
    });
    const isTraderWallet = summary.total_swaps >= 3;
    const transferRatio =
      summary.total_transactions > 0
        ? (summary.total_transfers / summary.total_transactions) * 100
        : 0;
    const isOperationalTreasury = walletSubtype === 'Operational/Treasury';
    const isBotLike = walletSubtype === 'Automated/Bot-like';

    reasoning.push(`Wallet type detected as ${walletType} from on-chain bytecode check.`);

    if (isSafeMultisig) {
      reasoning.push(
        'Bytecode contains the Safe proxy masterCopy() selector pattern, so the wallet is classified as Gnosis Safe.',
      );
    }

    reasoning.push(
      `Trader qualification is ${isTraderWallet ? 'true' : 'false'} because total swaps = ${summary.total_swaps}.`,
    );

    if (isOperationalTreasury) {
      reasoning.push(
        `Operational/Treasury heuristic matched: txCount=${summary.total_transactions}, transferRatio=${this.roundDecimal(transferRatio, 2)}%, swaps=${summary.total_swaps}.`,
      );
    }

    if (isBotLike) {
      reasoning.push(
        `Automated/Bot-like heuristic matched: tradesPerActiveDay=${activity.tradesPerActiveDay}, avgTradeGapHours=${activity.avgTradeGapHours}.`,
      );
    }

    if (!isSafeMultisig && !isOperationalTreasury && !isBotLike) {
      reasoning.push('No specialized Safe, treasury, or bot-like subtype heuristic was triggered.');
    }

    return {
      walletType,
      walletSubtype,
      isTraderWallet,
      classificationConfidence: this.computeClassificationConfidence({
        walletType,
        isSafeMultisig,
        isOperationalTreasury,
        isBotLike,
        isTraderWallet,
      }),
      reasoning,
    };
  }

  private async fetchBytecode(address: string): Promise<string> {
    for (const provider of this.rpcProviders) {
      try {
        const bytecode = await provider.getCode(address);

        this.logger.debug(
          `Raw bytecode for ${address} via ${provider._getConnection().url}: ${bytecode}`,
        );

        return bytecode;
      } catch (error) {
        this.logger.warn(
          `provider.getCode failed for ${address} via ${provider._getConnection().url}`,
        );
      }
    }

    return '0x';
  }

  private hasBytecode(bytecode: string): boolean {
    return typeof bytecode === 'string' && bytecode.length > 0 && bytecode !== '0x';
  }

  private detectSafeProxy(bytecode: string): boolean {
    if (!this.hasBytecode(bytecode)) {
      return false;
    }

    const normalizedBytecode = bytecode.toLowerCase();

    return (
      normalizedBytecode.includes('a619486e') &&
      normalizedBytecode.includes('5af4')
    );
  }

  private resolveWalletSubtype(input: {
    isSafeMultisig: boolean;
    totalTransactions: number;
    totalTransfers: number;
    totalSwaps: number;
    tradesPerActiveDay: number;
    avgTradeGapHours: number;
  }): WalletSubtype {
    if (input.isSafeMultisig) {
      return 'Gnosis Safe';
    }

    const transferRatio =
      input.totalTransactions > 0
        ? (input.totalTransfers / input.totalTransactions) * 100
        : 0;

    if (input.tradesPerActiveDay > 20 && input.avgTradeGapHours < 1) {
      return 'Automated/Bot-like';
    }

    if (
      input.totalTransactions > 50 &&
      transferRatio > 80 &&
      input.totalSwaps <= 2
    ) {
      return 'Operational/Treasury';
    }

    return null;
  }

  private computeClassificationConfidence(input: {
    walletType: WalletType;
    isSafeMultisig: boolean;
    isOperationalTreasury: boolean;
    isBotLike: boolean;
    isTraderWallet: boolean;
  }): number {
    let confidence = input.walletType === 'Contract' ? 0.7 : 0.65;

    if (input.isSafeMultisig) {
      confidence += 0.25;
    }

    if (input.isOperationalTreasury || input.isBotLike) {
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