import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isKnownExchangeAddress,
  lookupKnownExchange,
} from '../constants/known-exchange-addresses';

export type WalletLabel =
  | 'eoa'
  | 'exchange'
  | 'contract'
  | 'lp_pool'
  | 'bridge'
  | 'burn'
  | 'dust';

export interface WalletFilterResult {
  address: string;
  label: WalletLabel;
  labelDetail?: string;
  shouldAnalyze: boolean;
}

const KNOWN_CONTRACTS = new Map<string, string>([
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router'],
  ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router'],
  ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap Universal Router'],
  ['0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', 'SushiSwap Router'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch V5'],
  ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Exchange Proxy'],
  ['0xba12222222228d8ba445958a75a0704d566bf2c8', 'Balancer Vault'],
]);

const BURN_ADDRESSES = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000000000042069420694206',
]);

const ALCHEMY_NETWORK_MAP: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  bsc: 'bnb-mainnet',
  base: 'base-mainnet',
};

@Injectable()
export class WalletFilterService {
  private readonly logger = new Logger(WalletFilterService.name);
  private readonly contractCodeCache = new Map<string, boolean>();

  constructor(private readonly config: ConfigService) {}

  async filterWallet(
    address: string,
    usdValue: number,
    chain: string,
  ): Promise<WalletFilterResult> {
    const normalizedAddress = address.toLowerCase();

    if (BURN_ADDRESSES.has(normalizedAddress)) {
      return {
        address: normalizedAddress,
        label: 'burn',
        labelDetail: 'Burn Address',
        shouldAnalyze: false,
      };
    }

    const exchangeName = lookupKnownExchange(normalizedAddress);
    if (exchangeName) {
      return {
        address: normalizedAddress,
        label: 'exchange',
        labelDetail: exchangeName,
        shouldAnalyze: false,
      };
    }

    const contractName = KNOWN_CONTRACTS.get(normalizedAddress);
    if (contractName) {
      return {
        address: normalizedAddress,
        label: this.toContractLabel(contractName),
        labelDetail: contractName,
        shouldAnalyze: false,
      };
    }

    if (usdValue < 10) {
      return {
        address: normalizedAddress,
        label: 'dust',
        labelDetail: 'Holding below $10',
        shouldAnalyze: false,
      };
    }

    const isContract = await this.isContractAddress(normalizedAddress, chain);
    if (isContract) {
      return {
        address: normalizedAddress,
        label: 'contract',
        shouldAnalyze: false,
      };
    }

    return {
      address: normalizedAddress,
      label: 'eoa',
      shouldAnalyze: true,
    };
  }

  async filterWallets(
    wallets: Array<{ address: string; usdValue: number }>,
    chain: string,
  ): Promise<Map<string, WalletFilterResult>> {
    const results = new Map<string, WalletFilterResult>();
    const alchemyKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    const normalizedChain = chain.toLowerCase();
    const hasNetwork = Boolean(ALCHEMY_NETWORK_MAP[normalizedChain]);
    let codeLookupCount = 0;

    for (const wallet of wallets) {
      const normalizedAddress = wallet.address.toLowerCase();

      if (
        this.shouldCheckCode(normalizedAddress, wallet.usdValue) &&
        !this.contractCodeCache.has(normalizedAddress) &&
        Boolean(alchemyKey) &&
        hasNetwork
      ) {
        if (codeLookupCount > 0) {
          await this.sleep(200);
        }
        codeLookupCount += 1;
      }

      const result = await this.filterWallet(
        wallet.address,
        wallet.usdValue,
        normalizedChain,
      );
      results.set(normalizedAddress, result);
    }

    return results;
  }

  private shouldCheckCode(address: string, usdValue: number): boolean {
    if (BURN_ADDRESSES.has(address)) {
      return false;
    }
    if (isKnownExchangeAddress(address)) {
      return false;
    }
    if (KNOWN_CONTRACTS.has(address)) {
      return false;
    }
    if (usdValue < 10) {
      return false;
    }

    return true;
  }

  private async isContractAddress(address: string, chain: string): Promise<boolean> {
    if (this.contractCodeCache.has(address)) {
      return this.contractCodeCache.get(address) ?? false;
    }

    const alchemyKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    if (!alchemyKey) {
      return false;
    }

    const network = ALCHEMY_NETWORK_MAP[chain.toLowerCase()];
    if (!network) {
      return false;
    }

    try {
      const url = `https://${network}.g.alchemy.com/v2/${alchemyKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getCode',
          params: [address, 'latest'],
          id: 1,
        }),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { result?: string };
      const isContract =
        typeof data.result === 'string' &&
        data.result !== '0x' &&
        data.result !== '0x0';

      this.contractCodeCache.set(address, isContract);
      return isContract;
    } catch (err: unknown) {
      this.logger.warn(
        `eth_getCode failed for ${address} on ${chain}; defaulting to EOA: ${this.getErrorMessage(err)}`,
      );
      return false;
    }
  }

  private toContractLabel(detail: string): WalletLabel {
    const normalizedDetail = detail.toLowerCase();
    if (
      normalizedDetail.includes('pool') ||
      normalizedDetail.includes('pair') ||
      normalizedDetail.includes('lp')
    ) {
      return 'lp_pool';
    }

    if (normalizedDetail.includes('bridge')) {
      return 'bridge';
    }

    return 'contract';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }
}
