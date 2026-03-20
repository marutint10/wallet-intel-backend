import { Injectable } from '@nestjs/common';
import { AlchemyService } from '../services/alchemy/alchemy.service';
import { CalculatorService } from '../services/calculator/calculator.service';
import { TradeAnalyzerService } from '../services/trade-analyzer/trade-analyzer.service';
import { PnlService } from '../services/pnl/pnl.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly alchemyService: AlchemyService,
    private readonly calculatorService: CalculatorService,
    private readonly tradeAnalyzerService: TradeAnalyzerService,
    private readonly pnlService: PnlService,
  ) {}

  async analyseWallet(address: string) {
    const data = await this.alchemyService.getTransactions(address);
    const transfers = data?.result?.transfers || [];

    const metrics = this.calculatorService.calculateMetrics(transfers);

    const trades = this.tradeAnalyzerService.analyzeTrades(transfers);

    const pnl = this.pnlService.calculatePnL(trades);

    return {
      address,
      ...metrics,
        ...pnl,
      trades: trades.slice(0, 10), // 👈 now included
    };
  }
}