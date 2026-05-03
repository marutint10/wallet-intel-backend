import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletController } from './wallet.controller';
import {
  ClassificationService,
  PnlService,
  PortfolioService,
  WalletAnalyticsService,
  WalletConfidenceService,
  WalletContextService,
  WalletCoreService,
  WalletPnlService,
  WalletPortfolioService,
  WalletPricingService,
  WalletAiService,
  WalletScoringService,
  WalletService,
  HybridHoldingsService,
  WalletTriageService,
  UnifiedIntelligenceService,
} from './services';
import { WalletKnownTokenEntity } from './entities/wallet-known-token.entity';
import { TransactionEntity } from './transaction.entity';

@Module({
  imports: [
    CacheModule.register(),
    TypeOrmModule.forFeature([TransactionEntity, WalletKnownTokenEntity]),
  ],
  controllers: [WalletController],
  providers: [
    WalletAnalyticsService,
    WalletConfidenceService,
    WalletContextService,
    WalletCoreService,
    WalletPricingService,
    WalletAiService,
    WalletPnlService,
    WalletPortfolioService,
    WalletService,
    PortfolioService,
    PnlService,
    WalletScoringService,
    ClassificationService,
    WalletTriageService,
    HybridHoldingsService,
    UnifiedIntelligenceService,
  ],
})
export class WalletModule {}