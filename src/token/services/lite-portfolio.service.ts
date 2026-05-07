import { Injectable, Logger } from '@nestjs/common';
import { LiteIngestionService } from './lite-ingestion.service';
import { LitePricingService } from './lite-pricing.service';
import {
  TokenCategorySlug,
  classifyTokenCategory,
} from '../constants/token-categories';

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

      if (balances.length === 0) {
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
      }> = [];

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

        if (usdValue < 1 && balance.contractAddress !== normalizedTrackedToken) {
          continue;
        }

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

      this.logger.debug(
        `Portfolio context for ${walletAddress}: $${this.roundUsd(totalPortfolioUsd)}`,
      );

      return {
        totalPortfolioUsd: this.roundUsd(totalPortfolioUsd),
        trackedTokenUsd: this.roundUsd(trackedTokenUsdValue),
        trackedTokenWeight,
        diversificationScore,
        holdingTokenCount,
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