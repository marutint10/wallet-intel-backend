import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { isEthereumAddress } from '../shared/validators/address.validator';
import {
  StoredWalletTransactionsResponse,
  Trade,
  WalletHoldingsResponse,
  WalletHoldTimeMetricsResponse,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsResult,
  WalletRiskMetricsResponse,
  WalletSummaryResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from './wallet.types';
import { WalletService } from './services/wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get(':address/holdings')
  async getHoldings(
    @Param('address') address: string,
  ): Promise<WalletHoldingsResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getHoldings(address);
  }

  @Get(':address/portfolio')
  async getPortfolio(
    @Param('address') address: string,
  ): Promise<WalletPortfolioResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getPortfolio(address);
  }

  @Get(':address/ledger')
  async getLedger(
    @Param('address') address: string,
  ): Promise<WalletLedgerResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getLedger(address);
  }

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

  @Get(':address/transactions')
  async getStoredTransactions(
    @Param('address') address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getStoredTransactions(address);
  }

  @Get(':address/trades')
  async getTrades(@Param('address') address: string): Promise<Trade[]> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getTrades(address);
  }

  @Get(':address/priced-trades')
  async getPricedTrades(@Param('address') address: string) {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getPricedTrades(address);
  }

  @Get(':address/pnl')
  async getPnL(
    @Param('address') address: string,
  ): Promise<WalletPnLResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getPnL(address);
  }

  @Get(':address/risk-metrics')
  async getRiskMetrics(
    @Param('address') address: string,
    @Query('debug') debug?: string,
  ): Promise<WalletRiskMetricsResult> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getRiskMetrics(address, debug === 'true');
  }

  @Get(':address/hold-time-metrics')
  async getHoldTimeMetrics(
    @Param('address') address: string,
  ): Promise<WalletHoldTimeMetricsResponse> {
    if (!isEthereumAddress(address)) {
      throw new BadRequestException('Invalid Ethereum wallet address');
    }

    return this.walletService.getHoldTimeMetrics(address);
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