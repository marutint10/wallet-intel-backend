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
    | 'bridge_out'
    | 'bridge_in'
    | 'lending_deposit'
    | 'lending_withdraw'
    | 'borrow'
    | 'repay'
    | 'vault_deposit'
    | 'vault_withdraw'
    | 'reward_claim'
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
  transactionHash?: string;
  routeHopIndex?: number;
  rawAmount?: string;
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

export type WalletContractSubtype =
  | 'Vesting / Distribution'
  | 'Treasury / Multisig'
  | 'Exchange / Custody'
  | 'Unknown Contract';

export type WalletOperationalSubtype =
  | 'Operational/Treasury'
  | 'Automated/Bot-like';

export type WalletSubtype =
  | WalletContractSubtype
  | WalletOperationalSubtype
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

export type WalletConfidenceLabel = 'low' | 'medium' | 'high';

export interface WalletConfidenceFields {
  confidence: WalletConfidenceLabel;
  confidenceLabel: WalletConfidenceLabel;
  confidenceScore: number;
  confidenceReason: string;
  confidenceReasoning: string[];
}

export type WalletScoreConfidence = WalletConfidenceLabel;

export type WalletScoreGateStatus =
  | 'Eligible'
  | 'Eligible (Holder)'
  | 'Not a Trader Wallet'
  | 'Insufficient Data'
  | 'No Trading Activity'
  | 'Empty Wallet';

export type WalletScorePath =
  | 'trader'
  | 'holder'
  | 'triage_contract'
  | 'triage_operational';

export type WalletScoreBand =
  | 'Unscored'
  | 'Unproven'
  | 'Developing'
  | 'Capable'
  | 'Skilled'
  | 'Exceptional'
  | 'Dormant'
  | 'Basic'
  | 'Solid'
  | 'Strong'
  | 'Premium'
  | 'Institutional'
  | 'Elite';

export interface WalletScoreDimensionBreakdown {
  score: number;
  maxScore: number;
}

export interface TraderWalletScoreBreakdown {
  traderWeightedROI: WalletScoreDimensionBreakdown;
  realizedPnLQuality: WalletScoreDimensionBreakdown;
  profitability: WalletScoreDimensionBreakdown;
  consistency: WalletScoreDimensionBreakdown;
  riskManagement: WalletScoreDimensionBreakdown;
  portfolioQuality: WalletScoreDimensionBreakdown;
  experience: WalletScoreDimensionBreakdown;
  marketAdaptability: WalletScoreDimensionBreakdown;
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

export interface WalletScoreExplanation {
  positives: string[];
  negatives: string[];
  summary: string;
}

export interface WalletScoreResponse {
  address: string;
  score: number;
  scorePath: WalletScorePath;
  confidence: WalletScoreConfidence;
  confidenceLabel: WalletConfidenceLabel;
  confidenceScore: number;
  confidenceReasoning: string[];
  band: WalletScoreBand;
  breakdown: WalletScoreBreakdown;
  scoreExplanation: WalletScoreExplanation;
  gateStatus: WalletScoreGateStatus;
  balancesAvailable: boolean;
  scoredAt: string;
}

export interface WalletScoreWeightedRoiDebug
  extends WalletScoreDimensionDebugSummary {
  traderWeightedROI: WalletScoreMetricDebug;
  avgROI: WalletScoreMetricDebug;
  sampleSizeMultiplier: WalletScoreMetricDebug;
  qualityMultiplier: WalletScoreMetricDebug;
}

export interface WalletScoreRealizedPnLQualityDebug
  extends WalletScoreDimensionDebugSummary {
  totalRealizedPnL: WalletScoreMetricDebug;
  profitFactor: WalletScoreMetricDebug;
  bestWorstRatio: WalletScoreMetricDebug;
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
  sampleAdequacy: WalletScoreMetricDebug;
  totalSwaps: WalletScoreMetricDebug;
  dexDiversity: WalletScoreMetricDebug;
}

export interface WalletScoreMarketAdaptabilityDebug
  extends WalletScoreDimensionDebugSummary {
  dexDiversity: WalletScoreMetricDebug;
  primaryDexShare: WalletScoreMetricDebug;
  categoryDiversity: WalletScoreMetricDebug;
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
  liquidityExcludedHoldingsCount: number;
  adjustedPortfolioUsdForScoring: number;
}

export interface WalletHolderScoreAssetSelectionDebug
  extends WalletScoreDimensionDebugSummary {
  blueChipHoldingPercent: WalletScoreMetricDebug;
  stablecoinHoldingPercent: WalletScoreMetricDebug;
  hasEth: WalletScoreMetricDebug;
}

export interface TraderWalletScoreDebugData {
  traderWeightedROI: WalletScoreWeightedRoiDebug;
  realizedPnLQuality: WalletScoreRealizedPnLQualityDebug;
  profitability: WalletScoreProfitabilityDebug;
  consistency: WalletScoreConsistencyDebug;
  riskManagement: WalletScoreRiskManagementDebug;
  portfolio: WalletScorePortfolioDebug;
  portfolioQuality: WalletScorePortfolioDebug;
  experience: WalletScoreExperienceDebug;
  marketAdaptability: WalletScoreMarketAdaptabilityDebug;
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

export interface WalletTriageResponse {
  walletType: WalletType;
  walletSubtype: WalletContractSubtype | 'Operational/Treasury';
  traderEligible: false;
  scorePath: 'triage_contract' | 'triage_operational';
  confidence: WalletConfidenceLabel;
  confidenceLabel: WalletConfidenceLabel;
  confidenceScore: number;
  confidenceReason: string;
  confidenceReasoning: string[];
  score: null;
  scoreBand: null;
  reasoning: string[];
}

export type WalletScoreOrTriageResult = WalletScoreResult | WalletTriageResponse;

export interface WalletClassification {
  address: string;
  type: string;
  primaryType: string;
  primaryScore: number;
  confidence: WalletConfidenceLabel;
  confidenceLabel: WalletConfidenceLabel;
  confidenceScore: number;
  confidenceReason: string;
  confidenceReasoning: string[];
  description: string;
  traits: string[];
  riskProfile: 'conservative' | 'moderate' | 'aggressive';
  secondaryTypes: string[];
  scoreBreakdown: Record<string, number>;
  allScores: Record<string, number>;
  classifiedAt: string;
}

export type WalletClassificationResult =
  | WalletClassification
  | WalletTriageResponse;

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

export type PortfolioDisplayTier = 'core' | 'active' | 'secondary' | 'hidden';

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
  tokenQualityScore?: number;
  tokenQualityLabel?:
    | 'visible'
    | 'speculative'
    | 'hidden'
    | 'spoofed_major_symbol';
  priceSources?: string[];
  liquidityUsd?: string | null;
  hiddenReason?: string;
}

export type WalletPortfolioResponse = WalletPortfolioItem[];

export interface WalletPortfolioSummary {
  hiddenCount: number;
  hiddenUsdValue: string;
  spamCount: number;
  uiSummary: string;
}

type OptionalReasoningFields<T> = T extends unknown
  ? Omit<T, 'reasoning' | 'confidenceReasoning'> & {
      reasoning?: string[];
      confidenceReasoning?: string[];
    }
  : never;

export type WalletIntelligenceContext = Omit<WalletContextResponse, 'reasoning'> & {
  reasoning?: string[];
};

export type WalletIntelligenceScore =
  OptionalReasoningFields<WalletScoreOrTriageResult>;

export type WalletIntelligenceClassification =
  OptionalReasoningFields<WalletClassificationResult>;

export interface WalletIntelligenceSummary
  extends Omit<WalletSummaryResponse, 'avgROI'> {
  averageTradeRoi: number;
  /** @deprecated Use averageTradeRoi instead. */
  averagePerTradeROI: number;
}

export interface WalletIntelligenceFeatures {
  summary: WalletIntelligenceSummary;
  risk: WalletRiskMetricsResponse;
  holdTime: WalletHoldTimeMetricsResponse;
  activity: WalletActivityMetricsResponse;
  rawFeatureMetrics?: {
    risk: WalletRiskMetricsResponse;
    holdTime: WalletHoldTimeMetricsResponse;
    activity: WalletActivityMetricsResponse;
  };
}

export interface WalletIntelligenceRoiLabels {
  realizedRoi: string;
  averageTradeRoi: string;
  medianTradeRoi: string;
  unrealizedRoi: string;
  scoreAdjustedRoi: string;
  /** @deprecated Use realizedRoi instead. */
  realizedCapitalROI: string;
  /** @deprecated Use averageTradeRoi instead. */
  averagePerTradeROI: string;
  /** @deprecated Use medianTradeRoi instead. */
  medianTradeROI: string;
  /** @deprecated Use unrealizedRoi instead. */
  openPortfolioROI: string;
  /** @deprecated Use scoreAdjustedRoi instead. */
  scoreAdjustedROI: string;
}

export interface WalletIntelligenceRoiSampleWarnings {
  realizedRoi: string | null;
  averageTradeRoi: string | null;
  medianTradeRoi: string | null;
  unrealizedRoi: string | null;
  scoreAdjustedRoi: string | null;
  /** @deprecated Use realizedRoi instead. */
  realizedCapitalROI: string | null;
  /** @deprecated Use averageTradeRoi instead. */
  averagePerTradeROI: string | null;
  /** @deprecated Use medianTradeRoi instead. */
  medianTradeROI: string | null;
  /** @deprecated Use unrealizedRoi instead. */
  openPortfolioROI: string | null;
  /** @deprecated Use scoreAdjustedRoi instead. */
  scoreAdjustedROI: string | null;
}

export interface WalletIntelligencePnlLabels {
  realizedPnL: string;
  unrealizedPnL: string;
  netPnL: string;
}

export interface WalletIntelligenceTrustSignalSampleSize {
  totalSwaps: number;
  pricedTrades: number;
  minimumRecommendedSwaps: number;
  minimumRecommendedPricedTrades: number;
}

export interface WalletIntelligenceTrustSignals {
  confidence: WalletConfidenceLabel;
  sampleSize: WalletIntelligenceTrustSignalSampleSize;
  pricingCoverage: WalletPricingCoverage;
  warnings: string[];
}

export interface WalletIntelligenceTrustSignalLabels {
  confidence: string;
  sampleSize: string;
  pricingCoverage: string;
  warnings: string;
}

export interface WalletIntelligenceMetrics {
  realizedRoi: number;
  averageTradeRoi: number;
  medianTradeRoi: number;
  unrealizedRoi: number;
  scoreAdjustedRoi: number | null;
  /** @deprecated Use realizedRoi instead. */
  realizedCapitalROI: number;
  /** @deprecated Use averageTradeRoi instead. */
  averagePerTradeROI: number;
  /** @deprecated Use medianTradeRoi instead. */
  medianTradeROI: number;
  /** @deprecated Use unrealizedRoi instead. */
  openPortfolioROI: number;
  /** @deprecated Use scoreAdjustedRoi instead. */
  scoreAdjustedROI: number | null;
  realizedPnL: number;
  unrealizedPnL: number;
  netPnL: number;
  roiLabels: WalletIntelligenceRoiLabels;
  pnlLabels: WalletIntelligencePnlLabels;
  roiSampleWarnings: WalletIntelligenceRoiSampleWarnings;
  trustSignals: WalletIntelligenceTrustSignals;
  trustSignalLabels: WalletIntelligenceTrustSignalLabels;
  capitalBase: number;
  portfolioTotalValueUsd: number;
  lifetimeTradeVolumeUsd: number;
  lifetimeTradeCounted: number;
  lifetimeTradeSkipped: number;
  lifetimeTradeConfidence: number;
  roiConfidence: WalletConfidenceLabel;
  realizedCapitalRoiVisible: boolean;
  realizedCapitalRoiNotice: string | null;
  pricingCoverage: WalletPricingCoverage;
  pricingCoverageNotice: string;
}

export interface WalletPricingCoverage {
  totalTrades: number;
  pricedTrades: number;
  unpricedTrades: number;
  coveragePercent: number;
  unsupportedTokens: string[];
  requestsBlockedCount: number;
  providerStatus: Record<string, 'active' | 'cooldown'>;
  cooldownUntil: Record<string, string | null>;
}

export interface WalletIntelligenceLiteResponse {
  address: string;
  analyzedAt: string;
  summary: WalletIntelligenceSummary;
  metrics: WalletIntelligenceMetrics;
  score: WalletIntelligenceScore;
  classification: WalletIntelligenceClassification;
}

export interface WalletIntelligenceResponse
  extends WalletIntelligenceLiteResponse {
  context: WalletIntelligenceContext;
  portfolio: WalletPortfolioResponse;
  visiblePortfolio: WalletPortfolioResponse;
  portfolioSummary: WalletPortfolioSummary;
  hiddenPortfolio?: WalletPortfolioResponse;
  fullPortfolio?: WalletPortfolioResponse;
  features: WalletIntelligenceFeatures;
}

export type WalletIntelligenceResult =
  | WalletIntelligenceLiteResponse
  | WalletIntelligenceResponse;

export interface WalletIntelligenceOptions {
  lite?: boolean;
  verbose?: boolean;
}

export type {
  MoralisErc20Balance,
  MoralisNativeBalanceResponse,
};