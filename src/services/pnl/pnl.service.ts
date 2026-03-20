import { Injectable } from '@nestjs/common';

type TokenPnL = {
  token: string;
  buy: number;
  sell: number;
  pnl: number;
};

@Injectable()
export class PnlService {
  calculatePnL(trades: any[]) {
    const tokenStats: Record<string, { buy: number; sell: number }> = {};

    for (const trade of trades) {
      const token = trade.asset;

      if (!tokenStats[token]) {
        tokenStats[token] = { buy: 0, sell: 0 };
      }

      if (trade.type === 'BUY') {
        tokenStats[token].buy += Number(trade.value);
      }

      if (trade.type === 'SELL') {
        tokenStats[token].sell += Number(trade.value);
      }
    }

    const results: TokenPnL[] = [];

    for (const token in tokenStats) {
      const { buy, sell } = tokenStats[token];

      results.push({
        token,
        buy,
        sell,
        pnl: sell - buy,
      });
    }

    return {
      token_pnl: results,
    };
  }
}