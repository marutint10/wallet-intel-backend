import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { BlockchainAlchemyService } from './providers/alchemy.service';
import { HeliusService } from './providers/helius.service';
import { MoralisService } from './providers/moralis.service';

@Module({
  providers: [BlockchainService, MoralisService, BlockchainAlchemyService, HeliusService],
  exports: [BlockchainService],
})
export class BlockchainModule {}
