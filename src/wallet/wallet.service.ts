import { Injectable } from '@nestjs/common';
import { AlchemyService } from '../services/alchemy/alchemy.service';
import { CalculatorService } from '../services/calculator/calculator.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly alchemyService: AlchemyService,
    private readonly calculatorService: CalculatorService,
  ) {}

  async analyseWallet(address: string) {
    const data = await this.alchemyService.getTransactions(address);
    const transfers = data?.result?.transfers || [];

    const metrics = this.calculatorService.calculateMetrics(transfers);

    return {
      address,
      ...metrics,
    };
  }
}