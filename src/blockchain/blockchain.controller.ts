import { Controller, Get, Param } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';

@Controller('blockchain')
export class BlockchainController {
  constructor(private readonly blockchainService: BlockchainService) {}

  @Get('fetch/:address')
  async fetchWallet(@Param('address') address: string) {
    try {
      return await this.blockchainService.fetchAndStore(address);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to fetch and store blockchain data.',
      };
    }
  }
}
