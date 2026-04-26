import { Injectable, Logger } from '@nestjs/common';
import {
  MoralisErc20Balance,
  NormalizedTokenAmount,
  WalletHoldingItem,
  WalletHoldingsResponse,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPortfolioResponse,
  WalletTokenFlowResponse,
} from '../wallet.types';
import { MoralisKeysExhaustedError, WalletCoreService } from './wallet-core.service';
import { TokenMarketSignal, WalletPricingService } from './wallet-pricing.service';
import { HybridHoldingsService } from './hybrid-holdings.service';
import { WalletPnlService } from './wallet-pnl.service';
import {
  PortfolioTierSignals,
  classifyPortfolioTier,
} from './portfolio-tier.classifier';

interface HoldingLot {
  amount: bigint;
  acquiredAt: Date;
  avgBuyPrice: string | null;
  costBasisType: 'actual' | 'estimated';
}

interface HoldingAnalyticsInfo {
  holdingSince: string | null;
  holdingDays: number | null;
  avgBuyPrice: string | null;
}

interface AlignedHoldingLots {
  lots: HoldingLot[];
  fullyCovered: boolean;
}

interface HoldingsLoadResult {
  holdings: WalletHoldingsResponse;
  balancesAvailable: boolean;
}

export interface PortfolioLoadResult {
  portfolio: WalletPortfolioResponse;
  balancesAvailable: boolean;
}

@Injectable()
export class WalletPortfolioService {
  private readonly logger = new Logger(WalletPortfolioService.name);

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPricingService: WalletPricingService,
    private readonly hybridHoldingsService: HybridHoldingsService,
    private readonly walletPnlService: WalletPnlService,
  ) {}

  async getHoldings(address: string): Promise<WalletHoldingsResponse> {
    const { holdings } = await this.getHoldingsWithAvailability(address);

    return holdings;
  }

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
    const { portfolio } = await this.getPortfolioWithAvailability(address);

    return portfolio;
  }

  async getPortfolioWithAvailability(
    address: string,
  ): Promise<PortfolioLoadResult> {
    const { holdings, balancesAvailable } =
      await this.getHoldingsWithAvailability(address);

    if (!balancesAvailable) {
      return {
        portfolio: [],
        balancesAvailable: false,
      };
    }

    const [{ ethPrice, marketSignalsByContract }, holdingAnalytics, tierSignals] =
      await Promise.all([
        this.fetchHoldingPrices(holdings),
        this.buildHoldingAnalyticsMap(address, holdings),
        this.buildPortfolioTierSignals(address),
      ]);
    const holdingsWithUsd = holdings
      .map((holding) => ({
        holding,
        currentPrice: this.getCurrentHoldingPrice(
          holding,
          ethPrice,
          marketSignalsByContract,
        ),
      }))
      .map(({ holding, currentPrice }) => ({
        holding,
        currentPrice,
        usdValue: this.computeHoldingUsdValue(holding.amount, currentPrice),
      }));
    const totalPortfolioValue = holdingsWithUsd.reduce(
      (total, entry) => this.addDecimalStrings(total, entry.usdValue ?? '0'),
      '0',
    );

    return {
      portfolio: holdingsWithUsd.map(({ holding, currentPrice, usdValue }) => {
        const analytics =
          holdingAnalytics.get(
            this.getHoldingKey(holding.token, holding.contractAddress),
          ) ?? null;
        const priceUnavailable = currentPrice === null;
        const unrealizedPnl = this.computeUnrealizedPnl(
          holding.amount,
          currentPrice,
          analytics?.avgBuyPrice ?? null,
        );
        const allocation = this.computeAllocationPercentage(
          usdValue,
          totalPortfolioValue,
        );
        const tier = classifyPortfolioTier(
          {
            token: holding.token,
            amount: holding.amount,
            usdValue,
            allocation,
            currentPrice,
            priceUnavailable,
            contractAddress: holding.contractAddress,
            isSpoofedMajorSymbol:
              this.walletPricingService.isSpoofedMajorSymbol(
                holding.token,
                holding.contractAddress,
              ),
          },
          tierSignals,
          this.getMarketSignalForHolding(holding, marketSignalsByContract),
        );

        if (tier.displayTier !== 'core') {
          this.logger.debug(
            `Token classified as ${tier.displayTier}: ${holding.token}` +
              (tier.hiddenReason ? ` (${tier.hiddenReason})` : ''),
          );
        }

        return {
          token: holding.token,
          amount: holding.amount,
          usdValue,
          allocation,
          holdingSince: analytics?.holdingSince ?? null,
          holdingDays: analytics?.holdingDays ?? null,
          avgBuyPrice: analytics?.avgBuyPrice ?? null,
          currentPrice,
          pnl: unrealizedPnl,
          roi: this.computeUnrealizedRoi(
            currentPrice,
            analytics?.avgBuyPrice ?? null,
          ),
          priceUnavailable,
          decimals: holding.decimals,
          contractAddress: holding.contractAddress,
          displayTier: tier.displayTier,
          tokenQualityScore: tier.tokenQualityScore,
          tokenQualityLabel: tier.tokenQualityLabel,
          priceSources: tier.priceSources,
          liquidityUsd: tier.liquidityUsd,
          ...(tier.hiddenReason ? { hiddenReason: tier.hiddenReason } : {}),
        };
      }),
      balancesAvailable: true,
    };
  }

  async getLedger(address: string): Promise<WalletLedgerResponse> {
    const tokenFlow = await this.getTokenFlow(address);

    return Object.fromEntries(
      Object.entries(tokenFlow.flow).map(([token, amounts]) => [
        token,
        this.formatHumanReadableBalance(
          BigInt(amounts.in) - BigInt(amounts.out),
          amounts.decimals ?? 18,
        ),
      ]),
    );
  }

  async getTokenFlow(address: string): Promise<WalletTokenFlowResponse> {
    const walletAddress = address.toLowerCase();
    const transactions =
      await this.walletCoreService.getTransactionEntitiesUnordered(address);

    const flow: Record<
      string,
      {
        in: bigint;
        out: bigint;
        decimals?: number;
        contractAddress?: string;
      }
    > = {};

    for (const transaction of transactions) {
      for (const output of transaction.outputs) {
        if (!output.token) {
          continue;
        }

        if (!flow[output.token]) {
          flow[output.token] = {
            in: 0n,
            out: 0n,
            decimals: output.decimals,
            contractAddress: output.contractAddress?.toLowerCase(),
          };
        } else if (
          flow[output.token].decimals === undefined &&
          output.decimals !== undefined
        ) {
          flow[output.token].decimals = output.decimals;
        }

        if (!flow[output.token].contractAddress && output.contractAddress) {
          flow[output.token].contractAddress =
            output.contractAddress.toLowerCase();
        }

        flow[output.token].in += BigInt(output.amount);
      }

      for (const input of transaction.inputs) {
        if (!input.token) {
          continue;
        }

        if (!flow[input.token]) {
          flow[input.token] = {
            in: 0n,
            out: 0n,
            decimals: input.decimals,
            contractAddress: input.contractAddress?.toLowerCase(),
          };
        } else if (
          flow[input.token].decimals === undefined &&
          input.decimals !== undefined
        ) {
          flow[input.token].decimals = input.decimals;
        }

        if (!flow[input.token].contractAddress && input.contractAddress) {
          flow[input.token].contractAddress =
            input.contractAddress.toLowerCase();
        }

        flow[input.token].out += BigInt(input.amount);
      }
    }

    return {
      address: walletAddress,
      flow: Object.fromEntries(
        Object.entries(flow).map(([token, amounts]) => [
          token,
          {
            in: amounts.in.toString(),
            out: amounts.out.toString(),
            decimals: amounts.decimals,
            contractAddress: amounts.contractAddress,
          },
        ]),
      ),
    };
  }

  async getNetFlow(address: string): Promise<WalletNetFlowResponse> {
    const tokenFlow = await this.getTokenFlow(address);

    return Object.fromEntries(
      Object.entries(tokenFlow.flow).map(([token, amounts]) => [
        token,
        (BigInt(amounts.in) - BigInt(amounts.out)).toString(),
      ]),
    );
  }

  private async getHoldingsWithAvailability(
    address: string,
  ): Promise<HoldingsLoadResult> {
    this.logger.log(`Using hybrid holdings source for ${address.toLowerCase()}`);

    try {
      const holdings = await this.hybridHoldingsService.getHoldings(address);

      this.logger.log(
        `Hybrid success for ${address.toLowerCase()} with ${holdings.length} holdings`,
      );

      return {
        holdings,
        balancesAvailable: true,
      };
    } catch (error) {
      this.logger.warn(
        `Hybrid fallback to Moralis for ${address.toLowerCase()}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    try {
      const [nativeBalance, erc20Balances] = await Promise.all([
        this.walletCoreService.getNativeBalance(address),
        this.walletCoreService.getErc20Balances(address),
      ]);

      const holdings: WalletHoldingsResponse = [];
      const nativeRawBalance = this.parseRawAmount(nativeBalance.balance);

      if (nativeRawBalance && nativeRawBalance > 0n) {
        holdings.push({
          token: 'ETH',
          amount: this.formatTokenBalance(nativeRawBalance, 18),
          decimals: 18,
        });
      }

      for (const balance of erc20Balances) {
        const rawAmount = this.parseRawAmount(balance.balance);

        if (!rawAmount || rawAmount === 0n) {
          continue;
        }

        const decimals = this.toSafeDecimals(balance.decimals);

        holdings.push({
          token: this.resolveTokenLabel(balance),
          amount: this.formatTokenBalance(rawAmount, decimals),
          contractAddress: balance.token_address?.toLowerCase(),
          decimals,
        });
      }

      return {
        holdings,
        balancesAvailable: true,
      };
    } catch (error) {
      if (error instanceof MoralisKeysExhaustedError) {
        this.logger.warn(
          'Moralis balances unavailable because all API keys are exhausted; returning empty holdings data',
        );

        return {
          holdings: [],
          balancesAvailable: false,
        };
      }

      throw error;
    }
  }

  private formatHumanReadableBalance(net: bigint, decimals: number): string {
    if (net === 0n) {
      return '0';
    }

    const safeDecimals =
      Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
    const sign = net < 0n ? '-' : '';
    const absoluteNet = net < 0n ? -net : net;

    if (safeDecimals === 0) {
      return `${sign}${absoluteNet.toString()}`;
    }

    const divisor = 10n ** BigInt(safeDecimals);
    const wholePart = absoluteNet / divisor;
    const fractionalPart = absoluteNet % divisor;
    const fractionalString = fractionalPart
      .toString()
      .padStart(safeDecimals, '0')
      .slice(0, 8)
      .replace(/0+$/, '');

    if (!fractionalString) {
      return `${sign}${wholePart.toString()}`;
    }

    return `${sign}${wholePart.toString()}.${fractionalString}`;
  }

  private parseRawAmount(value: unknown): bigint | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private toSafeDecimals(value: unknown): number {
    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }

    return 18;
  }

  private formatTokenBalance(rawAmount: bigint, decimals: number): string {
    if (rawAmount === 0n) {
      return '0';
    }

    const safeDecimals = this.toSafeDecimals(decimals);

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

  private resolveTokenLabel(balance: MoralisErc20Balance): string {
    const symbol = typeof balance.symbol === 'string' ? balance.symbol.trim() : '';

    if (symbol) {
      return symbol;
    }

    const name = typeof balance.name === 'string' ? balance.name.trim() : '';

    if (name) {
      return name;
    }

    return balance.token_address?.toLowerCase() ?? 'UNKNOWN';
  }

  private async buildPortfolioTierSignals(
    address: string,
  ): Promise<PortfolioTierSignals> {
    const [transactions, realizedTrades] = await Promise.all([
      this.walletCoreService.getTransactionEntitiesUnordered(address),
      this.walletPnlService.getRealizedTradeMetrics(address),
    ]);
    const tradedTokens = new Set<string>();
    const recentTradedTokens = new Set<string>();
    const pnlHistoryTokens = new Set<string>();
    const airdropPatternTokens = new Set<string>();
    const transferInByToken = new Map<string, number>();
    const transferOutByToken = new Map<string, number>();
    const recentCutoffTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const transaction of transactions) {
      const transactionTimestamp = transaction.timestamp.getTime();

      if (transaction.type === 'swap') {
        for (const entry of [...transaction.inputs, ...transaction.outputs]) {
          if (!entry.token) {
            continue;
          }

          const tokenKey = this.getTierTokenKey(
            entry.token,
            entry.contractAddress,
          );
          tradedTokens.add(tokenKey);

          if (transactionTimestamp >= recentCutoffTimestamp) {
            recentTradedTokens.add(tokenKey);
          }
        }

        continue;
      }

      if (transaction.type !== 'transfer') {
        continue;
      }

      for (const entry of transaction.outputs) {
        if (!entry.token) {
          continue;
        }

        const tokenKey = this.getTierTokenKey(
          entry.token,
          entry.contractAddress,
        );
        transferInByToken.set(tokenKey, (transferInByToken.get(tokenKey) ?? 0) + 1);
      }

      for (const entry of transaction.inputs) {
        if (!entry.token) {
          continue;
        }

        const tokenKey = this.getTierTokenKey(
          entry.token,
          entry.contractAddress,
        );
        transferOutByToken.set(tokenKey, (transferOutByToken.get(tokenKey) ?? 0) + 1);
      }
    }

    for (const trade of realizedTrades) {
      if (!trade.token) {
        continue;
      }

      pnlHistoryTokens.add(this.getTierTokenKey(trade.token));
    }

    for (const [tokenKey, transferInCount] of transferInByToken.entries()) {
      const transferOutCount = transferOutByToken.get(tokenKey) ?? 0;
      const swapped = tradedTokens.has(tokenKey);

      if (!swapped && transferOutCount === 0 && transferInCount >= 2) {
        airdropPatternTokens.add(tokenKey);
      }
    }

    return {
      tradedTokens,
      recentTradedTokens,
      pnlHistoryTokens,
      airdropPatternTokens,
    };
  }

  private async fetchHoldingPrices(
    holdings: WalletHoldingsResponse,
  ): Promise<{
    ethPrice: number;
    marketSignalsByContract: Record<string, TokenMarketSignal>;
  }> {
    const contractAddresses = Array.from(
      new Set(
        holdings
          .map((holding) => holding.contractAddress?.toLowerCase())
          .filter((address): address is string => Boolean(address)),
      ),
    );

    const [tokenMarketsResult, ethPriceResult] = await Promise.allSettled([
      this.walletPricingService.fetchTokenMarketSignals(contractAddresses),
      this.walletPricingService.fetchEthereumUsdPrice(),
    ]);

    if (tokenMarketsResult.status === 'rejected') {
      this.logger.warn(
        'Token market lookup failed for holdings valuation, affected holdings will expose reduced quality signals',
        tokenMarketsResult.reason instanceof Error
          ? tokenMarketsResult.reason.stack
          : undefined,
      );
    }

    if (ethPriceResult.status === 'rejected') {
      this.logger.warn(
        'ETH pricing failed for holdings valuation, ETH holdings will expose unavailable pricing',
        ethPriceResult.reason instanceof Error
          ? ethPriceResult.reason.stack
          : undefined,
      );
    }

    return {
      marketSignalsByContract:
        tokenMarketsResult.status === 'fulfilled' ? tokenMarketsResult.value : {},
      ethPrice: ethPriceResult.status === 'fulfilled' ? ethPriceResult.value : 0,
    };
  }

  private async buildHoldingAnalyticsMap(
    address: string,
    holdings: WalletHoldingsResponse,
  ): Promise<Map<string, HoldingAnalyticsInfo>> {
    await this.refreshTransactionHistory(address);

    const transactions = await this.walletCoreService.getTransactionEntities(address);
    if (transactions.length === 0) {
      const emptyAnalyticsMap = new Map<string, HoldingAnalyticsInfo>();

      for (const holding of holdings) {
        emptyAnalyticsMap.set(
          this.getHoldingKey(holding.token, holding.contractAddress),
          {
            holdingSince: null,
            holdingDays: null,
            avgBuyPrice: null,
          },
        );
      }

      return emptyAnalyticsMap;
    }

    const lotsByHolding = await this.buildLotsByHoldingKey(transactions);
    const analyticsMap = new Map<string, HoldingAnalyticsInfo>();
    const now = new Date();

    for (const holding of holdings) {
      const holdingKey = this.getHoldingKey(holding.token, holding.contractAddress);
      const rawAmount = this.parseDisplayAmountToRaw(
        holding.amount,
        holding.decimals ?? 18,
      );

      if (rawAmount === null || rawAmount <= 0n) {
        analyticsMap.set(holdingKey, {
          holdingSince: null,
          holdingDays: null,
          avgBuyPrice: null,
        });
        continue;
      }

      const lots = lotsByHolding.get(holdingKey) ?? [];
      const alignedLots = this.alignLotsToCurrentBalance(lots, rawAmount);
      const oldestActiveLot = alignedLots.lots[0];

      if (!oldestActiveLot) {
        analyticsMap.set(holdingKey, {
          holdingSince: null,
          holdingDays: null,
          avgBuyPrice: null,
        });
        continue;
      }

      analyticsMap.set(holdingKey, {
        holdingSince: oldestActiveLot.acquiredAt.toISOString(),
        holdingDays: this.getHoldingDays(oldestActiveLot.acquiredAt, now),
        avgBuyPrice: this.computeAverageBuyPrice(
          alignedLots,
          holding.amount,
          holding.decimals ?? 18,
        ),
      });
    }

    return analyticsMap;
  }

  private async refreshTransactionHistory(address: string): Promise<void> {
    try {
      await this.walletCoreService.getWalletData(address);
    } catch (error) {
      this.logger.warn(
        'Wallet history refresh failed for holdings duration analytics, using stored history only',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private buildLotsByHoldingKey(
    transactions: Array<{
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
      timestamp: Date;
      inputs: NormalizedTokenAmount[];
      outputs: NormalizedTokenAmount[];
    }>,
  ): Promise<Map<string, HoldingLot[]>> {
    const priceCache = new Map<string, string | null>();
    const lotsByHolding = new Map<string, HoldingLot[]>();

    return this.buildHoldingLots(transactions, lotsByHolding, priceCache);
  }

  private async buildHoldingLots(
    transactions: Array<{
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
      timestamp: Date;
      inputs: NormalizedTokenAmount[];
      outputs: NormalizedTokenAmount[];
    }>,
    lotsByHolding: Map<string, HoldingLot[]>,
    priceCache: Map<string, string | null>,
  ): Promise<Map<string, HoldingLot[]>> {
    for (const transaction of transactions) {
      for (const output of transaction.outputs) {
        await this.applyIncomingEntry(
          lotsByHolding,
          output,
          transaction.timestamp,
          transaction.type,
          priceCache,
        );
      }

      for (const input of transaction.inputs) {
        this.applyOutgoingEntry(lotsByHolding, input);
      }
    }

    return lotsByHolding;
  }

  private async applyIncomingEntry(
    lotsByHolding: Map<string, HoldingLot[]>,
    entry: NormalizedTokenAmount,
    timestamp: Date,
    transactionType:
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
      | 'reward_claim',
    priceCache: Map<string, string | null>,
  ): Promise<void> {
    const rawAmount = this.parseRawAmount(entry.amount);

    if (!rawAmount || rawAmount <= 0n) {
      return;
    }

    const holdingKey = this.getHoldingKey(entry.token, entry.contractAddress);
    const lots = lotsByHolding.get(holdingKey) ?? [];

    lots.push({
      amount: rawAmount,
      acquiredAt: timestamp,
      avgBuyPrice:
        await this.getLotAcquisitionPrice(
          entry,
          timestamp,
          transactionType,
          priceCache,
        ),
      costBasisType: transactionType === 'swap' ? 'actual' : 'estimated',
    });

    lotsByHolding.set(holdingKey, lots);
  }

  private applyOutgoingEntry(
    lotsByHolding: Map<string, HoldingLot[]>,
    entry: NormalizedTokenAmount,
  ): void {
    const rawAmount = this.parseRawAmount(entry.amount);

    if (!rawAmount || rawAmount <= 0n) {
      return;
    }

    const holdingKey = this.getHoldingKey(entry.token, entry.contractAddress);
    const lots = lotsByHolding.get(holdingKey) ?? [];
    let remainingAmount = rawAmount;

    while (remainingAmount > 0n && lots.length > 0) {
      const oldestLot = lots[0];

      if (oldestLot.amount > remainingAmount) {
        oldestLot.amount -= remainingAmount;
        remainingAmount = 0n;
        break;
      }

      remainingAmount -= oldestLot.amount;
      lots.shift();
    }

    if (lots.length > 0) {
      lotsByHolding.set(holdingKey, lots);
      return;
    }

    lotsByHolding.delete(holdingKey);
  }

  private alignLotsToCurrentBalance(
    lots: HoldingLot[],
    currentBalance: bigint,
  ): AlignedHoldingLots {
    if (currentBalance <= 0n || lots.length === 0) {
      return {
        lots: [],
        fullyCovered: currentBalance === 0n,
      };
    }

    const trimmedLots = lots.map((lot) => ({
      amount: lot.amount,
      acquiredAt: lot.acquiredAt,
      avgBuyPrice: lot.avgBuyPrice,
      costBasisType: lot.costBasisType,
    }));
    const totalTrackedBalance = trimmedLots.reduce(
      (total, lot) => total + lot.amount,
      0n,
    );

    if (totalTrackedBalance <= currentBalance) {
      return {
        lots: trimmedLots,
        fullyCovered: totalTrackedBalance === currentBalance,
      };
    }

    let excessBalance = totalTrackedBalance - currentBalance;

    while (excessBalance > 0n && trimmedLots.length > 0) {
      const oldestLot = trimmedLots[0];

      if (oldestLot.amount > excessBalance) {
        oldestLot.amount -= excessBalance;
        excessBalance = 0n;
        break;
      }

      excessBalance -= oldestLot.amount;
      trimmedLots.shift();
    }

    return {
      lots: trimmedLots,
      fullyCovered: true,
    };
  }

  private parseDisplayAmountToRaw(
    value: string,
    decimals: number,
  ): bigint | null {
    const parsedValue = this.parseDecimalString(value);

    if (!parsedValue) {
      return null;
    }

    const safeDecimals = this.toSafeDecimals(decimals);

    if (parsedValue.scale > safeDecimals) {
      return null;
    }

    return parsedValue.value * 10n ** BigInt(safeDecimals - parsedValue.scale);
  }

  private getHoldingDays(acquiredAt: Date, now: Date): number {
    const milliseconds = now.getTime() - acquiredAt.getTime();

    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return 0;
    }

    return Math.floor(milliseconds / 86400000);
  }

  private getHoldingKey(token: string, contractAddress?: string): string {
    if (contractAddress) {
      return `contract:${contractAddress.toLowerCase()}`;
    }

    return `symbol:${token.toUpperCase()}`;
  }

  private async getLotAcquisitionPrice(
    entry: NormalizedTokenAmount,
    timestamp: Date,
    transactionType:
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
      | 'reward_claim',
    priceCache: Map<string, string | null>,
  ): Promise<string | null> {
    const cacheKey = `${transactionType}:${this.getHoldingKey(entry.token, entry.contractAddress)}:${timestamp.toISOString()}`;
    const cachedPrice = priceCache.get(cacheKey);

    if (cachedPrice !== undefined) {
      return cachedPrice;
    }

    const unixTimestamp = this.walletCoreService.toUnixTimestamp(timestamp);
    const price =
      transactionType === 'swap'
        ? await this.walletPricingService.fetchHistoricalTradePrice(
            entry.token,
            entry.contractAddress,
            unixTimestamp,
          )
        : await this.walletPricingService.fetchHistoricalMarketPrice(
            entry.token,
            entry.contractAddress,
            unixTimestamp,
          );
    const normalizedPrice =
      Number.isFinite(price) && price > 0
        ? this.normalizeDecimalString(price.toString())
        : null;

    priceCache.set(cacheKey, normalizedPrice);
    return normalizedPrice;
  }

  private computeAverageBuyPrice(
    alignedLots: AlignedHoldingLots,
    currentAmount: string,
    decimals: number,
  ): string | null {
    if (!alignedLots.fullyCovered || alignedLots.lots.length === 0) {
      return null;
    }

    let totalCostBasis = '0';

    for (const lot of alignedLots.lots) {
      if (!lot.avgBuyPrice) {
        return null;
      }

      const lotAmount = this.formatTokenBalance(lot.amount, decimals);
      totalCostBasis = this.addDecimalStrings(
        totalCostBasis,
        this.multiplyDecimalStrings(lotAmount, lot.avgBuyPrice),
      );
    }

    return this.divideDecimalStrings(totalCostBasis, currentAmount, 8);
  }

  private computeHoldingUsdValue(
    amount: string,
    currentPrice: string | null,
  ): string | null {
    if (!currentPrice) {
      return null;
    }

    return this.multiplyDecimalStrings(amount, currentPrice);
  }

  private getCurrentHoldingPrice(
    holding: WalletHoldingItem,
    ethPrice: number,
    marketSignalsByContract: Record<string, TokenMarketSignal>,
  ): string | null {
    const price =
      holding.token.toUpperCase() === 'ETH'
        ? ethPrice
        : holding.contractAddress
          ? marketSignalsByContract[holding.contractAddress.toLowerCase()]?.price ??
            0
          : 0;

    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }

    return this.normalizeDecimalString(price.toString());
  }

  private getTierTokenKey(token: string, contractAddress?: string): string {
    if (contractAddress) {
      return `contract:${contractAddress.toLowerCase()}`;
    }

    return `symbol:${token.toLowerCase()}`;
  }

  private getMarketSignalForHolding(
    holding: WalletHoldingItem,
    marketSignalsByContract: Record<string, TokenMarketSignal>,
  ): TokenMarketSignal | null {
    if (!holding.contractAddress) {
      return null;
    }

    return marketSignalsByContract[holding.contractAddress.toLowerCase()] ?? null;
  }

  private computeUnrealizedPnl(
    amount: string,
    currentPrice: string | null,
    avgBuyPrice: string | null,
  ): string | null {
    if (!currentPrice || !avgBuyPrice) {
      return null;
    }

    const priceDelta = this.subtractDecimalStrings(currentPrice, avgBuyPrice);

    if (priceDelta === null) {
      return null;
    }

    return this.multiplySignedDecimalStrings(amount, priceDelta);
  }

  private computeUnrealizedRoi(
    currentPrice: string | null,
    avgBuyPrice: string | null,
  ): string | null {
    if (!currentPrice || !avgBuyPrice) {
      return null;
    }

    const priceDelta = this.subtractDecimalStrings(currentPrice, avgBuyPrice);

    if (priceDelta === null) {
      return null;
    }

    const ratio = this.divideSignedDecimalStrings(priceDelta, avgBuyPrice, 8);

    if (ratio === null) {
      return null;
    }

    return this.multiplySignedDecimalStrings(ratio, '100');
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
      return rightDecimal ? this.formatScaledInteger(rightDecimal.value, rightDecimal.scale) : '0';
    }

    if (!rightDecimal) {
      return this.formatScaledInteger(leftDecimal.value, leftDecimal.scale);
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue = leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue = rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    return this.formatScaledInteger(leftValue + rightValue, scale);
  }

  private computeAllocationPercentage(
    usdValue: string | null,
    totalPortfolioValue: string,
  ): string {
    if (!usdValue) {
      return '0';
    }

    const usdDecimal = this.parseDecimalString(usdValue);
    const totalDecimal = this.parseDecimalString(totalPortfolioValue);

    if (!usdDecimal || !totalDecimal || usdDecimal.value === 0n || totalDecimal.value === 0n) {
      return '0';
    }

    const precision = 6;
    const scaledNumerator =
      usdDecimal.value * 100n * 10n ** BigInt(totalDecimal.scale + precision);
    const scaledDenominator =
      totalDecimal.value * 10n ** BigInt(usdDecimal.scale);

    if (scaledDenominator === 0n) {
      return '0';
    }

    return this.formatScaledInteger(scaledNumerator / scaledDenominator, precision);
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

  private subtractDecimalStrings(left: string, right: string): string | null {
    const leftDecimal = this.parseSignedDecimalString(left);
    const rightDecimal = this.parseSignedDecimalString(right);

    if (!leftDecimal || !rightDecimal) {
      return null;
    }

    const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftValue =
      leftDecimal.value * 10n ** BigInt(scale - leftDecimal.scale);
    const rightValue =
      rightDecimal.value * 10n ** BigInt(scale - rightDecimal.scale);

    return this.formatSignedScaledInteger(leftValue - rightValue, scale);
  }

  private multiplySignedDecimalStrings(left: string, right: string): string | null {
    const leftDecimal = this.parseSignedDecimalString(left);
    const rightDecimal = this.parseSignedDecimalString(right);

    if (!leftDecimal || !rightDecimal) {
      return null;
    }

    return this.formatSignedScaledInteger(
      leftDecimal.value * rightDecimal.value,
      leftDecimal.scale + rightDecimal.scale,
    );
  }

  private divideSignedDecimalStrings(
    numerator: string,
    denominator: string,
    precision: number,
  ): string | null {
    const numeratorDecimal = this.parseSignedDecimalString(numerator);
    const denominatorDecimal = this.parseSignedDecimalString(denominator);

    if (
      !numeratorDecimal ||
      !denominatorDecimal ||
      denominatorDecimal.value === 0n
    ) {
      return null;
    }

    const sign =
      (numeratorDecimal.value < 0n) !== (denominatorDecimal.value < 0n)
        ? -1n
        : 1n;
    const absoluteNumerator =
      numeratorDecimal.value < 0n
        ? -numeratorDecimal.value
        : numeratorDecimal.value;
    const absoluteDenominator =
      denominatorDecimal.value < 0n
        ? -denominatorDecimal.value
        : denominatorDecimal.value;
    const scaledNumerator =
      absoluteNumerator *
      10n ** BigInt(denominatorDecimal.scale + Math.max(0, precision));
    const scaledDenominator =
      absoluteDenominator * 10n ** BigInt(numeratorDecimal.scale);

    if (scaledDenominator === 0n) {
      return null;
    }

    return this.formatSignedScaledInteger(
      sign * (scaledNumerator / scaledDenominator),
      Math.max(0, precision),
    );
  }

  private parseSignedDecimalString(
    value: string,
  ): { value: bigint; scale: number } | null {
    const normalizedValue = this.normalizeSignedDecimalString(value);

    if (!normalizedValue) {
      return null;
    }

    const sign = normalizedValue.startsWith('-') ? -1n : 1n;
    const unsignedValue = normalizedValue.replace(/^[+-]/, '');
    const [wholePart, fractionalPart = ''] = unsignedValue.split('.');

    return {
      value: sign * BigInt(`${wholePart}${fractionalPart}`),
      scale: fractionalPart.length,
    };
  }

  private normalizeSignedDecimalString(value: string): string | null {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    const signPrefix = trimmedValue.startsWith('-') ? '-' : '';
    const unsignedValue = trimmedValue.replace(/^[+-]/, '');
    const normalizedValue = this.normalizeDecimalString(unsignedValue);

    if (!normalizedValue) {
      return null;
    }

    if (normalizedValue === '0') {
      return '0';
    }

    return signPrefix ? `-${normalizedValue}` : normalizedValue;
  }

  private formatSignedScaledInteger(value: bigint, scale: number): string {
    if (value === 0n) {
      return '0';
    }

    const signPrefix = value < 0n ? '-' : '';
    const absoluteValue = value < 0n ? -value : value;

    return `${signPrefix}${this.formatScaledInteger(absoluteValue, scale)}`;
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
}
