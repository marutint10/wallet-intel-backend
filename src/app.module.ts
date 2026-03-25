import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlockchainModule } from './blockchain/blockchain.module';
import { WalletModule } from './wallet/wallet.module';
import { AlchemyService } from './services/alchemy/alchemy.service';
import { CalculatorService } from './services/calculator/calculator.service';
import { TradeAnalyzerService } from './services/trade-analyzer/trade-analyzer.service';
import { PnlService } from './services/pnl/pnl.service';
import { WalletClassifierService } from './services/wallet-classifier/wallet-classifier.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BlockchainModule,
    WalletModule,
  ],
  providers: [AlchemyService, CalculatorService, TradeAnalyzerService, PnlService, WalletClassifierService],
})
export class AppModule {}