import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { AlchemyService } from '../services/alchemy/alchemy.service';
import { CalculatorService } from '../services/calculator/calculator.service';
import { TradeAnalyzerService } from '../services/trade-analyzer/trade-analyzer.service';


@Module({
  controllers: [WalletController],
  providers: [WalletService, AlchemyService, CalculatorService, TradeAnalyzerService],
})

export class WalletModule {}
