import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletModule } from './wallet/wallet.module';
import { AlchemyService } from './services/alchemy/alchemy.service';
import { CalculatorService } from './services/calculator/calculator.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    WalletModule,
  ],
  providers: [AlchemyService, CalculatorService],
})
export class AppModule {}