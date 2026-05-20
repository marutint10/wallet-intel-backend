import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { lookupKnownExchange } from '../constants/known-exchange-addresses';

export type HolderLabel =
  | 'eoa'
  | 'exchange'
  | 'cex_deposit'
  | 'dex_router'
  | 'dex_pool'
  | 'bridge'
  | 'burn'
  | 'vesting'
  | 'treasury'
  | 'staking'
  | 'generic_contract'
  | 'deployer'
  | 'owner'
  | 'team_connected'
  | 'dust';

export interface LabelEvidence {
  type: string;
  detail: string;
  weight: number;
  txHash?: string;
  txCount?: number;
  counterparty?: string;
}

export interface HolderFilterResult {
  address: string;
  label: HolderLabel;
  labelDetail?: string;
  // Etherscan-resolved contract name. Populated only for `generic_contract`
  // wallets; null/undefined for every other label.
  knownLabel?: string | null;
  shouldAnalyze: boolean;
  isTeamLinked: boolean;
  teamConnectionPath?: string;
  labelConfidence: number;
  labelEvidence: LabelEvidence[];
  teamConnectionScore: number;
}

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  circulatingSupply: string | null;
  totalSupplyFormatted: number | null;
  liquidityUsd: number | null;
  liquidityPairs: Array<{
    dex: string;
    pairAddress: string;
    liquidityUsd: number;
    priceUsd: number;
  }>;
  deployer: string | null;
  owner: string | null;
  source: string;
}

export interface TeamDetectionResult {
  deployerAddress: string | null;
  ownerAddress: string | null;
  teamWallets: Array<{
    address: string;
    role: string;
    connectionPath: string;
    balance: string;
    pctOfSupply: number;
    connectionScore: number;
    evidence: LabelEvidence[];
  }>;
  teamTotalPctOfSupply: number;
  teamWalletCount: number;
  avgTeamConfidence: number;
  highConfidenceTeamPct: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReason: string;
}

interface DexScreenerToken {
  address?: string;
  name?: string;
  symbol?: string;
}

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: DexScreenerToken;
  quoteToken?: DexScreenerToken;
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

interface EtherscanContractCreationResponse {
  status?: string;
  result?: Array<{ contractCreator?: string }>;
}

interface EtherscanSourceCodeResponse {
  status?: string;
  result?: Array<{ ContractName?: string }>;
}

interface EtherscanTokenTransfer {
  from?: string;
  to?: string;
  hash?: string;
}

interface EtherscanTokenTransferResponse {
  status?: string;
  result?: EtherscanTokenTransfer[];
}

interface AlchemyAssetTransfer {
  from?: string;
  to?: string;
  hash?: string;
  transactionHash?: string;
}

interface AlchemyAssetTransfersResponse {
  result?: {
    transfers?: AlchemyAssetTransfer[];
  };
}

interface CoinGeckoTokenResponse {
  name?: string;
  symbol?: string;
  market_data?: {
    total_supply?: number | string | null;
    circulating_supply?: number | string | null;
  };
}

type HolderInput = {
  walletAddress: string;
  balance: string;
  rank: number;
  usdValue: number;
};

type ContractClassification = {
  label: HolderLabel;
  labelDetail?: string;
  knownLabel?: string | null;
  isTeamLinked: boolean;
  labelConfidence: number;
  evidence: LabelEvidence[];
  teamConnectionScore: number;
  controller?: string | null;
};

type TeamCounterpartySignal = {
  totalTxCount: number;
  receivedFromSeedTxCount: number;
  sampleTxHash?: string;
};

@Injectable()
export class TokenIntelligenceService {
  private readonly logger = new Logger(TokenIntelligenceService.name);
  private static readonly CONTRACT_NAME_CACHE_PREFIX = 'token:contract-name:';
  private static readonly CONTRACT_NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly contractCodeCache = new Map<string, boolean>();
  /** L1: successful Etherscan contract names only (never cache transient failures). */
  private readonly contractNameMemoryCache = new Map<string, string>();
  private readonly missingKeyWarnings = new Set<string>();

  private static readonly KNOWN_DEX_ROUTERS = new Map<string, string>([
    ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router'],
    ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router'],
    ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap Universal Router'],
    ['0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', 'SushiSwap Router'],
    ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch V5'],
    ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Exchange Proxy'],
    ['0xba12222222228d8ba445958a75a0704d566bf2c8', 'Balancer Vault'],
    ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5', 'Kyber Network'],
    ['0xdef171fe48cf0115b1d80b88dc8eab59176fee57', 'Paraswap V5'],
    ['0x10ed43c718714eb63d5aa57b78b54704e256024e', 'PancakeSwap V2 (BSC)'],
    ['0x13f4ea83d0bd40e75c8222255bc855a974568dd4', 'PancakeSwap V3 (BSC)'],
  ]);

  private static readonly KNOWN_BRIDGES = new Map<string, string>([
    ['0x3154cf16ccdb4c6d922629664174b904d80f2c35', 'Base Bridge'],
    ['0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'Base Portal'],
    ['0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', 'Optimism Bridge'],
    ['0x3ee18b2214aff97000d974cf647e7c347e8fa585', 'Wormhole'],
  ]);

  private static readonly BURN_ADDRESSES = new Set<string>([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    '0xdead000000000000000000000042069420694206',
    '0x0000000000000000000000000000000000000001',
  ]);

  private static readonly KNOWN_STAKING_KEYWORDS = [
    'staking',
    'stake',
    'xtoken',
    'stoken',
    'staked',
  ];

  private static readonly KNOWN_VESTING_KEYWORDS = [
    'vesting',
    'vest',
    'timelock',
    'lock',
    'linear',
  ];

  private static readonly KNOWN_TREASURY_KEYWORDS = [
    'treasury',
    'multisig',
    'gnosis',
    'safe',
    'dao',
    'governance',
    'team',
  ];

  constructor(
    private readonly config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async getTokenMetadata(
    contractAddress: string,
    chain: string,
  ): Promise<TokenMetadata> {
    const address = contractAddress.toLowerCase();
    const dexData = await this.getDexScreenerMetadata(address, chain);
    const rpcUrl = this.getRpcUrl(chain);

    let onchainName: string | null = null;
    let onchainSymbol: string | null = null;
    let decimals: number | null = null;
    let totalSupply: string | null = null;
    let totalSupplyFormatted: number | null = null;
    let owner: string | null = null;
    let usedOnchain = false;

    if (rpcUrl) {
      const [totalSupplyHex, decimalsHex, nameHex, symbolHex, ownerHex] =
        await Promise.all([
          this.ethCall(rpcUrl, address, '0x18160ddd'),
          this.ethCall(rpcUrl, address, '0x313ce567'),
          this.ethCall(rpcUrl, address, '0x06fdde03'),
          this.ethCall(rpcUrl, address, '0x95d89b41'),
          this.ethCall(rpcUrl, address, '0x8da5cb5b'),
        ]);

      totalSupply = this.parseUint256(totalSupplyHex);
      decimals = this.parseSmallUint(decimalsHex);
      onchainName = this.decodeAbiString(nameHex);
      onchainSymbol = this.decodeAbiString(symbolHex);
      owner = this.parseAddressResult(ownerHex);

      if (totalSupply && decimals !== null) {
        totalSupplyFormatted = this.formatTokenAmount(totalSupply, decimals);
      }

      usedOnchain = Boolean(
        totalSupply || decimals !== null || onchainName || onchainSymbol || owner,
      );
    } else {
      this.warnMissingKeyOnce('ALCHEMY_API_KEY', 'Skipping on-chain token metadata');
    }

    const deployer = await this.getCreatorAddress(address, chain);
    const coinGeckoData = await this.getCoinGeckoFallback(address, chain, {
      needsName: !onchainName && !dexData.name,
      needsSymbol: !onchainSymbol && !dexData.symbol,
      needsSupply: !totalSupply && dexData.totalSupplyFormatted === null,
      needsCirculatingSupply: true,
    });

    const fallbackTotalSupplyFormatted =
      totalSupplyFormatted ??
      dexData.totalSupplyFormatted ??
      this.parseNullableNumber(coinGeckoData.totalSupply);
    const fallbackTotalSupply =
      totalSupply ??
      this.numberToPlainString(dexData.totalSupplyFormatted) ??
      this.stringOrNull(coinGeckoData.totalSupply);
    const source = this.buildMetadataSource(
      usedOnchain,
      dexData.usedDexScreener,
      coinGeckoData.usedCoinGecko,
    );

    return {
      name: onchainName ?? dexData.name ?? coinGeckoData.name,
      symbol: onchainSymbol ?? dexData.symbol ?? coinGeckoData.symbol,
      decimals,
      totalSupply: fallbackTotalSupply,
      circulatingSupply: this.stringOrNull(coinGeckoData.circulatingSupply),
      totalSupplyFormatted: fallbackTotalSupplyFormatted,
      liquidityUsd: dexData.liquidityUsd,
      liquidityPairs: dexData.liquidityPairs,
      deployer,
      owner,
      source,
    };
  }

  async classifyHolders(
    holders: HolderInput[],
    tokenMetadata: TokenMetadata,
    chain: string,
  ): Promise<{
    classifications: Map<string, HolderFilterResult>;
    teamDetection: TeamDetectionResult;
  }> {
    const classifications = new Map<string, HolderFilterResult>();
    const holderByAddress = new Map<string, HolderInput>();

    for (const holder of holders) {
      const address = holder.walletAddress.toLowerCase();
      holderByAddress.set(address, holder);
      const staticClassification = this.classifyByStaticRules(
        address,
        holder.usdValue,
        tokenMetadata,
      );

      if (staticClassification) {
        classifications.set(address, staticClassification);
      }
    }

    const remaining = holders.filter(
      (holder) => !classifications.has(holder.walletAddress.toLowerCase()),
    );
    const rpcUrl = this.getRpcUrl(chain);
    const contractControllers = new Map<
      string,
      { controller: string; label: HolderLabel }
    >();

    if (!rpcUrl) {
      this.warnMissingKeyOnce('ALCHEMY_API_KEY', 'Classifying unknown holders as EOAs');
      for (const holder of remaining) {
        const address = holder.walletAddress.toLowerCase();
        classifications.set(
          address,
          this.makeFallbackResult(address, 'eoa', true, false),
        );
      }
    } else {
      for (let i = 0; i < remaining.length; i += 10) {
        const batch = remaining.slice(i, i + 10);
        await Promise.all(
          batch.map(async (holder) => {
            const address = holder.walletAddress.toLowerCase();
            try {
              const isContract = await this.isContractAddress(rpcUrl, address);

              if (!isContract) {
                classifications.set(
                  address,
                  this.makeResult(address, 'eoa', true, false, {
                    labelConfidence: 95,
                    labelEvidence: [
                      {
                        type: 'bytecode_check',
                        detail:
                          'No contract bytecode found - externally owned account',
                        weight: 1.0,
                      },
                    ],
                    teamConnectionScore: 0,
                  }),
                );
                return;
              }

              const classification = await this.classifyContract(
                rpcUrl,
                address,
                chain,
              );
              if (classification.controller) {
                contractControllers.set(address, {
                  controller: classification.controller,
                  label: classification.label,
                });
              }

              classifications.set(
                address,
                this.makeResult(
                  address,
                  classification.label,
                  false,
                  classification.isTeamLinked,
                  {
                    labelDetail: classification.labelDetail,
                    knownLabel: classification.knownLabel ?? null,
                    teamConnectionPath: classification.isTeamLinked
                      ? `${classification.label} -> ${address}`
                      : undefined,
                    labelConfidence: classification.labelConfidence,
                    labelEvidence: classification.evidence,
                    teamConnectionScore: classification.teamConnectionScore,
                  },
                ),
              );
            } catch (err: unknown) {
              this.logger.warn(
                `Failed to classify ${address}; using fallback: ${this.getErrorMessage(err)}`,
              );
              classifications.set(
                address,
                this.makeFallbackResult(address, 'eoa', true, false),
              );
            }
          }),
        );

        if (i + 10 < remaining.length) {
          await this.sleep(200);
        }
      }
    }

    await this.applyTeamConnections(
      classifications,
      holderByAddress,
      tokenMetadata,
      contractControllers,
      chain,
      rpcUrl,
    );

    return {
      classifications,
      teamDetection: this.buildTeamDetection(
        classifications,
        holderByAddress,
        tokenMetadata,
      ),
    };
  }

  private getRpcUrl(chain: string): string | null {
    const apiKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    if (apiKey.trim().length === 0) {
      return null;
    }

    const networkMap: Record<string, string> = {
      ethereum: 'eth-mainnet',
      polygon: 'polygon-mainnet',
      bsc: 'bnb-mainnet',
      base: 'base-mainnet',
    };
    const network = networkMap[chain.toLowerCase()];

    return network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : null;
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

  private async getCreatorAddress(
    contractAddress: string,
    chain: string,
  ): Promise<string | null> {
    const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
    if (apiKey.trim().length === 0) {
      this.warnMissingKeyOnce('ETHERSCAN_API_KEY', 'Skipping deployer lookup');
      return null;
    }

    const chainId = this.getEtherscanChainId(chain);
    if (!chainId) {
      return null;
    }

    if (this.shouldSkipEtherscan(chainId)) {
      return null;
    }

    try {
      const url = new URL('https://api.etherscan.io/v2/api');
      url.searchParams.set('chainid', chainId);
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', 'getcontractcreation');
      url.searchParams.set('contractaddresses', contractAddress);
      url.searchParams.set('apikey', apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        return null;
      }

      const payload =
        (await response.json()) as EtherscanContractCreationResponse;
      const creator = payload.result?.[0]?.contractCreator;

      return payload.status === '1' && creator ? creator.toLowerCase() : null;
    } catch (err: unknown) {
      this.logger.warn(`Deployer lookup failed: ${this.getErrorMessage(err)}`);
      return null;
    }
  }

  private async getDexScreenerMetadata(
    contractAddress: string,
    chain: string,
  ): Promise<{
    name: string | null;
    symbol: string | null;
    liquidityUsd: number | null;
    totalSupplyFormatted: number | null;
    liquidityPairs: TokenMetadata['liquidityPairs'];
    usedDexScreener: boolean;
  }> {
    try {
      const dexChain = this.getDexScreenerChainId(chain);
      if (!dexChain) {
        return this.emptyDexMetadata();
      }

      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      );
      if (!response.ok) {
        return this.emptyDexMetadata();
      }

      const payload = (await response.json()) as DexScreenerResponse;
      const pairs = (payload.pairs ?? [])
        .filter((pair) => pair.chainId === dexChain)
        .sort((left, right) =>
          (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0),
        );

      if (pairs.length === 0) {
        return this.emptyDexMetadata();
      }

      const bestPair = pairs[0];
      const matchedToken = this.getMatchedDexToken(bestPair, contractAddress);
      const priceUsd = this.parseNullableNumber(bestPair.priceUsd);
      const totalSupplyFormatted =
        typeof bestPair.fdv === 'number' && priceUsd && priceUsd > 0
          ? bestPair.fdv / priceUsd
          : null;

      return {
        name: matchedToken?.name ?? null,
        symbol: matchedToken?.symbol ?? null,
        liquidityUsd: bestPair.liquidity?.usd ?? null,
        totalSupplyFormatted,
        liquidityPairs: pairs.slice(0, 5).map((pair) => ({
          dex: pair.dexId ?? 'unknown',
          pairAddress: pair.pairAddress ?? '',
          liquidityUsd: pair.liquidity?.usd ?? 0,
          priceUsd: this.parseNullableNumber(pair.priceUsd) ?? 0,
        })),
        usedDexScreener: true,
      };
    } catch (err: unknown) {
      this.logger.warn(`DexScreener metadata failed: ${this.getErrorMessage(err)}`);
      return this.emptyDexMetadata();
    }
  }

  private async getCoinGeckoFallback(
    contractAddress: string,
    chain: string,
    needs: {
      needsName: boolean;
      needsSymbol: boolean;
      needsSupply: boolean;
      needsCirculatingSupply: boolean;
    },
  ): Promise<{
    name: string | null;
    symbol: string | null;
    totalSupply: string | number | null;
    circulatingSupply: string | number | null;
    usedCoinGecko: boolean;
  }> {
    if (
      !needs.needsName &&
      !needs.needsSymbol &&
      !needs.needsSupply &&
      !needs.needsCirculatingSupply
    ) {
      return this.emptyCoinGeckoMetadata();
    }

    const platform = this.getCoinGeckoPlatform(chain);
    if (!platform) {
      return this.emptyCoinGeckoMetadata();
    }

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${platform}/contract/${contractAddress}`,
      );
      if (!response.ok) {
        return this.emptyCoinGeckoMetadata();
      }

      const payload = (await response.json()) as CoinGeckoTokenResponse;
      return {
        name: payload.name ?? null,
        symbol: payload.symbol ? payload.symbol.toUpperCase() : null,
        totalSupply: payload.market_data?.total_supply ?? null,
        circulatingSupply: payload.market_data?.circulating_supply ?? null,
        usedCoinGecko: true,
      };
    } catch (err: unknown) {
      this.logger.warn(`CoinGecko metadata failed: ${this.getErrorMessage(err)}`);
      return this.emptyCoinGeckoMetadata();
    }
  }

  private classifyByStaticRules(
    address: string,
    usdValue: number,
    tokenMetadata: TokenMetadata,
  ): HolderFilterResult | null {
    const normalizedAddress = address.trim().toLowerCase();

    if (TokenIntelligenceService.BURN_ADDRESSES.has(normalizedAddress)) {
      return this.makeResult(normalizedAddress, 'burn', false, false, {
        labelDetail: 'Burn Address',
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'static_lookup',
            detail: 'Address matches "Burn Address" in known burn list',
            weight: 1.0,
          },
        ],
        teamConnectionScore: 0,
      });
    }

    const exchangeName = lookupKnownExchange(normalizedAddress);
    if (exchangeName) {
      return this.makeResult(normalizedAddress, 'exchange', false, false, {
        labelDetail: exchangeName,
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'static_lookup',
            detail: `Address matches "${exchangeName}" in known exchange list`,
            weight: 1.0,
          },
        ],
        teamConnectionScore: 0,
      });
    }

    const dexRouter = TokenIntelligenceService.KNOWN_DEX_ROUTERS.get(normalizedAddress);
    if (dexRouter) {
      return this.makeResult(normalizedAddress, 'dex_router', false, false, {
        labelDetail: dexRouter,
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'static_lookup',
            detail: `Address matches "${dexRouter}" in known dex_router list`,
            weight: 1.0,
          },
        ],
        teamConnectionScore: 0,
      });
    }

    const bridge = TokenIntelligenceService.KNOWN_BRIDGES.get(normalizedAddress);
    if (bridge) {
      return this.makeResult(normalizedAddress, 'bridge', false, false, {
        labelDetail: bridge,
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'static_lookup',
            detail: `Address matches "${bridge}" in known bridge list`,
            weight: 1.0,
          },
        ],
        teamConnectionScore: 0,
      });
    }

    if (usdValue < 10) {
      return this.makeResult(normalizedAddress, 'dust', false, false, {
        labelDetail: 'Holding below $10',
        labelConfidence: 95,
        labelEvidence: [
          {
            type: 'dust_threshold',
            detail: `Holding value $${usdValue.toFixed(2)} is below $10 threshold`,
            weight: 1.0,
          },
        ],
        teamConnectionScore: 0,
      });
    }

    if (tokenMetadata.deployer?.toLowerCase() === normalizedAddress) {
      return this.makeResult(normalizedAddress, 'deployer', true, true, {
        labelDetail: 'Token deployer',
        teamConnectionPath: `deployer -> ${normalizedAddress}`,
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'deployer_match',
            detail: 'Address is the deployer of this token contract',
            weight: 1.0,
          },
        ],
        teamConnectionScore: 100,
      });
    }

    if (tokenMetadata.owner?.toLowerCase() === normalizedAddress) {
      return this.makeResult(normalizedAddress, 'owner', true, true, {
        labelDetail: 'Token owner',
        teamConnectionPath: `owner -> ${normalizedAddress}`,
        labelConfidence: 99,
        labelEvidence: [
          {
            type: 'owner_match',
            detail: 'Address is the current owner() of this token contract',
            weight: 1.0,
          },
        ],
        teamConnectionScore: 95,
      });
    }

    return null;
  }

  private async isContractAddress(
    rpcUrl: string,
    address: string,
  ): Promise<boolean> {
    if (this.contractCodeCache.has(address)) {
      return this.contractCodeCache.get(address) ?? false;
    }

    const code = await this.getCode(rpcUrl, address);
    const isContract = code !== null;
    this.contractCodeCache.set(address, isContract);

    return isContract;
  }

  private async classifyContract(
    rpcUrl: string,
    address: string,
    chain: string,
  ): Promise<ContractClassification> {
    try {
      const [code, token0Result, ownerResult, contractName] = await Promise.all([
        this.getCode(rpcUrl, address),
        this.ethCall(rpcUrl, address, '0x0dfe1681'),
        this.ethCall(rpcUrl, address, '0x8da5cb5b'),
        this.getContractName(address, chain),
      ]);
      const controller = this.parseAddressResult(ownerResult);
      const token0Address = this.parseAddressResult(token0Result);
      const contractNameLookupAvailable = this.canUseContractNameLookup(chain);
      const evidence: LabelEvidence[] = [
        {
          type: 'bytecode_check',
          detail: 'Address contains contract bytecode',
          weight: 0.5,
        },
      ];

      if (contractName) {
        evidence.push({
          type: 'etherscan_name',
          detail: `Resolved contract name "${contractName}" from source lookup`,
          weight: 0.4,
        });
      }

      if (token0Address) {
        evidence.push({
          type: 'token0_call_success',
          detail: 'Contract responds to token0() - likely LP pair',
          weight: 0.9,
        });
      }

      if (this.isLikelyDexPool(code, token0Result, contractName)) {
        if (!token0Address) {
          evidence.push({
            type: 'lp_function_detected',
            detail:
              'Contract bytecode/name indicates LP pool behavior even without token0() proof',
            weight: 0.7,
          });
        }

        return {
          label: 'dex_pool',
          labelDetail: contractName ?? 'DEX pool contract',
          isTeamLinked: false,
          labelConfidence: token0Address ? 90 : 80,
          evidence,
          teamConnectionScore: 0,
          controller,
        };
      }

      const keywordLabel = this.classifyContractName(contractName);
      if (keywordLabel === 'vesting') {
        evidence.push({
          type: 'vesting_keyword',
          detail: `Contract name "${contractName}" matches vesting pattern`,
          weight: 0.8,
        });
        return {
          label: keywordLabel,
          labelDetail: contractName ?? undefined,
          isTeamLinked: true,
          labelConfidence: 85,
          evidence,
          teamConnectionScore: 60,
          controller,
        };
      }

      if (keywordLabel === 'treasury') {
        evidence.push({
          type: 'treasury_keyword',
          detail: `Contract name "${contractName}" matches treasury pattern`,
          weight: 0.8,
        });
        return {
          label: keywordLabel,
          labelDetail: contractName ?? undefined,
          isTeamLinked: true,
          labelConfidence: 85,
          evidence,
          teamConnectionScore: 70,
          controller,
        };
      }

      if (keywordLabel === 'staking') {
        evidence.push({
          type: 'staking_keyword',
          detail: `Contract name "${contractName}" matches staking pattern`,
          weight: 0.7,
        });
        return {
          label: keywordLabel,
          labelDetail: contractName ?? undefined,
          isTeamLinked: false,
          labelConfidence: 80,
          evidence,
          teamConnectionScore: 0,
          controller,
        };
      }

      // CHANGE 1: log knownLabel enrichment outcome for generic_contract wallets.
      // The getsourcecode call already happened above via getContractName() (cached
      // in contractNameCache), so this is observability around the existing
      // enrichment - no extra Etherscan call is issued and no extra rate-limit
      // pacing is needed beyond the 200ms batch gap already present in
      // classifyHolders.
      const trimmedContractName = contractName?.trim();
      const knownLabel =
        trimmedContractName && trimmedContractName.length > 0
          ? trimmedContractName
          : null;

      if (knownLabel) {
        this.logger.log(
          `[token-intelligence] contract_name_enriched address=${address} name=${knownLabel}`,
        );
      } else {
        this.logger.log(
          `[token-intelligence] contract_name_not_found address=${address}`,
        );
      }

      const genericConfidence =
        contractNameLookupAvailable && knownLabel ? 60 : 50;
      return {
        label: 'generic_contract',
        labelDetail: knownLabel ?? undefined,
        knownLabel,
        isTeamLinked: false,
        labelConfidence: genericConfidence,
        evidence,
        teamConnectionScore: 0,
        controller,
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Contract classification failed for ${address}: ${this.getErrorMessage(err)}`,
      );
      // CHANGE 1: classification threw before we could resolve a contract name,
      // so emit the not_found log to keep observability symmetric with the
      // happy path above.
      this.logger.log(
        `[token-intelligence] contract_name_not_found address=${address}`,
      );
      return {
        label: 'generic_contract',
        labelDetail: undefined,
        isTeamLinked: false,
        labelConfidence: 50,
        evidence: [],
        teamConnectionScore: 0,
        controller: null,
      };
    }
  }

  private contractNameCacheKey(address: string, chain: string): string | null {
    const chainId = this.getEtherscanChainId(chain);
    if (!chainId) {
      return null;
    }

    return `${chainId}:${address.toLowerCase()}`;
  }

  private async getContractName(
    address: string,
    chain: string,
  ): Promise<string | null> {
    const cacheKey = this.contractNameCacheKey(address, chain);
    if (!cacheKey) {
      return null;
    }

    const memoryHit = this.contractNameMemoryCache.get(cacheKey);
    if (memoryHit) {
      return memoryHit;
    }

    const persistentKey =
      TokenIntelligenceService.CONTRACT_NAME_CACHE_PREFIX + cacheKey;
    const cached = await this.cacheManager.get<string>(persistentKey);
    if (typeof cached === 'string' && cached.length > 0) {
      this.contractNameMemoryCache.set(cacheKey, cached);
      return cached;
    }

    const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
    const chainId = this.getEtherscanChainId(chain);
    if (chainId && this.shouldSkipEtherscan(chainId)) {
      return null;
    }

    if (apiKey.trim().length === 0 || !chainId) {
      this.warnMissingKeyOnce(
        'ETHERSCAN_API_KEY',
        'Skipping contract source/name lookup',
      );
      return null;
    }

    try {
      const url = new URL('https://api.etherscan.io/v2/api');
      url.searchParams.set('chainid', chainId);
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', 'getsourcecode');
      url.searchParams.set('address', address);
      url.searchParams.set('apikey', apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        this.logger.debug(
          `Contract name lookup HTTP ${response.status} for ${address}; not caching`,
        );
        return null;
      }

      const payload = (await response.json()) as EtherscanSourceCodeResponse;
      const contractName = payload.result?.[0]?.ContractName?.trim() || null;
      if (contractName) {
        this.contractNameMemoryCache.set(cacheKey, contractName);
        await this.cacheManager.set(
          persistentKey,
          contractName,
          TokenIntelligenceService.CONTRACT_NAME_CACHE_TTL_MS,
        );
      }

      return contractName;
    } catch (err: unknown) {
      this.logger.warn(`Contract name lookup failed: ${this.getErrorMessage(err)}`);
      return null;
    }
  }

  private async applyTeamConnections(
    classifications: Map<string, HolderFilterResult>,
    holderByAddress: Map<string, HolderInput>,
    tokenMetadata: TokenMetadata,
    contractControllers: Map<string, { controller: string; label: HolderLabel }>,
    chain: string,
    rpcUrl: string | null,
  ): Promise<void> {
    const seedAddresses = new Map<string, string>();
    this.addSeed(seedAddresses, tokenMetadata.deployer, 'deployer');
    this.addSeed(seedAddresses, tokenMetadata.owner, 'owner');

    for (const [contractAddress, controllerInfo] of contractControllers.entries()) {
      const contractClassification = classifications.get(contractAddress);
      const controller = controllerInfo.controller;
      if (
        contractClassification?.isTeamLinked &&
        controller &&
        holderByAddress.has(controller)
      ) {
        seedAddresses.set(controller, `${contractClassification.label}_controller`);
        const controllerClassification = classifications.get(controller);
        if (!controllerClassification) {
          continue;
        }

        if (contractClassification.label === 'treasury') {
          const updatedController = this.applyTeamEvidenceToHolder(
            controllerClassification,
            [
              {
                type: 'treasury_controller',
                detail: `Controls treasury contract ${contractAddress} via owner()`,
                weight: 0.8,
                counterparty: contractAddress,
              },
            ],
            `${contractClassification.label} -> ${controller}`,
          );
          classifications.set(controller, updatedController);
        } else if (controllerClassification.label === 'eoa') {
          const updatedController = this.applyTeamEvidenceToHolder(
            controllerClassification,
            [
              {
                type: 'contract_creation_link',
                detail: `Controls ${contractClassification.label} contract ${contractAddress} via owner()`,
                weight: 0.55,
                counterparty: contractAddress,
              },
            ],
            `${contractClassification.label} -> ${controller}`,
          );
          classifications.set(controller, updatedController);
        }
      }
    }

    if (!rpcUrl) {
      this.warnMissingKeyOnce('ALCHEMY_API_KEY', 'Skipping team controller checks');
    }

    const chainId = this.getEtherscanChainId(chain);
    const requiresEtherscan = Boolean(
      chainId && !this.shouldSkipEtherscan(chainId),
    );
    if (requiresEtherscan) {
      const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
      if (apiKey.trim().length === 0) {
        this.warnMissingKeyOnce('ETHERSCAN_API_KEY', 'Skipping team transaction scan');
        return;
      }
    }

    const topSeeds = [...seedAddresses.entries()].slice(0, 5);
    for (let i = 0; i < topSeeds.length; i += 1) {
      const [seedAddress, seedRole] = topSeeds[i];
      let counterparties = new Map<string, TeamCounterpartySignal>();
      try {
        counterparties = await this.getRecentTokenTransferSignals(seedAddress, chain);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to gather team transfer evidence for ${seedAddress}: ${this.getErrorMessage(err)}`,
        );
      }

      for (const [counterparty, signal] of counterparties.entries()) {
        if (!holderByAddress.has(counterparty)) {
          continue;
        }

        const current = classifications.get(counterparty);
        if (current && ['deployer', 'owner'].includes(current.label)) {
          continue;
        }

        const evidence = this.buildTeamSignalEvidence(
          seedRole,
          seedAddress,
          signal,
        );
        if (evidence.length === 0) {
          continue;
        }

        const baseCurrent =
          current ?? this.makeFallbackResult(counterparty, 'eoa', true, false);
        const updated = this.applyTeamEvidenceToHolder(
          baseCurrent,
          evidence,
          `${seedRole} -> ${counterparty}`,
        );

        classifications.set(
          counterparty,
          updated,
        );
      }

      if (i + 1 < topSeeds.length) {
        await this.sleep(200);
      }
    }
  }

  private async getRecentTokenTransferSignals(
    seedAddress: string,
    chain: string,
  ): Promise<Map<string, TeamCounterpartySignal>> {
    const counterparties = new Map<string, TeamCounterpartySignal>();
    const chainId = this.getEtherscanChainId(chain);

    if (!chainId) {
      return counterparties;
    }

    if (this.shouldSkipEtherscan(chainId)) {
      return this.getRecentTokenTransferSignalsFromAlchemy(seedAddress, chain);
    }

    const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
    if (apiKey.trim().length === 0) {
      return counterparties;
    }

    try {
      const url = new URL('https://api.etherscan.io/v2/api');
      url.searchParams.set('chainid', chainId);
      url.searchParams.set('module', 'account');
      url.searchParams.set('action', 'tokentx');
      url.searchParams.set('address', seedAddress);
      url.searchParams.set('page', '1');
      url.searchParams.set('offset', '100');
      url.searchParams.set('sort', 'desc');
      url.searchParams.set('apikey', apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        return counterparties;
      }

      const payload = (await response.json()) as EtherscanTokenTransferResponse;
      if (payload.status !== '1' || !Array.isArray(payload.result)) {
        return counterparties;
      }

      const seed = seedAddress.toLowerCase();
      for (const transfer of payload.result) {
        const from = transfer.from?.toLowerCase();
        const to = transfer.to?.toLowerCase();
        const txHash = transfer.hash;

        if (from === seed && to && to !== seed) {
          this.upsertTeamCounterpartySignal(
            counterparties,
            to,
            true,
            txHash,
          );
          continue;
        }
        if (to === seed && from && from !== seed) {
          this.upsertTeamCounterpartySignal(
            counterparties,
            from,
            false,
            txHash,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.warn(`Team transaction scan failed: ${this.getErrorMessage(err)}`);
    }

    return counterparties;
  }

  private async getRecentTokenTransferSignalsFromAlchemy(
    seedAddress: string,
    chain: string,
  ): Promise<Map<string, TeamCounterpartySignal>> {
    const counterparties = new Map<string, TeamCounterpartySignal>();
    const rpcUrl = this.getRpcUrl(chain);

    if (!rpcUrl) {
      this.warnMissingKeyOnce(
        'ALCHEMY_API_KEY',
        'Skipping Alchemy fallback team transaction scan',
      );
      return counterparties;
    }

    const fetchTransfers = async (
      direction: 'from' | 'to',
    ): Promise<AlchemyAssetTransfer[]> => {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'alchemy_getAssetTransfers',
            params: [
              {
                ...(direction === 'from'
                  ? { fromAddress: seedAddress }
                  : { toAddress: seedAddress }),
                category: ['erc20'],
                order: 'desc',
                maxCount: '0x64',
              },
            ],
            id: 1,
          }),
        });

        if (!response.ok) {
          return [];
        }

        const payload = (await response.json()) as AlchemyAssetTransfersResponse;
        return payload.result?.transfers ?? [];
      } catch (err: unknown) {
        this.logger.warn(
          `Alchemy team transaction scan failed: ${this.getErrorMessage(err)}`,
        );
        return [];
      }
    };

    const [outgoing, incoming] = await Promise.all([
      fetchTransfers('from'),
      fetchTransfers('to'),
    ]);

    const seed = seedAddress.toLowerCase();
    for (const transfer of [...outgoing, ...incoming]) {
      const from = transfer.from?.toLowerCase();
      const to = transfer.to?.toLowerCase();
      const txHash = transfer.hash ?? transfer.transactionHash;

      if (from === seed && to && to !== seed) {
        this.upsertTeamCounterpartySignal(counterparties, to, true, txHash);
        continue;
      }
      if (to === seed && from && from !== seed) {
        this.upsertTeamCounterpartySignal(counterparties, from, false, txHash);
      }
    }

    return counterparties;
  }

  private buildTeamDetection(
    classifications: Map<string, HolderFilterResult>,
    holderByAddress: Map<string, HolderInput>,
    tokenMetadata: TokenMetadata,
  ): TeamDetectionResult {
    const effectiveSupply = this.getEffectiveSupply(holderByAddress, tokenMetadata);
    const teamWallets: TeamDetectionResult['teamWallets'] = [];

    for (const [address, classification] of classifications.entries()) {
      if (!classification.isTeamLinked) {
        continue;
      }

      const holder = holderByAddress.get(address);
      if (!holder) {
        continue;
      }

      teamWallets.push({
        address,
        role: this.getTeamRole(classification.label),
        connectionPath: classification.teamConnectionPath ?? classification.label,
        balance: holder.balance,
        pctOfSupply: this.calculatePctOfSupply(holder.balance, effectiveSupply),
        connectionScore: classification.teamConnectionScore,
        evidence: classification.labelEvidence.filter((item) =>
          this.isTeamEvidenceType(item),
        ),
      });
    }

    const teamTotalPctOfSupply = this.roundPercent(
      teamWallets.reduce((total, wallet) => total + wallet.pctOfSupply, 0),
    );
    const avgTeamConfidence =
      teamWallets.length > 0
        ? Math.round(
            teamWallets.reduce((sum, wallet) => sum + wallet.connectionScore, 0) /
              teamWallets.length,
          )
        : 0;
    const highConfidenceTeamPct = this.roundPercent(
      teamWallets
        .filter((wallet) => wallet.connectionScore > 70)
        .reduce((sum, wallet) => sum + wallet.pctOfSupply, 0),
    );
    const risk = this.getTeamRisk(
      teamTotalPctOfSupply,
      highConfidenceTeamPct,
      avgTeamConfidence,
    );

    return {
      deployerAddress: tokenMetadata.deployer,
      ownerAddress: tokenMetadata.owner,
      teamWallets,
      teamTotalPctOfSupply,
      teamWalletCount: teamWallets.length,
      avgTeamConfidence,
      highConfidenceTeamPct,
      riskLevel: risk.riskLevel,
      riskReason: risk.riskReason,
    };
  }

  private makeResult(
    address: string,
    label: HolderLabel,
    shouldAnalyze: boolean,
    isTeamLinked: boolean,
    options: {
      labelDetail?: string;
      knownLabel?: string | null;
      teamConnectionPath?: string;
      labelConfidence?: number;
      labelEvidence?: LabelEvidence[];
      teamConnectionScore?: number;
    } = {},
  ): HolderFilterResult {
    const labelEvidence = this.sanitizeEvidence(options.labelEvidence ?? []);
    const teamConnectionScore = this.normalizeScore(
      options.teamConnectionScore ?? 0,
    );
    const labelConfidence = this.normalizeScore(options.labelConfidence ?? 50);
    const knownLabel =
      typeof options.knownLabel === 'string' && options.knownLabel.length > 0
        ? options.knownLabel
        : null;

    return {
      address,
      label,
      ...(options.labelDetail ? { labelDetail: options.labelDetail } : {}),
      knownLabel,
      shouldAnalyze,
      isTeamLinked,
      ...(options.teamConnectionPath
        ? { teamConnectionPath: options.teamConnectionPath }
        : {}),
      labelConfidence,
      labelEvidence,
      teamConnectionScore,
    };
  }

  private isLikelyDexPool(
    code: string | null,
    token0Result: string | null,
    contractName: string | null,
  ): boolean {
    const normalizedName = contractName?.toLowerCase() ?? '';
    const hasPoolName =
      normalizedName.includes('pair') ||
      normalizedName.includes('pool') ||
      normalizedName.includes('lp');
    const hasPoolSelectors =
      Boolean(code?.includes('0902f1ac')) && Boolean(code?.includes('0dfe1681'));

    return hasPoolName || hasPoolSelectors || this.parseAddressResult(token0Result) !== null;
  }

  private classifyContractName(contractName: string | null): HolderLabel | null {
    if (!contractName) {
      return null;
    }

    const normalizedName = contractName.toLowerCase();
    if (this.includesKeyword(normalizedName, TokenIntelligenceService.KNOWN_VESTING_KEYWORDS)) {
      return 'vesting';
    }
    if (this.includesKeyword(normalizedName, TokenIntelligenceService.KNOWN_TREASURY_KEYWORDS)) {
      return 'treasury';
    }
    if (this.includesKeyword(normalizedName, TokenIntelligenceService.KNOWN_STAKING_KEYWORDS)) {
      return 'staking';
    }
    if (
      normalizedName.includes('pair') ||
      normalizedName.includes('pool') ||
      normalizedName.includes('lp')
    ) {
      return 'dex_pool';
    }

    return null;
  }

  private includesKeyword(value: string, keywords: string[]): boolean {
    return keywords.some((keyword) => value.includes(keyword));
  }

  private addSeed(
    seeds: Map<string, string>,
    address: string | null,
    role: string,
  ): void {
    if (address) {
      seeds.set(address.toLowerCase(), role);
    }
  }

  private getMatchedDexToken(
    pair: DexScreenerPair,
    contractAddress: string,
  ): DexScreenerToken | null {
    const address = contractAddress.toLowerCase();
    if (pair.baseToken?.address?.toLowerCase() === address) {
      return pair.baseToken;
    }
    if (pair.quoteToken?.address?.toLowerCase() === address) {
      return pair.quoteToken;
    }

    return pair.baseToken ?? pair.quoteToken ?? null;
  }

  private parseUint256(hexValue: string | null): string | null {
    if (!hexValue) {
      return null;
    }

    try {
      return BigInt(hexValue).toString();
    } catch {
      return null;
    }
  }

  private parseSmallUint(hexValue: string | null): number | null {
    const parsed = this.parseUint256(hexValue);
    if (!parsed) {
      return null;
    }

    const value = Number(parsed);
    return Number.isFinite(value) ? value : null;
  }

  private decodeAbiString(hexValue: string | null): string | null {
    if (!hexValue) {
      return null;
    }

    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    if (hex.length === 0) {
      return null;
    }

    const dynamic = this.decodeDynamicAbiString(hex);
    if (dynamic) {
      return dynamic;
    }

    return this.decodeBytes32String(hex);
  }

  private decodeDynamicAbiString(hex: string): string | null {
    if (hex.length < 128) {
      return null;
    }

    try {
      const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
      const lengthStart = offset * 2;
      const length = Number(BigInt(`0x${hex.slice(lengthStart, lengthStart + 64)}`));
      const dataStart = lengthStart + 64;
      const dataHex = hex.slice(dataStart, dataStart + length * 2);

      return this.hexToUtf8(dataHex);
    } catch {
      return null;
    }
  }

  private decodeBytes32String(hex: string): string | null {
    return this.hexToUtf8(hex.slice(0, 64));
  }

  private hexToUtf8(hex: string): string | null {
    try {
      const value = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private parseAddressResult(hexValue: string | null): string | null {
    if (!hexValue) {
      return null;
    }

    const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
    if (hex.length < 40) {
      return null;
    }

    const address = `0x${hex.slice(-40)}`.toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(address) && !/^0x0+$/.test(address)
      ? address
      : null;
  }

  private formatTokenAmount(rawAmount: string, decimals: number): number | null {
    try {
      return Number(BigInt(rawAmount)) / 10 ** decimals;
    } catch {
      return null;
    }
  }

  private parseNullableNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private stringOrNull(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    return String(value);
  }

  private numberToPlainString(value: number | null): string | null {
    if (value === null || !Number.isFinite(value)) {
      return null;
    }

    return value.toLocaleString('fullwide', { useGrouping: false });
  }

  private getEffectiveSupply(
    holderByAddress: Map<string, HolderInput>,
    tokenMetadata: TokenMetadata,
  ): number {
    if (
      tokenMetadata.totalSupplyFormatted !== null &&
      tokenMetadata.totalSupplyFormatted > 0
    ) {
      return tokenMetadata.totalSupplyFormatted;
    }

    return [...holderByAddress.values()].reduce((sum, holder) => {
      const balance = Number.parseFloat(holder.balance);
      return sum + (Number.isFinite(balance) ? balance : 0);
    }, 0);
  }

  private calculatePctOfSupply(balance: string, supply: number): number {
    const balanceNumber = Number.parseFloat(balance);
    if (!Number.isFinite(balanceNumber) || supply <= 0) {
      return 0;
    }

    return this.roundPercent((balanceNumber / supply) * 100);
  }

  private roundPercent(value: number): number {
    return Math.round(value * 10000) / 10000;
  }

  private getTeamRole(label: HolderLabel): string {
    if (label === 'deployer' || label === 'owner') {
      return label;
    }
    if (label === 'treasury') {
      return 'treasury_controller';
    }

    return 'connected';
  }

  private getTeamRisk(
    teamTotalPctOfSupply: number,
    highConfidenceTeamPct: number,
    avgTeamConfidence: number,
  ): {
    riskLevel: TeamDetectionResult['riskLevel'];
    riskReason: string;
  } {
    if (highConfidenceTeamPct > 30) {
      return {
        riskLevel: 'critical',
        riskReason: `High-confidence team wallets (avg score ${avgTeamConfidence}) control ${highConfidenceTeamPct.toFixed(1)}% of supply`,
      };
    }
    if (highConfidenceTeamPct > 15) {
      return {
        riskLevel: 'high',
        riskReason: `Team-connected wallets (avg confidence ${avgTeamConfidence}) hold ${teamTotalPctOfSupply.toFixed(1)}% of supply`,
      };
    }
    if (teamTotalPctOfSupply > 20 && avgTeamConfidence < 50) {
      return {
        riskLevel: 'medium',
        riskReason:
          'Team-connected wallets hold significant supply, but links are weak (avg confidence: ' +
          `${avgTeamConfidence})`,
      };
    }
    if (teamTotalPctOfSupply > 10) {
      return {
        riskLevel: 'medium',
        riskReason: `Team-connected wallets hold significant supply (avg confidence: ${avgTeamConfidence})`,
      };
    }

    return {
      riskLevel: 'low',
      riskReason: `Team wallet concentration within normal range (avg confidence: ${avgTeamConfidence})`,
    };
  }

  private canUseContractNameLookup(chain: string): boolean {
    const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
    const chainId = this.getEtherscanChainId(chain);
    return Boolean(
      chainId && !this.shouldSkipEtherscan(chainId) && apiKey.trim().length > 0,
    );
  }

  private makeFallbackResult(
    address: string,
    label: HolderLabel,
    shouldAnalyze: boolean,
    isTeamLinked: boolean,
    labelDetail?: string,
    teamConnectionPath?: string,
  ): HolderFilterResult {
    return this.makeResult(address, label, shouldAnalyze, isTeamLinked, {
      labelDetail,
      teamConnectionPath,
      labelConfidence: 50,
      labelEvidence: [],
      teamConnectionScore: isTeamLinked ? 50 : 0,
    });
  }

  private sanitizeEvidence(evidence: LabelEvidence[]): LabelEvidence[] {
    return evidence
      .filter(
        (item): item is LabelEvidence =>
          Boolean(
            item &&
              typeof item.type === 'string' &&
              typeof item.detail === 'string',
          ),
      )
      .map((item) => ({
        ...item,
        type: item.type.trim(),
        detail: item.detail.trim(),
        weight: this.normalizeWeight(item.weight),
      }))
      .filter((item) => item.type.length > 0 && item.detail.length > 0)
      .slice(0, 10);
  }

  private normalizeScore(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private normalizeWeight(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const clamped = Math.max(0, Math.min(1, value));
    return Math.round(clamped * 1000) / 1000;
  }

  private isTeamEvidenceType(evidence: LabelEvidence): boolean {
    const normalizedType = evidence.type.toLowerCase();
    return (
      normalizedType.includes('deployer') ||
      normalizedType.includes('owner') ||
      normalizedType.includes('treasury') ||
      normalizedType.includes('team') ||
      normalizedType.includes('counterparty')
    );
  }

  private computeTeamConnectionScore(evidence: LabelEvidence[]): number {
    const weightedSignals = evidence
      .filter((item) => this.isTeamEvidenceType(item))
      .map((item) => this.normalizeWeight(item.weight));

    if (weightedSignals.length === 0) {
      return 0;
    }

    const maxWeight = Math.max(...weightedSignals);
    const sumOfOtherWeights =
      weightedSignals.reduce((sum, weight) => sum + weight, 0) - maxWeight;
    const combinedWeight = Math.min(maxWeight + sumOfOtherWeights * 0.15, 1.0);
    return Math.round(combinedWeight * 100);
  }

  private getTeamConnectedLabelConfidence(teamConnectionScore: number): number {
    if (teamConnectionScore >= 80) {
      return 90;
    }
    if (teamConnectionScore >= 50) {
      return 70;
    }
    return 50;
  }

  private applyTeamEvidenceToHolder(
    current: HolderFilterResult,
    evidence: LabelEvidence[],
    teamConnectionPath: string,
  ): HolderFilterResult {
    const combinedEvidence = this.sanitizeEvidence([
      ...current.labelEvidence,
      ...evidence,
    ]);
    const computedScore = this.computeTeamConnectionScore(combinedEvidence);
    const priorScore = this.normalizeScore(current.teamConnectionScore);
    const mergedScore = Math.max(priorScore, computedScore);
    const shouldMarkTeam =
      mergedScore >= 30 ||
      ['deployer', 'owner'].includes(current.label) ||
      (current.isTeamLinked && priorScore >= 30);

    const nextLabel =
      shouldMarkTeam && current.label === 'eoa' ? 'team_connected' : current.label;
    const nextIsTeamLinked = shouldMarkTeam || current.isTeamLinked;

    let labelConfidence = current.labelConfidence;
    if (nextLabel === 'team_connected') {
      labelConfidence = this.getTeamConnectedLabelConfidence(mergedScore);
    } else if (nextIsTeamLinked) {
      labelConfidence = Math.max(
        current.labelConfidence,
        this.getTeamConnectedLabelConfidence(mergedScore),
      );
    }

    return this.makeResult(
      current.address,
      nextLabel,
      current.shouldAnalyze,
      nextIsTeamLinked,
      {
        labelDetail:
          nextLabel === 'team_connected'
            ? current.labelDetail ?? 'Linked to team wallet'
            : current.labelDetail,
        knownLabel: current.knownLabel ?? null,
        teamConnectionPath: nextIsTeamLinked
          ? current.teamConnectionPath ?? teamConnectionPath
          : current.teamConnectionPath,
        labelConfidence,
        labelEvidence: combinedEvidence,
        teamConnectionScore: nextIsTeamLinked ? mergedScore : 0,
      },
    );
  }

  private buildTeamSignalEvidence(
    seedRole: string,
    seedAddress: string,
    signal: TeamCounterpartySignal,
  ): LabelEvidence[] {
    const evidence: LabelEvidence[] = [];
    const normalizedRole = seedRole.toLowerCase();

    if (normalizedRole === 'deployer' && signal.receivedFromSeedTxCount > 0) {
      evidence.push({
        type: 'direct_transfer_from_deployer',
        detail: `Received ${signal.receivedFromSeedTxCount} direct transfer(s) from deployer ${seedAddress}`,
        weight: this.getDirectDeployerWeight(signal.receivedFromSeedTxCount),
        txHash: signal.sampleTxHash,
        txCount: signal.receivedFromSeedTxCount,
        counterparty: seedAddress,
      });
    }

    if (normalizedRole === 'owner' && signal.receivedFromSeedTxCount > 0) {
      evidence.push({
        type: 'direct_transfer_from_owner',
        detail: `Received ${signal.receivedFromSeedTxCount} direct transfer(s) from owner ${seedAddress}`,
        weight: this.getDirectOwnerWeight(signal.receivedFromSeedTxCount),
        txHash: signal.sampleTxHash,
        txCount: signal.receivedFromSeedTxCount,
        counterparty: seedAddress,
      });
    }

    if (evidence.length === 0 && signal.totalTxCount > 0) {
      evidence.push({
        type: 'counterparty_of_team_wallet',
        detail: `${signal.totalTxCount} transaction(s) with team wallet ${seedAddress}`,
        weight: this.getCounterpartyWeight(signal.totalTxCount),
        txHash: signal.sampleTxHash,
        txCount: signal.totalTxCount,
        counterparty: seedAddress,
      });
    }

    return evidence;
  }

  private getDirectDeployerWeight(txCount: number): number {
    if (txCount >= 5) {
      return 0.98;
    }
    if (txCount >= 3) {
      return 0.95;
    }
    return 0.9;
  }

  private getDirectOwnerWeight(txCount: number): number {
    if (txCount >= 3) {
      return 0.92;
    }
    return 0.85;
  }

  private getCounterpartyWeight(txCount: number): number {
    if (txCount >= 5) {
      return 0.65;
    }
    if (txCount >= 3) {
      return 0.55;
    }
    return 0.4;
  }

  private upsertTeamCounterpartySignal(
    target: Map<string, TeamCounterpartySignal>,
    address: string,
    receivedFromSeed: boolean,
    txHash?: string,
  ): void {
    const existing = target.get(address) ?? {
      totalTxCount: 0,
      receivedFromSeedTxCount: 0,
    };

    existing.totalTxCount += 1;
    if (receivedFromSeed) {
      existing.receivedFromSeedTxCount += 1;
    }
    if (txHash && !existing.sampleTxHash) {
      existing.sampleTxHash = txHash;
    }

    target.set(address, existing);
  }

  private buildMetadataSource(
    usedOnchain: boolean,
    usedDexScreener: boolean,
    usedCoinGecko: boolean,
  ): string {
    if (usedOnchain && usedDexScreener) {
      return 'onchain+dexscreener';
    }
    if (usedDexScreener) {
      return 'dexscreener';
    }
    if (usedOnchain) {
      return 'onchain';
    }
    if (usedCoinGecko) {
      return 'coingecko';
    }

    return 'unknown';
  }

  private shouldSkipEtherscan(chainId: string): boolean {
    return ['8453', '56'].includes(chainId);
  }

  private getEtherscanChainId(chain: string): string | null {
    const chainMap: Record<string, string> = {
      ethereum: '1',
      polygon: '137',
      base: '8453',
      bsc: '56',
    };

    return chainMap[chain.toLowerCase()] ?? null;
  }

  private getDexScreenerChainId(chain: string): string | null {
    const chainMap: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon',
      bsc: 'bsc',
      base: 'base',
    };

    return chainMap[chain.toLowerCase()] ?? null;
  }

  private getCoinGeckoPlatform(chain: string): string | null {
    const platformMap: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon-pos',
      bsc: 'binance-smart-chain',
      base: 'base',
    };

    return platformMap[chain.toLowerCase()] ?? null;
  }

  private emptyDexMetadata(): {
    name: string | null;
    symbol: string | null;
    liquidityUsd: number | null;
    totalSupplyFormatted: number | null;
    liquidityPairs: TokenMetadata['liquidityPairs'];
    usedDexScreener: boolean;
  } {
    return {
      name: null,
      symbol: null,
      liquidityUsd: null,
      totalSupplyFormatted: null,
      liquidityPairs: [],
      usedDexScreener: false,
    };
  }

  private emptyCoinGeckoMetadata(): {
    name: string | null;
    symbol: string | null;
    totalSupply: string | number | null;
    circulatingSupply: string | number | null;
    usedCoinGecko: boolean;
  } {
    return {
      name: null,
      symbol: null,
      totalSupply: null,
      circulatingSupply: null,
      usedCoinGecko: false,
    };
  }

  private warnMissingKeyOnce(key: string, action: string): void {
    const warningKey = `${key}:${action}`;
    if (this.missingKeyWarnings.has(warningKey)) {
      return;
    }

    this.missingKeyWarnings.add(warningKey);
    this.logger.warn(`${key} is missing; ${action}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}