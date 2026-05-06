import { Controller, Get, Param, Query } from '@nestjs/common';
import { ChainbaseService } from './services/chainbase.service';
import { LiteIngestionService } from './services/lite-ingestion.service';

@Controller('token')
export class TokenController {
  constructor(
    private readonly chainbase: ChainbaseService,
    private readonly liteIngestion: LiteIngestionService,
  ) {}

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

  // GET /token/wallet/:address/transfers?chain=ethereum
  @Get('wallet/:address/transfers')
  async getWalletTransfers(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const transfers = await this.liteIngestion.getRecentTransfers(
      address,
      chain,
      200,
    );
    return {
      walletAddress: address,
      chain,
      totalTransfers: transfers.length,
      transfers: transfers.slice(0, 10),
    };
  }
}
