import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { Repository } from 'typeorm';
import {
  NormalizedTokenAmount,
  NormalizedTransaction,
  StoredWalletTransactionsResponse,
  WalletSummaryResponse,
  WalletTransactionsResponse,
} from './wallet.types';
import { TransactionEntity } from './transaction.entity';

interface MoralisPaginatedResponse<T> {
  cursor?: string | null;
  page?: string;
  page_size?: string;
  result: T[];
}

interface MoralisFetchOptions {
  stopAtBlock?: number;
  firstPageOnly?: boolean;
}

export interface MoralisErc20Transfer {
  token_name?: string;
  token_symbol?: string;
  token_decimals?: string;
  transaction_hash: string;
  address: string;
  block_timestamp: string;
  block_number: number | string;
  from_address: string;
  to_address: string;
  value: string | number;
  [key: string]: unknown;
}

export interface MoralisNativeTransfer {
  from_address: string;
  to_address: string;
  value: string;
  token_symbol?: string;
  direction?: string;
  [key: string]: unknown;
}

export interface MoralisWalletHistoryItem {
  hash: string;
  from_address: string;
  to_address?: string;
  value?: string;
  block_timestamp: string;
  block_number: string;
  category?: string;
  summary?: string;
  native_transfers?: MoralisNativeTransfer[];
  [key: string]: unknown;
}

function mergeTokenAmounts(entries: NormalizedTokenAmount[]) {
  const map = new Map<string, bigint>();

  for (const entry of entries) {
    const current = map.get(entry.token) || 0n;
    map.set(entry.token, current + BigInt(entry.amount));
  }

  return Array.from(map.entries()).map(([token, amount]) => ({
    token,
    amount: amount.toString(),
  }));
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly moralisApiKey: string;
  private readonly moralisClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TransactionEntity)
    private readonly transactionRepo: Repository<TransactionEntity>,
  ) {
    this.moralisApiKey = this.configService.get<string>('moralis.apiKey') ?? '';

    this.moralisClient = axios.create({
      baseURL: 'https://deep-index.moralis.io/api/v2.2',
      timeout: 10000,
      headers: {
        Accept: 'application/json',
        'X-API-Key': this.moralisApiKey,
      },
    });
  }

  async getWalletData(address: string): Promise<WalletTransactionsResponse> {
    const walletAddress = address.toLowerCase();
    const latestStoredBlock = await this.getLatestStoredBlock(walletAddress);

    if (!this.moralisApiKey) {
      throw new InternalServerErrorException('MORALIS_API_KEY is not configured');
    }

    if (latestStoredBlock !== null) {
      let latestErc20Transfers: MoralisErc20Transfer[] = [];
      let latestWalletHistory: MoralisWalletHistoryItem[] = [];

      try {
        [latestErc20Transfers, latestWalletHistory] = await Promise.all([
          this.fetchErc20Transfers(address, {
            firstPageOnly: true,
          }),
          this.fetchWalletHistory(address, {
            firstPageOnly: true,
          }),
        ]);
      } catch {
        this.logger.warn('Moralis failed, falling back to DB');
        return this.getStoredWalletData(address, walletAddress);
      }

      const latestNativeTransactions = latestWalletHistory.filter((transaction) =>
        this.isNativeTransaction(transaction),
      );

      const apiLatestBlock = this.getHighestBlockNumber(
        latestErc20Transfers,
        latestNativeTransactions,
      );

      if (apiLatestBlock <= latestStoredBlock) {
        return this.getStoredWalletData(address, walletAddress);
      }

      let newErc20Transfers: MoralisErc20Transfer[] = [];
      let newWalletHistory: MoralisWalletHistoryItem[] = [];

      try {
        [newErc20Transfers, newWalletHistory] = await Promise.all([
          this.fetchErc20Transfers(address, {
            stopAtBlock: latestStoredBlock,
          }),
          this.fetchWalletHistory(address, {
            stopAtBlock: latestStoredBlock,
          }),
        ]);
      } catch {
        this.logger.warn('Moralis failed while refreshing, falling back to DB');
        return this.getStoredWalletData(address, walletAddress);
      }

      const newNativeTransactions = this.filterNewTransactions(
        newWalletHistory.filter((transaction) => this.isNativeTransaction(transaction)),
        latestStoredBlock,
      );

      const filteredErc20Transfers = this.filterNewTransactions(
        newErc20Transfers,
        latestStoredBlock,
      );

      const normalizedTransactions = this.normalizeTransactions(
        address,
        filteredErc20Transfers,
        newNativeTransactions,
      );

      await this.saveNormalizedTransactions(address, normalizedTransactions);

      return this.getStoredWalletData(address, walletAddress);
    }

    let erc20Transfers: MoralisErc20Transfer[] = [];
    let walletHistory: MoralisWalletHistoryItem[] = [];

    try {
      [erc20Transfers, walletHistory] = await Promise.all([
        this.fetchErc20Transfers(address),
        this.fetchWalletHistory(address),
      ]);
    } catch {
      this.logger.error('Moralis failed and no cached data available');
      throw new BadGatewayException('Unable to fetch wallet data');
    }

    const nativeTransactions = walletHistory.filter((transaction) =>
      this.isNativeTransaction(transaction),
    );

    const normalizedTransactions = this.normalizeTransactions(
      address,
      erc20Transfers,
      nativeTransactions,
    );

    await this.saveNormalizedTransactions(address, normalizedTransactions);

    return this.getStoredWalletData(address, walletAddress);
  }

  async getStoredTransactions(
    address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        block_number: 'DESC',
      },
    });

    return {
      address: walletAddress,
      transactions: transactions.map((transaction) =>
        this.mapEntityToNormalized(transaction),
      ),
    };
  }

  async getWalletSummary(address: string): Promise<WalletSummaryResponse> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
    });

    let totalSwaps = 0;
    let totalTransfers = 0;
    const tokenSet = new Set<string>();

    for (const transaction of transactions) {
      if (transaction.type === 'swap') {
        totalSwaps += 1;
      }

      if (transaction.type === 'transfer') {
        totalTransfers += 1;
      }

      for (const input of transaction.inputs) {
        tokenSet.add(input.token);
      }

      for (const output of transaction.outputs) {
        tokenSet.add(output.token);
      }
    }

    return {
      address: walletAddress,
      total_transactions: transactions.length,
      total_swaps: totalSwaps,
      total_transfers: totalTransfers,
      tokens_interacted: tokenSet.size,
    };
  }

  private async getStoredWalletData(
    address: string,
    walletAddress: string,
  ): Promise<WalletTransactionsResponse> {
    const cachedTransactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        block_number: 'DESC',
      },
    });

    this.logger.log('Serving wallet data from DB');

    return {
      raw: {
        address,
        erc20_transfers: [],
        native_transactions: [],
      },
      normalized: cachedTransactions.map((transaction) =>
        this.mapEntityToNormalized(transaction),
      ),
    };
  }

  private async getLatestStoredBlock(address: string): Promise<number | null> {
    const result = await this.transactionRepo
      .createQueryBuilder('transaction')
      .select('MAX(transaction.block_number)', 'latestBlock')
      .where('transaction.wallet_address = :address', { address })
      .getRawOne<{ latestBlock: string | null }>();

    if (!result?.latestBlock) {
      return null;
    }

    const latestBlock = Number(result.latestBlock);

    return Number.isFinite(latestBlock) ? latestBlock : null;
  }

  private filterNewTransactions<T extends { block_number: number | string }>(
    transactions: T[],
    latestBlock: number,
  ): T[] {
    return transactions.filter(
      (transaction) => this.toNumber(transaction.block_number) > latestBlock,
    );
  }

  private getHighestBlockNumber(
    erc20Transfers: MoralisErc20Transfer[],
    nativeTransactions: MoralisWalletHistoryItem[],
  ): number {
    let highestBlock = 0;

    for (const transfer of erc20Transfers) {
      highestBlock = Math.max(highestBlock, this.toNumber(transfer.block_number));
    }

    for (const transaction of nativeTransactions) {
      highestBlock = Math.max(
        highestBlock,
        this.toNumber(transaction.block_number),
      );
    }

    return highestBlock;
  }

  private async saveNormalizedTransactions(
    address: string,
    transactions: NormalizedTransaction[],
  ): Promise<void> {
    const transactionsToSave = transactions.filter(
      (
        transaction,
      ): transaction is NormalizedTransaction & { type: 'transfer' | 'swap' } =>
        transaction.type === 'transfer' || transaction.type === 'swap',
    );

    if (transactionsToSave.length === 0) {
      return;
    }

    try {
      await this.transactionRepo
        .createQueryBuilder()
        .insert()
        .into(TransactionEntity)
        .values(
          transactionsToSave.map((transaction) => ({
            wallet_address: address.toLowerCase(),
            transaction_hash: transaction.hash,
            block_number: transaction.block_number,
            timestamp: new Date(transaction.timestamp),
            from_address: transaction.from,
            to_address: transaction.to,
            type: transaction.type,
            inputs: transaction.inputs,
            outputs: transaction.outputs,
          })),
        )
        .orIgnore()
        .execute();
    } catch (error) {
      this.logger.error(
        `Failed to persist normalized transactions for wallet ${address}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException(
        'Failed to store normalized transactions.',
      );
    }
  }

  private mapEntityToNormalized(
    transaction: TransactionEntity,
  ): NormalizedTransaction {
    return {
      hash: transaction.transaction_hash,
      block_number: transaction.block_number,
      timestamp: transaction.timestamp.toISOString(),
      from: transaction.from_address,
      to: transaction.to_address,
      type: transaction.type,
      inputs: transaction.inputs,
      outputs: transaction.outputs,
    };
  }

  private normalizeTransactions(
    address: string,
    erc20Transfers: MoralisErc20Transfer[],
    nativeTransactions: MoralisWalletHistoryItem[],
  ): NormalizedTransaction[] {
    const normalizedByHash = new Map<string, NormalizedTransaction>();
    const normalizedAddress = address.toLowerCase();

    for (const transaction of nativeTransactions) {
      const normalizedTransaction = this.getOrCreateNormalizedTransaction(
        normalizedByHash,
        transaction.hash,
        transaction.block_number,
        transaction.block_timestamp,
        transaction.from_address,
        transaction.to_address,
      );

      const nativeTransfers =
        transaction.native_transfers && transaction.native_transfers.length > 0
          ? transaction.native_transfers
          : transaction.value && this.isPositiveValue(transaction.value)
            ? [
                {
                  from_address: transaction.from_address,
                  to_address: transaction.to_address ?? '',
                  value: transaction.value,
                  token_symbol: 'ETH',
                },
              ]
            : [];

      for (const nativeTransfer of nativeTransfers) {
        const entry = {
          token: nativeTransfer.token_symbol ?? 'ETH',
          amount: String(nativeTransfer.value),
        };

        this.addTransferEntry(
          normalizedTransaction,
          normalizedAddress,
          nativeTransfer.from_address,
          nativeTransfer.to_address,
          entry,
          nativeTransfer.direction,
        );
      }
    }

    for (const transfer of erc20Transfers) {
      const normalizedTransaction = this.getOrCreateNormalizedTransaction(
        normalizedByHash,
        transfer.transaction_hash,
        transfer.block_number,
        transfer.block_timestamp,
        transfer.from_address,
        transfer.to_address,
      );

      this.addTransferEntry(
        normalizedTransaction,
        normalizedAddress,
        transfer.from_address,
        transfer.to_address,
        {
          token: transfer.token_symbol || transfer.address.slice(0, 6),
          amount: String(transfer.value),
        },
      );
    }

    return Array.from(normalizedByHash.values())
      .map((transaction) => {
        const inputs = mergeTokenAmounts(transaction.inputs);
        const outputs = mergeTokenAmounts(transaction.outputs);

        return {
          ...transaction,
          inputs,
          outputs,
          type: this.getTransactionType({
            ...transaction,
            inputs,
            outputs,
          }),
        };
      })
      .sort((left, right) => right.block_number - left.block_number);
  }

  private getOrCreateNormalizedTransaction(
    transactions: Map<string, NormalizedTransaction>,
    hash: string,
    blockNumber: number | string,
    timestamp: string,
    from: string,
    to?: string,
  ): NormalizedTransaction {
    const existingTransaction = transactions.get(hash);

    if (existingTransaction) {
      if (!existingTransaction.from && from) {
        existingTransaction.from = from;
      }

      if (!existingTransaction.to && to) {
        existingTransaction.to = to;
      }

      if (!existingTransaction.timestamp && timestamp) {
        existingTransaction.timestamp = timestamp;
      }

      if (existingTransaction.block_number === 0) {
        existingTransaction.block_number = this.toNumber(blockNumber);
      }

      return existingTransaction;
    }

    const createdTransaction: NormalizedTransaction = {
      hash,
      block_number: this.toNumber(blockNumber),
      timestamp,
      from,
      to: to ?? '',
      type: 'unknown',
      inputs: [],
      outputs: [],
    };

    transactions.set(hash, createdTransaction);
    return createdTransaction;
  }

  private addTransferEntry(
    transaction: NormalizedTransaction,
    walletAddress: string,
    fromAddress: string,
    toAddress: string,
    entry: NormalizedTokenAmount,
    direction?: string,
  ): void {
    const normalizedFrom = fromAddress?.toLowerCase();
    const normalizedTo = toAddress?.toLowerCase();

    if (direction === 'outgoing' || normalizedFrom === walletAddress) {
      transaction.inputs.push(entry);
      return;
    }

    if (direction === 'incoming' || normalizedTo === walletAddress) {
      transaction.outputs.push(entry);
      return;
    }

    return;
  }

  private getTransactionType(
    transaction: NormalizedTransaction,
  ): NormalizedTransaction['type'] {
    const inputTokens = new Set(transaction.inputs.map((entry) => entry.token));
    const outputTokens = new Set(
      transaction.outputs.map((entry) => entry.token),
    );

    const hasInputs = transaction.inputs.length > 0;
    const hasOutputs = transaction.outputs.length > 0;

    if (hasInputs && hasOutputs) {
      const isSameToken =
        inputTokens.size === 1 &&
        outputTokens.size === 1 &&
        [...inputTokens][0] === [...outputTokens][0];

      if (isSameToken) {
        return 'transfer';
      }

      return 'swap';
    }

    if (hasInputs || hasOutputs) {
      return 'transfer';
    }

    return 'unknown';
  }

  private isPositiveValue(value: string): boolean {
    try {
      return BigInt(value) > 0n;
    } catch {
      return false;
    }
  }

  private toNumber(value: number | string): number {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async fetchErc20Transfers(
    address: string,
    options?: MoralisFetchOptions,
  ): Promise<MoralisErc20Transfer[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisErc20Transfer>(
      `/${address}/erc20/transfers`,
      'ERC-20 transfers',
      options,
    );
  }

  private async fetchWalletHistory(
    address: string,
    options?: MoralisFetchOptions,
  ): Promise<MoralisWalletHistoryItem[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisWalletHistoryItem>(
      `/wallets/${address}/history`,
      'wallet history',
      options,
    );
  }

  private async fetchPaginatedMoralisEndpoint<
    T extends { block_number: number | string },
  >(
    path: string,
    operation: string,
    options?: MoralisFetchOptions,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    let shouldContinue = true;

    do {
      try {
        const response = await this.moralisClient.get<MoralisPaginatedResponse<T>>(
          path,
          {
            params: {
              chain: 'eth',
              order: 'DESC',
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
          },
        );

        const filteredResult = this.applyStopAtBlock(
          response.data.result,
          options?.stopAtBlock,
        );

        items.push(...filteredResult.items);

        shouldContinue =
          !options?.firstPageOnly &&
          Boolean(response.data.cursor) &&
          !filteredResult.reachedStoredBlock;

        cursor = shouldContinue ? response.data.cursor ?? undefined : undefined;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = this.extractMoralisMessage(error);

          this.logger.warn(
            `Moralis failed for ${operation}, continuing with fallback (${status ?? 'NO_RESPONSE'}: ${message})`,
          );
        } else {
          this.logger.warn(
            `Moralis failed for ${operation}, continuing with fallback`,
          );
        }

        if (items.length === 0) {
          throw error;
        }

        break;
      }
    } while (cursor && shouldContinue);

    return items;
  }

  private applyStopAtBlock<T extends { block_number: number | string }>(
    items: T[],
    stopAtBlock?: number,
  ): { items: T[]; reachedStoredBlock: boolean } {
    if (stopAtBlock === undefined) {
      return {
        items,
        reachedStoredBlock: false,
      };
    }

    const filteredItems: T[] = [];

    for (const item of items) {
      if (this.toNumber(item.block_number) <= stopAtBlock) {
        return {
          items: filteredItems,
          reachedStoredBlock: true,
        };
      }

      filteredItems.push(item);
    }

    return {
      items: filteredItems,
      reachedStoredBlock: false,
    };
  }

  private isNativeTransaction(transaction: MoralisWalletHistoryItem): boolean {
    if (
      Array.isArray(transaction.native_transfers) &&
      transaction.native_transfers.length > 0
    ) {
      return true;
    }

    if (transaction.value === undefined) {
      return false;
    }

    return this.isPositiveValue(transaction.value);
  }

  private extractMoralisMessage(error: AxiosError): string {
    const data = error.response?.data;

    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'object' && data !== null && 'message' in data) {
      const message = (data as { message?: unknown }).message;

      if (typeof message === 'string') {
        return message;
      }
    }

    return error.message;
  }
}