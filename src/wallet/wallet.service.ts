import { Injectable } from '@nestjs/common';
import { AlchemyService } from '../services/alchemy/alchemy.service';
import { CalculatorService } from '../services/calculator/calculator.service';
import { TradeAnalyzerService } from '../services/trade-analyzer/trade-analyzer.service';
import { PnlService } from '../services/pnl/pnl.service';
import { WalletClassifierService } from '../services/wallet-classifier/wallet-classifier.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly alchemyService: AlchemyService,
    private readonly calculatorService: CalculatorService,
    private readonly tradeAnalyzerService: TradeAnalyzerService,
    private readonly pnlService: PnlService,
    private readonly walletClassifierService: WalletClassifierService,
  ) {}

  async analyseWallet(address: string) {
    const data = await this.alchemyService.getTransactions(address);
    const transfers = data?.result?.transfers || [];

    const metrics = this.calculatorService.calculateMetrics(transfers);

    const trades = this.tradeAnalyzerService.analyzeTrades(transfers);

    const pnl = this.pnlService.calculatePnL(trades);

    const walletClassification = this.walletClassifierService.classifyWallet(metrics, pnl.token_pnl);

    return {
      address,
      ...metrics,
        ...pnl,
        ...walletClassification,
      trades: trades.slice(0, 10), // 👈 now included
    };
  }
}