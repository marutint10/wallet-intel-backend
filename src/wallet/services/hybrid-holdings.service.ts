import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Contract, Interface, JsonRpcProvider } from 'ethers';
import { DataSource, Repository } from 'typeorm';
import { WalletKnownTokenEntity } from '../entities/wallet-known-token.entity';
import { TransactionEntity } from '../transaction.entity';
import { NormalizedTransaction, WalletHoldingsResponse } from '../wallet.types';
import {
  CHAIN_PROFILES,
  DEFAULT_SUPPORTED_CHAIN,
  SupportedChain,
  buildChainScopedKey,
  getChainProfile,
} from '../../shared/constants/chains';

export interface KnownToken {
  contractAddress: string;
  symbol?: string;
  decimals?: number;
}

interface Multicall3Result {
  success: boolean;
  returnData: string;
}

interface HoldingsCacheEntry {
  data: WalletHoldingsResponse;
  expiresAt: number;
}

interface KnownTokenSnapshot {
  chain: SupportedChain;
  walletAddress: string;
  contractAddress: string;
  symbol?: string;
  decimals?: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
}

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ERC20_INTERFACE = new Interface([
  'function balanceOf(address account) view returns (uint256)',
]);
const MULTICALL3_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
];

@Injectable()
export class HybridHoldingsService {
  private static readonly ERC20_BATCH_SIZE = 150;
  private static readonly HOLDINGS_CACHE_TTL_MS = 5 * 60 * 1000;
  private readonly logger = new Logger(HybridHoldingsService.name);
  private readonly providers = new Map<SupportedChain, JsonRpcProvider>();
  private readonly multicallContracts = new Map<SupportedChain, Contract>();
  private readonly holdingsCache = new Map<string, HoldingsCacheEntry>();

  constructor(
    @InjectRepository(WalletKnownTokenEntity)
    private readonly walletKnownTokenRepo: Repository<WalletKnownTokenEntity>,
    @InjectRepository(TransactionEntity)
    private readonly transactionRepo: Repository<TransactionEntity>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    for (const chain of Object.keys(CHAIN_PROFILES) as SupportedChain[]) {
      const rpcUrl = this.resolveRpcUrl(chain);
      this.logger.debug(`Hybrid holdings RPC configured for ${chain}: ${rpcUrl}`);
      const provider = new JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: true,
      });

      this.providers.set(chain, provider);
      this.multicallContracts.set(
        chain,
        new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider),
      );
    }
  }

  async getHoldings(
    walletAddress: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<WalletHoldingsResponse> {
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const cacheKey = buildChainScopedKey(chain, normalizedWalletAddress);
    const chainProfile = getChainProfile(chain);
    const cachedEntry = this.holdingsCache.get(cacheKey);

    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      this.logger.debug(`Hybrid holdings cache hit for ${cacheKey}`);
      return this.cloneHoldings(cachedEntry.data);
    }

    this.logger.debug(
      `Hybrid holdings cache miss for ${cacheKey}` +
        (cachedEntry ? ' (expired)' : ''),
    );

    try {
      const provider = this.getProvider(chain);
      const [knownTokens, nativeBalance] = await Promise.all([
        this.getKnownTokens(normalizedWalletAddress, chain),
        provider.getBalance(normalizedWalletAddress),
      ]);
      const erc20Balances = await this.getErc20Balances(
        normalizedWalletAddress,
        knownTokens,
        chain,
      );
      const holdings: WalletHoldingsResponse = [];

      if (nativeBalance > 0n) {
        holdings.push({
          token: chainProfile.nativeSymbol,
          amount: this.normalizeAmount(nativeBalance, 18),
          decimals: 18,
        });
      }

      holdings.push(
        ...erc20Balances.map((token) => ({
          token: token.symbol?.trim() || token.contractAddress,
          amount: this.normalizeAmount(token.balance, token.decimals ?? 18),
          contractAddress: token.contractAddress,
          decimals: token.decimals ?? 18,
        })),
      );

      this.holdingsCache.set(cacheKey, {
        data: this.cloneHoldings(holdings),
        expiresAt: Date.now() + HybridHoldingsService.HOLDINGS_CACHE_TTL_MS,
      });
      this.logger.debug(`Hybrid holdings cache refresh for ${cacheKey}`);
      return holdings;
    } catch (error) {
      this.logger.error(
        `Hybrid holdings failed for ${cacheKey}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  clearCache(
    walletAddress: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): void {
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const cacheKey = buildChainScopedKey(chain, normalizedWalletAddress);

    this.holdingsCache.delete(cacheKey);
    this.logger.debug(`Hybrid holdings cache cleared for ${cacheKey}`);
  }

  clearAllCache(): void {
    this.holdingsCache.clear();
    this.logger.debug('Hybrid holdings cache cleared for all wallets');
  }

  async getKnownTokens(
    walletAddress: string,
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<KnownToken[]> {
    const normalizedWalletAddress = walletAddress.toLowerCase();

    try {
      const knownTokens = await this.getKnownTokensFromTable(
        normalizedWalletAddress,
        chain,
      );

      if (knownTokens.length > 0) {
        return knownTokens;
      }

      this.logger.debug(
        `No wallet_known_tokens rows found for ${normalizedWalletAddress}, falling back to transaction scan`,
      );
    } catch (error) {
      this.logger.warn(
        `wallet_known_tokens lookup failed for ${normalizedWalletAddress}, falling back to transaction scan`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    const fallbackTokens = await this.getKnownTokensFromTransactions(
      normalizedWalletAddress,
      chain,
    );

    if (fallbackTokens.length > 0) {
      void this.backfillKnownTokens(normalizedWalletAddress, fallbackTokens, chain);
    }

    return fallbackTokens;
  }

  async syncKnownTokens(
    walletAddress: string,
    transactions: NormalizedTransaction[],
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<void> {
    const snapshots = this.buildKnownTokenSnapshots(walletAddress, transactions, chain);

    if (snapshots.length === 0) {
      return;
    }

    try {
      await this.upsertKnownTokenSnapshots(snapshots);
    } catch (error) {
      this.logger.warn(
        `Failed to sync wallet_known_tokens for ${walletAddress}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async getErc20Balances(
    walletAddress: string,
    tokens: KnownToken[],
    chain: SupportedChain = DEFAULT_SUPPORTED_CHAIN,
  ): Promise<Array<KnownToken & { balance: bigint }>> {
    if (tokens.length === 0) {
      return [];
    }

    try {
      const positiveBalances: Array<KnownToken & { balance: bigint }> = [];
      let successfulCalls = 0;
      const multicallContract = this.getMulticallContract(chain);

      for (const batch of this.chunkArray(tokens, HybridHoldingsService.ERC20_BATCH_SIZE)) {
        const calls = batch.map((token) => ({
          target: token.contractAddress,
          allowFailure: true,
          callData: ERC20_INTERFACE.encodeFunctionData('balanceOf', [walletAddress]),
        }));
        const results = (await multicallContract.aggregate3.staticCall(
          calls,
        )) as Multicall3Result[];

        results.forEach((result, index) => {
          if (result?.success) {
            successfulCalls += 1;
          }

          const balance = this.decodeBalance(result);

          if (balance > 0n) {
            positiveBalances.push({
              ...batch[index],
              balance,
            });
          }
        });
      }

      if (successfulCalls === 0) {
        throw new Error('All Multicall3 ERC-20 balance reads failed');
      }

      return positiveBalances;
    } catch (error) {
      this.logger.error(
        `Failed to read ERC-20 balances through Multicall3 for ${walletAddress}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  private chunkArray<T>(items: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {
      return [items];
    }

    const chunks: T[][] = [];

    for (let start = 0; start < items.length; start += chunkSize) {
      chunks.push(items.slice(start, start + chunkSize));
    }

    return chunks;
  }

  private decodeBalance(result?: Multicall3Result): bigint {
    if (!result?.success || !result.returnData || result.returnData === '0x') {
      return 0n;
    }

    try {
      const [decodedBalance] = ERC20_INTERFACE.decodeFunctionResult(
        'balanceOf',
        result.returnData,
      );

      if (typeof decodedBalance === 'bigint') {
        return decodedBalance;
      }

      return BigInt(decodedBalance.toString());
    } catch {
      return 0n;
    }
  }

  private normalizeAmount(rawAmount: bigint, decimals: number): string {
    if (rawAmount === 0n) {
      return '0';
    }

    const safeDecimals =
      Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;

    if (safeDecimals === 0) {
      return rawAmount.toString();
    }

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

  private cloneHoldings(holdings: WalletHoldingsResponse): WalletHoldingsResponse {
    return holdings.map((holding) => ({ ...holding }));
  }

  private async getKnownTokensFromTable(
    walletAddress: string,
    chain: SupportedChain,
  ): Promise<KnownToken[]> {
    const knownTokens = await this.walletKnownTokenRepo.find({
      where: {
        wallet_address: walletAddress,
        chain_id: chain,
      },
      order: {
        last_seen_at: 'DESC',
      },
    });

    return knownTokens.map((token) => ({
      contractAddress: token.contract_address.toLowerCase(),
      symbol:
        typeof token.symbol === 'string' && token.symbol.trim().length > 0
          ? token.symbol.trim()
          : undefined,
      decimals:
        typeof token.decimals === 'number' && Number.isInteger(token.decimals)
          ? token.decimals
          : undefined,
    }));
  }

  private async getKnownTokensFromTransactions(
    walletAddress: string,
    chain: SupportedChain,
  ): Promise<KnownToken[]> {
    const transactionsTable = this.transactionRepo.metadata.tableName;
    const rows = await this.dataSource.query(
      `
        WITH token_entries AS (
          SELECT
            LOWER(entry->>'contractAddress') AS "contractAddress",
            NULLIF(BTRIM(entry->>'token'), '') AS symbol,
            CASE
              WHEN entry ? 'decimals' AND (entry->>'decimals') ~ '^[0-9]+$'
                THEN (entry->>'decimals')::integer
              ELSE NULL
            END AS decimals,
            transaction_row.timestamp AS observed_at
          FROM ${transactionsTable} transaction_row
          CROSS JOIN LATERAL jsonb_array_elements(transaction_row.inputs) AS entry
          WHERE transaction_row.wallet_address = $1
            AND transaction_row.chain_id = $2

          UNION ALL

          SELECT
            LOWER(entry->>'contractAddress') AS "contractAddress",
            NULLIF(BTRIM(entry->>'token'), '') AS symbol,
            CASE
              WHEN entry ? 'decimals' AND (entry->>'decimals') ~ '^[0-9]+$'
                THEN (entry->>'decimals')::integer
              ELSE NULL
            END AS decimals,
            transaction_row.timestamp AS observed_at
          FROM ${transactionsTable} transaction_row
          CROSS JOIN LATERAL jsonb_array_elements(transaction_row.outputs) AS entry
          WHERE transaction_row.wallet_address = $1
            AND transaction_row.chain_id = $2
        )
        SELECT DISTINCT ON ("contractAddress")
          "contractAddress",
          symbol,
          decimals
        FROM token_entries
        WHERE "contractAddress" IS NOT NULL
          AND "contractAddress" <> ''
        ORDER BY
          "contractAddress",
          CASE WHEN decimals IS NULL THEN 1 ELSE 0 END,
          CASE WHEN symbol IS NULL THEN 1 ELSE 0 END,
          observed_at DESC
      `,
      [walletAddress, chain],
    );

    return rows.map((row: Record<string, unknown>) => ({
      contractAddress: String(row.contractAddress).toLowerCase(),
      symbol:
        typeof row.symbol === 'string' && row.symbol.trim().length > 0
          ? row.symbol.trim()
          : undefined,
      decimals:
        typeof row.decimals === 'number'
          ? row.decimals
          : typeof row.decimals === 'string' && row.decimals !== ''
            ? Number(row.decimals)
            : undefined,
    }));
  }

  private async backfillKnownTokens(
    walletAddress: string,
    tokens: KnownToken[],
    chain: SupportedChain,
  ): Promise<void> {
    const now = new Date();
    const snapshots = tokens.map((token) => ({
      chain,
      walletAddress,
      contractAddress: token.contractAddress.toLowerCase(),
      symbol: this.normalizeSymbol(token.symbol),
      decimals: this.normalizeDecimals(token.decimals),
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    }));

    try {
      await this.upsertKnownTokenSnapshots(snapshots);
    } catch (error) {
      this.logger.warn(
        `Failed to backfill wallet_known_tokens for ${walletAddress}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private buildKnownTokenSnapshots(
    walletAddress: string,
    transactions: NormalizedTransaction[],
    chain: SupportedChain,
  ): KnownTokenSnapshot[] {
    const normalizedWalletAddress = walletAddress.toLowerCase();
    const snapshots = new Map<string, KnownTokenSnapshot>();

    for (const transaction of transactions) {
      const observedAt = this.parseObservedAt(transaction.timestamp);

      for (const entry of [...transaction.inputs, ...transaction.outputs]) {
        const contractAddress = entry.contractAddress?.toLowerCase().trim();

        if (!contractAddress) {
          continue;
        }

        const existingSnapshot = snapshots.get(contractAddress);

        if (!existingSnapshot) {
          snapshots.set(contractAddress, {
            chain,
            walletAddress: normalizedWalletAddress,
            contractAddress,
            symbol: this.normalizeSymbol(entry.token),
            decimals: this.normalizeDecimals(entry.decimals),
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
            seenCount: 1,
          });
          continue;
        }

        if (observedAt < existingSnapshot.firstSeenAt) {
          existingSnapshot.firstSeenAt = observedAt;
        }

        if (observedAt > existingSnapshot.lastSeenAt) {
          existingSnapshot.lastSeenAt = observedAt;
        }

        if (!existingSnapshot.symbol) {
          existingSnapshot.symbol = this.normalizeSymbol(entry.token);
        }

        if (existingSnapshot.decimals === undefined) {
          existingSnapshot.decimals = this.normalizeDecimals(entry.decimals);
        }

        existingSnapshot.seenCount += 1;
      }
    }

    return Array.from(snapshots.values());
  }

  private async upsertKnownTokenSnapshots(
    snapshots: KnownTokenSnapshot[],
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const tableName = this.walletKnownTokenRepo.metadata.tableName;

    await this.walletKnownTokenRepo
      .createQueryBuilder()
      .insert()
      .into(WalletKnownTokenEntity)
      .values(
        snapshots.map((snapshot) => ({
          wallet_address: snapshot.walletAddress,
          chain_id: snapshot.chain,
          contract_address: snapshot.contractAddress,
          symbol: snapshot.symbol ?? null,
          decimals: snapshot.decimals ?? null,
          first_seen_at: snapshot.firstSeenAt,
          last_seen_at: snapshot.lastSeenAt,
          seen_count: snapshot.seenCount,
        })),
      )
      .onConflict(`
        ("chain_id", "wallet_address", "contract_address") DO UPDATE SET
          first_seen_at = LEAST(${tableName}.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(${tableName}.last_seen_at, EXCLUDED.last_seen_at),
          symbol = COALESCE(${tableName}.symbol, EXCLUDED.symbol),
          decimals = COALESCE(${tableName}.decimals, EXCLUDED.decimals),
          seen_count = ${tableName}.seen_count + EXCLUDED.seen_count,
          updated_at = NOW()
      `)
      .execute();
  }

  private parseObservedAt(timestamp: string): Date {
    const observedAt = new Date(timestamp);

    if (Number.isNaN(observedAt.getTime())) {
      return new Date();
    }

    return observedAt;
  }

  private normalizeSymbol(symbol: string | undefined): string | undefined {
    if (typeof symbol !== 'string') {
      return undefined;
    }

    const normalizedSymbol = symbol.trim();

    return normalizedSymbol.length > 0 ? normalizedSymbol : undefined;
  }

  private normalizeDecimals(decimals: number | undefined): number | undefined {
    if (typeof decimals !== 'number') {
      return undefined;
    }

    return Number.isInteger(decimals) && decimals >= 0 ? decimals : undefined;
  }

  private resolveRpcUrl(chain: SupportedChain): string {
    const profile = getChainProfile(chain);
    return (
      this.configService.get<string>(`rpc.urls.${chain}`) ??
      process.env[profile.rpcEnvKey] ??
      profile.defaultRpcUrl
    );
  }

  private getProvider(chain: SupportedChain): JsonRpcProvider {
    const provider = this.providers.get(chain);

    if (!provider) {
      throw new Error(`No RPC provider configured for chain ${chain}`);
    }

    return provider;
  }

  private getMulticallContract(chain: SupportedChain): Contract {
    const contract = this.multicallContracts.get(chain);

    if (!contract) {
      throw new Error(`No Multicall3 contract configured for chain ${chain}`);
    }

    return contract;
  }
}