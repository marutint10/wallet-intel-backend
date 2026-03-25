import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { TokenTransferEntity, TransactionEntity } from './entities/transaction.entity';
import { FetchResult, FetchTransactionsOptions, NormalizedTransaction, ProviderFetchResult } from './interfaces/transaction.interface';
import { BlockchainAlchemyService } from './providers/alchemy.service';
import { HeliusService } from './providers/helius.service';
import { MoralisService } from './providers/moralis.service';
import { detectBlockchainNetwork } from './utils/address.util';

@Injectable()
export class BlockchainService {
  constructor(
    @InjectRepository(TransactionEntity)
    private readonly txRepo: Repository<TransactionEntity>,
    @InjectRepository(TokenTransferEntity)
    private readonly transferRepo: Repository<TokenTransferEntity>,
    private readonly moralisService: MoralisService,
    private readonly alchemyService: BlockchainAlchemyService,
    private readonly heliusService: HeliusService,
  ) {}

  async syncWallet(address: string, limit = 25): Promise<FetchResult> {
    const network = detectBlockchainNetwork(address);
    const options: FetchTransactionsOptions = { address, network, limit };
    const result = await this.fetchWithFallback(options);
    const tokenTransferCount = await this.persistInBatches(address, result.transactions);

    return {
      transactionCount: result.transactions.length,
      tokenTransferCount,
      source: result.provider,
    };
  }

  private async fetchWithFallback(options: FetchTransactionsOptions): Promise<ProviderFetchResult> {
    const providers = options.network === 'solana'
      ? [this.heliusService]
      : [this.moralisService, this.alchemyService, this.heliusService];

    let fallbackResult: ProviderFetchResult | null = null;

    for (const provider of providers) {
      const result = await provider.fetchTransactions(options);

      if (!fallbackResult) {
        fallbackResult = result;
      }

      if (result.transactions.length > 0) {
        return result;
      }
    }

    return fallbackResult ?? { provider: 'helius', transactions: [] };
  }

  private async persistInBatches(address: string, transactions: NormalizedTransaction[]): Promise<number> {
    let tokenTransferCount = 0;

    for (let index = 0; index < transactions.length; index += 100) {
      const batch = transactions.slice(index, index + 100);
      const transactionRows: QueryDeepPartialEntity<TransactionEntity>[] = batch.map((transaction) =>
        this.toTransactionRecord(address, transaction),
      );
      const transferRows: QueryDeepPartialEntity<TokenTransferEntity>[] = batch.flatMap((transaction) =>
        transaction.tokenTransfers.map((transfer, transferIndex) =>
          this.toTokenTransferRecord(address, transaction, transferIndex),
        ),
      );

      if (transactionRows.length > 0) {
        await this.txRepo.upsert(transactionRows, { conflictPaths: ['hash'] });
      }

      if (transferRows.length > 0) {
        await this.transferRepo.upsert(transferRows, { conflictPaths: ['id'] });
        tokenTransferCount += transferRows.length;
      }
    }

    return tokenTransferCount;
  }

  private toTransactionRecord(
    address: string,
    transaction: NormalizedTransaction,
  ): QueryDeepPartialEntity<TransactionEntity> {
    return {
      address,
      network: transaction.network,
      provider: transaction.provider,
      hash: transaction.txHash,
      blockNumber: transaction.blockNumber,
      timestamp: transaction.timestamp,
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress,
      assetSymbol: transaction.assetSymbol,
      amount: transaction.amount,
      raw: transaction.raw as QueryDeepPartialEntity<Record<string, unknown>>,
    };
  }

  private toTokenTransferRecord(
    address: string,
    transaction: NormalizedTransaction,
    transferIndex: number,
  ): QueryDeepPartialEntity<TokenTransferEntity> {
    const transfer = transaction.tokenTransfers[transferIndex];

    return {
      id: `${transaction.txHash}-${transferIndex}`,
      transactionHash: transaction.txHash,
      walletAddress: address,
      network: transaction.network,
      provider: transaction.provider,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      assetSymbol: transfer.assetSymbol,
      amount: transfer.amount,
      transferIndex,
      raw: transfer.raw as QueryDeepPartialEntity<Record<string, unknown>>,
    };
  }
}
