import { Controller, Get, Param, Query } from '@nestjs/common';
import { ChainbaseService } from './services/chainbase.service';

@Controller('token')
export class TokenController {
  constructor(private readonly chainbase: ChainbaseService) {}

  // GET /token/:address/holders?chain=ethereum
  // Tests that Chainbase returns top holders for any token contract
  @Get(':address/holders')
  async getHolders(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const result = await this.chainbase.getTopHolders(address, chain, 200);
    return {
      contractAddress: address,
      chain,
      totalHolders: result.totalHolders,
      holders: result.holders.slice(0, 20),
    };
  }
}
