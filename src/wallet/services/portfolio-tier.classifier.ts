import { PortfolioDisplayTier } from '../wallet.types';
import { TOKEN_CATEGORY_MAP } from '../constants/token-categories';

export interface TierClassification {
  displayTier: PortfolioDisplayTier;
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
}

export interface PortfolioTierSignals {
  tradedTokens: Set<string>;
  recentTradedTokens: Set<string>;
  pnlHistoryTokens: Set<string>;
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
): TierClassification {
  const tokenLower = item.token.toLowerCase();
  const usdValue = parseFloat(item.usdValue ?? '0');
  const tokenAmount = parseFloat(item.amount);
  const hasTradeHistory =
    signals.tradedTokens.has(tokenLower) ||
    signals.recentTradedTokens.has(tokenLower) ||
    signals.pnlHistoryTokens.has(tokenLower);

  // ── CORE ─────────────────────────────────────────────────────────────────
  const hasStrongUsdValue = Number.isFinite(usdValue) && usdValue > 10;
  const isAllowlisted = CORE_SYMBOL_ALLOWLIST.has(item.token.toUpperCase());

  if (hasStrongUsdValue || (isAllowlisted && usdValue > 1)) {
    return { displayTier: 'core' };
  }

  // ── ACTIVE ───────────────────────────────────────────────────────────────
  const recentlyTraded = signals.recentTradedTokens.has(tokenLower);
  const hasPnlHistory = signals.pnlHistoryTokens.has(tokenLower);
  const hasMeaningfulUsdValue = Number.isFinite(usdValue) && usdValue > 1;

  if (recentlyTraded || hasPnlHistory || hasMeaningfulUsdValue) {
    return { displayTier: 'active' };
  }

  // ── HIDDEN checks (run before secondary) ─────────────────────────────────

  // 1. Spam keyword in the token symbol.
  if (SPAM_KEYWORDS.some((kw) => tokenLower.includes(kw))) {
    return {
      displayTier: 'hidden',
      hiddenReason: 'spam keyword in token name',
    };
  }

  // 2. Abnormally long symbol — typical of promo/scam airdrops.
  if (item.token.length > MAX_NORMAL_SYMBOL_LENGTH) {
    return {
      displayTier: 'hidden',
      hiddenReason: 'symbol too long (promo text)',
    };
  }

  // Shared signals used in rules 3 and 4.
  const isKnownContract = Boolean(
    item.contractAddress &&
      KNOWN_PROTOCOL_ADDRESSES.has(item.contractAddress.toLowerCase()),
  );

  // 3. Fully unpriced + no trade history + not a known protocol contract.
  const isFullyUnpriced =
    item.priceUnavailable &&
    parseFloat(item.allocation) === 0 &&
    item.usdValue === null;

  if (isFullyUnpriced && !hasTradeHistory && !isKnownContract) {
    return {
      displayTier: 'hidden',
      hiddenReason: 'unpriced, no trade history, unknown protocol',
    };
  }

  // 4. Dust amount + unknown token (not traded, not in known-protocol map).
  if (
    tokenAmount < DUST_AMOUNT_THRESHOLD &&
    !hasTradeHistory &&
    !isKnownContract
  ) {
    return { displayTier: 'hidden', hiddenReason: 'dust amount, unknown token' };
  }

  // ── SECONDARY ────────────────────────────────────────────────────────────
  // Legitimate-looking but unpriced DeFi assets.
  if (item.priceUnavailable) {
    const hasSecondaryPrefix = SECONDARY_PREFIXES.some((p) =>
      item.token.startsWith(p),
    );
    const isMeaningfulAmount =
      Number.isFinite(tokenAmount) && tokenAmount >= DUST_AMOUNT_THRESHOLD;
    const isLegitimate = hasSecondaryPrefix || isKnownContract || hasTradeHistory;

    if (isLegitimate && isMeaningfulAmount) {
      return { displayTier: 'secondary' };
    }
  }

  // Fallback: unpriced with no legitimacy signal.
  return {
    displayTier: 'hidden',
    hiddenReason: 'unpriced with no legitimacy signal',
  };
}
