import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Moralis from 'moralis';
import { FetchTransactionsOptions, ProviderFetchResult } from '../interfaces/transaction.interface';
import { withBackoff as withExponentialBackoff } from '../utils/backoff.util';
import { normalizeTransaction } from '../utils/normalizer.util';

type MoralisJsonResponse = {
  result: Record<string, unknown>[];
  cursor?: string | null;
};

@Injectable()
export class MoralisService implements OnModuleInit {
  private readonly logger = new Logger(MoralisService.name);
  private started = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureStarted();
    } catch (error) {
      const typedError = error as { message?: string; details?: { status?: number }; status?: number };
      console.error('Moralis initialization failed:', typedError.message ?? error);
      console.error('Moralis initialization status code:', typedError.details?.status ?? typedError.status ?? 'unknown');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
    }
  }

  private async ensureStarted(): Promise<boolean> {
    const apiKey = this.configService.get<string>('MORALIS_API_KEY');

    if (!apiKey) {
      console.error('Moralis initialization skipped: MORALIS_API_KEY is missing');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
      return false;
    }

    if (!this.started) {
      await Moralis.start({ apiKey });
      console.log('Moralis initialized successfully');
      this.started = true;
    }

    return true;
  }

  private async fetchAllNativeTransactions(walletAddress: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];

    try {
      let cursor: string | undefined;
      do {
        const response = await withExponentialBackoff(() =>
          Moralis.EvmApi.transaction.getWalletTransactions({
            address: walletAddress,
            chain: '0x1',
            cursor,
            limit: 100,
          }),
        );
        const json = response.toJSON() as MoralisJsonResponse;
        all.push(...json.result);
        cursor = json.cursor ?? undefined;
      } while (cursor);
    } catch (error) {
      const typedError = error as { message?: string; details?: { status?: number }; status?: number };
      console.error('Moralis native transaction fetch failed:', typedError.message ?? error);
      console.error('Moralis native transaction status code:', typedError.details?.status ?? typedError.status ?? 'unknown');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
      throw error;
    }

    return all;
  }

  private async fetchAllTokenTransfers(walletAddress: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];

    try {
      let cursor: string | undefined;
      do {
        const response = await withExponentialBackoff(() =>
          Moralis.EvmApi.token.getWalletTokenTransfers({
            address: walletAddress,
            chain: '0x1',
            cursor,
            limit: 100,
          }),
        );
        const json = response.toJSON() as MoralisJsonResponse;
        all.push(...json.result);
        cursor = json.cursor ?? undefined;
      } while (cursor);
    } catch (error) {
      const typedError = error as { message?: string; details?: { status?: number }; status?: number };
      console.error('Moralis token transfer fetch failed:', typedError.message ?? error);
      console.error('Moralis token transfer status code:', typedError.details?.status ?? typedError.status ?? 'unknown');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
      throw error;
    }

    return all;
  }

  private async getAllTransactions(walletAddress: string): Promise<Record<string, unknown>[]> {
    const [nativeTxns, tokenTransfers] = await Promise.all([
      this.fetchAllNativeTransactions(walletAddress),
      this.fetchAllTokenTransfers(walletAddress),
    ]);

    this.logger.log(`Native txns total: ${nativeTxns.length}`);
    this.logger.log(`Token transfers total: ${tokenTransfers.length}`);

    const transfersByHash = new Map<string, Record<string, unknown>[]>();

    for (const transfer of tokenTransfers) {
      const transactionHash =
        typeof transfer.transactionHash === 'string'
          ? transfer.transactionHash
          : typeof transfer.hash === 'string'
            ? transfer.hash
            : undefined;

      if (!transactionHash) {
        continue;
      }

      const existingTransfers = transfersByHash.get(transactionHash) ?? [];
      existingTransfers.push(transfer);
      transfersByHash.set(transactionHash, existingTransfers);
    }

    return nativeTxns.map((transaction) => {
      const transactionHash = typeof transaction.hash === 'string' ? transaction.hash : undefined;
      const attachedTransfers = transactionHash ? transfersByHash.get(transactionHash) ?? [] : [];

      return {
        ...transaction,
        tokenTransfers: attachedTransfers,
      };
    });
  }

  async fetchTransactions(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    if (options.network !== 'evm') {
      return { provider: 'moralis', transactions: [] };
    }

    const enabled = await this.ensureStarted();
    if (!enabled) {
      return { provider: 'moralis', transactions: [] };
    }

    const transactions = await this.getAllTransactions(options.address);

    return {
      provider: 'moralis',
      transactions: transactions.map((transaction) =>
        normalizeTransaction('moralis', 'evm', transaction as Record<string, unknown>),
      ),
    };
  }
}
