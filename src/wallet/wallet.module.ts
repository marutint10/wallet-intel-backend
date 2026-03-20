import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { AlchemyService } from '../services/alchemy/alchemy.service';
@Module({
  controllers: [WalletController],
  providers: [WalletService, AlchemyService],
})
export class WalletModule {}