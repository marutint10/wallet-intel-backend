import { Injectable } from '@nestjs/common';
import {
  Trade,
  WalletActivityMetricsResponse,
  WalletDexMetricsDebugResponse,
  WalletDexMetricsResponse,
  WalletDexMetricsResult,
  WalletHoldTimeBuckets,
  WalletHoldTimeMetricsResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsDebugResponse,
  WalletRiskMetricsResult,
  WalletRiskMetricsResponse,
} from '../wallet.types';
import { DEX_ROUTERS, UNKNOWN_DEX_LABEL } from '../constants/dex-routers';
import {
  RealizedTradeMetrics,
  WalletPnlService,
} from './wallet-pnl.service';
import { WalletCoreService } from './wallet-core.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

interface PortfolioConcentrationSnapshot {
  largestHoldingUsd: string;
  totalPortfolioUsd: string;
  concentrationRisk: number;
}

@Injectable()
export class WalletAnalyticsService {
  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPortfolioService: WalletPortfolioService,
  ) {}

  async getRiskMetrics(
    address: string,
    debug = false,
  ): Promise<WalletRiskMetricsResult> {
    const [realizedTrades, portfolio] = await Promise.all([
      this.walletPnlService.getRealizedTradeMetrics(address),
      this.walletPortfolioService.getPortfolio(address),
    ]);
    const positivePnLTrades = realizedTrades
      .filter((trade) => trade.pnl > 0)
      .map((trade) => this.roundDecimal(trade.pnl));
    const negativePnLTrades = realizedTrades
      .filter((trade) => trade.pnl < 0)
      .map((trade) => this.roundDecimal(trade.pnl));
    const cumulativePnLCurve = this.buildCumulativePnLCurve(realizedTrades);
    const tradeROIs = realizedTrades.map((trade) => this.roundDecimal(trade.roi));
    const concentrationSnapshot = this.computeConcentrationSnapshot(portfolio);

    const metrics: WalletRiskMetricsResponse = {
      profitFactor: this.computeProfitFactorFromValues(
        positivePnLTrades,
        negativePnLTrades,
      ),
      maxDrawdown: this.computeMaxDrawdownFromCurve(cumulativePnLCurve),
      returnStdDev: this.computePopulationStdDev(tradeROIs),
      concentrationRisk: concentrationSnapshot.concentrationRisk,
    };

    if (!debug) {
      return metrics;
    }

    return {
      ...metrics,
      positivePnLTrades,
      negativePnLTrades,
      cumulativePnLCurve,
      tradeROIs,
      largestHoldingUsd: this.toFiniteNumber(
        concentrationSnapshot.largestHoldingUsd,
      ),
      totalPortfolioUsd: this.toFiniteNumber(
        concentrationSnapshot.totalPortfolioUsd,
      ),
    } satisfies WalletRiskMetricsDebugResponse;
  }

  async getHoldTimeMetrics(
    address: string,
  ): Promise<WalletHoldTimeMetricsResponse> {
    const completedTradeLots =
      await this.walletPnlService.getCompletedTradeLots(address);

    if (completedTradeLots.length === 0) {
      return {
        avgHoldHours: 0,
        medianHoldHours: 0,
        holdBuckets: this.createEmptyHoldBuckets(),
      };
    }

    const holdHours = completedTradeLots
      .map((tradeLot) => this.roundDecimal(tradeLot.holdHours))
      .sort((left, right) => left - right);

    const avgHoldHours = this.roundDecimal(
      holdHours.reduce((total, value) => total + value, 0) / holdHours.length,
    );

    return {
      avgHoldHours,
      medianHoldHours: this.computeMedian(holdHours),
      holdBuckets: this.buildHoldBuckets(holdHours),
    };
  }

  async getActivityMetrics(
    address: string,
  ): Promise<WalletActivityMetricsResponse> {
    const trades = await this.walletPnlService.getTrades(address);

    if (trades.length === 0) {
      return {
        tradesPerActiveDay: 0,
        tradesPerLifetimeDay: 0,
        avgTradeGapHours: 0,
        burstinessScore: 0,
        tradingSpanRatio: 0,
      };
    }

    const sortedTrades = [...trades].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const activeTradingDays = this.countActiveTradingDays(sortedTrades);
    const walletAgeDays = this.computeWalletAgeDays(sortedTrades);
    const tradeGapHours = this.buildTradeGapHours(sortedTrades);
    const avgTradeGapHours =
      tradeGapHours.length > 0
        ? this.roundDecimal(
            tradeGapHours.reduce((total, value) => total + value, 0) /
              tradeGapHours.length,
          )
        : 0;
    const tradingSpanRatio = this.computeTradingSpanRatio(sortedTrades);

    return {
      tradesPerActiveDay:
        activeTradingDays > 0
          ? this.roundDecimal(sortedTrades.length / activeTradingDays)
          : 0,
      tradesPerLifetimeDay:
        walletAgeDays > 0
          ? this.roundDecimal(sortedTrades.length / walletAgeDays)
          : 0,
      avgTradeGapHours,
      burstinessScore:
        avgTradeGapHours > 0
          ? this.roundDecimal(
              this.computePopulationStdDev(tradeGapHours) / avgTradeGapHours,
            )
          : 0,
      tradingSpanRatio,
    };
  }

  async getDexMetrics(
    address: string,
    debug = false,
  ): Promise<WalletDexMetricsResult> {
    const transactions = await this.walletCoreService.getTransactionEntities(address);
    const swapTransactions = transactions.filter(
      (transaction) => transaction.type === 'swap',
    );

    if (swapTransactions.length === 0) {
      const emptyMetrics: WalletDexMetricsResponse = {
        tradesPerDex: {},
        primaryDex: null,
        primaryDexShare: 0,
        dexDiversity: 0,
        unknownDexPercent: 0,
      };

      if (!debug) {
        return emptyMetrics;
      }

      return {
        ...emptyMetrics,
        unknownRouterAddresses: [],
      };
    }

    const tradesPerDex = new Map<string, number>();
    const unknownRouterCounts = new Map<string, number>();

    for (const transaction of swapTransactions) {
      const routerAddress = transaction.to_address?.toLowerCase() ?? '';
      const dexName = DEX_ROUTERS[routerAddress] ?? UNKNOWN_DEX_LABEL;

      tradesPerDex.set(dexName, (tradesPerDex.get(dexName) ?? 0) + 1);

      if (dexName === UNKNOWN_DEX_LABEL) {
        unknownRouterCounts.set(
          routerAddress || '(empty)',
          (unknownRouterCounts.get(routerAddress || '(empty)') ?? 0) + 1,
        );
      }
    }

    const tradesPerDexObject = Object.fromEntries(tradesPerDex.entries());
    const primaryDexEntry = Array.from(tradesPerDex.entries()).sort(
      (left, right) => right[1] - left[1],
    )[0] ?? null;
    const unknownTrades = tradesPerDex.get(UNKNOWN_DEX_LABEL) ?? 0;
    const matchedDexNames = Array.from(tradesPerDex.keys()).filter(
      (dexName) => dexName !== UNKNOWN_DEX_LABEL,
    );

    const metrics: WalletDexMetricsResponse = {
      tradesPerDex: tradesPerDexObject,
      primaryDex: primaryDexEntry?.[0] ?? null,
      primaryDexShare: primaryDexEntry
        ? this.roundDecimal((primaryDexEntry[1] / swapTransactions.length) * 100)
        : 0,
      dexDiversity: matchedDexNames.length,
      unknownDexPercent: this.roundDecimal(
        (unknownTrades / swapTransactions.length) * 100,
      ),
    };

    if (!debug) {
      return metrics;
    }

    return {
      ...metrics,
      unknownRouterAddresses: Array.from(unknownRouterCounts.entries())
        .map(([address, count]) => ({ address, count }))
        .sort((left, right) => right.count - left.count),
    };
  }

  private computeProfitFactor(realizedTrades: RealizedTradeMetrics[]): number {
    return this.computeProfitFactorFromValues(
      realizedTrades
        .filter((trade) => trade.pnl > 0)
        .map((trade) => this.roundDecimal(trade.pnl)),
      realizedTrades
        .filter((trade) => trade.pnl < 0)
        .map((trade) => this.roundDecimal(trade.pnl)),
    );
  }

  private computeProfitFactorFromValues(
    positivePnLTrades: number[],
    negativePnLTrades: number[],
  ): number {
    const totalPositivePnl = positivePnLTrades.reduce(
      (total, value) => total + value,
      0,
    );
    const totalNegativePnl = negativePnLTrades.reduce(
      (total, value) => total + Math.abs(value),
      0,
    );

    if (totalNegativePnl === 0) {
      if (totalPositivePnl > 0) {
        return 10;
      }

      return 0;
    }

    return this.roundDecimal(totalPositivePnl / totalNegativePnl);
  }

  private computeMaxDrawdown(realizedTrades: RealizedTradeMetrics[]): number {
    return this.computeMaxDrawdownFromCurve(
      this.buildCumulativePnLCurve(realizedTrades),
    );
  }

  private computeMaxDrawdownFromCurve(cumulativePnLCurve: number[]): number {
    let cumulativePnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;

    for (const point of cumulativePnLCurve) {
      cumulativePnl = this.roundDecimal(point);
      peakPnl = Math.max(peakPnl, cumulativePnl);
      maxDrawdown = Math.max(
        maxDrawdown,
        this.roundDecimal(peakPnl - cumulativePnl),
      );
    }

    return this.roundDecimal(maxDrawdown);
  }

  private buildCumulativePnLCurve(realizedTrades: RealizedTradeMetrics[]): number[] {
    let cumulativePnl = 0;

    return realizedTrades.map((trade) => {
      cumulativePnl = this.roundDecimal(cumulativePnl + trade.pnl);
      return cumulativePnl;
    });
  }

  private computePopulationStdDev(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance =
      values.reduce((total, value) => total + (value - mean) ** 2, 0) /
      values.length;

    return this.roundDecimal(Math.sqrt(variance));
  }

  private computeMedian(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const midpoint = Math.floor(values.length / 2);

    if (values.length % 2 === 1) {
      return this.roundDecimal(values[midpoint]);
    }

    return this.roundDecimal((values[midpoint - 1] + values[midpoint]) / 2);
  }

  private buildHoldBuckets(holdHours: number[]): WalletHoldTimeBuckets {
    const buckets = this.createEmptyHoldBuckets();

    for (const hours of holdHours) {
      if (hours < 1) {
        buckets.under1h += 1;
        continue;
      }

      if (hours < 24) {
        buckets.under24h += 1;
        continue;
      }

      if (hours < 24 * 7) {
        buckets.under7d += 1;
        continue;
      }

      buckets.over7d += 1;
    }

    return buckets;
  }

  private countActiveTradingDays(trades: Trade[]): number {
    return new Set(
      trades.map((trade) => new Date(trade.timestamp * 1000).toISOString().slice(0, 10)),
    ).size;
  }

  private buildTradeGapHours(trades: Trade[]): number[] {
    const gapHours: number[] = [];

    for (let index = 1; index < trades.length; index += 1) {
      gapHours.push(
        this.roundDecimal(
          (trades[index].timestamp - trades[index - 1].timestamp) / 3600,
        ),
      );
    }

    return gapHours;
  }

  private computeTradingSpanRatio(trades: Trade[]): number {
    if (trades.length < 2) {
      return 0;
    }

    const firstTradeTimestamp = trades[0].timestamp;
    const lastTradeTimestamp = trades[trades.length - 1].timestamp;
    const walletAgeSeconds = Math.max(
      Math.floor(Date.now() / 1000) - firstTradeTimestamp,
      0,
    );

    if (walletAgeSeconds === 0) {
      return 0;
    }

    return this.roundDecimal(
      (lastTradeTimestamp - firstTradeTimestamp) / walletAgeSeconds,
    );
  }

  private computeWalletAgeDays(trades: Trade[]): number {
    if (trades.length === 0) {
      return 0;
    }

    const firstTradeTimestamp = trades[0].timestamp;
    const walletAgeSeconds = Math.max(
      Math.floor(Date.now() / 1000) - firstTradeTimestamp,
      0,
    );

    if (walletAgeSeconds === 0) {
      return 0;
    }

    return this.roundDecimal(walletAgeSeconds / (24 * 3600));
  }

  private createEmptyHoldBuckets(): WalletHoldTimeBuckets {
    return {
      under1h: 0,
      under24h: 0,
      under7d: 0,
      over7d: 0,
    };
  }

  private computeConcentrationRisk(portfolio: WalletPortfolioResponse): number {
    return this.computeConcentrationSnapshot(portfolio).concentrationRisk;
  }

  private computeConcentrationSnapshot(
    portfolio: WalletPortfolioResponse,
  ): PortfolioConcentrationSnapshot {
    let largestUsdValue = '0';
    let totalUsdValue = '0';

    for (const holding of portfolio) {
      if (!holding.usdValue) {
        continue;
      }

      totalUsdValue = this.addDecimalStrings(totalUsdValue, holding.usdValue);

      if (this.compareDecimalStrings(holding.usdValue, largestUsdValue) > 0) {
        largestUsdValue = holding.usdValue;
      }
    }

    const concentrationRisk = this.divideDecimalStrings(
      this.multiplyDecimalStrings(largestUsdValue, '100'),
      totalUsdValue,
      8,
    );

    return {
      largestHoldingUsd: largestUsdValue,
      totalPortfolioUsd: totalUsdValue,
      concentrationRisk: concentrationRisk
        ? this.toFiniteNumber(concentrationRisk)
        : 0,
    };
  }

  private multiplyDecimalStrings(left: string, right: string): string {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal || !rightDecimal) {
      return '0';
    }

    if (leftDecimal.value === 0n || rightDecimal.value === 0n) {
      return '0';
    }

    return this.formatScaledInteger(
      leftDecimal.value * rightDecimal.value,
      leftDecimal.scale + rightDecimal.scale,
    );
  }

  private addDecimalStrings(left: string, right: string): string {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal && !rightDecimal) {
      return '0';
    }

    if (!leftDecimal) {
      return rightDecimal
        ? this.formatScaledInteger(rightDecimal.value, rightDecimal.scale)
        : '0';
    }

    if (!rightDecimal) {
      return this.formatScaledInteger(leftDecimal.value, leftDecimal.scale);
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue = leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue = rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    return this.formatScaledInteger(leftValue + rightValue, scale);
  }

  private divideDecimalStrings(
    numerator: string,
    denominator: string,
    precision: number,
  ): string | null {
    const numeratorDecimal = this.parseDecimalString(numerator);
    const denominatorDecimal = this.parseDecimalString(denominator);

    if (
      !numeratorDecimal ||
      !denominatorDecimal ||
      denominatorDecimal.value === 0n
    ) {
      return null;
    }

    const scaledNumerator =
      numeratorDecimal.value *
      10n ** BigInt(denominatorDecimal.scale + Math.max(0, precision));
    const scaledDenominator =
      denominatorDecimal.value * 10n ** BigInt(numeratorDecimal.scale);

    if (scaledDenominator === 0n) {
      return null;
    }

    return this.formatScaledInteger(
      scaledNumerator / scaledDenominator,
      Math.max(0, precision),
    );
  }

  private compareDecimalStrings(left: string, right: string): number {
    const leftDecimal = this.parseDecimalString(left);
    const rightDecimal = this.parseDecimalString(right);

    if (!leftDecimal && !rightDecimal) {
      return 0;
    }

    if (!leftDecimal) {
      return -1;
    }

    if (!rightDecimal) {
      return 1;
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue = leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue = rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    if (leftValue === rightValue) {
      return 0;
    }

    return leftValue > rightValue ? 1 : -1;
  }

  private parseDecimalString(value: string): { value: bigint; scale: number } | null {
    const normalizedValue = this.normalizeDecimalString(value);

    if (!normalizedValue) {
      return null;
    }

    const [wholePart, fractionalPart = ''] = normalizedValue.split('.');

    return {
      value: BigInt(`${wholePart}${fractionalPart}`),
      scale: fractionalPart.length,
    };
  }

  private normalizeDecimalString(value: string): string | null {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    const match = trimmedValue.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/);

    if (!match) {
      return null;
    }

    if (!/[eE]/.test(trimmedValue)) {
      return trimmedValue.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    }

    const [base, exponentValue] = trimmedValue.toLowerCase().split('e');
    const exponent = Number(exponentValue);

    if (!Number.isInteger(exponent)) {
      return null;
    }

    const [wholePart, fractionalPart = ''] = base.split('.');
    const digits = `${wholePart}${fractionalPart}`;
    const decimalIndex = wholePart.length + exponent;

    if (decimalIndex <= 0) {
      return `0.${'0'.repeat(-decimalIndex)}${digits}`.replace(/0+$/, '');
    }

    if (decimalIndex >= digits.length) {
      return `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
    }

    return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`.replace(
      /\.0+$|(\.\d*?)0+$/,
      '$1',
    );
  }

  private formatScaledInteger(value: bigint, scale: number): string {
    if (value === 0n) {
      return '0';
    }

    if (scale === 0) {
      return value.toString();
    }

    const digits = value.toString().padStart(scale + 1, '0');
    const wholePart = digits.slice(0, digits.length - scale);
    const fractionalPart = digits.slice(digits.length - scale).replace(/0+$/, '');

    if (!fractionalPart) {
      return wholePart;
    }

    return `${wholePart}.${fractionalPart}`;
  }

  private toFiniteNumber(value: string): number {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
      return 0;
    }

    return this.roundDecimal(parsedValue);
  }

  private roundDecimal(value: number, decimals = 12): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }
}