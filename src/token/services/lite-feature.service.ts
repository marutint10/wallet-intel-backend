import { Injectable } from '@nestjs/common';
import { LiteTransfer } from './lite-ingestion.service';

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
}

// These are the same token categories from your existing shared constants.
// For now, define inline. Later we can import from src/shared/constants/token-categories.ts
const STABLECOINS = new Set([
  'USDC',
  'USDT',
  'DAI',
  'FRAX',
  'LUSD',
  'TUSD',
  'BUSD',
  'USDP',
  'GUSD',
  'USDD',
]);

const BLUE_CHIPS = new Set([
  'ETH',
  'WETH',
  'WBTC',
  'BTC',
  'BNB',
  'WBNB',
  'MATIC',
  'WMATIC',
  'ARB',
  'OP',
  'AVAX',
  'SOL',
  'LINK',
  'UNI',
  'AAVE',
  'MKR',
  'CRV',
  'LDO',
]);

const MEMECOINS = new Set([
  'PEPE',
  'DOGE',
  'SHIB',
  'FLOKI',
  'BONK',
  'WIF',
  'MEME',
  'TURBO',
  'BABYDOGE',
  'ELON',
  'KISHU',
  'SAFEMOON',
  'WOJAK',
]);

@Injectable()
export class LiteFeatureService {
  extractFeatures(
    transfers: LiteTransfer[],
    walletAddress: string,
    chain: string,
    holdingTokenCount: number = 0,
    holdingChainCount: number = 1,
  ): LiteFeatureVector {
    if (!transfers || transfers.length === 0) {
      return this.emptyVector(walletAddress, chain);
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

    // 6. Hold time from FIFO matching of swap lots
    const { holdTimes, matchedLotCount } = this.computeHoldTimes(swaps, walletAddress);
    const medianHoldHours = holdTimes.length > 0 ? this.median(holdTimes) : null;
    const holdBuckets = this.bucketHoldTimes(holdTimes);

    // 7. Token category analysis
    const allTokenSymbols = transfers.map((t) => t.tokenSymbol.toUpperCase());
    const uniqueTokens = new Set(allTokenSymbols).size;
    const memecoinPercent = this.categoryPercent(allTokenSymbols, MEMECOINS);
    const blueChipPercent = this.categoryPercent(allTokenSymbols, BLUE_CHIPS);
    const stablecoinPercent = this.categoryPercent(allTokenSymbols, STABLECOINS);

    return {
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
      totalHoldingTokens: holdingTokenCount,
      holdingChainCount,
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

  private categoryPercent(symbols: string[], categorySet: Set<string>): number {
    if (symbols.length === 0) {
      return 0;
    }
    const count = symbols.filter((symbol) => categorySet.has(symbol)).length;
    return Math.round((count / symbols.length) * 100);
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

  private emptyVector(address: string, chain: string): LiteFeatureVector {
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
      totalHoldingTokens: 0,
      holdingChainCount: 0,
    };
  }
}
