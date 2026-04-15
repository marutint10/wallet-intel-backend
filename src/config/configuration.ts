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
  },
});