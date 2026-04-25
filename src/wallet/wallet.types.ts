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
  tokenName?: string;
}

export interface NormalizedTransaction {
  hash: string;
  block_number: number;
  timestamp: string;
  from: string;
  to: string;
  type:
    | 'transfer'
    | 'swap'
    | 'wrap'
    | 'unwrap'
    | 'liquidity_add'
    | 'liquidity_remove'
    | 'stake'
    | 'unstake'
    | 'staking_wrap'
    | 'staking_unwrap'
    | 'yield_split'
    | 'yield_merge'
    | 'receipt_mint'
    | 'receipt_burn'
    | 'protocol_transform'
    | 'unknown';
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

export interface WalletDexMetricsResponse {
  tradesPerDex: Record<string, number>;
  primaryDex: string | null;
  primaryDexShare: number;
  dexDiversity: number;
  unknownDexPercent: number;
}

export interface WalletTokenCategoryMetricsResponse {
  tradesByCategory: Record<string, number>;
  historicalVolumeByCategory: Record<string, number>;
  dominantTradingCategory: string | null;
  categoryDiversity: number;
  memecoinTradePercent: number;
  blueChipTradePercent: number;
  stablecoinTradePercent: number;
  currentHoldingsByCategory: Record<string, number>;
  dominantHoldingCategory: string | null;
  memecoinHoldingPercent: number;
  blueChipHoldingPercent: number;
  stablecoinHoldingPercent: number;
}

export interface UnknownRouterAddressCount {
  address: string;
  count: number;
}

export interface WalletDexMetricsDebugResponse
  extends WalletDexMetricsResponse {
  unknownRouterAddresses: UnknownRouterAddressCount[];
}

export type WalletDexMetricsResult =
  | WalletDexMetricsResponse
  | WalletDexMetricsDebugResponse;

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

export type WalletScoreConfidence = 'low' | 'medium' | 'high';

export type WalletScoreGateStatus =
  | 'Eligible'
  | 'Eligible (Holder)'
  | 'Not a Trader Wallet'
  | 'Insufficient Data'
  | 'No Trading Activity'
  | 'Empty Wallet';

export type WalletScoreBand =
  | 'Unscored'
  | 'Poor'
  | 'Early'
  | 'Developing'
  | 'Skilled'
  | 'Advanced'
  | 'Elite';

export interface WalletScoreDimensionBreakdown {
  score: number;
  maxScore: number;
}

export interface TraderWalletScoreBreakdown {
  profitability: WalletScoreDimensionBreakdown;
  consistency: WalletScoreDimensionBreakdown;
  riskManagement: WalletScoreDimensionBreakdown;
  portfolioQuality: WalletScoreDimensionBreakdown;
  experience: WalletScoreDimensionBreakdown;
}

export interface HolderWalletScoreBreakdown {
  portfolioQuality: WalletScoreDimensionBreakdown;
  conviction: WalletScoreDimensionBreakdown;
  portfolioSize: WalletScoreDimensionBreakdown;
  assetSelection: WalletScoreDimensionBreakdown;
}

export type WalletScoreBreakdown =
  | TraderWalletScoreBreakdown
  | HolderWalletScoreBreakdown;

export interface WalletScoreResponse {
  address: string;
  score: number;
  confidence: WalletScoreConfidence;
  band: WalletScoreBand;
  breakdown: WalletScoreBreakdown;
  gateStatus: WalletScoreGateStatus;
  balancesAvailable: boolean;
  scoredAt: string;
}

export interface WalletScoreMetricDebug {
  value: number | null;
  score: number;
  weightedContribution: number;
}

export interface WalletScoreDimensionDebugSummary {
  raw: number;
  final: number;
  maxScore: number;
}

export interface WalletScoreProfitabilityDebug
  extends WalletScoreDimensionDebugSummary {
  totalRealizedPnL: WalletScoreMetricDebug;
  avgROI: WalletScoreMetricDebug;
  profitFactor: WalletScoreMetricDebug;
  bestWorstRatio: WalletScoreMetricDebug;
}

export interface WalletScoreConsistencyDebug
  extends WalletScoreDimensionDebugSummary {
  avgWinRate: WalletScoreMetricDebug;
  returnStdDev: WalletScoreMetricDebug;
  burstinessScore: WalletScoreMetricDebug;
  profitableTokenRate: WalletScoreMetricDebug;
}

export interface WalletScoreRiskManagementDebug
  extends WalletScoreDimensionDebugSummary {
  maxDrawdown: WalletScoreMetricDebug;
  concentrationRisk: WalletScoreMetricDebug;
  memecoinTradePercent: WalletScoreMetricDebug;
  stablecoinHoldingPercent: WalletScoreMetricDebug;
  worstTradeImpact: WalletScoreMetricDebug;
}

export interface WalletScorePortfolioDebug
  extends WalletScoreDimensionDebugSummary {
  qualityAssetPercent: WalletScoreMetricDebug;
  profitableTokenPercent: WalletScoreMetricDebug;
  categoryDiversity: WalletScoreMetricDebug;
  uniqueTokens: WalletScoreMetricDebug;
  avgHoldHours: WalletScoreMetricDebug;
}

export interface WalletScoreExperienceDebug
  extends WalletScoreDimensionDebugSummary {
  tradingSpanDays: WalletScoreMetricDebug;
  tradingSpanRatio: WalletScoreMetricDebug;
  totalSwaps: WalletScoreMetricDebug;
  dexDiversity: WalletScoreMetricDebug;
}

export interface WalletHolderScorePortfolioQualityDebug
  extends WalletScoreDimensionDebugSummary {
  qualityAssetPercent: WalletScoreMetricDebug;
  categoryDiversity: WalletScoreMetricDebug;
  uniqueTokenCount: WalletScoreMetricDebug;
  memecoinHoldingPercent: WalletScoreMetricDebug;
}

export interface WalletHolderScoreConvictionDebug
  extends WalletScoreDimensionDebugSummary {
  avgHoldingDays: WalletScoreMetricDebug;
  longestHoldDays: WalletScoreMetricDebug;
  holdingsInProfitPercent: WalletScoreMetricDebug;
  avgUnrealizedROI: WalletScoreMetricDebug;
}

export interface WalletHolderScorePortfolioSizeDebug
  extends WalletScoreDimensionDebugSummary {
  totalPortfolioUsd: WalletScoreMetricDebug;
  largestPositionUsd: WalletScoreMetricDebug;
  nonDustCount: WalletScoreMetricDebug;
  portfolioSizeMultiplier: WalletScoreMetricDebug;
}

export interface WalletHolderScoreAssetSelectionDebug
  extends WalletScoreDimensionDebugSummary {
  blueChipHoldingPercent: WalletScoreMetricDebug;
  stablecoinHoldingPercent: WalletScoreMetricDebug;
  hasEth: WalletScoreMetricDebug;
}

export interface TraderWalletScoreDebugData {
  profitability: WalletScoreProfitabilityDebug;
  consistency: WalletScoreConsistencyDebug;
  riskManagement: WalletScoreRiskManagementDebug;
  portfolio: WalletScorePortfolioDebug;
  experience: WalletScoreExperienceDebug;
}

export interface HolderWalletScoreDebugData {
  portfolioQuality: WalletHolderScorePortfolioQualityDebug;
  conviction: WalletHolderScoreConvictionDebug;
  portfolioSize: WalletHolderScorePortfolioSizeDebug;
  assetSelection: WalletHolderScoreAssetSelectionDebug;
}

export type WalletScoreDebugData =
  | TraderWalletScoreDebugData
  | HolderWalletScoreDebugData;

export interface WalletScoreDebugResponse extends WalletScoreResponse {
  debug: WalletScoreDebugData;
}

export type WalletScoreResult = WalletScoreResponse | WalletScoreDebugResponse;

export interface WalletClassification {
  address: string;
  type: string;
  primaryType: string;
  primaryScore: number;
  confidence: 'low' | 'medium' | 'high';
  description: string;
  traits: string[];
  riskProfile: 'conservative' | 'moderate' | 'aggressive';
  secondaryTypes: string[];
  allScores: Record<string, number>;
  classifiedAt: string;
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

export type PortfolioDisplayTier = 'core' | 'secondary' | 'hidden';

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
  displayTier: PortfolioDisplayTier;
  hiddenReason?: string;
}

export type WalletPortfolioResponse = WalletPortfolioItem[];

export type {
  MoralisErc20Balance,
  MoralisNativeBalanceResponse,
};