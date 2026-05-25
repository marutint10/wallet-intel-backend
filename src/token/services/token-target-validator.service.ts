import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEvmAddress } from '../../shared/validators/address.validator';

export type TokenAnalysisAddressType = 'invalid' | 'eoa' | 'contract' | 'erc20';

export type TokenAnalysisTargetKind =
  | 'invalid_address'
  | 'eoa_wallet'
  | 'non_token_contract'
  | 'erc20_token';

export interface TokenAnalysisTargetValidation {
  kind: TokenAnalysisTargetKind;
  addressType: TokenAnalysisAddressType;
  canAnalyze: boolean;
  title: string;
  message: string;
}

const ALCHEMY_NETWORK_MAP: Record<string, string> = {
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet',
  bsc: 'bnb-mainnet',
  base: 'base-mainnet',
};

const DEX_SCREENER_CHAIN_MAP: Record<string, string> = {
  ethereum: 'ethereum',
  polygon: 'polygon',
  bsc: 'bsc',
  base: 'base',
};

const ERC20_TOTAL_SUPPLY_SELECTOR = '0x18160ddd';
const ERC20_DECIMALS_SELECTOR = '0x313ce567';
const ERC20_SYMBOL_SELECTOR = '0x95d89b41';
const UNISWAP_V2_TOKEN0_SELECTOR = '0x0dfe1681';

@Injectable()
export class TokenTargetValidatorService {
  private readonly logger = new Logger(TokenTargetValidatorService.name);
  private readonly bytecodeCache = new Map<string, boolean>();

  constructor(private readonly config: ConfigService) {}

  async validate(
    contractAddress: string,
    chain: string,
  ): Promise<TokenAnalysisTargetValidation> {
    const normalized = contractAddress.trim().toLowerCase();
    const normalizedChain = chain.trim().toLowerCase();

    if (!isEvmAddress(normalized)) {
      return {
        kind: 'invalid_address',
        addressType: 'invalid',
        canAnalyze: false,
        title: 'Invalid address',
        message:
          'Enter a valid EVM token contract address (0x followed by 40 hexadecimal characters).',
      };
    }

    if (!ALCHEMY_NETWORK_MAP[normalizedChain] && !DEX_SCREENER_CHAIN_MAP[normalizedChain]) {
      return {
        kind: 'invalid_address',
        addressType: 'invalid',
        canAnalyze: false,
        title: 'Unsupported chain',
        message: `Chain "${chain}" is not supported for token analysis.`,
      };
    }

    const rpcUrl = this.getRpcUrl(normalizedChain);
    if (rpcUrl) {
      const hasBytecode = await this.hasContractBytecode(rpcUrl, normalized);
      if (!hasBytecode) {
        return this.eoaValidation();
      }

      const erc20Signals = await this.countErc20Signals(rpcUrl, normalized);
      if (erc20Signals >= 2) {
        return this.erc20Validation();
      }

      const token0Response = await this.ethCall(
        rpcUrl,
        normalized,
        UNISWAP_V2_TOKEN0_SELECTOR,
      );
      if (token0Response) {
        return this.nonTokenContractValidation(
          'This address is a liquidity pool or pair contract, not an ERC-20 token.',
        );
      }

      if (erc20Signals >= 1) {
        return this.erc20Validation();
      }
    }

    const dexListed = await this.isListedOnDexScreener(normalized, normalizedChain);
    if (dexListed) {
      return this.erc20Validation();
    }

    if (rpcUrl) {
      return this.nonTokenContractValidation(
        'This address is a smart contract, but it does not expose standard ERC-20 token metadata. Token holder analytics requires an ERC-20 fungible token contract.',
      );
    }

    this.logger.warn(
      `Token target validation skipped on-chain checks for ${normalized} on ${normalizedChain} (no RPC URL). Allowing analysis.`,
    );
    return this.erc20Validation();
  }

  private eoaValidation(): TokenAnalysisTargetValidation {
    return {
      kind: 'eoa_wallet',
      addressType: 'eoa',
      canAnalyze: false,
      title: 'Wallet address (EOA)',
      message:
        'This address is a user wallet (EOA), not an ERC-20 token contract. Paste a fungible token contract address to run holder analytics.',
    };
  }

  private erc20Validation(): TokenAnalysisTargetValidation {
    return {
      kind: 'erc20_token',
      addressType: 'erc20',
      canAnalyze: true,
      title: 'ERC-20 token contract',
      message: 'Address is a token contract eligible for holder analytics.',
    };
  }

  private nonTokenContractValidation(
    detail: string,
  ): TokenAnalysisTargetValidation {
    return {
      kind: 'non_token_contract',
      addressType: 'contract',
      canAnalyze: false,
      title: 'Not a token contract',
      message: `${detail} It cannot be analyzed as a token.`,
    };
  }

  private async hasContractBytecode(rpcUrl: string, address: string): Promise<boolean> {
    const cacheKey = `${rpcUrl}:${address}`;
    if (this.bytecodeCache.has(cacheKey)) {
      return this.bytecodeCache.get(cacheKey) ?? false;
    }

    const code = await this.getCode(rpcUrl, address);
    const hasBytecode = code !== null;
    this.bytecodeCache.set(cacheKey, hasBytecode);
    return hasBytecode;
  }

  private async countErc20Signals(rpcUrl: string, address: string): Promise<number> {
    const [totalSupply, decimals, symbol] = await Promise.all([
      this.ethCall(rpcUrl, address, ERC20_TOTAL_SUPPLY_SELECTOR),
      this.ethCall(rpcUrl, address, ERC20_DECIMALS_SELECTOR),
      this.ethCall(rpcUrl, address, ERC20_SYMBOL_SELECTOR),
    ]);

    let signals = 0;
    if (this.isValidUint256Result(totalSupply)) {
      signals += 1;
    }
    if (this.isValidDecimalsResult(decimals)) {
      signals += 1;
    }
    if (this.isValidAbiStringResult(symbol)) {
      signals += 1;
    }

    return signals;
  }

  private isValidUint256Result(result: string | null): boolean {
    if (!result || result === '0x') {
      return false;
    }

    try {
      return BigInt(result) >= 0n;
    } catch {
      return false;
    }
  }

  private isValidDecimalsResult(result: string | null): boolean {
    if (!result || result.length < 4) {
      return false;
    }

    try {
      const value = Number.parseInt(result.slice(-2), 16);
      return Number.isFinite(value) && value >= 0 && value <= 77;
    } catch {
      return false;
    }
  }

  private isValidAbiStringResult(result: string | null): boolean {
    if (!result || result === '0x' || result.length < 130) {
      return false;
    }

    try {
      const hex = result.slice(2);
      const offset = Number.parseInt(hex.slice(0, 64), 16) * 2;
      const length = Number.parseInt(hex.slice(offset, offset + 64), 16);
      return length > 0 && length <= 64;
    } catch {
      return false;
    }
  }

  private async isListedOnDexScreener(
    contractAddress: string,
    chain: string,
  ): Promise<boolean> {
    const dexChain = DEX_SCREENER_CHAIN_MAP[chain];
    if (!dexChain) {
      return false;
    }

    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) {
        return false;
      }

      const payload = (await response.json()) as {
        pairs?: Array<{ chainId?: string }>;
      };
      const pairs = payload.pairs ?? [];
      return pairs.some(
        (pair) => (pair.chainId ?? '').toLowerCase() === dexChain.toLowerCase(),
      );
    } catch (err: unknown) {
      this.logger.warn(
        `DexScreener lookup failed for ${contractAddress}: ${this.getErrorMessage(err)}`,
      );
      return false;
    }
  }

  private getRpcUrl(chain: string): string | null {
    const apiKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    if (apiKey.trim().length === 0) {
      return null;
    }

    const network = ALCHEMY_NETWORK_MAP[chain];
    return network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : null;
  }

  private async getCode(rpcUrl: string, address: string): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getCode',
          params: [address, 'latest'],
          id: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as { result?: string };
      if (!payload.result || payload.result === '0x' || payload.result === '0x0') {
        return null;
      }

      return payload.result;
    } catch (err: unknown) {
      this.logger.warn(`eth_getCode failed: ${this.getErrorMessage(err)}`);
      return null;
    }
  }

  private async ethCall(
    rpcUrl: string,
    to: string,
    data: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
          id: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as { result?: string };
      return typeof payload.result === 'string' && payload.result !== '0x'
        ? payload.result
        : null;
    } catch (err: unknown) {
      this.logger.warn(`eth_call failed: ${this.getErrorMessage(err)}`);
      return null;
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
