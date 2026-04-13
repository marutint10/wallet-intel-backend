import { Injectable } from '@nestjs/common';
import {
  Trade,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletPortfolioUSDResponse,
  StoredWalletTransactionsResponse,
  WalletSummaryResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from '../wallet.types';
import { WalletCoreService } from './wallet-core.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPortfolioService: WalletPortfolioService,
  ) {}

  async getWalletData(address: string): Promise<WalletTransactionsResponse> {
    return this.walletCoreService.getWalletData(address);
  }

  async getStoredTransactions(
    address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    return this.walletCoreService.getStoredTransactions(address);
  }

  async getTrades(address: string): Promise<Trade[]> {
    return this.walletPnlService.getTrades(address);
  }

  async getPricedTrades(address: string) {
    return this.walletPnlService.getPricedTrades(address);
  }

  async getPnL(address: string): Promise<WalletPnLResponse> {
    return this.walletPnlService.getPnL(address);
  }

  async getWalletSummary(address: string): Promise<WalletSummaryResponse> {
    return this.walletPnlService.getWalletSummary(address);
  }

  async getTokenFlow(address: string): Promise<WalletTokenFlowResponse> {
    return this.walletPortfolioService.getTokenFlow(address);
  }

  async getNetFlow(address: string): Promise<WalletNetFlowResponse> {
    return this.walletPortfolioService.getNetFlow(address);
  }

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
    return this.walletPortfolioService.getPortfolio(address);
  }

  async getPortfolioUSD(
    address: string,
  ): Promise<WalletPortfolioUSDResponse> {
    return this.walletPortfolioService.getPortfolioUSD(address);
  }
}