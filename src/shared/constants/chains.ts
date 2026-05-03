export const CHAIN_PROFILES = {
  ethereum: {
    chainId: 'ethereum',
    moralisId: '0x1',
    coingeckoId: 'ethereum',
    defillamaId: 'ethereum',
    dexScreenerId: 'ethereum',
    nativeSymbol: 'ETH',
    nativeAliases: ['ETH'],
    nativeCoinGeckoId: 'ethereum',
    wrappedSymbol: 'WETH',
    wrappedAliases: ['WETH'],
    wrappedAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    rpcEnvKey: 'ETH_RPC_URL',
    defaultRpcUrl: 'https://ethereum-rpc.publicnode.com',
    fallbackRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
  },
  base: {
    chainId: 'base',
    moralisId: '0x2105',
    coingeckoId: 'base',
    defillamaId: 'base',
    dexScreenerId: 'base',
    nativeSymbol: 'ETH',
    nativeAliases: ['ETH'],
    nativeCoinGeckoId: 'ethereum',
    wrappedSymbol: 'WETH',
    wrappedAliases: ['WETH'],
    wrappedAddress: '0x4200000000000000000000000000000000000006',
    rpcEnvKey: 'BASE_RPC_URL',
    defaultRpcUrl: 'https://base-rpc.publicnode.com',
    fallbackRpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  },
  bsc: {
    chainId: 'bsc',
    moralisId: '0x38',
    coingeckoId: 'binance-smart-chain',
    defillamaId: 'bsc',
    dexScreenerId: 'bsc',
    nativeSymbol: 'BNB',
    nativeAliases: ['BNB'],
    nativeCoinGeckoId: 'binancecoin',
    wrappedSymbol: 'WBNB',
    wrappedAliases: ['WBNB'],
    wrappedAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    rpcEnvKey: 'BSC_RPC_URL',
    defaultRpcUrl: 'https://bsc-dataseed.binance.org',
    fallbackRpcUrls: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'],
  },
  polygon: {
    chainId: 'polygon',
    moralisId: '0x89',
    coingeckoId: 'polygon-pos',
    defillamaId: 'polygon',
    dexScreenerId: 'polygon',
    nativeSymbol: 'POL',
    nativeAliases: ['POL', 'MATIC'],
    nativeCoinGeckoId: 'polygon-ecosystem-token',
    wrappedSymbol: 'WPOL',
    wrappedAliases: ['WPOL', 'WMATIC'],
    wrappedAddress: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    rpcEnvKey: 'POLYGON_RPC_URL',
    defaultRpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    fallbackRpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  },
} as const;

export type SupportedChain = keyof typeof CHAIN_PROFILES;

export const DEFAULT_SUPPORTED_CHAIN: SupportedChain = 'ethereum';

export const SUPPORTED_CHAINS = Object.keys(CHAIN_PROFILES) as SupportedChain[];

const CHAIN_ALIASES: Record<string, SupportedChain> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  mainnet: 'ethereum',
  base: 'base',
  bnb: 'bsc',
  binance: 'bsc',
  bsc: 'bsc',
  polygon: 'polygon',
  matic: 'polygon',
  pol: 'polygon',
};

export function normalizeSupportedChain(value?: string | null): SupportedChain | null {
  if (!value || value.trim().length === 0) {
    return DEFAULT_SUPPORTED_CHAIN;
  }

  return CHAIN_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function getChainProfile(chain: SupportedChain) {
  return CHAIN_PROFILES[chain];
}

export function buildChainScopedKey(chain: SupportedChain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}