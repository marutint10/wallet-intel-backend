const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsedValue = Number.parseInt(value ?? '', 10);

  return Number.isNaN(parsedValue) ? fallback : parsedValue;
};

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
  },
  moralis: {
    apiKey: process.env.MORALIS_API_KEY ?? process.env.MORALIS_API_KEY_1 ?? '',
    apiKey1: process.env.MORALIS_API_KEY_1 ?? process.env.MORALIS_API_KEY ?? '',
    apiKey2:
      process.env.MORALIS_API_KEY_2 ?? process.env.MORALIS_API_URL_2 ?? '',
  },
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY ?? '',
  },
  rpc: {
    url: process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
    urls: {
      ethereum: process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
      base: process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com',
      bsc: process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org',
      polygon:
        process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
    },
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
    ssl: parseBoolean(process.env.DATABASE_SSL),
    connectionTimeoutMs: parseNumber(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS,
      10000,
    ),
  },
});