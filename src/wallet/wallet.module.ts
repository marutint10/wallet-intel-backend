import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletController } from './wallet.controller';
import { TransactionEntity } from './transaction.entity';
import { WalletService } from './wallet.service';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionEntity])],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}