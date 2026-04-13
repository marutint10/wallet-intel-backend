import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletController } from './wallet.controller';
import {
  ClassificationService,
  PnlService,
  PortfolioService,
  ScoringService,
  WalletCoreService,
  WalletPnlService,
  WalletPortfolioService,
  WalletPricingService,
  WalletService,
} from './services';
import { TransactionEntity } from './transaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionEntity])],
  controllers: [WalletController],
  providers: [
    WalletCoreService,
    WalletPricingService,
    WalletPnlService,
    WalletPortfolioService,
    WalletService,
    PortfolioService,
    PnlService,
    ScoringService,
    ClassificationService,
  ],
})
export class WalletModule {}