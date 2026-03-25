import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { makeEnhancedTxClientLazy } from 'helius-sdk/enhanced/lazy';
import { FetchTransactionsOptions, ProviderFetchResult } from '../interfaces/transaction.interface';
import { withBackoff } from '../utils/backoff.util';
import { normalizeTransaction } from '../utils/normalizer.util';

@Injectable()
export class HeliusService {
  constructor(private readonly configService: ConfigService) {}

  async fetchTransactions(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    const apiKey = this.configService.get<string>('HELIUS_API_KEY');

    if (!apiKey || options.network !== 'solana') {
      return { provider: 'helius', transactions: [] };
    }

    const client = makeEnhancedTxClientLazy(apiKey);

    const transactions = await withBackoff(() =>
      client.getTransactionsByAddress({
        address: options.address,
        limit: options.limit,
      }),
    );

    return {
      provider: 'helius',
      transactions: transactions.map((transaction) =>
        normalizeTransaction('helius', 'solana', transaction as unknown as Record<string, unknown>),
      ),
    };
  }
}
