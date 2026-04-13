import { Injectable, Logger } from '@nestjs/common';
import {
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
}
