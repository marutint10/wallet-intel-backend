import { PortfolioDisplayTier } from '../wallet.types';
import { TOKEN_CATEGORY_MAP } from '../constants/token-categories';
import { TokenMarketSignal } from './wallet-pricing.service';

export interface TierClassification {
  displayTier: PortfolioDisplayTier;
  tokenQualityScore: number;
  tokenQualityLabel:
    | 'visible'
    | 'speculative'
    | 'hidden'
    | 'spoofed_major_symbol';
  priceSources: string[];
  liquidityUsd: string | null;
  hiddenReason?: string;
}

/**
 * Minimal subset of WalletPortfolioItem fields needed for tier classification.
 * Kept independent of the full type to avoid coupling.
 */
export interface PortfolioItemForTier {
  token: string;
  amount: string;
  usdValue: string | null;
  allocation: string;
  currentPrice: string | null;
  priceUnavailable: boolean;
  contractAddress?: string;
  isSpoofedMajorSymbol?: boolean;
}

export interface PortfolioTierSignals {
  tradedTokens: Set<string>;
  recentTradedTokens: Set<string>;
  pnlHistoryTokens: Set<string>;
  airdropPatternTokens: Set<string>;
}

// ─── Core allowlist ──────────────────────────────────────────────────────────
// Symbols here are always classified as core regardless of pricing availability.
const CORE_SYMBOL_ALLOWLIST = new Set([
  'ETH',
  'WETH',
  'USDC',
  'USDT',
  'DAI',
  'WBTC',
  'AAVE',
  'LINK',
  'UNI',
  'LDO',
  'OP',
  'ARB',
]);

// ─── Spam / scam keyword fragments (case-insensitive match) ──────────────────
const SPAM_KEYWORDS = [
  'claim',
  'reward',
  'receive at',
  'visit',
  'airdrop',
  'bonus',
  'free',
];

// ─── Legitimate DeFi prefix patterns (Pendle, staking wrappers, etc.) ────────
const SECONDARY_PREFIXES = ['SY-', 'YT-', 'PT-'];

// Amount below this (in token units) is considered dust.
const DUST_AMOUNT_THRESHOLD = 0.001;

// Symbol character length above this (with priceUnavailable) signals promo text.
const MAX_NORMAL_SYMBOL_LENGTH = 20;

// Set of all contract addresses in our known-protocol map.
const KNOWN_PROTOCOL_ADDRESSES = new Set(Object.keys(TOKEN_CATEGORY_MAP));

/**
 * Classify a single portfolio item into a display tier.
 *
 * @param item            - The portfolio item to classify.
 * @param tradedTokens    - Lowercase token symbols that appear in the wallet's
 *                          swap history.  Used to distinguish held DeFi positions
 *                          from spam airdrops.
 */
export function classifyPortfolioTier(
  item: PortfolioItemForTier,
  signals: PortfolioTierSignals,
  marketSignal: TokenMarketSignal | null = null,
): TierClassification {
  if (item.isSpoofedMajorSymbol) {
    return {
      displayTier: 'hidden',
      tokenQualityScore: 0,
      tokenQualityLabel: 'spoofed_major_symbol',
      priceSources: marketSignal?.priceSources ?? [],
      liquidityUsd: formatOptionalUsd(marketSignal?.liquidityUsd ?? null),
      hiddenReason: 'spoofed major-asset symbol with untrusted contract',
    };
  }

  const tokenLower = item.token.toLowerCase();
  const tokenIdentity = toTokenIdentity(item.token, item.contractAddress);
  const usdValue = toFiniteNumber(item.usdValue);
  const tokenAmount = toFiniteNumber(item.amount);
  const isAllowlisted = CORE_SYMBOL_ALLOWLIST.has(item.token.toUpperCase());
  const isKnownContract = Boolean(
    item.contractAddress &&
      KNOWN_PROTOCOL_ADDRESSES.has(item.contractAddress.toLowerCase()),
  );
  const hasSecondaryPrefix = SECONDARY_PREFIXES.some((prefix) =>
    item.token.startsWith(prefix),
  );
  const hasSpamKeyword = SPAM_KEYWORDS.some((keyword) =>
    tokenLower.includes(keyword),
  );
  const longPromoSymbol = item.token.length > MAX_NORMAL_SYMBOL_LENGTH;
  const hasRecentTrade = signals.recentTradedTokens.has(tokenIdentity);
  const hasPnlHistory = signals.pnlHistoryTokens.has(tokenIdentity);
  const hasTradeHistory =
    hasRecentTrade ||
    signals.tradedTokens.has(tokenIdentity) ||
    hasPnlHistory;
  const matchesAirdropPattern = signals.airdropPatternTokens.has(tokenIdentity);
  const hasAnyPrice =
    Boolean(item.currentPrice) || Boolean((marketSignal?.price ?? 0) > 0);
  const hasLiquidity = Boolean((marketSignal?.liquidityUsd ?? 0) > 0);
  const isTrustedToken = isAllowlisted || isKnownContract || hasSecondaryPrefix;
  const isLowWalletValue = usdValue !== null && usdValue < 1;
  const significantWalletValue = usdValue !== null && usdValue >= 10;
  const verySignificantWalletValue = usdValue !== null && usdValue >= 100;
  const isDustAmount =
    tokenAmount !== null && tokenAmount > 0 && tokenAmount < DUST_AMOUNT_THRESHOLD;

  let tokenQualityScore = 50;

  // Positive trust and market signals.
  tokenQualityScore += hasAnyPrice ? 24 : -30;
  tokenQualityScore += hasLiquidity ? 18 : -10;
  tokenQualityScore += hasRecentTrade ? 15 : 0;
  tokenQualityScore += hasTradeHistory ? 8 : -10;
  tokenQualityScore += isTrustedToken ? 16 : 0;
  tokenQualityScore += significantWalletValue ? 12 : 0;
  tokenQualityScore += verySignificantWalletValue ? 8 : 0;

  // Negative spam/noise signals.
  tokenQualityScore += hasSpamKeyword ? -35 : 0;
  tokenQualityScore += longPromoSymbol ? -12 : 0;
  tokenQualityScore += isLowWalletValue ? -15 : 0;
  tokenQualityScore += isDustAmount && !hasTradeHistory ? -10 : 0;
  tokenQualityScore += matchesAirdropPattern ? -22 : 0;
  tokenQualityScore += !hasLiquidity && !hasTradeHistory && !isTrustedToken ? -8 : 0;

  tokenQualityScore = clampScore(tokenQualityScore);

  const qualityLabel: 'visible' | 'speculative' | 'hidden' =
    tokenQualityScore >= 70
      ? 'visible'
      : tokenQualityScore >= 35
        ? 'speculative'
        : 'hidden';
  const displayTier: PortfolioDisplayTier =
    qualityLabel === 'visible'
      ? 'core'
      : qualityLabel === 'speculative'
        ? hasRecentTrade || significantWalletValue || hasLiquidity
          ? 'active'
          : 'secondary'
        : 'hidden';

  return {
    displayTier,
    tokenQualityScore,
    tokenQualityLabel: qualityLabel,
    priceSources: marketSignal?.priceSources ?? [],
    liquidityUsd: formatOptionalUsd(marketSignal?.liquidityUsd ?? null),
    ...(displayTier === 'hidden'
      ? {
          hiddenReason: resolveHiddenReason({
            hasSpamKeyword,
            longPromoSymbol,
            matchesAirdropPattern,
            hasAnyPrice,
            hasLiquidity,
            hasTradeHistory,
            isLowWalletValue,
          }),
        }
      : {}),
  };
}

function resolveHiddenReason(input: {
  hasSpamKeyword: boolean;
  longPromoSymbol: boolean;
  matchesAirdropPattern: boolean;
  hasAnyPrice: boolean;
  hasLiquidity: boolean;
  hasTradeHistory: boolean;
  isLowWalletValue: boolean;
}): string {
  if (input.hasSpamKeyword) {
    return 'spam keyword in token symbol';
  }

  if (input.longPromoSymbol) {
    return 'symbol too long (promo text)';
  }

  if (input.matchesAirdropPattern) {
    return 'random airdrop pattern';
  }

  if (!input.hasAnyPrice && !input.hasLiquidity && !input.hasTradeHistory) {
    return 'no price, liquidity, or trade history';
  }

  if (input.isLowWalletValue && !input.hasTradeHistory) {
    return 'low value and no trade history';
  }

  return 'low token quality score';
}

function toTokenIdentity(token: string, contractAddress?: string): string {
  if (contractAddress) {
    return `contract:${contractAddress.toLowerCase()}`;
  }

  return `symbol:${token.toLowerCase()}`;
}

function toFiniteNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return parsedValue;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function formatOptionalUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return (Math.round(value * 100) / 100).toString();
}
