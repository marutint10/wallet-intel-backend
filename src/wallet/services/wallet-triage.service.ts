import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonRpcProvider } from 'ethers';
import {
  NormalizedTransaction,
  WalletContractSubtype,
  WalletTriageResponse,
} from '../wallet.types';
import { WalletCoreService } from './wallet-core.service';

interface ContractActivitySnapshot {
  totalTransactions: number;
  transferCount: number;
  swapCount: number;
  incomingTransfers: number;
  outgoingTransfers: number;
  uniqueRecipients: number;
  uniqueSenders: number;
  uniqueCounterparties: number;
  transferShare: number;
  outgoingTransferShare: number;
}

@Injectable()
export class WalletTriageService {
  private readonly logger = new Logger(WalletTriageService.name);
  private readonly rpcProviders: JsonRpcProvider[];

  constructor(
    private readonly configService: ConfigService,
    private readonly walletCoreService: WalletCoreService,
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

  async getWalletTriage(address: string): Promise<WalletTriageResponse | null> {
    const bytecode = await this.fetchBytecode(address);

    if (!this.hasBytecode(bytecode)) {
      return null;
    }

    const storedTransactions = await this.walletCoreService.getStoredTransactions(
      address,
    );
    const activity = this.buildActivitySnapshot(
      address,
      storedTransactions.transactions,
    );
    const { subtype, subtypeReasoning } = this.resolveContractSubtype(
      bytecode,
      activity,
    );

    return {
      walletType: 'Contract',
      walletSubtype: subtype,
      traderEligible: false,
      score: null,
      scoreBand: null,
      reasoning: [
        'On-chain bytecode is present, so this address is treated as a smart contract wallet.',
        `Contract activity snapshot: transfers=${activity.transferCount}, swaps=${activity.swapCount}, uniqueCounterparties=${activity.uniqueCounterparties}.`,
        ...subtypeReasoning,
      ],
    };
  }

  private buildActivitySnapshot(
    address: string,
    transactions: NormalizedTransaction[],
  ): ContractActivitySnapshot {
    const normalizedAddress = address.toLowerCase();
    let transferCount = 0;
    let swapCount = 0;
    let incomingTransfers = 0;
    let outgoingTransfers = 0;
    const uniqueRecipients = new Set<string>();
    const uniqueSenders = new Set<string>();
    const uniqueCounterparties = new Set<string>();

    for (const transaction of transactions) {
      if (transaction.type === 'swap') {
        swapCount += 1;
      }

      if (transaction.type !== 'transfer') {
        continue;
      }

      transferCount += 1;

      const from = transaction.from?.toLowerCase() ?? '';
      const to = transaction.to?.toLowerCase() ?? '';

      if (from === normalizedAddress && to && to !== normalizedAddress) {
        outgoingTransfers += 1;
        uniqueRecipients.add(to);
        uniqueCounterparties.add(to);
        continue;
      }

      if (to === normalizedAddress && from && from !== normalizedAddress) {
        incomingTransfers += 1;
        uniqueSenders.add(from);
        uniqueCounterparties.add(from);
        continue;
      }

      if (from && from !== normalizedAddress) {
        uniqueCounterparties.add(from);
      }

      if (to && to !== normalizedAddress) {
        uniqueCounterparties.add(to);
      }
    }

    const totalTransactions = transactions.length;
    const transferShare =
      totalTransactions > 0 ? transferCount / totalTransactions : 0;
    const outgoingTransferShare =
      transferCount > 0 ? outgoingTransfers / transferCount : 0;

    return {
      totalTransactions,
      transferCount,
      swapCount,
      incomingTransfers,
      outgoingTransfers,
      uniqueRecipients: uniqueRecipients.size,
      uniqueSenders: uniqueSenders.size,
      uniqueCounterparties: uniqueCounterparties.size,
      transferShare,
      outgoingTransferShare,
    };
  }

  private resolveContractSubtype(
    bytecode: string,
    activity: ContractActivitySnapshot,
  ): { subtype: WalletContractSubtype; subtypeReasoning: string[] } {
    if (this.detectSafeProxy(bytecode)) {
      return {
        subtype: 'Treasury / Multisig',
        subtypeReasoning: [
          'Bytecode matches Safe proxy signatures, which strongly indicates multisig treasury management.',
        ],
      };
    }

    if (this.isVestingOrDistribution(activity)) {
      return {
        subtype: 'Vesting / Distribution',
        subtypeReasoning: [
          `High outbound transfer bias (${this.toPercent(activity.outgoingTransferShare)}) with many recipients (${activity.uniqueRecipients}) and minimal swap activity indicates vesting/distribution behavior.`,
        ],
      };
    }

    if (this.isExchangeOrCustody(activity)) {
      return {
        subtype: 'Exchange / Custody',
        subtypeReasoning: [
          `Large bidirectional transfer flow across many counterparties (${activity.uniqueCounterparties}) is consistent with exchange/custody operations.`,
        ],
      };
    }

    if (this.isTreasuryOrMultisig(activity)) {
      return {
        subtype: 'Treasury / Multisig',
        subtypeReasoning: [
          'Transfer-heavy, low-swap behavior with concentrated counterparties aligns with treasury operations.',
        ],
      };
    }

    return {
      subtype: 'Unknown Contract',
      subtypeReasoning: [
        'Contract behavior does not confidently match vesting, treasury/multisig, or exchange/custody heuristics.',
      ],
    };
  }

  private isVestingOrDistribution(activity: ContractActivitySnapshot): boolean {
    return (
      activity.transferCount >= 20 &&
      activity.outgoingTransferShare >= 0.75 &&
      activity.uniqueRecipients >= 15 &&
      activity.swapCount <= 1 &&
      activity.incomingTransfers <=
        Math.max(3, Math.floor(activity.outgoingTransfers * 0.2))
    );
  }

  private isExchangeOrCustody(activity: ContractActivitySnapshot): boolean {
    return (
      activity.transferCount >= 40 &&
      activity.uniqueCounterparties >= 30 &&
      activity.incomingTransfers >= 10 &&
      activity.outgoingTransfers >= 10 &&
      activity.transferShare >= 0.5 &&
      (activity.swapCount >= 5 || activity.totalTransactions >= 80)
    );
  }

  private isTreasuryOrMultisig(activity: ContractActivitySnapshot): boolean {
    const transferHeavy =
      activity.transferCount >= 15 && activity.transferShare >= 0.6;
    const lowSwapActivity = activity.swapCount <= 2;
    const concentratedCounterparties =
      activity.uniqueCounterparties > 0 && activity.uniqueCounterparties <= 25;
    const biDirectionalTreasuryFlow =
      activity.incomingTransfers >= 3 && activity.outgoingTransfers >= 3;

    return (
      transferHeavy &&
      lowSwapActivity &&
      (concentratedCounterparties || biDirectionalTreasuryFlow)
    );
  }

  private async fetchBytecode(address: string): Promise<string> {
    for (const provider of this.rpcProviders) {
      try {
        return await provider.getCode(address);
      } catch {
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
    const normalizedBytecode = bytecode.toLowerCase();

    return (
      normalizedBytecode.includes('a619486e') &&
      normalizedBytecode.includes('5af4')
    );
  }

  private toPercent(value: number): string {
    if (!Number.isFinite(value)) {
      return '0%';
    }

    return `${(value * 100).toFixed(1)}%`;
  }
}
