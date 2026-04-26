import { Injectable, Logger } from '@nestjs/common';
import {
  Trade,
  WalletPnLResponse,
  WalletSummaryResponse,
} from '../wallet.types';
import { WalletCoreService } from './wallet-core.service';
import { PricedTrade, WalletPricingService } from './wallet-pricing.service';

type FifoBuyLot = { amount: number; price: number; timestamp: number };

export interface CompletedTradeLot {
  token: string;
  buyTimestamp: number;
  sellTimestamp: number;
  amount: number;
  buyPrice: number;
  sellPrice: number;
  costBasis: number;
  proceeds: number;
  pnl: number;
  holdHours: number;
}

export interface RealizedTradeMetrics {
  token: string;
  timestamp: number;
  pnl: number;
  roi: number;
  costBasis: number;
  proceeds: number;
}

interface PricedTradeAnalysis {
  completedTradeLots: CompletedTradeLot[];
  realizedTradeMetrics: RealizedTradeMetrics[];
  realizedPnLByToken: Map<string, number>;
  realizedCostBasisByToken: Map<string, number>;
  sellStatsByToken: Map<
    string,
    { wins: number; losses: number; bestTrade: number; worstTrade: number }
  >;
}

@Injectable()
export class WalletPnlService {
  private readonly logger = new Logger(WalletPnlService.name);

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPricingService: WalletPricingService,
  ) {}

  async getTrades(address: string): Promise<Trade[]> {
    const transactions =
      await this.walletCoreService.getTransactionEntities(address);

    const swapTransactions = transactions
      .filter((transaction) => transaction.type === 'swap')
      .sort(
        (left, right) =>
          left.timestamp.getTime() - right.timestamp.getTime(),
      );

    const trades: Trade[] = [];

    for (const transaction of swapTransactions) {
      const timestamp = this.walletCoreService.toUnixTimestamp(
        transaction.timestamp,
      );

      trades.push(
        ...this.walletCoreService.buildTradesFromEntries(
          transaction.inputs,
          'SELL',
          timestamp,
          {
            transactionHash: transaction.transaction_hash,
            hopIndexOffset: 0,
          },
        ),
      );
      trades.push(
        ...this.walletCoreService.buildTradesFromEntries(
          transaction.outputs,
          'BUY',
          timestamp,
          {
            transactionHash: transaction.transaction_hash,
            hopIndexOffset: transaction.inputs.length,
          },
        ),
      );
    }

    return trades.sort((left, right) => left.timestamp - right.timestamp);
  }

  async getPricedTrades(address: string): Promise<PricedTrade[]> {
    const trades = await this.getTrades(address);

    const externalPriceCache = new Map<string, number>();
    const pricedTrades: PricedTrade[] = trades.map((trade) => ({
      ...trade,
      price: 0,
    }));
    const tradesByTimestamp = new Map<number, PricedTrade[]>();

    for (const trade of pricedTrades) {
      const bucket = tradesByTimestamp.get(trade.timestamp) ?? [];
      bucket.push(trade);
      tradesByTimestamp.set(trade.timestamp, bucket);
    }

    for (const tradesAtTimestamp of tradesByTimestamp.values()) {
      if (tradesAtTimestamp.length !== 2) {
        continue;
      }

      const [firstTrade, secondTrade] = tradesAtTimestamp;

      if (firstTrade.type === secondTrade.type) {
        continue;
      }

      for (const trade of tradesAtTimestamp) {
        const inferredCandidate = this.walletPricingService.getHistoricalPriceCandidate(
          trade.token,
          trade.contractAddress,
          trade.timestamp,
        );

        if (inferredCandidate) {
          trade.price = inferredCandidate.price;
          continue;
        }

        if (
          !this.walletPricingService.isTrustedMajorToken(
            trade.token,
            trade.contractAddress,
          )
        ) {
          continue;
        }

        trade.price = await this.fetchHistoricalTradePriceCached(
          trade,
          externalPriceCache,
        );
      }

      const knownTrade = tradesAtTimestamp.find((trade) => trade.price > 0);
      const unknownTrade = tradesAtTimestamp.find((trade) => trade.price <= 0);

      if (!knownTrade || !unknownTrade) {
        continue;
      }

      const inferenceDecision = this.walletPricingService.tryInferUnknownSidePrice(
        knownTrade,
        knownTrade.price,
        unknownTrade,
        tradesAtTimestamp.length,
      );

      if (!inferenceDecision) {
        continue;
      }

      unknownTrade.price = inferenceDecision.price;
      this.walletPricingService.recordInferredHistoricalPrice(
        unknownTrade.token,
        unknownTrade.contractAddress,
        unknownTrade.timestamp,
        inferenceDecision.price,
        inferenceDecision.confidenceScore,
      );
    }

    for (const trade of pricedTrades) {
      if (trade.price > 0) {
        continue;
      }

      const inferredCandidate = this.walletPricingService.getHistoricalPriceCandidate(
        trade.token,
        trade.contractAddress,
        trade.timestamp,
      );

      if (inferredCandidate) {
        trade.price = inferredCandidate.price;
        continue;
      }

      trade.price = await this.fetchHistoricalTradePriceCached(
        trade,
        externalPriceCache,
      );
    }

    return this.walletPricingService.inferMissingSwapPrices(pricedTrades);
  }

  private async fetchHistoricalTradePriceCached(
    trade: Trade,
    priceCache: Map<string, number>,
  ): Promise<number> {
    const cacheKey = `${trade.contractAddress?.toLowerCase() ?? trade.token.toUpperCase()}-${trade.timestamp}`;
    const cached = priceCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const fetchedPrice = await this.walletPricingService.fetchHistoricalTradePrice(
      trade.token,
      trade.contractAddress,
      trade.timestamp,
    );
    priceCache.set(cacheKey, fetchedPrice);
    return fetchedPrice;
  }

  async getRealizedTradeMetrics(address: string): Promise<RealizedTradeMetrics[]> {
    const pricedTrades = await this.getPricedTrades(address);

    return this.analyzePricedTrades(pricedTrades).realizedTradeMetrics;
  }

  computeMedianRealizedTradeRoi(pricedTrades: PricedTrade[]): number {
    const realizedRois = this.analyzePricedTrades(pricedTrades)
      .realizedTradeMetrics.map((metric) => metric.roi)
      .filter((roi) => Number.isFinite(roi))
      .sort((left, right) => left - right);

    if (realizedRois.length === 0) {
      return 0;
    }

    const middleIndex = Math.floor(realizedRois.length / 2);

    if (realizedRois.length % 2 === 0) {
      return this.roundDecimal(
        (realizedRois[middleIndex - 1] + realizedRois[middleIndex]) / 2,
        4,
      );
    }

    return this.roundDecimal(realizedRois[middleIndex], 4);
  }

  async getCompletedTradeLots(address: string): Promise<CompletedTradeLot[]> {
    const pricedTrades = await this.getPricedTrades(address);

    return this.analyzePricedTrades(pricedTrades).completedTradeLots;
  }

  async getPnL(address: string): Promise<WalletPnLResponse> {
    const pricedTrades = await this.getPricedTrades(address);
    const {
      realizedPnLByToken,
      realizedCostBasisByToken,
      sellStatsByToken,
    } = this.analyzePricedTrades(pricedTrades);

    return Object.fromEntries(
      Array.from(realizedPnLByToken.entries()).map(([token, realizedPnL]) => {
        const costBasis = realizedCostBasisByToken.get(token) ?? 0;
        const sellStats = sellStatsByToken.get(token) ?? {
          wins: 0,
          losses: 0,
          bestTrade: 0,
          worstTrade: 0,
        };
        const totalClosedTrades = sellStats.wins + sellStats.losses;
        const roundedRealizedPnL = this.roundDecimal(realizedPnL);
        const roi =
          costBasis > 0
            ? this.roundDecimal((roundedRealizedPnL / costBasis) * 100)
            : 0;
        const winRate =
          totalClosedTrades > 0
            ? this.roundDecimal((sellStats.wins / totalClosedTrades) * 100)
            : 0;

        return [
          token,
          {
            realizedPnL: roundedRealizedPnL,
            roi,
            winRate,
            bestTrade: this.roundDecimal(sellStats.bestTrade),
            worstTrade: this.roundDecimal(sellStats.worstTrade),
          },
        ];
      }),
    );
  }

  async getWalletSummary(address: string): Promise<WalletSummaryResponse> {
    const walletAddress = address.toLowerCase();
    const [transactions, pnlByToken] = await Promise.all([
      this.walletCoreService.getTransactionEntitiesUnordered(address),
      this.getPnL(address),
    ]);

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

    const pnlEntries = Object.entries(pnlByToken);
    const tokenPerformance = pnlEntries.map(([, metrics]) =>
      this.classifyTokenByRealizedPnl(metrics.realizedPnL),
    );
    const activeTokens = pnlEntries.filter(
      ([, metrics]) =>
        metrics.realizedPnL !== 0 ||
        metrics.bestTrade !== 0 ||
        metrics.worstTrade !== 0 ||
        metrics.winRate !== 0,
    );
    const roiValues = pnlEntries
      .filter(([, metrics]) => metrics.realizedPnL !== 0)
      .map(([, metrics]) => metrics.roi)
      .filter((roi) => Number.isFinite(roi));
    const winRateValues = activeTokens.map(([, metrics]) => metrics.winRate);
    const bestTradeCandidates = activeTokens.map(
      ([, metrics]) => metrics.bestTrade,
    );
    const worstTradeCandidates = activeTokens.map(
      ([, metrics]) => metrics.worstTrade,
    );
    const totalRealizedPnL = this.roundDecimal(
      pnlEntries.reduce(
        (total, [, metrics]) => total + metrics.realizedPnL,
        0,
      ),
    );
    const avgROI =
      roiValues.length > 0
        ? this.roundDecimal(
            roiValues.reduce((total, value) => total + value, 0) /
              roiValues.length,
          )
        : 0;
    const avgWinRate =
      winRateValues.length > 0
        ? this.roundDecimal(
            winRateValues.reduce((total, value) => total + value, 0) /
              winRateValues.length,
          )
        : 0;
    const bestTrade =
      bestTradeCandidates.length > 0
        ? this.roundDecimal(Math.max(...bestTradeCandidates))
        : 0;
    const worstTrade =
      worstTradeCandidates.length > 0
        ? this.roundDecimal(Math.min(...worstTradeCandidates))
        : 0;
    const profitableTokens = tokenPerformance.filter(
      (classification) => classification === 'profit',
    ).length;
    const losingTokens = tokenPerformance.filter(
      (classification) => classification === 'loss',
    ).length;
    const totalTradedTokens = tokenPerformance.length;

    if (profitableTokens + losingTokens > totalTradedTokens) {
      this.logger.warn(
        `Wallet summary token counts exceeded traded token count for ${walletAddress}`,
      );
    }

    return {
      address: walletAddress,
      total_transactions: transactions.length,
      total_swaps: totalSwaps,
      total_transfers: totalTransfers,
      tokens_interacted: tokenSet.size,
      totalRealizedPnL,
      avgROI,
      avgWinRate,
      bestTrade,
      worstTrade,
      profitableTokens,
      losingTokens,
    };
  }

  private classifyTokenByRealizedPnl(
    realizedPnl: number,
  ): 'profit' | 'loss' | 'neutral' {
    if (realizedPnl > 0) {
      return 'profit';
    }

    if (realizedPnl < 0) {
      return 'loss';
    }

    return 'neutral';
  }

  private isValidTradePrice(price: number): boolean {
    return Number.isFinite(price) && price >= 0;
  }

  private analyzePricedTrades(pricedTrades: PricedTrade[]): PricedTradeAnalysis {
    const sortedTrades = [...pricedTrades].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const buyQueues = new Map<string, FifoBuyLot[]>();
    const completedTradeLots: CompletedTradeLot[] = [];
    const realizedTradeMetrics: RealizedTradeMetrics[] = [];
    const realizedPnLByToken = new Map<string, number>();
    const realizedCostBasisByToken = new Map<string, number>();
    const sellStatsByToken = new Map<
      string,
      { wins: number; losses: number; bestTrade: number; worstTrade: number }
    >();

    for (const trade of sortedTrades) {
      if (!realizedPnLByToken.has(trade.token)) {
        realizedPnLByToken.set(trade.token, 0);
      }

      if (!realizedCostBasisByToken.has(trade.token)) {
        realizedCostBasisByToken.set(trade.token, 0);
      }

      if (!sellStatsByToken.has(trade.token)) {
        sellStatsByToken.set(trade.token, {
          wins: 0,
          losses: 0,
          bestTrade: 0,
          worstTrade: 0,
        });
      }

      const amount = this.walletPricingService.parsePositiveNumber(
        trade.amount,
      );

      if (amount === null || !this.isValidTradePrice(trade.price)) {
        continue;
      }

      const queue = buyQueues.get(trade.token) ?? [];

      if (trade.type === 'BUY') {
        queue.push({
          amount,
          price: trade.price,
          timestamp: trade.timestamp,
        });
        buyQueues.set(trade.token, queue);
        continue;
      }

      let sellAmount = amount;
      let sellPnL = 0;
      let sellCostBasis = 0;
      let sellProceeds = 0;
      let matchedAnyLots = false;

      while (sellAmount > 0 && queue.length > 0) {
        const oldestBuy = queue[0];
        const matchedAmount = Math.min(sellAmount, oldestBuy.amount);
        const currentPnL = realizedPnLByToken.get(trade.token) ?? 0;
        const currentCostBasis =
          realizedCostBasisByToken.get(trade.token) ?? 0;
        const matchedPnL = (trade.price - oldestBuy.price) * matchedAmount;
        const matchedCostBasis = oldestBuy.price * matchedAmount;
        const matchedProceeds = trade.price * matchedAmount;

        sellPnL = this.roundDecimal(sellPnL + matchedPnL);
        sellCostBasis = this.roundDecimal(sellCostBasis + matchedCostBasis);
        sellProceeds = this.roundDecimal(sellProceeds + matchedProceeds);
        matchedAnyLots = true;

        completedTradeLots.push({
          token: trade.token,
          buyTimestamp: oldestBuy.timestamp,
          sellTimestamp: trade.timestamp,
          amount: this.roundDecimal(matchedAmount),
          buyPrice: this.roundDecimal(oldestBuy.price),
          sellPrice: this.roundDecimal(trade.price),
          costBasis: this.roundDecimal(matchedCostBasis),
          proceeds: this.roundDecimal(matchedProceeds),
          pnl: this.roundDecimal(matchedPnL),
          holdHours: this.roundDecimal(
            (trade.timestamp - oldestBuy.timestamp) / 3600,
          ),
        });

        realizedPnLByToken.set(
          trade.token,
          this.roundDecimal(currentPnL + matchedPnL),
        );
        realizedCostBasisByToken.set(
          trade.token,
          this.roundDecimal(currentCostBasis + matchedCostBasis),
        );

        oldestBuy.amount = this.roundDecimal(oldestBuy.amount - matchedAmount);
        sellAmount = this.roundDecimal(sellAmount - matchedAmount);

        if (oldestBuy.amount <= 0) {
          queue.shift();
        }
      }

      if (matchedAnyLots) {
        const sellStats = sellStatsByToken.get(trade.token) ?? {
          wins: 0,
          losses: 0,
          bestTrade: 0,
          worstTrade: 0,
        };

        if (sellPnL > 0) {
          sellStats.wins += 1;
        } else {
          sellStats.losses += 1;
        }

        if (sellStats.wins + sellStats.losses === 1) {
          sellStats.bestTrade = sellPnL;
          sellStats.worstTrade = sellPnL;
        } else {
          sellStats.bestTrade = Math.max(sellStats.bestTrade, sellPnL);
          sellStats.worstTrade = Math.min(sellStats.worstTrade, sellPnL);
        }

        sellStatsByToken.set(trade.token, sellStats);
        realizedTradeMetrics.push({
          token: trade.token,
          timestamp: trade.timestamp,
          pnl: this.roundDecimal(sellPnL),
          roi:
            sellCostBasis > 0
              ? this.roundDecimal((sellPnL / sellCostBasis) * 100)
              : 0,
          costBasis: this.roundDecimal(sellCostBasis),
          proceeds: this.roundDecimal(sellProceeds),
        });
      }

      if (queue.length > 0) {
        buyQueues.set(trade.token, queue);
      }
    }

    return {
      completedTradeLots,
      realizedTradeMetrics,
      realizedPnLByToken,
      realizedCostBasisByToken,
      sellStatsByToken,
    };
  }

  private roundDecimal(value: number, decimals = 12): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }
}
