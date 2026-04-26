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
  Trade,
  StoredWalletTransactionsResponse,
  WalletTransactionsResponse,
} from '../wallet.types';
import { TransactionEntity } from '../transaction.entity';
import { HybridHoldingsService } from './hybrid-holdings.service';
import { TX_FETCH_LIMIT } from '../../config/constants';

export class MoralisKeysExhaustedError extends Error {
  constructor() {
    super('All Moralis API keys exhausted');
  }
}

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

export interface MoralisNativeBalanceResponse {
  balance?: string;
  [key: string]: unknown;
}

export interface MoralisErc20Balance {
  token_address?: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
  balance?: string;
  [key: string]: unknown;
}

function mergeTokenAmounts(entries: NormalizedTokenAmount[]) {
  const map = new Map<
    string,
    {
      amount: bigint;
      decimals?: number;
      contractAddress?: string;
      tokenName?: string;
    }
  >();

  for (const entry of entries) {
    if (!entry.token) {
      continue;
    }

    const current = map.get(entry.token);

    if (!current) {
      map.set(entry.token, {
        amount: BigInt(entry.amount),
        decimals: entry.decimals,
        contractAddress: entry.contractAddress?.toLowerCase(),
        tokenName: entry.tokenName,
      });

      continue;
    }

    current.amount += BigInt(entry.amount);

    if (current.decimals === undefined && entry.decimals !== undefined) {
      current.decimals = entry.decimals;
    }

    if (!current.contractAddress && entry.contractAddress) {
      current.contractAddress = entry.contractAddress.toLowerCase();
    }

    if (!current.tokenName && entry.tokenName) {
      current.tokenName = entry.tokenName;
    }
  }

  return Array.from(map.entries()).map(([token, entry]) => ({
    token,
    amount: entry.amount.toString(),
    decimals: entry.decimals,
    contractAddress: entry.contractAddress,
    tokenName: entry.tokenName,
  }));
}

@Injectable()
export class WalletCoreService {
  private static readonly MORALIS_RETRY_DELAY_MS = 500;
  private static readonly MORALIS_KEY_EXHAUSTED_WINDOW_MS = 60 * 60 * 1000;
  private static readonly ZERO_ADDRESS =
    '0x0000000000000000000000000000000000000000';
  private static readonly BRIDGE_PROTOCOL_ADDRESSES = new Set([
    '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', // Optimism Standard Bridge
    '0x3154cf16ccdb4c6d922629664174b904d80f2c35', // Base Standard Bridge
    '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', // Arbitrum Inbox
    '0x8731d54e9d02c286767d56ac03e8037c07e01e98', // Stargate Router
    '0x66a71dcef29a0ffbdbE3c6a460a3b5bc225cd675'.toLowerCase(), // LayerZero Endpoint
  ]);
  private static readonly LENDING_PROTOCOL_ADDRESSES = new Set([
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3 Pool
  ]);
  private static readonly VAULT_PROTOCOL_ADDRESSES = new Set([
    '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault
  ]);
  private static readonly REWARD_DISTRIBUTOR_ADDRESSES = new Set([
    '0x4da27a545c0c5b758a6ba100e3a049001de870f5', // stkAAVE
  ]);
  private static readonly LP_TOKEN_PATTERN = /\bLP\b|UNI-V2|PAIR|POOL|BPT|\bSLP\b|Cake-LP/i;
  private static readonly YIELD_TOKEN_PREFIXES = ['YT-', 'PT-', 'SY-'];
  private static readonly LENDING_RECEIPT_SYMBOLS = new Set([
    'AUSDC',
    'AUSDT',
    'ADAI',
    'AWETH',
    'AWBTC',
    'CUSDC',
    'CDAI',
    'CUSDT',
    'CWETH',
    'SDAI',
  ]);
  private static readonly LENDING_RECEIPT_PREFIXES = ['A', 'C'];
  private static readonly LENDING_RECEIPT_NAME_MATCHES = [
    'AAVE',
    'COMPOUND',
    'INTEREST BEARING',
    'LENDING',
    'SPARK',
  ];
  private static readonly VAULT_SHARE_PREFIXES = ['YV', 'MOO', 'STK', 'X'];
  private static readonly VAULT_SHARE_NAME_MATCHES = [
    'VAULT',
    'SHARE',
    'YEARN',
    'BEEFY',
    'ERC4626',
  ];
  private static readonly BASE_ASSET_SYMBOLS = new Set([
    'ETH',
    'WETH',
    'USDC',
    'USDT',
    'DAI',
    'FRAX',
    'LUSD',
    'USDE',
    'USDS',
    'TUSD',
    'CRVUSD',
    'RETH',
    'WEETH',
    'STETH',
    'EZETH',
    'RSWETH',
  ]);
  private static readonly REWARD_TOKEN_SYMBOLS = new Set([
    'ARB',
    'OP',
    'AAVE',
    'PENDLE',
    'VELO',
    'GMX',
  ]);
  private static readonly PENDLE_BASE_OR_RESTAKED_SYMBOLS = new Set([
    'ETH',
    'WETH',
    'STETH',
    'EZETH',
    'RSWETH',
    'WEETH',
    'RETH',
  ]);
  private static readonly PENDLE_BASE_OR_RESTAKED_NAME_MATCHES = [
    'RENZO RESTAKED ETH',
  ];
  private static readonly PROTOCOL_TRANSFORM_GROUPS: Record<string, string> = {
    ETH: 'ETH',
    WETH: 'ETH',
    STETH: 'STETH',
    WSTETH: 'STETH',
    EZETH: 'EZETH',
    RSWETH: 'RSWETH',
    WEETH: 'WEETH',
    RETH: 'RETH',
  };
  private static readonly PROTOCOL_TRANSFORM_NAME_MATCHES: Array<{
    fragment: string;
    group: string;
  }> = [
    { fragment: 'RENZO RESTAKED ETH', group: 'EZETH' },
  ];
  private static readonly STAKING_BASE_ASSET_SYMBOLS = new Set(['ETH', 'WETH']);
  private static readonly STAKING_DERIVATIVE_SYMBOLS = new Set([
    'STETH',
    'WSTETH',
    'EZETH',
    'RSWETH',
    'WEETH',
    'METH',
    'CBETH',
    'RETH',
  ]);
  private static readonly STAKING_DERIVATIVE_NAME_MATCHES = [
    'RENZO RESTAKED ETH',
    'RESTAKED ETH',
  ];
  private static readonly WRAPPED_STAKING_DERIVATIVE_SYMBOLS = new Set([
    'WSTETH',
    'WEETH',
  ]);
  private readonly logger = new Logger(WalletCoreService.name);
  private readonly moralisApiKey1: string;
  private readonly moralisApiKey2: string;
  private readonly moralisClient: AxiosInstance;
  private activeKeyIndex = 0;
  private key1ExhaustedAt: number | null = null;
  private key2ExhaustedAt: number | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TransactionEntity)
    private readonly transactionRepo: Repository<TransactionEntity>,
    private readonly hybridHoldingsService: HybridHoldingsService,
  ) {
    this.moralisApiKey1 = this.configService.get<string>('moralis.apiKey1') ?? '';
    this.moralisApiKey2 = this.configService.get<string>('moralis.apiKey2') ?? '';
    this.activeKeyIndex = this.resolveInitialActiveKeyIndex();

    this.logger.log(`Moralis keys configured: ${this.getConfiguredMoralisKeyCount()}`);
    this.logger.log(`TX_FETCH_LIMIT active: ${TX_FETCH_LIMIT}`);

    this.moralisClient = axios.create({
      baseURL: 'https://deep-index.moralis.io/api/v2.2',
      timeout: 15000,
      headers: {
        Accept: 'application/json',
      },
    });
  }

  async getNativeBalance(address: string): Promise<MoralisNativeBalanceResponse> {
    this.ensureMoralisApiKey();

    try {
      const response = await this.callMoralisWithRetry((apiKey) =>
        this.moralisClient.get<MoralisNativeBalanceResponse>(
          `/${address}/balance`,
          {
            params: {
              chain: 'eth',
            },
            headers: this.buildMoralisHeaders(apiKey),
          },
        ),
      );

      return response.data;
    } catch (error) {
      this.logMoralisRequestFailure('native balance', error);

      if (error instanceof MoralisKeysExhaustedError) {
        throw error;
      }

      throw new BadGatewayException('Unable to fetch wallet holdings');
    }
  }

  async getErc20Balances(address: string): Promise<MoralisErc20Balance[]> {
    this.ensureMoralisApiKey();

    try {
      const response = await this.callMoralisWithRetry((apiKey) =>
        this.moralisClient.get<MoralisErc20Balance[]>(`/${address}/erc20`, {
          params: {
            chain: 'eth',
          },
          headers: this.buildMoralisHeaders(apiKey),
        }),
      );

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      this.logMoralisRequestFailure('ERC-20 balances', error);

      if (error instanceof MoralisKeysExhaustedError) {
        throw error;
      }

      throw new BadGatewayException('Unable to fetch wallet holdings');
    }
  }

  async getWalletData(address: string): Promise<WalletTransactionsResponse> {
    const walletAddress = address.toLowerCase();
    const latestStoredBlock = await this.getLatestStoredBlock(walletAddress);

    this.ensureMoralisApiKey();

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

      const insertedTransactionCount = await this.saveNormalizedTransactions(
        address,
        normalizedTransactions,
      );

      if (insertedTransactionCount > 0) {
        this.hybridHoldingsService.clearCache(walletAddress);
      }

      this.logger.log(
        `Wallet sync completed with ${normalizedTransactions.length} records (incremental)`,
      );

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

    const insertedTransactionCount = await this.saveNormalizedTransactions(
      address,
      normalizedTransactions,
    );

    if (insertedTransactionCount > 0) {
      this.hybridHoldingsService.clearCache(walletAddress);
    }

    this.logger.log(
      `Wallet sync completed with ${normalizedTransactions.length} records (full)`,
    );

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

  async getTransactionEntities(address: string): Promise<TransactionEntity[]> {
    const walletAddress = address.toLowerCase();
    return this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        timestamp: 'ASC',
      },
    });
  }

  async getTransactionEntitiesUnordered(
    address: string,
  ): Promise<TransactionEntity[]> {
    const walletAddress = address.toLowerCase();
    return this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
    });
  }

  buildTradesFromEntries(
    entries: NormalizedTokenAmount[],
    type: Trade['type'],
    timestamp: number,
    options: {
      transactionHash?: string;
      hopIndexOffset?: number;
    } = {},
  ): Trade[] {
    const trades: Trade[] = [];

    for (const [index, entry] of entries.entries()) {
      const trade = this.createTradeFromEntry(entry, type, timestamp, {
        transactionHash: options.transactionHash,
        routeHopIndex: (options.hopIndexOffset ?? 0) + index,
      });

      if (trade) {
        trades.push(trade);
      }
    }

    return trades;
  }

  toUnixTimestamp(timestamp: Date): number {
    return Math.floor(timestamp.getTime() / 1000);
  }

  private createTradeFromEntry(
    entry: NormalizedTokenAmount,
    type: Trade['type'],
    timestamp: number,
    options: {
      transactionHash?: string;
      routeHopIndex?: number;
    } = {},
  ): Trade | null {
    if (!entry.token) {
      return null;
    }

    const rawAmount = this.parseBigInt(entry.amount);

    if (rawAmount === null || rawAmount === 0n) {
      return null;
    }

    return {
      token: entry.token,
      type,
      amount: this.normalizeTokenAmount(rawAmount, entry.decimals),
      decimals: entry.decimals,
      contractAddress: entry.contractAddress?.toLowerCase(),
      timestamp,
      transactionHash: options.transactionHash,
      routeHopIndex: options.routeHopIndex,
      rawAmount: rawAmount.toString(),
    };
  }

  private parseBigInt(value: string): bigint | null {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private normalizeTokenAmount(rawAmount: bigint, decimals?: number): string {
    const safeDecimals =
      typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
        ? decimals
        : 18;

    const divisor = 10n ** BigInt(safeDecimals);
    const wholePart = rawAmount / divisor;
    const fractionalPart = rawAmount % divisor;

    if (fractionalPart === 0n) {
      return wholePart.toString();
    }

    const fractionalString = fractionalPart
      .toString()
      .padStart(safeDecimals, '0')
      .replace(/0+$/, '');

    return `${wholePart.toString()}.${fractionalString}`;
  }

  private ensureMoralisApiKey(): void {
    if (!this.getMoralisApiKey(0) && !this.getMoralisApiKey(1)) {
      throw new InternalServerErrorException(
        'No Moralis API keys are configured',
      );
    }
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
  ): Promise<number> {
    const transactionsToSave = transactions.filter(
      (
        transaction,
      ): transaction is NormalizedTransaction & {
        type:
          | 'transfer'
          | 'swap'
          | 'wrap'
          | 'unwrap'
          | 'liquidity_add'
          | 'liquidity_remove'
          | 'stake'
          | 'unstake'
          | 'staking_wrap'
          | 'staking_unwrap'
          | 'yield_split'
          | 'yield_merge'
          | 'receipt_mint'
          | 'receipt_burn'
          | 'protocol_transform'
          | 'bridge_out'
          | 'bridge_in'
          | 'lending_deposit'
          | 'lending_withdraw'
          | 'borrow'
          | 'repay'
          | 'vault_deposit'
          | 'vault_withdraw'
          | 'reward_claim';
      } =>
        transaction.type === 'transfer' ||
        transaction.type === 'swap' ||
        transaction.type === 'wrap' ||
        transaction.type === 'unwrap' ||
        transaction.type === 'liquidity_add' ||
        transaction.type === 'liquidity_remove' ||
        transaction.type === 'stake' ||
        transaction.type === 'unstake' ||
        transaction.type === 'staking_wrap' ||
        transaction.type === 'staking_unwrap' ||
        transaction.type === 'yield_split' ||
        transaction.type === 'yield_merge' ||
        transaction.type === 'receipt_mint' ||
        transaction.type === 'receipt_burn' ||
        transaction.type === 'protocol_transform' ||
        transaction.type === 'bridge_out' ||
        transaction.type === 'bridge_in' ||
        transaction.type === 'lending_deposit' ||
        transaction.type === 'lending_withdraw' ||
        transaction.type === 'borrow' ||
        transaction.type === 'repay' ||
        transaction.type === 'vault_deposit' ||
        transaction.type === 'vault_withdraw' ||
        transaction.type === 'reward_claim',
    );

    if (transactionsToSave.length === 0) {
      return 0;
    }

    try {
      const insertResult = await this.transactionRepo
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
        .returning('id')
        .execute();

      await this.hybridHoldingsService.syncKnownTokens(
        address.toLowerCase(),
        transactionsToSave,
      );

      if (Array.isArray(insertResult.raw)) {
        return insertResult.raw.length;
      }

      return insertResult.identifiers.length;
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
        const entry: NormalizedTokenAmount = {
          token: nativeTransfer.token_symbol ?? 'ETH',
          amount: String(nativeTransfer.value),
          decimals: 18,
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
          token: transfer.token_symbol ?? '',
          amount: String(transfer.value),
          decimals:
            transfer.token_decimals !== undefined
              ? this.toNumber(transfer.token_decimals)
              : undefined,
          contractAddress: transfer.address?.toLowerCase(),
          tokenName: transfer.token_name,
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
    if (!entry.token) {
      return;
    }

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
    const outputTokens = new Set(transaction.outputs.map((entry) => entry.token));

    const hasInputs = transaction.inputs.length > 0;
    const hasOutputs = transaction.outputs.length > 0;

    if (!hasInputs && !hasOutputs) {
      return 'unknown';
    }

    const bridgeTo = this.isKnownBridgeAddress(transaction.to);
    const bridgeFrom = this.isKnownBridgeAddress(transaction.from);
    const lendingTo = this.isKnownLendingProtocolAddress(transaction.to);
    const lendingFrom = this.isKnownLendingProtocolAddress(transaction.from);
    const vaultTo = this.isKnownVaultProtocolAddress(transaction.to);
    const vaultFrom = this.isKnownVaultProtocolAddress(transaction.from);
    const rewardFrom = this.isKnownRewardDistributorAddress(transaction.from);

    if (hasInputs && !hasOutputs) {
      if (lendingTo) {
        this.logger.debug(`Detected repay tx ${transaction.hash}`);
        return 'repay';
      }

      if (bridgeTo || this.isLikelyBridgeOutWithoutReturn(transaction)) {
        this.logger.debug(`Detected bridge_out tx ${transaction.hash}`);
        return 'bridge_out';
      }

      if (vaultTo && transaction.inputs.some((entry) => this.isBaseAssetLike(entry))) {
        this.logger.debug(`Detected vault_deposit tx ${transaction.hash}`);
        return 'vault_deposit';
      }

      return 'transfer';
    }

    if (!hasInputs && hasOutputs) {
      if (bridgeFrom) {
        this.logger.debug(`Detected bridge_in tx ${transaction.hash}`);
        return 'bridge_in';
      }

      if (lendingFrom) {
        this.logger.debug(`Detected borrow tx ${transaction.hash}`);
        return 'borrow';
      }

      if (this.isZeroAddress(transaction.from)) {
        if (this.hasYieldToken(transaction.outputs)) {
          this.logger.debug(`Detected yield_split tx ${transaction.hash}`);
          return 'yield_split';
        }

        if (this.hasReceiptLikeToken(transaction.outputs)) {
          this.logger.debug(`Detected zero-address mint tx ${transaction.hash}`);
          return 'receipt_mint';
        }

        this.logger.debug(`Detected reward_claim tx ${transaction.hash}`);
        return 'reward_claim';
      }

      if (rewardFrom || this.hasRewardLikeOutput(transaction.outputs)) {
        this.logger.debug(`Detected reward_claim tx ${transaction.hash}`);
        return 'reward_claim';
      }

      if (vaultFrom && transaction.outputs.some((entry) => this.isBaseAssetLike(entry))) {
        this.logger.debug(`Detected vault_withdraw tx ${transaction.hash}`);
        return 'vault_withdraw';
      }

      return 'transfer';
    }

    const singleInputEntry =
      inputTokens.size === 1 ? transaction.inputs[0] : undefined;
    const singleOutputEntry =
      outputTokens.size === 1 ? transaction.outputs[0] : undefined;

    // --- WRAP: ETH in, WETH out ---
    if (
      inputTokens.size === 1 &&
      outputTokens.size === 1 &&
      [...inputTokens][0].toUpperCase() === 'ETH' &&
      [...outputTokens][0].toUpperCase() === 'WETH'
    ) {
      this.logger.debug(`Detected wrap tx ${transaction.hash}`);
      return 'wrap';
    }

    // --- UNWRAP: WETH in, ETH out ---
    if (
      inputTokens.size === 1 &&
      outputTokens.size === 1 &&
      [...inputTokens][0].toUpperCase() === 'WETH' &&
      [...outputTokens][0].toUpperCase() === 'ETH'
    ) {
      this.logger.debug(`Detected unwrap tx ${transaction.hash}`);
      return 'unwrap';
    }

    // --- LIQUIDITY ADD: 2+ distinct input tokens, 1 LP token output ---
    if (inputTokens.size >= 2 && outputTokens.size === 1) {
      const outputSymbol = transaction.outputs[0].token;
      if (WalletCoreService.LP_TOKEN_PATTERN.test(outputSymbol)) {
        this.logger.debug(`Detected liquidity_add tx ${transaction.hash}`);
        return 'liquidity_add';
      }
    }

    // --- LIQUIDITY REMOVE: 1 LP token input, 2+ distinct output tokens ---
    if (inputTokens.size === 1 && outputTokens.size >= 2) {
      const inputSymbol = transaction.inputs[0].token;
      if (WalletCoreService.LP_TOKEN_PATTERN.test(inputSymbol)) {
        this.logger.debug(`Detected liquidity_remove tx ${transaction.hash}`);
        return 'liquidity_remove';
      }
    }

    // --- YIELD SPLIT: base/restaked in, YT/PT/SY out ---
    if (
      this.hasPendleBaseOrRestakedAsset(transaction.inputs) &&
      this.hasYieldToken(transaction.outputs)
    ) {
      this.logger.debug(`Detected yield_split tx ${transaction.hash}`);
      return 'yield_split';
    }

    // --- YIELD MERGE: YT/PT/SY in, base/restaked out ---
    if (
      this.hasYieldToken(transaction.inputs) &&
      this.hasPendleBaseOrRestakedAsset(transaction.outputs)
    ) {
      this.logger.debug(`Detected yield_merge tx ${transaction.hash}`);
      return 'yield_merge';
    }

    if (this.isZeroAddress(transaction.from)) {
      if (this.hasYieldToken(transaction.outputs)) {
        this.logger.debug(`Detected yield_split tx ${transaction.hash}`);
        return 'yield_split';
      }

      if (this.hasReceiptLikeToken(transaction.outputs)) {
        this.logger.debug(`Detected zero-address mint tx ${transaction.hash}`);
        return 'receipt_mint';
      }

      this.logger.debug(`Detected reward_claim tx ${transaction.hash}`);
      return 'reward_claim';
    }

    if (this.isZeroAddress(transaction.to)) {
      if (
        this.hasYieldToken(transaction.inputs) ||
        this.hasYieldToken(transaction.outputs)
      ) {
        this.logger.debug(`Detected yield_merge tx ${transaction.hash}`);
        return 'yield_merge';
      }

      return 'receipt_burn';
    }

    if (singleInputEntry && singleOutputEntry) {
      const inputIsBaseAsset = this.isBaseAssetLike(singleInputEntry);
      const outputIsBaseAsset = this.isBaseAssetLike(singleOutputEntry);
      const inputIsLendingReceipt = this.isLikelyLendingReceiptToken(singleInputEntry);
      const outputIsLendingReceipt =
        this.isLikelyLendingReceiptToken(singleOutputEntry);
      const inputIsVaultShare = this.isLikelyVaultShareToken(singleInputEntry);
      const outputIsVaultShare = this.isLikelyVaultShareToken(singleOutputEntry);

      if (inputIsBaseAsset && outputIsLendingReceipt) {
        this.logger.debug(`Detected lending_deposit tx ${transaction.hash}`);
        return 'lending_deposit';
      }

      if (inputIsLendingReceipt && outputIsBaseAsset) {
        this.logger.debug(`Detected lending_withdraw tx ${transaction.hash}`);
        return 'lending_withdraw';
      }

      if (inputIsBaseAsset && outputIsVaultShare) {
        this.logger.debug(`Detected vault_deposit tx ${transaction.hash}`);
        return 'vault_deposit';
      }

      if (inputIsVaultShare && outputIsBaseAsset) {
        this.logger.debug(`Detected vault_withdraw tx ${transaction.hash}`);
        return 'vault_withdraw';
      }

      const inputIsStakingDerivative =
        this.isKnownStakingDerivative(singleInputEntry);
      const outputIsStakingDerivative =
        this.isKnownStakingDerivative(singleOutputEntry);
      const inputIsWrappedStakingDerivative =
        this.isWrappedStakingDerivative(singleInputEntry);
      const outputIsWrappedStakingDerivative =
        this.isWrappedStakingDerivative(singleOutputEntry);

      if (
        inputIsStakingDerivative &&
        outputIsStakingDerivative &&
        !inputIsWrappedStakingDerivative &&
        outputIsWrappedStakingDerivative
      ) {
        this.logger.debug(`Detected staking_wrap tx ${transaction.hash}`);
        return 'staking_wrap';
      }

      if (
        inputIsStakingDerivative &&
        outputIsStakingDerivative &&
        inputIsWrappedStakingDerivative &&
        !outputIsWrappedStakingDerivative
      ) {
        this.logger.debug(`Detected staking_unwrap tx ${transaction.hash}`);
        return 'staking_unwrap';
      }

      const inputIsBaseStakingAsset = this.isStakingBaseAsset(singleInputEntry);
      const outputIsBaseStakingAsset = this.isStakingBaseAsset(singleOutputEntry);

      if (inputIsBaseStakingAsset && outputIsStakingDerivative) {
        this.logger.debug(`Detected stake tx ${transaction.hash}`);
        return 'stake';
      }

      if (inputIsStakingDerivative && outputIsBaseStakingAsset) {
        this.logger.debug(`Detected unstake tx ${transaction.hash}`);
        return 'unstake';
      }

      if (this.isProtocolTransformPair(singleInputEntry, singleOutputEntry)) {
        this.logger.debug(`Detected protocol_transform tx ${transaction.hash}`);
        return 'protocol_transform';
      }
    }

    if (bridgeTo) {
      this.logger.debug(`Detected bridge_out tx ${transaction.hash}`);
      return 'bridge_out';
    }

    if (bridgeFrom) {
      this.logger.debug(`Detected bridge_in tx ${transaction.hash}`);
      return 'bridge_in';
    }

    // --- TRANSFER: same single token on both sides ---
    if (
      inputTokens.size === 1 &&
      outputTokens.size === 1 &&
      [...inputTokens][0] === [...outputTokens][0]
    ) {
      return 'transfer';
    }

    return 'swap';
  }

  private normalizeTokenSymbol(token?: string): string {
    return token?.trim().toUpperCase() ?? '';
  }

  private normalizeTokenName(tokenName?: string): string {
    return tokenName?.trim().toUpperCase() ?? '';
  }

  private normalizeAddress(address?: string): string {
    return address?.trim().toLowerCase() ?? '';
  }

  private isZeroAddress(address?: string): boolean {
    return this.normalizeAddress(address) === WalletCoreService.ZERO_ADDRESS;
  }

  private isKnownBridgeAddress(address?: string): boolean {
    const normalizedAddress = this.normalizeAddress(address);

    return WalletCoreService.BRIDGE_PROTOCOL_ADDRESSES.has(normalizedAddress);
  }

  private isKnownLendingProtocolAddress(address?: string): boolean {
    const normalizedAddress = this.normalizeAddress(address);

    return WalletCoreService.LENDING_PROTOCOL_ADDRESSES.has(normalizedAddress);
  }

  private isKnownVaultProtocolAddress(address?: string): boolean {
    const normalizedAddress = this.normalizeAddress(address);

    return WalletCoreService.VAULT_PROTOCOL_ADDRESSES.has(normalizedAddress);
  }

  private isKnownRewardDistributorAddress(address?: string): boolean {
    const normalizedAddress = this.normalizeAddress(address);

    return WalletCoreService.REWARD_DISTRIBUTOR_ADDRESSES.has(normalizedAddress);
  }

  private isYieldToken(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    return WalletCoreService.YIELD_TOKEN_PREFIXES.some(
      (prefix) => symbol.startsWith(prefix) || tokenName.includes(prefix),
    );
  }

  private hasYieldToken(entries: NormalizedTokenAmount[]): boolean {
    return entries.some((entry) => this.isYieldToken(entry));
  }

  private isLikelyLendingReceiptToken(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    if (WalletCoreService.LENDING_RECEIPT_SYMBOLS.has(symbol)) {
      return true;
    }

    const hasLendingPrefix = WalletCoreService.LENDING_RECEIPT_PREFIXES.some(
      (prefix) => symbol.startsWith(prefix) && symbol.length > 4,
    );

    if (
      hasLendingPrefix &&
      WalletCoreService.BASE_ASSET_SYMBOLS.has(symbol.slice(1))
    ) {
      return true;
    }

    return WalletCoreService.LENDING_RECEIPT_NAME_MATCHES.some((fragment) =>
      tokenName.includes(fragment),
    );
  }

  private isLikelyVaultShareToken(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);
    const hasVaultPrefix = WalletCoreService.VAULT_SHARE_PREFIXES.some(
      (prefix) => symbol.startsWith(prefix) && symbol.length > 3,
    );

    if (hasVaultPrefix) {
      return true;
    }

    return WalletCoreService.VAULT_SHARE_NAME_MATCHES.some((fragment) =>
      tokenName.includes(fragment),
    );
  }

  private hasReceiptLikeToken(entries: NormalizedTokenAmount[]): boolean {
    return entries.some(
      (entry) =>
        this.isLikelyLendingReceiptToken(entry) ||
        this.isLikelyVaultShareToken(entry),
    );
  }

  private isBaseAssetLike(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);

    return (
      WalletCoreService.BASE_ASSET_SYMBOLS.has(symbol) ||
      this.isPendleBaseOrRestakedAsset(entry)
    );
  }

  private isLikelyRewardToken(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    if (WalletCoreService.REWARD_TOKEN_SYMBOLS.has(symbol)) {
      return true;
    }

    return (
      tokenName.includes('REWARD') ||
      tokenName.includes('INCENTIVE') ||
      tokenName.includes('AIRDROP')
    );
  }

  private hasRewardLikeOutput(entries: NormalizedTokenAmount[]): boolean {
    return entries.some((entry) => this.isLikelyRewardToken(entry));
  }

  private isLikelyBridgeOutWithoutReturn(
    transaction: NormalizedTransaction,
  ): boolean {
    if (transaction.inputs.length === 0 || transaction.outputs.length > 0) {
      return false;
    }

    if (!transaction.to || this.isZeroAddress(transaction.to)) {
      return false;
    }

    return transaction.inputs.some((entry) => this.isBaseAssetLike(entry));
  }

  private isPendleBaseOrRestakedAsset(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    if (WalletCoreService.PENDLE_BASE_OR_RESTAKED_SYMBOLS.has(symbol)) {
      return true;
    }

    return WalletCoreService.PENDLE_BASE_OR_RESTAKED_NAME_MATCHES.some((fragment) =>
      tokenName.includes(fragment),
    );
  }

  private hasPendleBaseOrRestakedAsset(
    entries: NormalizedTokenAmount[],
  ): boolean {
    return entries.some((entry) => this.isPendleBaseOrRestakedAsset(entry));
  }

  private getProtocolTransformGroup(entry: NormalizedTokenAmount): string | null {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    const directGroup = WalletCoreService.PROTOCOL_TRANSFORM_GROUPS[symbol];
    if (directGroup) {
      return directGroup;
    }

    for (const matcher of WalletCoreService.PROTOCOL_TRANSFORM_NAME_MATCHES) {
      if (tokenName.includes(matcher.fragment)) {
        return matcher.group;
      }
    }

    if (
      symbol.startsWith('W') &&
      WalletCoreService.PROTOCOL_TRANSFORM_GROUPS[symbol.slice(1)]
    ) {
      return WalletCoreService.PROTOCOL_TRANSFORM_GROUPS[symbol.slice(1)];
    }

    return null;
  }

  private isProtocolTransformPair(
    inputEntry: NormalizedTokenAmount,
    outputEntry: NormalizedTokenAmount,
  ): boolean {
    const inputGroup = this.getProtocolTransformGroup(inputEntry);
    const outputGroup = this.getProtocolTransformGroup(outputEntry);

    if (!inputGroup || !outputGroup || inputGroup !== outputGroup) {
      return false;
    }

    const inputSymbol = this.normalizeTokenSymbol(inputEntry.token);
    const outputSymbol = this.normalizeTokenSymbol(outputEntry.token);

    if (inputSymbol !== outputSymbol) {
      return true;
    }

    const inputContract = inputEntry.contractAddress?.toLowerCase() ?? '';
    const outputContract = outputEntry.contractAddress?.toLowerCase() ?? '';

    return Boolean(
      inputContract && outputContract && inputContract !== outputContract,
    );
  }

  private isStakingBaseAsset(entry: NormalizedTokenAmount): boolean {
    return WalletCoreService.STAKING_BASE_ASSET_SYMBOLS.has(
      this.normalizeTokenSymbol(entry.token),
    );
  }

  private isKnownStakingDerivative(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    if (WalletCoreService.STAKING_DERIVATIVE_SYMBOLS.has(symbol)) {
      return true;
    }

    return WalletCoreService.STAKING_DERIVATIVE_NAME_MATCHES.some((nameFragment) =>
      tokenName.includes(nameFragment),
    );
  }

  private isWrappedStakingDerivative(entry: NormalizedTokenAmount): boolean {
    const symbol = this.normalizeTokenSymbol(entry.token);
    const tokenName = this.normalizeTokenName(entry.tokenName);

    if (WalletCoreService.WRAPPED_STAKING_DERIVATIVE_SYMBOLS.has(symbol)) {
      return true;
    }

    if (
      symbol.startsWith('W') &&
      WalletCoreService.STAKING_DERIVATIVE_SYMBOLS.has(symbol.slice(1))
    ) {
      return true;
    }

    return tokenName.includes('WRAPPED') && this.isKnownStakingDerivative(entry);
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
        const response = await this.callMoralisWithRetry((apiKey) =>
          this.moralisClient.get<MoralisPaginatedResponse<T>>(path, {
            params: {
              chain: 'eth',
              order: 'DESC',
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            headers: this.buildMoralisHeaders(apiKey),
          }),
        );

        const filteredResult = this.applyStopAtBlock(
          response.data.result,
          options?.stopAtBlock,
        );

        items.push(...filteredResult.items);

        if (items.length >= TX_FETCH_LIMIT) {
          const trimmed = items.splice(TX_FETCH_LIMIT);
          this.logger.log(
            `Fetched ${TX_FETCH_LIMIT} transactions, stopping pagination` +
              (trimmed.length > 0 ? ` (trimmed ${trimmed.length} overflow records)` : ''),
          );
          break;
        }

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

  private async callMoralisWithRetry<T>(
    fn: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    this.ensureMoralisApiKey();

    let keyIndex = this.getAvailableKeyIndex(this.activeKeyIndex);

    if (keyIndex === null) {
      this.logger.error('All Moralis API keys exhausted');
      throw new MoralisKeysExhaustedError();
    }

    this.activeKeyIndex = keyIndex;
    let hasRetriedTransientError = false;

    while (true) {
      const apiKey = this.getMoralisApiKey(keyIndex);

      try {
        return await fn(apiKey);
      } catch (error) {
        if (this.isMoralisQuotaExhausted(error)) {
          this.markKeyExhausted(keyIndex);

          const nextKeyIndex = this.getAvailableKeyIndex(keyIndex === 0 ? 1 : 0);

          if (nextKeyIndex !== null && nextKeyIndex !== keyIndex) {
            this.logger.warn(
              `Moralis API key ${keyIndex + 1} exhausted, switching to key ${nextKeyIndex + 1}`,
            );
            this.activeKeyIndex = nextKeyIndex;
            keyIndex = nextKeyIndex;
            hasRetriedTransientError = false;
            continue;
          }

          this.logger.error('All Moralis API keys exhausted');
          throw new MoralisKeysExhaustedError();
        }

        if (!hasRetriedTransientError && this.isMoralisTransientError(error)) {
          hasRetriedTransientError = true;
          this.logger.warn('Moralis failed, retrying once with the same key...');
          await this.delay(WalletCoreService.MORALIS_RETRY_DELAY_MS);
          continue;
        }

        throw error;
      }
    }
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

  private logMoralisRequestFailure(operation: string, error: unknown): void {
    if (error instanceof MoralisKeysExhaustedError) {
      this.logger.error(`${operation} unavailable: All Moralis API keys exhausted`);
      return;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = this.extractMoralisMessage(error);

      this.logger.error(
        `Moralis failed for ${operation} (${status ?? 'NO_RESPONSE'}: ${message})`,
      );
      return;
    }

    this.logger.error(`Moralis failed for ${operation}`);
  }

  private resolveInitialActiveKeyIndex(): number {
    return this.getAvailableKeyIndex(0) ?? 0;
  }

  private getConfiguredMoralisKeyCount(): number {
    return [this.moralisApiKey1, this.moralisApiKey2].filter(
      (apiKey) => apiKey.length > 0,
    ).length;
  }

  private getMoralisApiKey(index: number): string {
    return index === 0 ? this.moralisApiKey1 : this.moralisApiKey2;
  }

  private buildMoralisHeaders(apiKey: string): Record<string, string> {
    return {
      'X-API-Key': apiKey,
    };
  }

  private getAvailableKeyIndex(preferredIndex: number): number | null {
    const orderedIndices = preferredIndex === 1 ? [1, 0] : [0, 1];

    for (const index of orderedIndices) {
      if (!this.getMoralisApiKey(index)) {
        continue;
      }

      if (this.isKeyRecentlyExhausted(index)) {
        continue;
      }

      return index;
    }

    return null;
  }

  private isKeyRecentlyExhausted(index: number): boolean {
    const exhaustedAt = index === 0 ? this.key1ExhaustedAt : this.key2ExhaustedAt;

    if (exhaustedAt === null) {
      return false;
    }

    return Date.now() - exhaustedAt < WalletCoreService.MORALIS_KEY_EXHAUSTED_WINDOW_MS;
  }

  private markKeyExhausted(index: number): void {
    const exhaustedAt = Date.now();

    if (index === 0) {
      this.key1ExhaustedAt = exhaustedAt;
      return;
    }

    this.key2ExhaustedAt = exhaustedAt;
  }

  private isMoralisQuotaExhausted(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 401;
  }

  private isMoralisTransientError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;

    if (status === 429 || (typeof status === 'number' && status >= 500)) {
      return true;
    }

    return (
      !error.response ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT'
    );
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
