import { Injectable } from '@nestjs/common';
import { TransactionEntity } from './entities/transaction.entity';
import { FetchTransactionsOptions, NormalizedTransaction } from './interfaces/transaction.interface';
import { BlockchainAlchemyService } from './providers/alchemy.service';
import { HeliusService } from './providers/helius.service';
import { MoralisService } from './providers/moralis.service';
import { detectBlockchainNetwork } from './utils/address.util';

@Injectable()
export class BlockchainService {
  constructor(
    private readonly moralisService: MoralisService,
    private readonly alchemyService: BlockchainAlchemyService,
    private readonly heliusService: HeliusService,
  ) {}

  async syncWallet(address: string, limit = 25): Promise<{
    network: string;
    transactions: NormalizedTransaction[];
    records: Partial<TransactionEntity>[];
  }> {
    const network = detectBlockchainNetwork(address);
    const options: FetchTransactionsOptions = { address, network, limit };

    const [moralisResult, alchemyResult, heliusResult] = await Promise.all([
      this.moralisService.fetchTransactions(options),
      this.alchemyService.fetchTransactions(options),
      this.heliusService.fetchTransactions(options),
    ]);

    const transactions = [...moralisResult.transactions, ...alchemyResult.transactions, ...heliusResult.transactions];
    const records = transactions.map((transaction) => this.toTransactionRecord(address, transaction));

    return {
      network,
      transactions,
      records,
    };
  }

  private toTransactionRecord(address: string, transaction: NormalizedTransaction): Partial<TransactionEntity> {
    return {
      address,
      network: transaction.network,
      provider: transaction.provider,
      txHash: transaction.txHash,
      blockNumber: transaction.blockNumber,
      timestamp: transaction.timestamp,
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      assetSymbol: transaction.assetSymbol,
      amount: transaction.amount,
      raw: transaction.raw,
    };
  }
}
