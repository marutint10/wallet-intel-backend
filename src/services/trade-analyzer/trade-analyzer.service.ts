import { Injectable } from '@nestjs/common';

type AssetTransfer = {
  hash: string;
  from?: string;
  to?: string;
  asset?: string;
  value?: number | string;
  metadata?: {
    blockTimestamp?: string;
  };
};

type AnalyzedTrade = {
  type: 'SWAP';
  from_token?: string;
  to_token?: string;
  amount_in?: number | string;
  amount_out?: number | string;
  timestamp?: string;
};

@Injectable()
export class TradeAnalyzerService {
  analyzeTrades(transfers: AssetTransfer[]): AnalyzedTrade[] {
    const grouped: Record<string, AssetTransfer[]> = {};

    // 🔹 Group by transaction hash
    for (const tx of transfers) {
      const hash = tx.hash;

      if (!grouped[hash]) {
        grouped[hash] = [];
      }

      grouped[hash].push(tx);
    }

    const trades: AnalyzedTrade[] = [];

    // 🔹 Analyze each transaction group
    for (const hash in grouped) {
      const txGroup = grouped[hash];

      let sent: AssetTransfer | null = null;
      let received: AssetTransfer | null = null;

      for (const tx of txGroup) {
        // outgoing (from wallet)
        if (tx.from?.toLowerCase() === txGroup[0].from?.toLowerCase()) {
          sent = tx;
        }

        // incoming (to wallet)
        if (tx.to?.toLowerCase() === txGroup[0].to?.toLowerCase()) {
          received = tx;
        }
      }

      if (sent && received) {
        trades.push({
          type: 'SWAP',
          from_token: sent.asset,
          to_token: received.asset,
          amount_in: sent.value,
          amount_out: received.value,
          timestamp: sent.metadata?.blockTimestamp,
        });
      }
    }

    return trades;
  }
}