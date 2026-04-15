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
  moralis: {
    apiKey: process.env.MORALIS_API_KEY ?? '',
  },
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY ?? '',
  },
  rpc: {
    url: process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
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