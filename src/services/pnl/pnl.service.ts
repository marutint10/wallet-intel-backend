import { Injectable } from '@nestjs/common';

@Injectable()
export class PnlService {
  calculatePnL(trades: any[]) {
    let totalBuy = 0;
    let totalSell = 0;
    let winTrades = 0;
    let totalTrades = 0;

    for (const trade of trades) {
      if (!trade.value) continue;

      if (trade.type === 'BUY') {
        totalBuy += Number(trade.value);
        totalTrades++;
      }

      if (trade.type === 'SELL') {
        totalSell += Number(trade.value);
        totalTrades++;

        if (trade.value > 0) {
          winTrades++; // simple assumption for now
        }
      }
    }

    const pnl = totalSell - totalBuy;
    const winRate = totalTrades
      ? (winTrades / totalTrades) * 100
      : 0;

    return {
      total_pnl: pnl,
      total_buy: totalBuy,
      total_sell: totalSell,
      total_trades: totalTrades,
      win_rate: winRate.toFixed(2),
    };
  }
}