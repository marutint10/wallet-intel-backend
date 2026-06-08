import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type MarketContextStatus = 'done' | 'partial' | 'error' | 'unknown';
export type MarketContextRiskLevel =
  | 'low'
  | 'moderate'
  | 'high'
  | 'severe'
  | 'unknown';
export type MarketContextConfidence = 'low' | 'medium' | 'high';
export type MaturityTier =
  | 'new'
  | 'early'
  | 'established'
  | 'bluechip'
  | 'unknown';
export type LiquidityRiskLevel =
  | 'low'
  | 'moderate'
  | 'high'
  | 'severe'
  | 'unknown';

export interface MarketContextReport {
  status: MarketContextStatus;
  score: number | null;
  riskLevel: MarketContextRiskLevel;
  maturityTier: MaturityTier;
  verdict: string;
  confidence: MarketContextConfidence;

  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;

  tokenAgeDays: number | null;
  firstSeenAt: string | null;

  exchangeContext: {
    cexSignals: {
      exchangeSupplyPct: number | null;
      exchangeWalletCount: number | null;
      interpretation: string;
    };
    dexSignals: {
      pairCount: number | null;
      topPairLiquidityUsd: number | null;
      totalDexLiquidityUsd: number | null;
      mainDex: string | null;
    };
  };

  liquidityRisk: {
    level: LiquidityRiskLevel;
    reason: string;
  };

  maturitySignals: Array<{
    strength: 'low' | 'medium' | 'high';
    title: string;
    description: string;
  }>;

  riskFlags: Array<{
    severity: 'low' | 'medium' | 'high' | 'severe';
    title: string;
    description: string;
  }>;

  unknowns: string[];
  limitations: string[];
  checkedAt: string;
}

export interface MarketContextCollectedData {
  contractAddress: string;
  chain: string;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  tokenAgeDays: number | null;
  firstSeenAt: string | null;
  exchangeSupplyPct: number | null;
  exchangeWalletCount: number | null;
  pairCount: number | null;
  topPairLiquidityUsd: number | null;
  totalDexLiquidityUsd: number | null;
  mainDex: string | null;
  fetchError: string | null;
}

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

interface CoinGeckoMarketResponse {
  genesis_date?: string;
  market_data?: {
    market_cap?: { usd?: number };
    fully_diluted_valuation?: { usd?: number };
    total_volume?: { usd?: number };
  };
}

@Injectable()
export class TokenMarketContextService {
  private readonly logger = new Logger(TokenMarketContextService.name);

  constructor(private readonly config: ConfigService) {}

  async buildReport(input: {
    contractAddress: string;
    chain: string;
    qualityMetrics?: Record<string, unknown> | null;
    distribution?: unknown;
    holdersData?: unknown[] | null;
  }): Promise<MarketContextReport> {
    const address = input.contractAddress.trim().toLowerCase();
    const quality = input.qualityMetrics ?? {};
    const distribution = asRecord(input.distribution);

    const persistedLiquidity = safeNumberOrNull(quality.liquidityUsd);
    const liquidityPairs = Array.isArray(quality.liquidityPairs)
      ? (quality.liquidityPairs as Array<Record<string, unknown>>)
      : [];
    const tokenPriceUsd = safeNumberOrNull(quality.tokenPriceUsd);
    const circulatingSupply = safeNumberOrNull(quality.circulatingSupply);

    const supplyBreakdown = asRecord(distribution.supplyBreakdown);
    const exchangeEntry = asRecord(supplyBreakdown.exchange);
    const exchangeSupplyPct = safeNumberOrNull(exchangeEntry.pctOfSupply);

    const exchangeWalletCount = countExchangeWallets(input.holdersData);

    let marketCapUsd =
      tokenPriceUsd !== null && circulatingSupply !== null
        ? tokenPriceUsd * circulatingSupply
        : null;
    let fdvUsd: number | null = null;
    let liquidityUsd = persistedLiquidity;
    let volume24hUsd: number | null = null;
    let priceChange24hPct: number | null = null;
    let tokenAgeDays: number | null = null;
    let firstSeenAt: string | null = null;
    let pairCount: number | null = liquidityPairs.length > 0 ? liquidityPairs.length : null;
    let topPairLiquidityUsd: number | null = null;
    let totalDexLiquidityUsd: number | null = null;
    let mainDex: string | null = null;
    let fetchError: string | null = null;

    const dexData = await this.fetchDexScreenerMarketData(address, input.chain);
    if (dexData.usedDexScreener) {
      liquidityUsd = liquidityUsd ?? dexData.liquidityUsd;
      fdvUsd = dexData.fdvUsd ?? fdvUsd;
      marketCapUsd = dexData.marketCapUsd ?? marketCapUsd;
      volume24hUsd = dexData.volume24hUsd;
      priceChange24hPct = dexData.priceChange24hPct;
      pairCount = dexData.pairCount;
      topPairLiquidityUsd = dexData.topPairLiquidityUsd;
      totalDexLiquidityUsd = dexData.totalDexLiquidityUsd;
      mainDex = dexData.mainDex;
      if (dexData.firstSeenAt) {
        firstSeenAt = dexData.firstSeenAt;
        tokenAgeDays = dexData.tokenAgeDays;
      }
    } else if (liquidityPairs.length > 0) {
      topPairLiquidityUsd = safeNumberOrNull(liquidityPairs[0]?.liquidityUsd);
      totalDexLiquidityUsd = liquidityPairs.reduce(
        (sum, pair) => sum + safeNumber(pair.liquidityUsd),
        0,
      );
      mainDex = safeStringOrNull(liquidityPairs[0]?.dex);
    }

    if (tokenAgeDays === null || marketCapUsd === null || volume24hUsd === null) {
      const coinGecko = await this.fetchCoinGeckoMarketData(address, input.chain);
      if (coinGecko.usedCoinGecko) {
        marketCapUsd = marketCapUsd ?? coinGecko.marketCapUsd;
        fdvUsd = fdvUsd ?? coinGecko.fdvUsd;
        volume24hUsd = volume24hUsd ?? coinGecko.volume24hUsd;
        if (coinGecko.tokenAgeDays !== null) {
          tokenAgeDays = coinGecko.tokenAgeDays;
          firstSeenAt = coinGecko.firstSeenAt;
        }
      } else if (!dexData.usedDexScreener) {
        fetchError = 'Market data providers unavailable or returned no data';
      }
    }

    return buildMarketContextReport({
      contractAddress: address,
      chain: input.chain,
      marketCapUsd,
      fdvUsd,
      liquidityUsd,
      volume24hUsd,
      priceChange24hPct,
      tokenAgeDays,
      firstSeenAt,
      exchangeSupplyPct,
      exchangeWalletCount,
      pairCount,
      topPairLiquidityUsd,
      totalDexLiquidityUsd,
      mainDex,
      fetchError,
    });
  }

  private async fetchDexScreenerMarketData(
    contractAddress: string,
    chain: string,
  ): Promise<{
    usedDexScreener: boolean;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPct: number | null;
    pairCount: number | null;
    topPairLiquidityUsd: number | null;
    totalDexLiquidityUsd: number | null;
    mainDex: string | null;
    tokenAgeDays: number | null;
    firstSeenAt: string | null;
  }> {
    const empty = {
      usedDexScreener: false,
      marketCapUsd: null,
      fdvUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      priceChange24hPct: null,
      pairCount: null,
      topPairLiquidityUsd: null,
      totalDexLiquidityUsd: null,
      mainDex: null,
      tokenAgeDays: null,
      firstSeenAt: null,
    };

    const dexChain = this.getDexScreenerChainId(chain);
    if (!dexChain) {
      return empty;
    }

    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      );
      if (!response.ok) {
        return empty;
      }

      const payload = (await response.json()) as DexScreenerResponse;
      const pairs = (payload.pairs ?? []).filter((pair) => pair.chainId === dexChain);
      if (pairs.length === 0) {
        return empty;
      }

      const sorted = [...pairs].sort(
        (left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0),
      );
      const best = sorted[0];
      const totalLiquidity = pairs.reduce(
        (sum, pair) => sum + (pair.liquidity?.usd ?? 0),
        0,
      );
      const totalVolume = pairs.reduce((sum, pair) => sum + (pair.volume?.h24 ?? 0), 0);

      const createdTimestamps = pairs
        .map((pair) => pair.pairCreatedAt)
        .filter((value): value is number => typeof value === 'number' && value > 0);
      const oldestCreated =
        createdTimestamps.length > 0 ? Math.min(...createdTimestamps) : null;
      const firstSeenAt =
        oldestCreated !== null ? new Date(oldestCreated).toISOString() : null;
      const tokenAgeDays =
        oldestCreated !== null
          ? Math.floor((Date.now() - oldestCreated) / (24 * 60 * 60 * 1000))
          : null;

      return {
        usedDexScreener: true,
        marketCapUsd: best.marketCap ?? null,
        fdvUsd: best.fdv ?? null,
        liquidityUsd: best.liquidity?.usd ?? null,
        volume24hUsd: totalVolume > 0 ? totalVolume : best.volume?.h24 ?? null,
        priceChange24hPct: best.priceChange?.h24 ?? null,
        pairCount: pairs.length,
        topPairLiquidityUsd: best.liquidity?.usd ?? null,
        totalDexLiquidityUsd: totalLiquidity > 0 ? totalLiquidity : null,
        mainDex: best.dexId ?? null,
        tokenAgeDays,
        firstSeenAt,
      };
    } catch (err: unknown) {
      this.logger.warn(`DexScreener market context failed: ${getErrorMessage(err)}`);
      return empty;
    }
  }

  private async fetchCoinGeckoMarketData(
    contractAddress: string,
    chain: string,
  ): Promise<{
    usedCoinGecko: boolean;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    volume24hUsd: number | null;
    tokenAgeDays: number | null;
    firstSeenAt: string | null;
  }> {
    const empty = {
      usedCoinGecko: false,
      marketCapUsd: null,
      fdvUsd: null,
      volume24hUsd: null,
      tokenAgeDays: null,
      firstSeenAt: null,
    };

    const platform = this.getCoinGeckoPlatform(chain);
    if (!platform) {
      return empty;
    }

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${platform}/contract/${contractAddress}`,
      );
      if (!response.ok) {
        return empty;
      }

      const payload = (await response.json()) as CoinGeckoMarketResponse;
      const genesisDate = payload.genesis_date;
      let tokenAgeDays: number | null = null;
      let firstSeenAt: string | null = null;
      if (genesisDate) {
        const genesisMs = Date.parse(genesisDate);
        if (Number.isFinite(genesisMs)) {
          firstSeenAt = new Date(genesisMs).toISOString();
          tokenAgeDays = Math.floor((Date.now() - genesisMs) / (24 * 60 * 60 * 1000));
        }
      }

      return {
        usedCoinGecko: true,
        marketCapUsd: payload.market_data?.market_cap?.usd ?? null,
        fdvUsd: payload.market_data?.fully_diluted_valuation?.usd ?? null,
        volume24hUsd: payload.market_data?.total_volume?.usd ?? null,
        tokenAgeDays,
        firstSeenAt,
      };
    } catch (err: unknown) {
      this.logger.warn(`CoinGecko market context failed: ${getErrorMessage(err)}`);
      return empty;
    }
  }

  private getDexScreenerChainId(chain: string): string | null {
    const map: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon',
      base: 'base',
      bsc: 'bsc',
    };
    return map[chain.toLowerCase()] ?? null;
  }

  private getCoinGeckoPlatform(chain: string): string | null {
    const map: Record<string, string> = {
      ethereum: 'ethereum',
      polygon: 'polygon-pos',
      base: 'base',
      bsc: 'binance-smart-chain',
    };
    return map[chain.toLowerCase()] ?? null;
  }
}

export function buildMarketContextReport(
  data: MarketContextCollectedData,
): MarketContextReport {
  const checkedAt = new Date().toISOString();
  const unknowns: string[] = [];
  const limitations: string[] = [
    'Market maturity and liquidity context are shown separately and are not yet merged into the visible on-chain score.',
    'Off-chain website/news credibility is not included in this module.',
    'Market context uses public market/liquidity data and may lag real-time conditions.',
  ];

  const hasCoreMarketData =
    data.marketCapUsd !== null ||
    data.liquidityUsd !== null ||
    data.volume24hUsd !== null;
  const hasAge = data.tokenAgeDays !== null;

  if (!hasCoreMarketData) {
    unknowns.push('Missing market cap, liquidity, or volume data');
  }
  if (!hasAge) {
    unknowns.push('Token age unavailable');
  }
  if (data.fetchError) {
    unknowns.push(data.fetchError);
    limitations.push(data.fetchError);
  }

  let status: MarketContextStatus = 'done';
  if (!hasCoreMarketData || !hasAge) {
    status = 'partial';
  }
  if (!hasCoreMarketData && !hasAge) {
    status = 'unknown';
  }

  const liquidityRisk = resolveLiquidityRisk(data.liquidityUsd, data.volume24hUsd);
  const scoring = scoreMarketContext(data);
  const maturityTier = resolveMaturityTier(data, liquidityRisk.level);
  const maturitySignals = buildMaturitySignals(data, maturityTier);
  const riskFlags = buildRiskFlags(data, liquidityRisk);

  const confidence = resolveConfidence(data, hasCoreMarketData, hasAge);
  const riskLevel =
    scoring.score === null && status === 'unknown'
      ? 'unknown'
      : scoring.riskLevel;
  const verdict = resolveMarketVerdict(riskLevel, maturityTier, riskFlags, data);

  return {
    status,
    score: scoring.score,
    riskLevel,
    maturityTier,
    verdict,
    confidence,
    marketCapUsd: nullableRound(data.marketCapUsd),
    fdvUsd: nullableRound(data.fdvUsd),
    liquidityUsd: nullableRound(data.liquidityUsd),
    volume24hUsd: nullableRound(data.volume24hUsd),
    priceChange24hPct: nullableRound(data.priceChange24hPct, 2),
    tokenAgeDays: data.tokenAgeDays,
    firstSeenAt: data.firstSeenAt,
    exchangeContext: {
      cexSignals: {
        exchangeSupplyPct: nullableRound(data.exchangeSupplyPct, 2),
        exchangeWalletCount: data.exchangeWalletCount,
        interpretation: interpretExchangeContext(data.exchangeSupplyPct),
      },
      dexSignals: {
        pairCount: data.pairCount,
        topPairLiquidityUsd: nullableRound(data.topPairLiquidityUsd),
        totalDexLiquidityUsd: nullableRound(data.totalDexLiquidityUsd),
        mainDex: data.mainDex,
      },
    },
    liquidityRisk,
    maturitySignals,
    riskFlags,
    unknowns,
    limitations,
    checkedAt,
  };
}

function scoreMarketContext(data: MarketContextCollectedData): {
  score: number | null;
  riskLevel: MarketContextRiskLevel;
} {
  if (
    data.marketCapUsd === null &&
    data.liquidityUsd === null &&
    data.volume24hUsd === null
  ) {
    return { score: null, riskLevel: 'unknown' };
  }

  let score = 50;

  if (data.marketCapUsd !== null) {
    if (data.marketCapUsd >= 10_000_000_000) {
      score += 25;
    } else if (data.marketCapUsd >= 1_000_000_000) {
      score += 18;
    } else if (data.marketCapUsd >= 100_000_000) {
      score += 10;
    } else if (data.marketCapUsd >= 20_000_000) {
      score += 3;
    } else {
      score -= 8;
    }
  }

  if (data.liquidityUsd !== null) {
    if (data.liquidityUsd >= 50_000_000) {
      score += 20;
    } else if (data.liquidityUsd >= 10_000_000) {
      score += 14;
    } else if (data.liquidityUsd >= 1_000_000) {
      score += 6;
    } else if (data.liquidityUsd >= 250_000) {
      score += 0;
    } else {
      score -= 15;
    }
  } else {
    score -= 4;
  }

  if (data.volume24hUsd !== null && data.liquidityUsd !== null && data.liquidityUsd > 0) {
    const ratio = data.volume24hUsd / data.liquidityUsd;
    if (ratio >= 0.05 && ratio <= 2 && data.liquidityUsd >= 1_000_000) {
      score += 5;
    } else if (ratio > 3 && data.liquidityUsd < 1_000_000) {
      score -= 8;
    } else if (ratio < 0.01 && data.liquidityUsd < 1_000_000) {
      score -= 10;
    }
  }

  if (data.tokenAgeDays !== null) {
    if (data.tokenAgeDays >= 365 * 5) {
      score += 20;
    } else if (data.tokenAgeDays >= 365 * 2) {
      score += 14;
    } else if (data.tokenAgeDays >= 365) {
      score += 8;
    } else if (data.tokenAgeDays >= 90) {
      score += 2;
    } else if (data.tokenAgeDays < 30) {
      score -= 12;
    }
  }

  if (data.exchangeSupplyPct !== null) {
    if (data.exchangeSupplyPct >= 10 && data.exchangeSupplyPct <= 60) {
      score += 5;
    } else if (data.exchangeSupplyPct > 70) {
      score -= 4;
    } else if (data.exchangeSupplyPct < 2) {
      score -= 4;
    }
  }

  score = clamp(Math.round(score), 0, 100);
  return { score, riskLevel: resolveMarketRiskLevel(score) };
}

function resolveMaturityTier(
  data: MarketContextCollectedData,
  liquidityLevel: LiquidityRiskLevel,
): MaturityTier {
  const age = data.tokenAgeDays;
  const marketCap = data.marketCapUsd;
  const liquidityStrong =
    data.liquidityUsd !== null && data.liquidityUsd >= 10_000_000;

  if (age === null && marketCap === null) {
    return 'unknown';
  }

  if (
    marketCap !== null &&
    marketCap >= 5_000_000_000 &&
    age !== null &&
    age >= 365 * 3 &&
    liquidityStrong &&
    liquidityLevel !== 'high' &&
    liquidityLevel !== 'severe'
  ) {
    return 'bluechip';
  }

  if (
    marketCap !== null &&
    marketCap >= 500_000_000 &&
    age !== null &&
    age >= 365
  ) {
    return 'established';
  }

  if ((age !== null && age >= 90) || (marketCap !== null && marketCap >= 20_000_000)) {
    return 'early';
  }

  if (age !== null && age < 90) {
    return 'new';
  }

  return 'unknown';
}

function resolveLiquidityRisk(
  liquidityUsd: number | null,
  volume24hUsd: number | null,
): { level: LiquidityRiskLevel; reason: string } {
  if (liquidityUsd === null) {
    return { level: 'unknown', reason: 'Liquidity depth unavailable' };
  }
  if (liquidityUsd < 250_000) {
    return {
      level: 'severe',
      reason: 'Very shallow on-chain/DEX liquidity relative to tradable size',
    };
  }
  if (liquidityUsd < 1_000_000) {
    return {
      level: 'high',
      reason: 'Limited liquidity depth may amplify price impact',
    };
  }
  if (liquidityUsd < 10_000_000) {
    return {
      level: 'moderate',
      reason: 'Moderate liquidity depth; larger trades may still move price',
    };
  }
  if (volume24hUsd !== null && volume24hUsd < 100_000 && liquidityUsd < 50_000_000) {
    return {
      level: 'moderate',
      reason: 'Liquidity exists but recent trading activity appears weak',
    };
  }
  return {
    level: 'low',
    reason: 'Liquidity depth appears supportive for broader market access',
  };
}

function buildMaturitySignals(
  data: MarketContextCollectedData,
  maturityTier: MaturityTier,
): MarketContextReport['maturitySignals'] {
  const signals: MarketContextReport['maturitySignals'] = [];

  if (data.marketCapUsd !== null && data.marketCapUsd >= 1_000_000_000) {
    signals.push({
      strength: data.marketCapUsd >= 10_000_000_000 ? 'high' : 'medium',
      title: 'Large Market Cap',
      description: 'Token shows a large reported market capitalization.',
    });
  }

  if (data.liquidityUsd !== null && data.liquidityUsd >= 10_000_000) {
    signals.push({
      strength: data.liquidityUsd >= 50_000_000 ? 'high' : 'medium',
      title: 'Deep Liquidity',
      description: 'DEX liquidity depth appears supportive for trading access.',
    });
  }

  if (data.tokenAgeDays !== null && data.tokenAgeDays >= 365) {
    signals.push({
      strength: data.tokenAgeDays >= 365 * 5 ? 'high' : 'medium',
      title: 'Established Token Age',
      description: 'Token has been present in market data for an extended period.',
    });
  }

  if (
    data.exchangeSupplyPct !== null &&
    data.exchangeSupplyPct >= 10 &&
    data.exchangeSupplyPct <= 60
  ) {
    signals.push({
      strength: 'medium',
      title: 'Strong Exchange Access',
      description: 'A meaningful share of supply sits in exchange custody, suggesting CEX access.',
    });
  }

  if (data.volume24hUsd !== null && data.volume24hUsd >= 5_000_000) {
    signals.push({
      strength: data.volume24hUsd >= 50_000_000 ? 'high' : 'medium',
      title: 'Active Trading Volume',
      description: 'Recent trading volume suggests active market participation.',
    });
  }

  if (data.pairCount !== null && data.pairCount >= 3) {
    signals.push({
      strength: 'low',
      title: 'Multiple Trading Venues',
      description: 'Multiple DEX pairs were detected for this token.',
    });
  }

  if (maturityTier === 'bluechip' || maturityTier === 'established') {
    signals.push({
      strength: 'medium',
      title: 'Mature Market Profile',
      description: 'Combined market cap, age, and liquidity suggest a more mature market profile.',
    });
  }

  return signals;
}

function buildRiskFlags(
  data: MarketContextCollectedData,
  liquidityRisk: { level: LiquidityRiskLevel; reason: string },
): MarketContextReport['riskFlags'] {
  const flags: MarketContextReport['riskFlags'] = [];

  if (data.liquidityUsd !== null && data.liquidityUsd < 1_000_000) {
    flags.push({
      severity: data.liquidityUsd < 250_000 ? 'high' : 'medium',
      title: 'Low Liquidity',
      description: liquidityRisk.reason,
    });
  }

  if (
    data.fdvUsd !== null &&
    data.liquidityUsd !== null &&
    data.fdvUsd > 0 &&
    data.liquidityUsd / data.fdvUsd < 0.001
  ) {
    flags.push({
      severity: 'medium',
      title: 'High FDV / Low Liquidity',
      description: 'Fully diluted valuation is high relative to visible DEX liquidity depth.',
    });
  }

  if (data.tokenAgeDays !== null && data.tokenAgeDays < 30) {
    flags.push({
      severity: 'high',
      title: 'New Token',
      description: 'Token age is very short based on available market data.',
    });
  } else if (data.tokenAgeDays !== null && data.tokenAgeDays < 90) {
    flags.push({
      severity: 'medium',
      title: 'New Token',
      description: 'Token appears relatively new based on available market data.',
    });
  }

  if (
    data.volume24hUsd !== null &&
    data.volume24hUsd < 250_000 &&
    data.liquidityUsd !== null &&
    data.liquidityUsd < 10_000_000
  ) {
    flags.push({
      severity: 'medium',
      title: 'Weak Trading Activity',
      description: 'Recent trading volume appears limited relative to liquidity.',
    });
  }

  if (data.exchangeSupplyPct !== null && data.exchangeSupplyPct > 70) {
    flags.push({
      severity: 'low',
      title: 'Excessive CEX Custody',
      description: 'A very large share of supply sits in exchange custody.',
    });
  }

  if (
    data.marketCapUsd === null &&
    data.liquidityUsd === null &&
    data.volume24hUsd === null
  ) {
    flags.push({
      severity: 'medium',
      title: 'Missing Market Data',
      description: 'Core market metrics were unavailable from current data sources.',
    });
  }

  if (liquidityRisk.level === 'high' || liquidityRisk.level === 'severe') {
    flags.push({
      severity: liquidityRisk.level === 'severe' ? 'high' : 'medium',
      title: 'Thin Market Depth',
      description: liquidityRisk.reason,
    });
  }

  return flags;
}

function resolveMarketVerdict(
  riskLevel: MarketContextRiskLevel,
  maturityTier: MaturityTier,
  riskFlags: MarketContextReport['riskFlags'],
  data: MarketContextCollectedData,
): string {
  if (riskLevel === 'unknown') {
    return 'Market maturity could not be fully assessed';
  }
  if (riskLevel === 'severe' || riskLevel === 'high') {
    return 'Market maturity and liquidity profile require careful review';
  }
  if (maturityTier === 'bluechip' || maturityTier === 'established') {
    return 'Market maturity appears strong based on available market and liquidity data';
  }
  if (riskFlags.some((flag) => flag.title === 'Low Liquidity')) {
    return 'Liquidity depth appears limited relative to market size';
  }
  if (data.volume24hUsd !== null && data.liquidityUsd !== null && data.liquidityUsd >= 1_000_000) {
    return 'Market access and liquidity appear supportive, but holder risk remains separate';
  }
  return 'Market context is mixed and should be reviewed alongside holder risk';
}

function interpretExchangeContext(exchangeSupplyPct: number | null): string {
  if (exchangeSupplyPct === null) {
    return 'Exchange custody share unavailable';
  }
  if (exchangeSupplyPct >= 10 && exchangeSupplyPct <= 60) {
    return 'Exchange custody suggests reasonable CEX accessibility without extreme concentration';
  }
  if (exchangeSupplyPct > 70) {
    return 'Very high exchange custody may reduce float available outside CEX wallets';
  }
  if (exchangeSupplyPct < 2) {
    return 'Very low visible exchange custody; CEX accessibility may be harder to infer from holders alone';
  }
  return 'Exchange custody is one liquidity-access signal, not a direct holder-risk score';
}

function resolveMarketRiskLevel(score: number): MarketContextRiskLevel {
  if (score >= 85) {
    return 'low';
  }
  if (score >= 70) {
    return 'moderate';
  }
  if (score >= 45) {
    return 'high';
  }
  return 'severe';
}

function resolveConfidence(
  data: MarketContextCollectedData,
  hasCoreMarketData: boolean,
  hasAge: boolean,
): MarketContextConfidence {
  if (hasCoreMarketData && hasAge) {
    return 'high';
  }
  if (hasCoreMarketData || hasAge) {
    return 'medium';
  }
  return 'low';
}

function countExchangeWallets(holdersData: unknown[] | null | undefined): number | null {
  if (!Array.isArray(holdersData)) {
    return null;
  }
  const count = holdersData.filter((holder) => {
    if (!holder || typeof holder !== 'object') {
      return false;
    }
    const label = String((holder as Record<string, unknown>).walletLabel ?? '').toLowerCase();
    return label === 'exchange' || label === 'cex_deposit';
  }).length;
  return count;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nullableRound(value: number | null, digits = 0): number | null {
  if (value === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
