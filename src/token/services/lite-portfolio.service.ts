import { Injectable, Logger } from '@nestjs/common';
import { LiteIngestionService } from './lite-ingestion.service';
import { LitePricingService } from './lite-pricing.service';
import {
  TokenCategorySlug,
  classifyTokenCategory,
} from '../constants/token-categories';

// Native gas-token pricing placeholders.
// DexScreener and CoinGecko both recognise these well-known native-token
// proxy addresses on their respective chains.
const NATIVE_TOKEN_PRICE_ADDR: Record<string, string> = {
  ethereum: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  base: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  polygon: '0x0000000000000000000000000000000000001010',
};

export type PortfolioRiskSignal =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'degen';

export interface CategoryAllocations {
  bluechip: number;
  defi: number;
  meme: number;
  ai: number;
  gaming: number;
  infrastructure: number;
  stablecoin: number;
  rwa: number;
  other: number;
}

export interface HoldingsProfile {
  totalPortfolioUsd: number;
  trackedTokenUsd: number;
  trackedTokenWeight: number;
  diversificationScore: number;
  holdingTokenCount: number;
  totalTokenBalances: number;
  pricedTokenCount: number;
  unpricedTokenCount: number;
  categoryAllocations: CategoryAllocations;
  topHoldings: Array<{
    symbol: string;
    contractAddress: string;
    usdValue: number;
    weight: number;
    category: TokenCategorySlug;
  }>;
  portfolioRiskSignal: PortfolioRiskSignal;
}

export interface PortfolioContext extends HoldingsProfile {
  // Backward compatibility for existing consumers.
  holdingCount: number;
}

@Injectable()
export class LitePortfolioService {
  private readonly logger = new Logger(LitePortfolioService.name);

  constructor(
    private readonly ingestion: LiteIngestionService,
    private readonly pricing: LitePricingService,
  ) {}

  async getPortfolioContext(
    walletAddress: string,
    trackedTokenAddress: string,
    trackedTokenUsdValue: number,
    chain: string,
  ): Promise<PortfolioContext | null> {
    try {
      const balances = await this.ingestion.getTokenBalances(walletAddress, chain);
      const normalizedTrackedToken = trackedTokenAddress.toLowerCase();

      // Resolve native gas-token holding (ETH / BNB / POL). This must run AFTER
      // ERC-20 balances are fetched and BEFORE we price the rest of the
      // portfolio so the native bag participates in totals, weights, and the
      // category mix downstream. Pricing failures are tolerated.
      const nativeHolding = await this.resolveNativeHolding(walletAddress, chain);

      // The legacy early-return path triggered when the Alchemy ERC-20 fetch
      // returned empty (e.g. missing API key). We now extend that condition to
      // also require zero native balance, so an ETH-only wallet no longer
      // appears as an empty portfolio.
      if (balances.length === 0 && !nativeHolding) {
        const trackedTokenUsd = this.roundUsd(trackedTokenUsdValue);
        const trackedTokenWeight = trackedTokenUsdValue > 0 ? 100 : 0;
        const categoryAllocations = this.emptyCategoryAllocations();
        const holdingTokenCount = trackedTokenUsdValue > 0 ? 1 : 0;

        return {
          totalPortfolioUsd: trackedTokenUsd,
          trackedTokenUsd,
          trackedTokenWeight,
          diversificationScore: 0,
          holdingTokenCount,
          totalTokenBalances: holdingTokenCount,
          pricedTokenCount: holdingTokenCount,
          unpricedTokenCount: 0,
          holdingCount: holdingTokenCount,
          categoryAllocations,
          topHoldings: [],
          portfolioRiskSignal: this.computePortfolioRiskSignal(categoryAllocations),
        };
      }

      const tokensToPrice = balances
        .filter((balance) => balance.contractAddress !== normalizedTrackedToken)
        .map((balance) => ({ contractAddress: balance.contractAddress, chain }));
      const priceMap = await this.pricing.getBatchPrices(tokensToPrice);

      const holdings: Array<{
        contractAddress: string;
        symbol: string;
        balance: number;
        usdValue: number;
        category: TokenCategorySlug;
        decimals?: number;
        name?: string;
      }> = [];
      let pricedTokenCount = nativeHolding ? 1 : 0;
      let unpricedTokenCount = 0;

      if (nativeHolding) {
        holdings.push(nativeHolding);
      }

      for (const balance of balances) {
        const balanceNum = Number.parseFloat(balance.balance);
        if (!Number.isFinite(balanceNum) || balanceNum <= 0) {
          continue;
        }

        const usdValue =
          balance.contractAddress === normalizedTrackedToken
            ? trackedTokenUsdValue
            : balanceNum *
              (priceMap.get(`${chain.toLowerCase()}:${balance.contractAddress}`) ??
                0);

        if (
          balance.contractAddress !== normalizedTrackedToken &&
          !priceMap.has(`${chain.toLowerCase()}:${balance.contractAddress}`)
        ) {
          unpricedTokenCount += 1;
        }

        if (usdValue < 1 && balance.contractAddress !== normalizedTrackedToken) {
          continue;
        }

        pricedTokenCount += 1;
        holdings.push({
          contractAddress: balance.contractAddress,
          symbol: balance.symbol || 'UNKNOWN',
          balance: balanceNum,
          usdValue: this.roundUsd(usdValue),
          category: classifyTokenCategory(
            balance.contractAddress,
            balance.symbol ?? undefined,
            chain,
          ),
        });
      }

      if (
        trackedTokenUsdValue > 0 &&
        !holdings.some((holding) => holding.contractAddress === normalizedTrackedToken)
      ) {
        pricedTokenCount += 1;
        holdings.push({
          contractAddress: normalizedTrackedToken,
          symbol: 'TRACKED',
          balance: 0,
          usdValue: this.roundUsd(trackedTokenUsdValue),
          category: classifyTokenCategory(normalizedTrackedToken, undefined, chain),
        });
      }

      const otherTotal = holdings
        .filter((holding) => holding.contractAddress !== normalizedTrackedToken)
        .reduce((sum, holding) => sum + holding.usdValue, 0);
      const totalPortfolioUsd = otherTotal + trackedTokenUsdValue;
      const trackedTokenWeight =
        totalPortfolioUsd > 0
          ? Math.round((trackedTokenUsdValue / totalPortfolioUsd) * 10000) / 100
          : 0;

      const categoryTotals = this.emptyCategoryAllocations();
      for (const holding of holdings) {
        categoryTotals[holding.category] += holding.usdValue;
      }
      const categoryAllocations = this.computeCategoryAllocations(
        categoryTotals,
        totalPortfolioUsd,
      );

      const topHoldings = holdings
        .filter((holding) => holding.contractAddress !== normalizedTrackedToken)
        .sort((left, right) => right.usdValue - left.usdValue)
        .slice(0, 5)
        .map((holding) => ({
          symbol: holding.symbol,
          contractAddress: holding.contractAddress,
          usdValue: holding.usdValue,
          weight:
            totalPortfolioUsd > 0
              ? Math.round((holding.usdValue / totalPortfolioUsd) * 10000) / 100
              : 0,
          category: holding.category,
        }));

      const maxWeight = Math.max(
        trackedTokenWeight,
        ...topHoldings.map((holding) => holding.weight),
      );
      const diversificationScore = Math.round(
        Math.max(0, Math.min(100, (1 - maxWeight / 100) * 120)),
      );
      const holdingTokenCount = holdings.length;
      const totalTokenBalances = balances.length + (nativeHolding ? 1 : 0);

      this.logger.debug(
        `Portfolio context for ${walletAddress}: $${this.roundUsd(totalPortfolioUsd)}`,
      );

      return {
        totalPortfolioUsd: this.roundUsd(totalPortfolioUsd),
        trackedTokenUsd: this.roundUsd(trackedTokenUsdValue),
        trackedTokenWeight,
        diversificationScore,
        holdingTokenCount,
        totalTokenBalances,
        pricedTokenCount,
        unpricedTokenCount,
        holdingCount: holdingTokenCount,
        categoryAllocations,
        topHoldings,
        portfolioRiskSignal: this.computePortfolioRiskSignal(categoryAllocations),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Portfolio context failed for ${walletAddress}: ${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  // Returns a priced native-token holding (>= $1) or null. Never throws so
  // portfolio generation degrades gracefully when pricing or RPC are flaky.
  private async resolveNativeHolding(
    walletAddress: string,
    chain: string,
  ): Promise<{
    contractAddress: string;
    symbol: string;
    balance: number;
    usdValue: number;
    category: TokenCategorySlug;
    decimals: number;
    name: string;
  } | null> {
    try {
      const native = await this.ingestion.getNativeBalance(walletAddress, chain);
      if (!native.balanceFormatted || native.balanceFormatted <= 0) {
        return null;
      }

      const priceAddress = NATIVE_TOKEN_PRICE_ADDR[chain.toLowerCase()];
      if (!priceAddress) {
        return null;
      }

      let priceUsd = 0;
      try {
        const priced = await this.pricing.getTokenPrice(priceAddress, chain);
        priceUsd = priced.priceUsd ?? 0;
      } catch (err: unknown) {
        this.logger.debug(
          `Native price fetch failed for ${walletAddress} on ${chain}: ${this.getErrorMessage(err)}`,
        );
        return null;
      }

      const usdValue = native.balanceFormatted * priceUsd;
      if (!Number.isFinite(usdValue) || usdValue < 1) {
        return null;
      }

      this.logger.debug(
        `[portfolio] native holding added wallet=${walletAddress} symbol=${native.symbol} usdValue=${this.roundUsd(usdValue)}`,
      );

      return {
        contractAddress: priceAddress,
        symbol: native.symbol,
        balance: native.balanceFormatted,
        usdValue: this.roundUsd(usdValue),
        category: 'bluechip',
        decimals: 18,
        name: 'Native Token',
      };
    } catch (err: unknown) {
      this.logger.debug(
        `Native holding resolution failed for ${walletAddress}: ${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private emptyCategoryAllocations(): CategoryAllocations {
    return {
      bluechip: 0,
      defi: 0,
      meme: 0,
      ai: 0,
      gaming: 0,
      infrastructure: 0,
      stablecoin: 0,
      rwa: 0,
      other: 0,
    };
  }

  private computeCategoryAllocations(
    categoryTotals: CategoryAllocations,
    totalPortfolioUsd: number,
  ): CategoryAllocations {
    if (totalPortfolioUsd <= 0) {
      return this.emptyCategoryAllocations();
    }

    return {
      bluechip: Math.round((categoryTotals.bluechip / totalPortfolioUsd) * 10000) / 100,
      defi: Math.round((categoryTotals.defi / totalPortfolioUsd) * 10000) / 100,
      meme: Math.round((categoryTotals.meme / totalPortfolioUsd) * 10000) / 100,
      ai: Math.round((categoryTotals.ai / totalPortfolioUsd) * 10000) / 100,
      gaming: Math.round((categoryTotals.gaming / totalPortfolioUsd) * 10000) / 100,
      infrastructure:
        Math.round((categoryTotals.infrastructure / totalPortfolioUsd) * 10000) /
        100,
      stablecoin:
        Math.round((categoryTotals.stablecoin / totalPortfolioUsd) * 10000) / 100,
      rwa: Math.round((categoryTotals.rwa / totalPortfolioUsd) * 10000) / 100,
      other: Math.round((categoryTotals.other / totalPortfolioUsd) * 10000) / 100,
    };
  }

  private computePortfolioRiskSignal(
    categoryAllocations: CategoryAllocations,
  ): PortfolioRiskSignal {
    const { stablecoin, meme, bluechip, defi, ai, gaming } = categoryAllocations;

    if (stablecoin > 40 && meme < 10) {
      return 'conservative';
    }

    if (bluechip + defi + stablecoin > 60 && meme < 20) {
      return 'balanced';
    }

    if (meme > 40 || meme + ai + gaming > 60) {
      return 'degen';
    }

    return 'aggressive';
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }
}