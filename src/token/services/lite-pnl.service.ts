import { Injectable, Logger } from '@nestjs/common';
import { LitePricingService } from './lite-pricing.service';

interface PositionLot {
  token: string;
  amountRemaining: number;
  costBasisUsd: number;
  costPerToken: number;
  timestamp: number;
  txHash: string;
}

export interface RealizedTrade {
  token: string;
  symbol?: string;
  side: 'sell';
  soldAmount: number;
  costBasisUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  roiPercent: number;
  holdDurationHours: number;
  entryTimestamp: number;
  exitTimestamp: number;
  txHash: string;
}

export interface WalletPnlMetrics {
  totalRealizedPnlUsd: number;
  totalInvestedUsd: number;
  totalReturnedUsd: number;
  avgRoiPercent: number;
  medianRoiPercent: number;
  profitableTradeCount: number;
  losingTradeCount: number;
  winRate: number;
  avgHoldDurationHours: number;
  largestWinUsd: number;
  largestLossUsd: number;
  profitFactor: number;
  trades: RealizedTrade[];
}

export interface PnlInputSwap {
  txHash: string;
  timestamp: number;
  soldToken: string;
  soldSymbol?: string;
  soldAmount: number;
  boughtToken: string;
  boughtSymbol?: string;
  boughtAmount: number;
}

const STABLECOINS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0x6b175474e89094c44da98b954eedeac495271d0f',
  '0x4fabb145d64652a948d72533023f6e7a623c7c53',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  '0x55d398326f99059ff775485246999027b3197955',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
]);

@Injectable()
export class LitePnlService {
  private readonly logger = new Logger(LitePnlService.name);

  constructor(private readonly pricing: LitePricingService) {}

  async computePnl(
    swaps: PnlInputSwap[],
    chain: string,
  ): Promise<WalletPnlMetrics> {
    if (swaps.length === 0) {
      return this.emptyMetrics();
    }

    const sorted = [...swaps].sort((left, right) => left.timestamp - right.timestamp);
    const lots = new Map<string, PositionLot[]>();
    const realizedTrades: RealizedTrade[] = [];

    for (const swap of sorted) {
      const swapUsdValue = await this.estimateSwapUsdValue(swap, chain);
      if (swapUsdValue <= 0) {
        continue;
      }

      const boughtToken = swap.boughtToken.toLowerCase();
      if (!this.isStablecoin(boughtToken) && swap.boughtAmount > 0) {
        if (!lots.has(boughtToken)) {
          lots.set(boughtToken, []);
        }
        lots.get(boughtToken)?.push({
          token: boughtToken,
          amountRemaining: swap.boughtAmount,
          costBasisUsd: swapUsdValue,
          costPerToken: swapUsdValue / swap.boughtAmount,
          timestamp: swap.timestamp,
          txHash: swap.txHash,
        });
      }

      const soldToken = swap.soldToken.toLowerCase();
      if (this.isStablecoin(soldToken) || !lots.has(soldToken)) {
        continue;
      }

      let remainingToSell = swap.soldAmount;
      const tokenLots = lots.get(soldToken) ?? [];
      let totalCostBasis = 0;
      let earliestEntry = swap.timestamp;

      while (remainingToSell > 0 && tokenLots.length > 0) {
        const oldestLot = tokenLots[0];
        earliestEntry = Math.min(earliestEntry, oldestLot.timestamp);

        if (oldestLot.amountRemaining <= remainingToSell) {
          totalCostBasis += oldestLot.costBasisUsd;
          remainingToSell -= oldestLot.amountRemaining;
          tokenLots.shift();
        } else {
          const fraction = remainingToSell / oldestLot.amountRemaining;
          totalCostBasis += oldestLot.costBasisUsd * fraction;
          oldestLot.amountRemaining -= remainingToSell;
          oldestLot.costBasisUsd *= 1 - fraction;
          remainingToSell = 0;
        }
      }

      if (totalCostBasis <= 0) {
        continue;
      }

      const proceedsUsd = swapUsdValue;
      const pnlUsd = proceedsUsd - totalCostBasis;
      const roiPercent = (proceedsUsd / totalCostBasis - 1) * 100;
      const holdDurationHours = (swap.timestamp - earliestEntry) / 3600;

      realizedTrades.push({
        token: soldToken,
        symbol: swap.soldSymbol,
        side: 'sell',
        soldAmount: swap.soldAmount,
        costBasisUsd: this.round(totalCostBasis),
        proceedsUsd: this.round(proceedsUsd),
        pnlUsd: this.round(pnlUsd),
        roiPercent: this.round(roiPercent),
        holdDurationHours: this.round(holdDurationHours),
        entryTimestamp: earliestEntry,
        exitTimestamp: swap.timestamp,
        txHash: swap.txHash,
      });
    }

    return this.aggregateMetrics(realizedTrades);
  }

  private async estimateSwapUsdValue(
    swap: PnlInputSwap,
    chain: string,
  ): Promise<number> {
    const soldToken = swap.soldToken.toLowerCase();
    const boughtToken = swap.boughtToken.toLowerCase();

    if (this.isStablecoin(soldToken)) {
      return swap.soldAmount;
    }
    if (this.isStablecoin(boughtToken)) {
      return swap.boughtAmount;
    }

    try {
      const price = await this.pricing.getTokenPrice(soldToken, chain);
      return swap.soldAmount * price.priceUsd;
    } catch (err: unknown) {
      this.logger.warn(
        `PnL price estimate failed for ${soldToken}: ${this.getErrorMessage(err)}`,
      );
      return 0;
    }
  }

  private aggregateMetrics(trades: RealizedTrade[]): WalletPnlMetrics {
    if (trades.length === 0) {
      return this.emptyMetrics();
    }

    const pnls = trades.map((trade) => trade.pnlUsd);
    const rois = trades.map((trade) => trade.roiPercent);
    const holds = trades.map((trade) => trade.holdDurationHours);
    const profitable = trades.filter((trade) => trade.pnlUsd > 0);
    const losing = trades.filter((trade) => trade.pnlUsd < 0);
    const grossProfit = profitable.reduce((sum, trade) => sum + trade.pnlUsd, 0);
    const grossLoss = Math.abs(losing.reduce((sum, trade) => sum + trade.pnlUsd, 0));

    return {
      totalRealizedPnlUsd: this.round(pnls.reduce((sum, pnl) => sum + pnl, 0)),
      totalInvestedUsd: this.round(
        trades.reduce((sum, trade) => sum + trade.costBasisUsd, 0),
      ),
      totalReturnedUsd: this.round(
        trades.reduce((sum, trade) => sum + trade.proceedsUsd, 0),
      ),
      avgRoiPercent: this.round(
        rois.reduce((sum, roi) => sum + roi, 0) / rois.length,
      ),
      medianRoiPercent: this.round(this.median(rois)),
      profitableTradeCount: profitable.length,
      losingTradeCount: losing.length,
      winRate: this.round((profitable.length / trades.length) * 100),
      avgHoldDurationHours: this.round(
        holds.reduce((sum, hold) => sum + hold, 0) / holds.length,
      ),
      largestWinUsd: this.round(Math.max(0, ...pnls)),
      largestLossUsd: this.round(Math.min(0, ...pnls)),
      profitFactor:
        grossLoss > 0
          ? this.round(grossProfit / grossLoss)
          : grossProfit > 0
            ? 10
            : 0,
      trades,
    };
  }

  private emptyMetrics(): WalletPnlMetrics {
    return {
      totalRealizedPnlUsd: 0,
      totalInvestedUsd: 0,
      totalReturnedUsd: 0,
      avgRoiPercent: 0,
      medianRoiPercent: 0,
      profitableTradeCount: 0,
      losingTradeCount: 0,
      winRate: 0,
      avgHoldDurationHours: 0,
      largestWinUsd: 0,
      largestLossUsd: 0,
      profitFactor: 0,
      trades: [],
    };
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private isStablecoin(address: string): boolean {
    return STABLECOINS.has(address.toLowerCase());
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}