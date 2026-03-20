import { Injectable } from '@nestjs/common';
import { AlchemyService } from '../services/alchemy/alchemy.service';
import { CalculatorService } from '../services/calculator/calculator.service';
import { TradeAnalyzerService } from '../services/trade-analyzer/trade-analyzer.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly alchemyService: AlchemyService,
    private readonly calculatorService: CalculatorService,
    private readonly tradeAnalyzerService: TradeAnalyzerService,
  ) {}

  async analyseWallet(address: string) {
    const data = await this.alchemyService.getTransactions(address);
    const transfers = data?.result?.transfers || [];

    const metrics = this.calculatorService.calculateMetrics(transfers);

    const trades = this.tradeAnalyzerService.analyzeTrades(transfers);

    return {
      address,
      ...metrics,
      trades: trades.slice(0, 10), // 👈 now included
    };
  }
}