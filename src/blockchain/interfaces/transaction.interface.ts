export type BlockchainNetwork = 'evm' | 'solana';

export type BlockchainProvider = 'moralis' | 'alchemy' | 'helius';

export interface FetchTransactionsOptions {
  address: string;
  network: BlockchainNetwork;
  limit?: number;
}

export interface NormalizedTransaction {
  provider: BlockchainProvider;
  network: BlockchainNetwork;
  txHash: string;
  blockNumber?: string;
  timestamp?: Date;
  fromAddress: string;
  toAddress: string;
  assetSymbol?: string;
  amount?: string;
  raw: Record<string, unknown>;
}

export interface ProviderFetchResult {
  provider: BlockchainProvider;
  transactions: NormalizedTransaction[];
}
