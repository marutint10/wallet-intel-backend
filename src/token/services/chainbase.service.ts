import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CHAINBASE_CHAIN_MAP: Record<string, string> = {
  ethereum: '1',
  polygon: '137',
  bsc: '56',
  base: '8453',
};

export interface TokenHolder {
  walletAddress: string;
  balance: string;
  rank: number;
}

type ChainbaseHolderRow = {
  wallet_address: string;
  original_amount: string;
};

type ChainbaseTopHoldersResponse = {
  code: number;
  message: string;
  data: ChainbaseHolderRow[];
};

@Injectable()
export class ChainbaseService {
  private readonly logger = new Logger(ChainbaseService.name);

  constructor(private readonly configService: ConfigService) {}

  async getTopHolders(
    contractAddress: string,
    chain: string,
    limit: number = 200,
  ): Promise<{ holders: TokenHolder[]; totalHolders: number }> {
    const apiKey = this.configService.get<string>('CHAINBASE_API_KEY') ?? '';
    const chainId = CHAINBASE_CHAIN_MAP[chain.toLowerCase()];

    if (!chainId) {
      throw new Error(`Unsupported chain for Chainbase: ${chain}`);
    }

    if (apiKey.trim().length === 0) {
      this.logger.warn('CHAINBASE_API_KEY is missing; returning empty holders');
      return { holders: [], totalHolders: 0 };
    }

    const allHolders: TokenHolder[] = [];

    const fetchPage = async (
      page: number,
    ): Promise<{ holders: TokenHolder[]; shouldStop: boolean }> => {
      const url = new URL('https://api.chainbase.online/v1/token/top-holders');
      url.searchParams.set('chain_id', chainId);
      url.searchParams.set('contract_address', contractAddress);
      url.searchParams.set('page', String(page));
      url.searchParams.set('limit', '100');

      try {
        const response = await fetch(url.toString(), {
          headers: { 'x-api-key': apiKey, accept: 'application/json' },
        });

        if (response.status === 429) {
          this.logger.warn('Chainbase rate limit hit');
          return { holders: [], shouldStop: true };
        }

        if (!response.ok) {
          this.logger.warn(
            `[Chainbase] HTTP ${response.status} while fetching top holders page ${page}`,
          );
          return { holders: [], shouldStop: false };
        }

        const payload =
          (await response.json()) as Partial<ChainbaseTopHoldersResponse>;

        if (
          payload.code !== 0 ||
          !Array.isArray(payload.data) ||
          payload.data.length === 0
        ) {
          this.logger.warn(
            `[Chainbase] Empty/invalid top holders response on page ${page}`,
          );
          return { holders: [], shouldStop: false };
        }

        const holders = payload.data.map((item, index): TokenHolder => ({
          walletAddress: item.wallet_address,
          balance: item.original_amount,
          rank: (page - 1) * 100 + index + 1,
        }));

        return { holders, shouldStop: false };
      } catch (error) {
        this.logger.error(
          `[Chainbase] Failed to fetch top holders page ${page}`,
          error instanceof Error ? error.stack : String(error),
        );
        return { holders: [], shouldStop: true };
      }
    };

    const firstPage = await fetchPage(1);
    allHolders.push(...firstPage.holders);

    if (firstPage.shouldStop) {
      return {
        holders: allHolders.slice(0, limit),
        totalHolders: allHolders.length,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const secondPage = await fetchPage(2);
    allHolders.push(...secondPage.holders);

    return {
      holders: allHolders.slice(0, limit),
      totalHolders: allHolders.length,
    };
  }
}
