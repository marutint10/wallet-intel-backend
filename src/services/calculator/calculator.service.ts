import { Injectable } from '@nestjs/common';

@Injectable()
export class CalculatorService {
  calculateMetrics(transfers: any[]) {
    const totalTransactions = transfers.length;

    // Unique tokens
    const uniqueTokens = new Set(
      transfers.map((tx) => tx.asset).filter(Boolean)
    ).size;

    // Activity level (simple logic for now)
    let activityLevel = 'low';
    if (totalTransactions > 500) activityLevel = 'high';
    else if (totalTransactions > 100) activityLevel = 'medium';

    // Time analysis
  const timestamps = transfers
  .map((tx) => tx.metadata?.blockTimestamp)
  .filter(Boolean)
  .map((t) => new Date(t).getTime());

const firstTx = timestamps.length ? new Date(Math.min(...timestamps)) : null;
const lastTx = timestamps.length ? new Date(Math.max(...timestamps)) : null;

    return {
      total_transactions: totalTransactions,
      unique_tokens: uniqueTokens,
      activity_level: activityLevel,
      first_tx_time: firstTx,
      last_tx_time: lastTx,
    };
  }
}