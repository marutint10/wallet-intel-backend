import { Controller, Get, Param } from '@nestjs/common';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('analyse/:address')
  async analyse(@Param('address') address: string) {
    return this.walletService.analyseWallet(address);
  }
}