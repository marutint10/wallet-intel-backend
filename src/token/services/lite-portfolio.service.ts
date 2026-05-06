import { Injectable, Logger } from '@nestjs/common';
import { LiteIngestionService } from './lite-ingestion.service';
import { LitePricingService } from './lite-pricing.service';

export interface PortfolioContext {
  totalPortfolioUsd: number;
  trackedTokenUsd: number;
  trackedTokenWeight: number;
  holdingCount: number;
  topHoldings: Array<{
    symbol: string;
    contractAddress: string;
    usdValue: number;
    weight: number;
  }>;
  diversificationScore: number;
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
  ): Promise<PortfolioContext> {
    const balances = await this.ingestion.getTokenBalances(walletAddress, chain);
    const normalizedTrackedToken = trackedTokenAddress.toLowerCase();

    if (balances.length === 0) {
      return {
        totalPortfolioUsd: this.roundUsd(trackedTokenUsdValue),
        trackedTokenUsd: this.roundUsd(trackedTokenUsdValue),
        trackedTokenWeight: trackedTokenUsdValue > 0 ? 100 : 0,
        holdingCount: trackedTokenUsdValue > 0 ? 1 : 0,
        topHoldings: [],
        diversificationScore: 0,
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
            (priceMap.get(`${chain.toLowerCase()}:${balance.contractAddress}`) ?? 0);

      if (usdValue < 1 && balance.contractAddress !== normalizedTrackedToken) {
        continue;
      }

      holdings.push({
        contractAddress: balance.contractAddress,
        symbol: balance.symbol || 'UNKNOWN',
        balance: balanceNum,
        usdValue: this.roundUsd(usdValue),
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
      }));

    const maxWeight = Math.max(
      trackedTokenWeight,
      ...topHoldings.map((holding) => holding.weight),
    );
    const diversificationScore = Math.round(
      Math.max(0, Math.min(100, (1 - maxWeight / 100) * 120)),
    );

    this.logger.debug(
      `Portfolio context for ${walletAddress}: $${this.roundUsd(totalPortfolioUsd)}`,
    );

    return {
      totalPortfolioUsd: this.roundUsd(totalPortfolioUsd),
      trackedTokenUsd: this.roundUsd(trackedTokenUsdValue),
      trackedTokenWeight,
      holdingCount: holdings.length,
      topHoldings,
      diversificationScore,
    };
  }

  private roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
  }
}