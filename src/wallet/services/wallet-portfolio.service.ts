import { Injectable, Logger } from '@nestjs/common';
import {
  MoralisErc20Balance,
  WalletHoldingItem,
  WalletHoldingsResponse,
  WalletHoldingsUSDResponse,
  WalletNetFlowResponse,
  WalletPortfolioResponse,
  WalletPortfolioUSDResponse,
  WalletTokenFlowResponse,
} from '../wallet.types';
import { WalletCoreService } from './wallet-core.service';
import { WalletPricingService } from './wallet-pricing.service';

interface PortfolioTokenEntry {
  amount: string;
  contractAddress?: string;
}

@Injectable()
export class WalletPortfolioService {
  private readonly logger = new Logger(WalletPortfolioService.name);

  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPricingService: WalletPricingService,
  ) {}

  async getHoldings(address: string): Promise<WalletHoldingsResponse> {
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

    return holdings;
  }

  async getHoldingsWithUSD(
    address: string,
  ): Promise<WalletHoldingsUSDResponse> {
    const holdings = await this.getHoldings(address);
    const { ethPrice, tokenPrices } = await this.fetchHoldingPrices(holdings);
    const holdingsWithUsd = holdings.map((holding) => ({
      holding,
      usdValue: this.computeHoldingUsdValue(holding, ethPrice, tokenPrices),
    }));
    const totalPortfolioValue = holdingsWithUsd.reduce(
      (total, entry) => this.addDecimalStrings(total, entry.usdValue),
      '0',
    );

    return holdingsWithUsd.map(({ holding, usdValue }) => ({
      token: holding.token,
      amount: holding.amount,
      usdValue,
      allocation: this.computeAllocationPercentage(usdValue, totalPortfolioValue),
      decimals: holding.decimals,
      contractAddress: holding.contractAddress,
    }));
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

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
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

  async getPortfolioUSD(
    address: string,
  ): Promise<WalletPortfolioUSDResponse> {
    const portfolio = await this.getPortfolio(address);
    const tokenFlow = await this.getTokenFlow(address);
    const portfolioEntries = Object.fromEntries(
      Object.entries(portfolio).map(([token, entry]) => {
        const normalizedEntry = this.normalizePortfolioEntry(entry);

        return [
          token,
          {
            amount: normalizedEntry.amount,
            contractAddress:
              normalizedEntry.contractAddress ??
              tokenFlow.flow[token]?.contractAddress,
          },
        ];
      }),
    ) as Record<string, PortfolioTokenEntry>;

    const contractAddresses = Array.from(
      new Set(
        Object.values(portfolioEntries)
          .map((entry) => entry.contractAddress?.toLowerCase())
          .filter((address): address is string => Boolean(address)),
      ),
    );

    let priceMap: Record<string, number> = {};
    let ethPrice = 0;

    try {
      [priceMap, ethPrice] = await Promise.all([
        this.walletPricingService.fetchCoinGeckoTokenPrices(contractAddresses),
        this.walletPricingService.fetchEthereumUsdPrice(),
      ]);
    } catch (error) {
      this.logger.warn(
        'CoinGecko pricing failed, returning zero USD values',
        error instanceof Error ? error.stack : undefined,
      );
    }

    return Object.fromEntries(
      Object.entries(portfolioEntries).map(([token, entry]) => {
        const amount = Number(entry.amount);
        const normalizedContractAddress = entry.contractAddress?.toLowerCase();
        const price =
          token.toUpperCase() === 'ETH'
            ? ethPrice
            : normalizedContractAddress
              ? priceMap[normalizedContractAddress] ?? 0
              : 0;
        const usdValue = Number.isFinite(amount) ? amount * price : 0;

        return [
          token,
          {
            amount: entry.amount,
            usd: this.walletPricingService.formatUsdValue(usdValue),
          },
        ];
      }),
    );
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

  private normalizePortfolioEntry(entry: unknown): PortfolioTokenEntry {
    if (typeof entry === 'string') {
      return {
        amount: entry,
      };
    }

    if (typeof entry === 'object' && entry !== null) {
      const portfolioEntry = entry as {
        amount?: unknown;
        contractAddress?: unknown;
      };

      return {
        amount:
          typeof portfolioEntry.amount === 'string'
            ? portfolioEntry.amount
            : '0',
        contractAddress:
          typeof portfolioEntry.contractAddress === 'string'
            ? portfolioEntry.contractAddress
            : undefined,
      };
    }

    return {
      amount: '0',
    };
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

  private async fetchHoldingPrices(
    holdings: WalletHoldingsResponse,
  ): Promise<{ ethPrice: number; tokenPrices: Record<string, number> }> {
    const contractAddresses = Array.from(
      new Set(
        holdings
          .map((holding) => holding.contractAddress?.toLowerCase())
          .filter((address): address is string => Boolean(address)),
      ),
    );

    const [tokenPricesResult, ethPriceResult] = await Promise.allSettled([
      this.walletPricingService.fetchCoinGeckoTokenPrices(contractAddresses),
      this.walletPricingService.fetchEthereumUsdPrice(),
    ]);

    if (tokenPricesResult.status === 'rejected') {
      this.logger.warn(
        'Token pricing failed for holdings valuation, defaulting token usdValue to 0',
        tokenPricesResult.reason instanceof Error
          ? tokenPricesResult.reason.stack
          : undefined,
      );
    }

    if (ethPriceResult.status === 'rejected') {
      this.logger.warn(
        'ETH pricing failed for holdings valuation, defaulting ETH usdValue to 0',
        ethPriceResult.reason instanceof Error
          ? ethPriceResult.reason.stack
          : undefined,
      );
    }

    return {
      tokenPrices:
        tokenPricesResult.status === 'fulfilled' ? tokenPricesResult.value : {},
      ethPrice: ethPriceResult.status === 'fulfilled' ? ethPriceResult.value : 0,
    };
  }

  private computeHoldingUsdValue(
    holding: WalletHoldingItem,
    ethPrice: number,
    tokenPrices: Record<string, number>,
  ): string {
    const price =
      holding.token.toUpperCase() === 'ETH'
        ? ethPrice
        : holding.contractAddress
          ? tokenPrices[holding.contractAddress.toLowerCase()] ?? 0
          : 0;

    if (!Number.isFinite(price) || price <= 0) {
      return '0';
    }

    return this.multiplyDecimalStrings(holding.amount, price.toString());
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
    usdValue: string,
    totalPortfolioValue: string,
  ): string {
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
