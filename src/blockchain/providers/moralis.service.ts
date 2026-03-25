import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Moralis from 'moralis';
import { EvmChain } from '@moralisweb3/common-evm-utils';
import { FetchTransactionsOptions, ProviderFetchResult } from '../interfaces/transaction.interface';
import { withBackoff } from '../utils/backoff.util';
import { normalizeTransaction } from '../utils/normalizer.util';

@Injectable()
export class MoralisService implements OnModuleInit {
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

  private async fetchAllNativeTransactions(options: FetchTransactionsOptions) {
    try {
      return await withBackoff(() =>
        Moralis.EvmApi.transaction.getWalletTransactions({
          address: options.address,
          chain: EvmChain.ETHEREUM,
          limit: options.limit,
        }),
      );
    } catch (error) {
      const typedError = error as { message?: string; details?: { status?: number }; status?: number };
      console.error('Moralis native transaction fetch failed:', typedError.message ?? error);
      console.error('Moralis native transaction status code:', typedError.details?.status ?? typedError.status ?? 'unknown');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
      throw error;
    }
  }

  private async fetchAllTokenTransfers(options: FetchTransactionsOptions) {
    try {
      return await withBackoff(() =>
        Moralis.EvmApi.token.getWalletTokenTransfers({
          address: options.address,
          chain: EvmChain.ETHEREUM,
          limit: options.limit,
        }),
      );
    } catch (error) {
      const typedError = error as { message?: string; details?: { status?: number }; status?: number };
      console.error('Moralis token transfer fetch failed:', typedError.message ?? error);
      console.error('Moralis token transfer status code:', typedError.details?.status ?? typedError.status ?? 'unknown');
      console.log('Moralis API Key present:', !!process.env.MORALIS_API_KEY);
      throw error;
    }
  }

  async fetchTransactions(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    if (options.network !== 'evm') {
      return { provider: 'moralis', transactions: [] };
    }

    const enabled = await this.ensureStarted();
    if (!enabled) {
      return { provider: 'moralis', transactions: [] };
    }

    const response = await this.fetchAllNativeTransactions(options);
    await this.fetchAllTokenTransfers(options);

    return {
      provider: 'moralis',
      transactions: response.raw.result.map((transaction) =>
        normalizeTransaction('moralis', 'evm', transaction as Record<string, unknown>),
      ),
    };
  }
}
