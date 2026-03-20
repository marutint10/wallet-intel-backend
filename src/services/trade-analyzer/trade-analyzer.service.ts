import { Injectable } from '@nestjs/common';

@Injectable()
export class TradeAnalyzerService {
  analyzeTrades(transfers: any[]) {
   const trades: any[] = [];

for (let i = 0; i < transfers.length; i++) {
  const tx = transfers[i];

  const asset = tx.asset;
  const value = tx.value;
  const timestamp = tx.metadata?.blockTimestamp;

  let type = 'UNKNOWN';

  if (asset === 'ETH') {
    type = 'SELL';
  } else {
    type = 'BUY';
  }

  trades.push({
    type,
    asset,
    value,
    timestamp,
  });
}

    return trades;
  }
}