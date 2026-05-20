import { Injectable } from '@nestjs/common';
import { LiteTransfer } from './lite-ingestion.service';
import {
  TokenCategorySlug,
  classifyTokenCategory,
} from '../constants/token-categories';
import type {
  CategoryAllocations,
  HoldingsProfile,
  PortfolioRiskSignal,
} from './lite-portfolio.service';

export interface SwapPair {
  txHash: string;
  timestamp: number;
  ins: LiteTransfer[];
  outs: LiteTransfer[];
}

export interface LiteSwap {
  txHash: string;
  timestamp: number;
  blockNumber: number;
  soldToken: string;
  soldSymbol?: string;
  soldAmount: number;
  boughtToken: string;
  boughtSymbol?: string;
  boughtAmount: number;
  estimatedUsdValue?: number;
  priceSource?: string;
}

export interface LiteFeatureVector {
  address: string;
  chain: string;
  sampleSize: number;

  // Activity
  totalTransfers: number;
  swapCount: number;
  tradingSpanDays: number;
  tradesPerDay: number;
  avgGapHours: number;
  burstinessCoeff: number;

  // Hold time (from FIFO matched swap lots)
  medianHoldHours: number | null;
  holdBuckets: {
    under1h: number;
    under24h: number;
    under7d: number;
    over7d: number;
  };
  matchedLotCount: number;

  // Token preferences
  uniqueTokens: number;
  memecoinPercent: number;
  blueChipPercent: number;
  stablecoinPercent: number;

  // Portfolio diversity (from holdings passed in)
  totalHoldingTokens: number;
  holdingChainCount: number;

  // Holdings-based features (filled when portfolio data is available)
  totalPortfolioUsd?: number;
  trackedTokenWeight?: number;
  portfolioDiversificationScore?: number;
  holdingCategoryMix?: CategoryAllocations;
  portfolioRiskSignal?: PortfolioRiskSignal;

  // FAST_MODE derived features.
  // These replace exact realized hold durations as the primary classification
  // and scoring signals, so the pipeline stays meaningful without FIFO.
  walletAgeDays: number;
  daysSinceLastActivity: number;
  activityConsistencyScore: number; // 0-100, higher = steadier cadence
  portfolioConcentrationScore: number; // 0-100, higher = more concentrated
  fastModeApplied: boolean;
}

/** True when portfolio enrichment was applied (not merely an empty category object). */
export function hasPortfolioContext(features: LiteFeatureVector): boolean {
  if (typeof features.totalPortfolioUsd === 'number' && features.totalPortfolioUsd > 0) {
    return true;
  }

  const mix = features.holdingCategoryMix;
  if (mix && Object.values(mix).some((value) => (value ?? 0) > 0)) {
    return true;
  }

  return (
    typeof features.trackedTokenWeight === 'number' &&
    typeof features.portfolioDiversificationScore === 'number'
  );
}

@Injectable()
export class LiteFeatureService {
  extractFeatures(
    transfers: LiteTransfer[],
    walletAddress: string,
    chain: string,
    holdingTokenCount?: number,
    holdingChainCount?: number,
    holdingsProfile?: HoldingsProfile | null,
    fastMode = false,
  ): LiteFeatureVector {
    const resolvedHoldingTokenCount =
      holdingsProfile?.holdingTokenCount ?? holdingTokenCount ?? 0;
    const resolvedHoldingChainCount = holdingChainCount ?? 1;

    if (!transfers || transfers.length === 0) {
      return this.withHoldingsProfile(
        this.emptyVector(
          walletAddress,
          chain,
          resolvedHoldingTokenCount,
          resolvedHoldingChainCount,
          fastMode,
        ),
        holdingsProfile,
        resolvedHoldingTokenCount,
      );
    }

    // 1. Detect swaps by grouping transfers by txHash
    const swaps = this.detectSwaps(transfers, walletAddress);

    // 2. Compute trading span
    const timestamps = transfers.map((t) => t.timestamp).sort((a, b) => a - b);
    const spanSeconds = timestamps[timestamps.length - 1] - timestamps[0];
    const tradingSpanDays = spanSeconds / 86400;

    // 3. Compute trades per day
    const tradesPerDay = tradingSpanDays > 0 ? swaps.length / tradingSpanDays : 0;

    // 4. Compute average gap between swaps (hours)
    const swapTimestamps = swaps.map((s) => s.timestamp).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < swapTimestamps.length; i++) {
      gaps.push((swapTimestamps[i] - swapTimestamps[i - 1]) / 3600);
    }
    const avgGapHours =
      gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

    // 5. Burstiness coefficient (stddev / mean of gaps)
    const burstinessCoeff = this.computeBurstiness(gaps);

    // 6. Hold time signals.
    // FIFO swap-lot reconstruction is O(swaps * tokens) and only really pays off
    // when we have a near-complete transfer history. In FAST_MODE we are working
    // with a truncated recent slice (FAST_MODE_TRANSFER_LIMIT), so FIFO would be
    // both expensive AND statistically biased. We swap it for a per-token
    // first/last-seen span approximation that scales cleanly with truncation.
    let holdTimes: number[];
    let matchedLotCount: number;
    if (fastMode) {
      holdTimes = this.estimateLightweightHoldHours(transfers);
      matchedLotCount = this.countRoundTripTokens(transfers);
    } else {
      const fifo = this.computeHoldTimes(swaps, walletAddress);
      holdTimes = fifo.holdTimes;
      matchedLotCount = fifo.matchedLotCount;
    }
    const medianHoldHours = holdTimes.length > 0 ? this.median(holdTimes) : null;
    const holdBuckets = this.bucketHoldTimes(holdTimes);

    // 7. Token category analysis
    const allTokenSymbols = transfers.map((t) => t.tokenSymbol.toUpperCase());
    const tokenCategories = transfers.map((t) =>
      classifyTokenCategory(t.tokenContract, t.tokenSymbol, chain),
    );
    const uniqueTokens = new Set(allTokenSymbols).size;
    const memecoinPercent = this.categoryPercent(tokenCategories, 'meme');
    const blueChipPercent = this.categoryPercent(tokenCategories, 'bluechip');
    const stablecoinPercent = this.categoryPercent(tokenCategories, 'stablecoin');

    // 8. FAST_MODE derived features.
    // These are the primary signals classifier/scorer rely on when realized
    // hold durations are not available.
    const nowSeconds = Date.now() / 1000;
    const oldestTimestamp = timestamps[0];
    const newestTimestamp = timestamps[timestamps.length - 1];
    const walletAgeDays = Math.max(0, (nowSeconds - oldestTimestamp) / 86400);
    const daysSinceLastActivity = Math.max(
      0,
      (nowSeconds - newestTimestamp) / 86400,
    );
    const activityConsistencyScore = this.computeActivityConsistencyScore(
      burstinessCoeff,
      tradingSpanDays,
      swaps.length,
    );
    const portfolioConcentrationScore = this.computePortfolioConcentrationScore(
      holdingsProfile,
    );

    return this.withHoldingsProfile(
      {
        address: walletAddress,
        chain,
        sampleSize: transfers.length,
        totalTransfers: transfers.length,
        swapCount: swaps.length,
        tradingSpanDays: Math.round(tradingSpanDays * 10) / 10,
        tradesPerDay: Math.round(tradesPerDay * 100) / 100,
        avgGapHours: Math.round(avgGapHours * 100) / 100,
        burstinessCoeff: Math.round(burstinessCoeff * 100) / 100,
        medianHoldHours,
        holdBuckets,
        matchedLotCount,
        uniqueTokens,
        memecoinPercent,
        blueChipPercent,
        stablecoinPercent,
        totalHoldingTokens: resolvedHoldingTokenCount,
        holdingChainCount: resolvedHoldingChainCount,
        walletAgeDays: Math.round(walletAgeDays * 10) / 10,
        daysSinceLastActivity: Math.round(daysSinceLastActivity * 10) / 10,
        activityConsistencyScore,
        portfolioConcentrationScore: this.computePortfolioConcentrationScore(
          holdingsProfile,
        ),
        fastModeApplied: fastMode,
      },
      holdingsProfile,
      resolvedHoldingTokenCount,
    );
  }

  // IMPROVEMENT 2/3: Always merge portfolio fields in one place so classify/score gates see them.
  private withHoldingsProfile(
    vector: LiteFeatureVector,
    holdingsProfile?: HoldingsProfile | null,
    holdingTokenCount?: number,
  ): LiteFeatureVector {
    if (!holdingsProfile) {
      return vector;
    }

    return {
      ...vector,
      totalPortfolioUsd: holdingsProfile.totalPortfolioUsd,
      trackedTokenWeight: holdingsProfile.trackedTokenWeight,
      portfolioDiversificationScore: holdingsProfile.diversificationScore,
      holdingCategoryMix: holdingsProfile.categoryAllocations,
      portfolioRiskSignal: holdingsProfile.portfolioRiskSignal,
      totalHoldingTokens:
        holdingsProfile.holdingTokenCount ?? holdingTokenCount ?? vector.totalHoldingTokens,
      portfolioConcentrationScore: this.computePortfolioConcentrationScore(
        holdingsProfile,
      ),
    };
  }

  extractSwaps(transfers: LiteTransfer[], walletAddress: string): LiteSwap[] {
    const swapPairs = this.detectSwaps(transfers, walletAddress);
    const swaps: LiteSwap[] = [];

    for (const swap of swapPairs) {
      const sold = this.largestTransfer(swap.outs);
      if (!sold) {
        continue;
      }

      const bought = this.largestTransfer(
        swap.ins.filter(
          (transfer) =>
            transfer.tokenContract.toLowerCase() !== sold.tokenContract.toLowerCase(),
        ),
      );
      if (!bought) {
        continue;
      }

      const liteSwap: LiteSwap = {
        txHash: swap.txHash,
        timestamp: swap.timestamp,
        blockNumber: Math.max(sold.blockNumber, bought.blockNumber),
        soldToken: sold.tokenContract.toLowerCase(),
        soldSymbol: sold.tokenSymbol,
        soldAmount: Number.parseFloat(sold.humanAmount) || 0,
        boughtToken: bought.tokenContract.toLowerCase(),
        boughtSymbol: bought.tokenSymbol,
        boughtAmount: Number.parseFloat(bought.humanAmount) || 0,
      };

      if (liteSwap.soldAmount > 0 && liteSwap.boughtAmount > 0) {
        swaps.push(liteSwap);
      }
    }

    return swaps;
  }

  // Group by txHash. A swap = same tx has IN and OUT with DIFFERENT token contracts.
  private detectSwaps(transfers: LiteTransfer[], walletAddress: string): SwapPair[] {
    const byHash = new Map<string, LiteTransfer[]>();
    for (const transfer of transfers) {
      if (!byHash.has(transfer.txHash)) {
        byHash.set(transfer.txHash, []);
      }
      byHash.get(transfer.txHash)?.push(transfer);
    }

    const swaps: SwapPair[] = [];
    for (const [hash, txs] of byHash.entries()) {
      const ins = txs.filter((transfer) => transfer.direction === 'IN');
      const outs = txs.filter((transfer) => transfer.direction === 'OUT');

      if (ins.length === 0 || outs.length === 0) {
        continue;
      }

      // Different token contracts = it's a swap, not a same-token round-trip
      const inContracts = new Set(ins.map((transfer) => transfer.tokenContract.toLowerCase()));
      const outContracts = new Set(
        outs.map((transfer) => transfer.tokenContract.toLowerCase()),
      );
      const isSwap = [...inContracts].some((contractAddress) => !outContracts.has(contractAddress));

      if (isSwap) {
        swaps.push({ txHash: hash, timestamp: txs[0].timestamp, ins, outs });
      }
    }

    return swaps.sort((a, b) => a.timestamp - b.timestamp);
  }

  // FAST_MODE lightweight hold-duration estimator.
  // Group all observed transfers per token contract and treat the span between
  // the first and last observation as a proxy for how long the wallet was
  // engaged with that token. This is O(N) and tolerates a truncated history.
  private estimateLightweightHoldHours(transfers: LiteTransfer[]): number[] {
    const byToken = new Map<string, number[]>();
    for (const transfer of transfers) {
      const key = transfer.tokenContract.toLowerCase();
      if (!byToken.has(key)) {
        byToken.set(key, []);
      }
      byToken.get(key)?.push(transfer.timestamp);
    }

    const spansHours: number[] = [];
    for (const timestamps of byToken.values()) {
      if (timestamps.length < 2) {
        continue;
      }
      const minTs = Math.min(...timestamps);
      const maxTs = Math.max(...timestamps);
      const spanHours = (maxTs - minTs) / 3600;
      if (spanHours > 0) {
        spansHours.push(spanHours);
      }
    }

    return spansHours;
  }

  // FAST_MODE round-trip proxy for matchedLotCount.
  // Counts tokens for which the wallet has both an inbound and an outbound
  // transfer in the observed window. This stands in for "completed positions"
  // when full FIFO matching is unavailable.
  private countRoundTripTokens(transfers: LiteTransfer[]): number {
    const inTokens = new Set<string>();
    const outTokens = new Set<string>();
    for (const transfer of transfers) {
      const key = transfer.tokenContract.toLowerCase();
      if (transfer.direction === 'IN') {
        inTokens.add(key);
      } else {
        outTokens.add(key);
      }
    }
    let count = 0;
    for (const key of inTokens) {
      if (outTokens.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  private computeActivityConsistencyScore(
    burstinessCoeff: number,
    tradingSpanDays: number,
    swapCount: number,
  ): number {
    // burstiness 0 => perfectly even cadence, >2 => bursty / FOMO pattern.
    const burstinessFactor = Math.max(0, Math.min(1, 1 - burstinessCoeff / 3));
    const spanFactor =
      swapCount > 0 ? Math.max(0, Math.min(1, tradingSpanDays / 180)) : 0;
    return Math.round((burstinessFactor * 0.7 + spanFactor * 0.3) * 100);
  }

  private computePortfolioConcentrationScore(
    holdingsProfile?: HoldingsProfile | null,
  ): number {
    if (!holdingsProfile) {
      return 0;
    }
    const tracked = holdingsProfile.trackedTokenWeight ?? 0;
    const topHoldingMax = (holdingsProfile.topHoldings ?? []).reduce(
      (acc, holding) => Math.max(acc, holding.weight ?? 0),
      0,
    );
    return Math.round(Math.max(tracked, topHoldingMax));
  }

  // For each token: match OUT swaps to the earliest IN swap (FIFO).
  // Hold time = sell timestamp - buy timestamp.
  private computeHoldTimes(
    swaps: SwapPair[],
    walletAddress: string,
  ): { holdTimes: number[]; matchedLotCount: number } {
    // Build buy queue per token: token contract -> [{timestamp, amount}]
    const buyQueues = new Map<string, Array<{ timestamp: number; amount: number }>>();
    const holdTimes: number[] = [];

    for (const swap of swaps) {
      // BUYs = tokens coming IN
      for (const transfer of swap.ins) {
        const key = transfer.tokenContract.toLowerCase();
        if (!buyQueues.has(key)) {
          buyQueues.set(key, []);
        }
        buyQueues.get(key)?.push({
          timestamp: swap.timestamp,
          amount: Number.parseFloat(transfer.humanAmount) || 0,
        });
      }

      // SELLs = tokens going OUT - match to oldest buy (FIFO)
      for (const transfer of swap.outs) {
        const key = transfer.tokenContract.toLowerCase();
        const queue = buyQueues.get(key);
        if (queue && queue.length > 0) {
          const oldestBuy = queue.shift();
          if (!oldestBuy) {
            continue;
          }
          const holdHours = (swap.timestamp - oldestBuy.timestamp) / 3600;
          if (holdHours >= 0) {
            holdTimes.push(holdHours);
          }
        }
      }
    }

    return { holdTimes, matchedLotCount: holdTimes.length };
  }

  private bucketHoldTimes(holdTimes: number[]): {
    under1h: number;
    under24h: number;
    under7d: number;
    over7d: number;
  } {
    return {
      under1h: holdTimes.filter((hours) => hours < 1).length,
      under24h: holdTimes.filter((hours) => hours >= 1 && hours < 24).length,
      under7d: holdTimes.filter((hours) => hours >= 24 && hours < 168).length,
      over7d: holdTimes.filter((hours) => hours >= 168).length,
    };
  }

  private computeBurstiness(gaps: number[]): number {
    if (gaps.length < 2) {
      return 0;
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean === 0) {
      return 0;
    }
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    return Math.sqrt(variance) / mean;
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private categoryPercent(
    categories: TokenCategorySlug[],
    targetCategory: TokenCategorySlug,
  ): number {
    if (categories.length === 0) {
      return 0;
    }
    const count = categories.filter((category) => category === targetCategory).length;
    return Math.round((count / categories.length) * 100);
  }

  private largestTransfer(transfers: LiteTransfer[]): LiteTransfer | null {
    if (transfers.length === 0) {
      return null;
    }

    return [...transfers].sort(
      (left, right) =>
        (Number.parseFloat(right.humanAmount) || 0) -
        (Number.parseFloat(left.humanAmount) || 0),
    )[0];
  }

  private emptyVector(
    address: string,
    chain: string,
    holdingTokenCount: number,
    holdingChainCount: number,
    fastMode = false,
  ): LiteFeatureVector {
    return {
      address,
      chain,
      sampleSize: 0,
      totalTransfers: 0,
      swapCount: 0,
      tradingSpanDays: 0,
      tradesPerDay: 0,
      avgGapHours: 0,
      burstinessCoeff: 0,
      medianHoldHours: null,
      holdBuckets: {
        under1h: 0,
        under24h: 0,
        under7d: 0,
        over7d: 0,
      },
      matchedLotCount: 0,
      uniqueTokens: 0,
      memecoinPercent: 0,
      blueChipPercent: 0,
      stablecoinPercent: 0,
      totalHoldingTokens: holdingTokenCount,
      holdingChainCount,
      walletAgeDays: 0,
      daysSinceLastActivity: 0,
      activityConsistencyScore: 0,
      portfolioConcentrationScore: 0,
      fastModeApplied: fastMode,
    };
  }
}
