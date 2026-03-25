import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Alchemy, AssetTransfersCategory, Network } from 'alchemy-sdk';
import { FetchTransactionsOptions, ProviderFetchResult } from '../interfaces/transaction.interface';
import { withBackoff } from '../utils/backoff.util';
import { normalizeTransaction } from '../utils/normalizer.util';

@Injectable()
export class BlockchainAlchemyService {
  constructor(private readonly configService: ConfigService) {}

  async fetchTransactions(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY');

    if (!apiKey || options.network !== 'evm') {
      return { provider: 'alchemy', transactions: [] };
    }

    const client = new Alchemy({ apiKey, network: Network.ETH_MAINNET });

    const response = await withBackoff(() =>
      client.core.getAssetTransfers({
        fromBlock: '0x0',
        toAddress: options.address,
        category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
        maxCount: options.limit,
        withMetadata: true,
      }),
    );

    return {
      provider: 'alchemy',
      transactions: response.transfers.map((transfer) =>
        normalizeTransaction('alchemy', 'evm', transfer as unknown as Record<string, unknown>),
      ),
    };
  }
}
