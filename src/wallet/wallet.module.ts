import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonRpcProvider } from 'ethers';
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
    {
      provide: JsonRpcProvider,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const rpcUrl =
          configService.get<string>('rpc.url') ??
          'https://ethereum-rpc.publicnode.com';

        return new JsonRpcProvider(rpcUrl, undefined, {
          staticNetwork: true,
        });
      },
    },
    HybridHoldingsService,
  ],
})
export class WalletModule {}