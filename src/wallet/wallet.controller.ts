import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { isEthereumAddress } from '../shared/validators/address.validator';
import {
  StoredWalletTransactionsResponse,
  WalletNetFlowResponse,
  WalletSummaryResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from './wallet.types';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get(':address/net-flow')
  async getNetFlow(
    @Param('address') address: string,
  ): Promise<WalletNetFlowResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getNetFlow(address);
  }

  @Get(':address/token-flow')
  async getTokenFlow(
    @Param('address') address: string,
  ): Promise<WalletTokenFlowResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getTokenFlow(address);
  }

  @Get(':address/summary')
  async getWalletSummary(
    @Param('address') address: string,
  ): Promise<WalletSummaryResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getWalletSummary(address);
  }

  @Get(':address/stored')
  async getStoredTransactions(
    @Param('address') address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getStoredTransactions(address);
  }

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