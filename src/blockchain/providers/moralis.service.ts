import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Moralis from 'moralis';
import { EvmChain } from '@moralisweb3/common-evm-utils';
import { FetchTransactionsOptions, ProviderFetchResult } from '../interfaces/transaction.interface';
import { withBackoff } from '../utils/backoff.util';
import { normalizeTransaction } from '../utils/normalizer.util';

@Injectable()
export class MoralisService {
  private started = false;

  constructor(private readonly configService: ConfigService) {}

  private async ensureStarted(): Promise<boolean> {
    const apiKey = this.configService.get<string>('MORALIS_API_KEY');

    if (!apiKey) {
      return false;
    }

    if (!this.started) {
      await Moralis.start({ apiKey });
      this.started = true;
    }

    return true;
  }

  async fetchTransactions(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    if (options.network !== 'evm') {
      return { provider: 'moralis', transactions: [] };
    }

    const enabled = await this.ensureStarted();
    if (!enabled) {
      return { provider: 'moralis', transactions: [] };
    }

    const response = await withBackoff(() =>
      Moralis.EvmApi.transaction.getWalletTransactions({
        address: options.address,
        chain: EvmChain.ETHEREUM,
        limit: options.limit,
      }),
    );

    return {
      provider: 'moralis',
      transactions: response.raw.result.map((transaction) =>
        normalizeTransaction('moralis', 'evm', transaction as Record<string, unknown>),
      ),
    };
  }
}
