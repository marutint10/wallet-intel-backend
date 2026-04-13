import type {
  MoralisErc20Transfer,
  MoralisWalletHistoryItem,
} from './wallet.service';

export interface NormalizedTokenAmount {
  token: string;
  amount: string;
  decimals?: number;
  contractAddress?: string;
}

export interface NormalizedTransaction {
  hash: string;
  block_number: number;
  timestamp: string;
  from: string;
  to: string;
  type: 'transfer' | 'swap' | 'unknown';
  inputs: NormalizedTokenAmount[];
  outputs: NormalizedTokenAmount[];
}

export interface WalletRawData {
  address: string;
  erc20_transfers: MoralisErc20Transfer[];
  native_transactions: MoralisWalletHistoryItem[];
}

export interface WalletTransactionsResponse {
  raw: WalletRawData;
  normalized: NormalizedTransaction[];
}

export interface StoredWalletTransactionsResponse {
  address: string;
  transactions: NormalizedTransaction[];
}

export interface WalletSummaryResponse {
  address: string;
  total_transactions: number;
  total_swaps: number;
  total_transfers: number;
  tokens_interacted: number;
}

export interface Trade {
  token: string;
  type: 'BUY' | 'SELL';
  amount: string;
  decimals?: number;
  contractAddress?: string;
  timestamp: number;
}

export interface WalletTokenPnL {
  realizedPnL: number;
}

export interface WalletPnLResponse {
  [token: string]: WalletTokenPnL;
}

export interface TokenFlowAmount {
  in: string;
  out: string;
  decimals?: number;
  contractAddress?: string;
}

export interface WalletTokenFlowResponse {
  address: string;
  flow: Record<string, TokenFlowAmount>;
}

export interface WalletNetFlowResponse {
  [token: string]: string;
}

export interface WalletPortfolioResponse {
  [token: string]: string;
}

export interface WalletPortfolioUsdItem {
  amount: string;
  usd: string;
}

export interface WalletPortfolioUSDResponse {
  [token: string]: WalletPortfolioUsdItem;
}