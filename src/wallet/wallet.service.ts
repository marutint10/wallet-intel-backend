import { Injectable } from '@nestjs/common';
import { AlchemyService } from '../services/alchemy/alchemy.service';
@Injectable()
export class WalletService {
  constructor(private readonly alchemyService: AlchemyService) {}

  async analyseWallet(address: string) {
    const data = await this.alchemyService.getTransactions(address);

    const transfers = data?.result?.transfers || [];

    return {
      address,
      total_transactions: transfers.length,
    };
  }
}