import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletController } from './wallet.controller';
import {
  ClassificationService,
  PnlService,
  PortfolioService,
  WalletAnalyticsService,
  WalletContextService,
  WalletCoreService,
  WalletPnlService,
  WalletPortfolioService,
  WalletPricingService,
  WalletScoringService,
  WalletService,
} from './services';
import { TransactionEntity } from './transaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionEntity])],
  controllers: [WalletController],
  providers: [
    WalletAnalyticsService,
    WalletContextService,
    WalletCoreService,
    WalletPricingService,
    WalletPnlService,
    WalletPortfolioService,
    WalletService,
    PortfolioService,
    PnlService,
    WalletScoringService,
    ClassificationService,
  ],
})
export class WalletModule {}