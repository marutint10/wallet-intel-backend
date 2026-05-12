import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface LiteTransfer {
  tokenContract: string;
  tokenSymbol: string;
  tokenName: string;
  decimals: number;
  rawAmount: string;
  humanAmount: string;
  from: string;
  to: string;
  direction: 'IN' | 'OUT';
  txHash: string;
  timestamp: number;
  blockNumber: number;
}

export interface LiteTokenBalance {
  contractAddress: string;
  balance: string;
  decimals: number;
  symbol?: string | null;
  name?: string | null;
}

// FAST_MODE B2B holder-intelligence cap.
// We deliberately fetch only the most recent N ERC-20 transfers per wallet
// (no pagination into older history) to keep classification latency low.
// Historical completeness is reserved for the deep wallet-analysis mode.
export const FAST_MODE_TRANSFER_LIMIT = 50;

const ETHERSCAN_CHAIN_ID_MAP: Record<string, string> = {
  ethereum: '1',
  polygon: '137',
};

const ALCHEMY_RPC_MAP: Record<string, string> = {
  base: 'https://base-mainnet.g.alchemy.com/v2',
  bsc: 'https://bnb-mainnet.g.alchemy.com/v2',
};

const ALCHEMY_NETWORK_MAP: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  bsc: 'bnb-mainnet',
  base: 'base-mainnet',
};

interface EtherscanTransferRow {
  contractAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenDecimal?: string;
  value?: string;
  from?: string;
  to?: string;
  hash?: string;
  timeStamp?: string;
  blockNumber?: string;
}

interface EtherscanTokenTxResponse {
  status?: string;
  message?: string;
  result?: EtherscanTransferRow[];
}

interface AlchemyTransfer {
  rawContract?: {
    address?: string;
    decimal?: string;
    value?: string;
  };
  asset?: string;
  value?: number | string;
  from?: string;
  to?: string;
  hash?: string;
  metadata?: {
    blockTimestamp?: string;
  };
  blockNum?: string;
}

interface AlchemyAssetTransfersResponse {
  result?: {
    transfers?: AlchemyTransfer[];
  };
}

interface AlchemyTokenBalanceRow {
  contractAddress?: string;
  tokenBalance?: string;
}

interface AlchemyTokenBalancesResponse {
  result?: {
    tokenBalances?: AlchemyTokenBalanceRow[];
  };
}

interface AlchemyTokenMetadataResponse {
  result?: {
    decimals?: number;
    symbol?: string | null;
    name?: string | null;
  };
}

@Injectable()
export class LiteIngestionService {
  private readonly logger = new Logger(LiteIngestionService.name);

  constructor(private readonly configService: ConfigService) {}

  async getRecentTransfers(
    walletAddress: string,
    chain: string,
    limit = 200,
    fastMode = false,
  ): Promise<LiteTransfer[]> {
    const normalizedChain = chain.toLowerCase();

    // FAST_MODE: hard-cap to the most recent FAST_MODE_TRANSFER_LIMIT transfers and
    // never paginate beyond that. This is the B2B holder-intelligence path.
    const effectiveLimit = fastMode
      ? Math.min(limit, FAST_MODE_TRANSFER_LIMIT)
      : limit;

    const started = Date.now();
    let transfers: LiteTransfer[];

    if (ETHERSCAN_CHAIN_ID_MAP[normalizedChain]) {
      transfers = await this.fetchFromEtherscan(
        walletAddress,
        normalizedChain,
        effectiveLimit,
      );
    } else if (ALCHEMY_RPC_MAP[normalizedChain]) {
      transfers = await this.fetchFromAlchemy(
        walletAddress,
        normalizedChain,
        effectiveLimit,
      );
    } else {
      throw new Error(`Unsupported chain for lite ingestion: ${chain}`);
    }

    const elapsedMs = Date.now() - started;
    this.logger.debug(
      `[timing] transfers walletAddress=${walletAddress} chain=${normalizedChain} ` +
        `fastMode=${fastMode} limit=${effectiveLimit} count=${transfers.length} ` +
        `duration_ms=${elapsedMs}`,
    );

    return transfers;
  }

  async getTokenBalances(
    walletAddress: string,
    chain: string,
  ): Promise<LiteTokenBalance[]> {
    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY') ?? '';
    if (!apiKey) {
      this.logger.warn('ALCHEMY_API_KEY is missing; skipping portfolio fetch');
      return [];
    }

    const normalizedChain = chain.toLowerCase();
    const network = ALCHEMY_NETWORK_MAP[normalizedChain];
    if (!network) {
      return [];
    }

    const url = `https://${network}.g.alchemy.com/v2/${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'alchemy_getTokenBalances',
          params: [walletAddress, 'erc20'],
          id: 1,
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `alchemy_getTokenBalances failed for ${walletAddress} on ${normalizedChain}: HTTP ${response.status}`,
        );
        return [];
      }

      const data = (await response.json()) as AlchemyTokenBalancesResponse;
      const balances = data.result?.tokenBalances ?? [];
      const nonZero = balances.filter(
        (balance) =>
          balance.contractAddress &&
          balance.tokenBalance &&
          this.hasPositiveTokenBalance(balance.tokenBalance),
      );

      this.logger.debug(
        `[TokenBalances] ${walletAddress} ${normalizedChain}: raw=${balances.length}, nonZero=${nonZero.length}`,
      );

      const enriched: LiteTokenBalance[] = [];
      let metadataFailures = 0;
      for (const balance of nonZero.slice(0, 50)) {
        const contractAddress = balance.contractAddress?.toLowerCase();
        if (!contractAddress) {
          continue;
        }

        let decimals = 18;
        let symbol: string | null = null;
        let name: string | null = null;

        try {
          const metadataResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'alchemy_getTokenMetadata',
              params: [balance.contractAddress],
              id: 2,
            }),
          });
          if (metadataResponse.ok) {
            const metadataData =
              (await metadataResponse.json()) as AlchemyTokenMetadataResponse;
            const metadata = metadataData.result;
            decimals = metadata?.decimals ?? 18;
            symbol = metadata?.symbol ?? null;
            name = metadata?.name ?? null;
          } else {
            metadataFailures += 1;
          }
        } catch {
          metadataFailures += 1;
        }

        const humanBalance = this.formatUnits(balance.tokenBalance ?? '0', decimals);
        const balanceValue = Number.parseFloat(humanBalance);
        if (!Number.isFinite(balanceValue) || balanceValue <= 0) {
          continue;
        }

        enriched.push({
          contractAddress,
          balance: humanBalance,
          decimals,
          symbol,
          name,
        });
      }

      this.logger.debug(
        `[TokenBalances] ${walletAddress} ${normalizedChain}: enriched=${enriched.length}, metadataFailures=${metadataFailures}`,
      );

      return enriched;
    } catch (err: unknown) {
      this.logger.warn(
        `Portfolio fetch failed for ${walletAddress}: ${this.getErrorMessage(err)}`,
      );
      return [];
    }
  }

  private async fetchFromEtherscan(
    address: string,
    chain: string,
    limit: number,
  ): Promise<LiteTransfer[]> {
    const apiKey = this.configService.get<string>('ETHERSCAN_API_KEY') ?? '';
    const chainId = ETHERSCAN_CHAIN_ID_MAP[chain];

    if (!apiKey) {
      this.logger.warn('ETHERSCAN_API_KEY is missing; returning empty transfers');
      return [];
    }

    const url = new URL('https://api.etherscan.io/v2/api');
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'tokentx');
    url.searchParams.set('address', address);
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('offset', String(limit));
    url.searchParams.set('page', '1');
    url.searchParams.set('chainid', chainId);
    url.searchParams.set('apikey', apiKey);

    try {
      const res = await fetch(url.toString());
      const data = (await res.json()) as EtherscanTokenTxResponse;

      if (data.status !== '1' || !Array.isArray(data.result)) {
        this.logger.warn(
          `Etherscan returned no results for ${address} on ${chain}: ${data.message ?? 'unknown'}`,
        );
        return [];
      }

      const normalizedAddress = address.toLowerCase();

      return data.result.map((tx): LiteTransfer => {
        const decimals = this.parseNumber(tx.tokenDecimal, 18);

        return {
          tokenContract: tx.contractAddress ?? '',
          tokenSymbol: tx.tokenSymbol || '???',
          tokenName: tx.tokenName || 'Unknown',
          decimals,
          rawAmount: tx.value ?? '0',
          humanAmount: this.formatUnits(tx.value ?? '0', decimals),
          from: tx.from ?? '',
          to: tx.to ?? '',
          direction:
            tx.to?.toLowerCase() === normalizedAddress ? 'IN' : 'OUT',
          txHash: tx.hash ?? '',
          timestamp: this.parseNumber(tx.timeStamp, 0),
          blockNumber: this.parseNumber(tx.blockNumber, 0),
        };
      });
    } catch (err: unknown) {
      this.logger.error(
        `Etherscan fetch failed for ${address}: ${this.getErrorMessage(err)}`,
      );
      return [];
    }
  }

  private async fetchFromAlchemy(
    address: string,
    chain: string,
    limit: number,
  ): Promise<LiteTransfer[]> {
    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY') ?? '';

    if (!apiKey) {
      this.logger.warn('ALCHEMY_API_KEY is missing; returning empty transfers');
      return [];
    }

    const baseUrl = `${ALCHEMY_RPC_MAP[chain]}/${apiKey}`;
    const half = Math.max(1, Math.floor(limit / 2));
    const maxCountHex = `0x${half.toString(16)}`;

    const fetchTransfers = async (
      direction: 'from' | 'to',
    ): Promise<AlchemyTransfer[]> => {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [
          {
            ...(direction === 'from'
              ? { fromAddress: address }
              : { toAddress: address }),
            category: ['erc20'],
            order: 'desc',
            maxCount: maxCountHex,
            withMetadata: true,
          },
        ],
      };

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as AlchemyAssetTransfersResponse;
      return data.result?.transfers ?? [];
    };

    try {
      const [outgoing, incoming] = await Promise.all([
        fetchTransfers('from'),
        fetchTransfers('to'),
      ]);

      const all = [...outgoing, ...incoming];

      all.sort(
        (a, b) =>
          this.parseHexNumber(b.blockNum, 0) - this.parseHexNumber(a.blockNum, 0),
      );

      const top = all.slice(0, limit);
      const normalizedAddress = address.toLowerCase();

      return top.map((tx): LiteTransfer => {
        const decimals = this.parseHexNumber(tx.rawContract?.decimal, 18);

        return {
          tokenContract: tx.rawContract?.address ?? '',
          tokenSymbol: tx.asset ?? '???',
          tokenName: tx.asset ?? 'Unknown',
          decimals,
          rawAmount: tx.rawContract?.value ?? '0',
          humanAmount: String(tx.value ?? 0),
          from: tx.from ?? '',
          to: tx.to ?? '',
          direction: tx.to?.toLowerCase() === normalizedAddress ? 'IN' : 'OUT',
          txHash: tx.hash ?? '',
          timestamp: tx.metadata?.blockTimestamp
            ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000)
            : 0,
          blockNumber: this.parseHexNumber(tx.blockNum, 0),
        };
      });
    } catch (err: unknown) {
      this.logger.error(
        `Alchemy fetch failed for ${address} on ${chain}: ${this.getErrorMessage(err)}`,
      );
      return [];
    }
  }

  private formatUnits(value: string, decimals: number): string {
    try {
      const bn = BigInt(value);
      const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
      const divisor = BigInt(10) ** BigInt(safeDecimals);
      const whole = bn / divisor;
      const fraction = bn % divisor;
      if (safeDecimals === 0) {
        return whole.toString();
      }

      const fractionString = fraction
        .toString()
        .padStart(safeDecimals, '0')
        .slice(0, 6)
        .replace(/0+$/, '');

      return fractionString.length > 0
        ? `${whole.toString()}.${fractionString}`
        : whole.toString();
    } catch {
      return '0';
    }
  }

  private hasPositiveTokenBalance(value: string): boolean {
    try {
      return BigInt(value) > 0n;
    } catch {
      return false;
    }
  }

  private parseNumber(value: string | undefined, fallback: number): number {
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseHexNumber(value: string | undefined, fallback: number): number {
    if (!value) {
      return fallback;
    }

    const parsed = value.startsWith('0x')
      ? Number.parseInt(value, 16)
      : Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }
}
