import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import {
  NormalizedTokenAmount,
  NormalizedTransaction,
  WalletRawData,
  WalletTransactionsResponse,
} from './wallet.types';

interface MoralisPaginatedResponse<T> {
  cursor?: string | null;
  page?: string;
  page_size?: string;
  result: T[];
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

  constructor(private readonly configService: ConfigService) {
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
    if (!this.moralisApiKey) {
      throw new InternalServerErrorException('MORALIS_API_KEY is not configured');
    }

    const [erc20Transfers, walletHistory] = await Promise.all([
      this.fetchAllErc20Transfers(address),
      this.fetchAllWalletHistory(address),
    ]);

    const nativeTransactions = walletHistory.filter((transaction) =>
      this.isNativeTransaction(transaction),
    );

    const rawData: WalletRawData = {
      address,
      erc20_transfers: erc20Transfers,
      native_transactions: nativeTransactions,
    };

    return {
      raw: rawData,
      normalized: this.normalizeTransactions(
        address,
        erc20Transfers,
        nativeTransactions,
      ),
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

  private async fetchAllErc20Transfers(
    address: string,
  ): Promise<MoralisErc20Transfer[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisErc20Transfer>(
      `/${address}/erc20/transfers`,
      'ERC-20 transfers',
    );
  }

  private async fetchAllWalletHistory(
    address: string,
  ): Promise<MoralisWalletHistoryItem[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisWalletHistoryItem>(
      `/wallets/${address}/history`,
      'wallet history',
    );
  }

  private async fetchPaginatedMoralisEndpoint<T>(
    path: string,
    operation: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

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

        items.push(...response.data.result);
        cursor = response.data.cursor ?? undefined;
      } catch (error) {
        this.handleMoralisError(error, operation);
      }
    } while (cursor);

    return items;
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

  private handleMoralisError(error: unknown, operation: string): never {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = this.extractMoralisMessage(error);

      this.logger.error(
        `Moralis ${operation} request failed with status ${status ?? 'NO_RESPONSE'}: ${message}`,
      );

      if (status === 401 || status === 403) {
        throw new BadGatewayException(
          'Moralis authentication failed. Check MORALIS_API_KEY.',
        );
      }

      if (status) {
        throw new BadGatewayException(
          `Moralis API failed while fetching ${operation}.`,
        );
      }

      throw new BadGatewayException(
        `Moralis did not respond while fetching ${operation}.`,
      );
    }

    this.logger.error(
      `Unexpected error while fetching ${operation}`,
      error instanceof Error ? error.stack : undefined,
    );

    throw new BadGatewayException(
      `Unexpected error while fetching ${operation}.`,
    );
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