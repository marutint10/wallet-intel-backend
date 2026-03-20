import { Injectable } from '@nestjs/common';

@Injectable()
export class WalletService {
  async analyseWallet(address: string) {
    return {
      address,
      message: 'Wallet analysis started',
    };
  }
}