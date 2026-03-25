import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { TokenTransferEntity, TransactionEntity } from './entities/transaction.entity';
import { BlockchainAlchemyService } from './providers/alchemy.service';
import { HeliusService } from './providers/helius.service';
import { MoralisService } from './providers/moralis.service';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionEntity, TokenTransferEntity])],
  controllers: [BlockchainController],
  providers: [BlockchainService, MoralisService, BlockchainAlchemyService, HeliusService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
