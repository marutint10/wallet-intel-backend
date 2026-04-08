import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { isEthereumAddress } from '../shared/validators/address.validator';
import { WalletTransactionsResponse } from './wallet.types';
import { WalletService } from './wallet.service';

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