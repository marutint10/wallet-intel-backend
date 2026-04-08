import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { isEthereumAddress } from '../utils/address.validator';
import { WalletService, WalletTransactionsResponse } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get(':address')
  async getWalletData(
    @Param('address') address: string,
  ): Promise<WalletTransactionsResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getWalletData(address);
  }
}