import type {
  MoralisErc20Balance,
  MoralisErc20Transfer,
  MoralisNativeBalanceResponse,
  MoralisWalletHistoryItem,
} from './services/wallet-core.service';

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
  totalRealizedPnL: number;
  avgROI: number;
  avgWinRate: number;
  bestTrade: number;
  worstTrade: number;
  profitableTokens: number;
  losingTokens: number;
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
  roi: number;
  winRate: number;
  bestTrade: number;
  worstTrade: number;
}

export interface WalletPnLResponse {
  [token: string]: WalletTokenPnL;
}

export interface WalletRiskMetricsResponse {
  profitFactor: number;
  maxDrawdown: number;
  returnStdDev: number;
  concentrationRisk: number;
}

export interface WalletHoldTimeBuckets {
  under1h: number;
  under24h: number;
  under7d: number;
  over7d: number;
}

export interface WalletHoldTimeMetricsResponse {
  avgHoldHours: number;
  medianHoldHours: number;
  holdBuckets: WalletHoldTimeBuckets;
}

export interface WalletActivityMetricsResponse {
  tradesPerActiveDay: number;
  tradesPerLifetimeDay: number;
  avgTradeGapHours: number;
  burstinessScore: number;
  tradingSpanRatio: number;
}

export type WalletType = 'EOA' | 'Contract';

export type WalletSubtype =
  | 'Gnosis Safe'
  | 'Operational/Treasury'
  | 'Automated/Bot-like'
  | null;

export interface WalletContextResponse {
  walletType: WalletType;
  walletSubtype: WalletSubtype;
  isTraderWallet: boolean;
  classificationConfidence: number;
  reasoning: string[];
}

export interface WalletFeaturesResponse {
  summary: WalletSummaryResponse;
  risk: WalletRiskMetricsResponse;
  holdTime: WalletHoldTimeMetricsResponse;
  activity: WalletActivityMetricsResponse;
}

export interface WalletRiskMetricsDebugResponse
  extends WalletRiskMetricsResponse {
  positivePnLTrades: number[];
  negativePnLTrades: number[];
  cumulativePnLCurve: number[];
  tradeROIs: number[];
  largestHoldingUsd: number;
  totalPortfolioUsd: number;
}

export type WalletRiskMetricsResult =
  | WalletRiskMetricsResponse
  | WalletRiskMetricsDebugResponse;

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

export interface WalletLedgerResponse {
  [token: string]: string;
}

export interface WalletHoldingItem {
  token: string;
  amount: string;
  contractAddress?: string;
  decimals?: number;
}

export type WalletHoldingsResponse = WalletHoldingItem[];

export interface WalletPortfolioItem {
  token: string;
  amount: string;
  usdValue: string | null;
  allocation: string;
  holdingSince: string | null;
  holdingDays: number | null;
  avgBuyPrice: string | null;
  currentPrice: string | null;
  pnl: string | null;
  roi: string | null;
  priceUnavailable: boolean;
  decimals?: number;
  contractAddress?: string;
}

export type WalletPortfolioResponse = WalletPortfolioItem[];

export type {
  MoralisErc20Balance,
  MoralisNativeBalanceResponse,
};