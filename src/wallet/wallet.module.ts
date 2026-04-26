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
  WalletContextService,
  WalletCoreService,
  WalletPnlService,
  WalletPortfolioService,
  WalletPricingService,
  WalletScoringService,
  WalletService,
  HybridHoldingsService,
  WalletTriageService,
} from './services';
import { WalletKnownTokenEntity } from './entities/wallet-known-token.entity';
import { TransactionEntity } from './transaction.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionEntity, WalletKnownTokenEntity]),
  ],
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