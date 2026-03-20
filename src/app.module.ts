import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletModule } from './wallet/wallet.module';
import { AlchemyService } from './services/alchemy/alchemy.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    WalletModule,
  ],
  providers: [AlchemyService],
})
export class AppModule {}