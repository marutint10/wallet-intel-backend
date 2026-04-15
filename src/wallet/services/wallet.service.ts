import { Injectable } from '@nestjs/common';
import {
  Trade,
  WalletActivityMetricsResponse,
  WalletContextResponse,
  WalletDexMetricsResponse,
  WalletDexMetricsResult,
  WalletFeaturesResponse,
  WalletHoldingsResponse,
  WalletHoldTimeMetricsResponse,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsResult,
  WalletRiskMetricsResponse,
  StoredWalletTransactionsResponse,
  WalletSummaryResponse,
  WalletTokenCategoryMetricsResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletContextService } from './wallet-context.service';
import { WalletCoreService } from './wallet-core.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

@Injectable()
export class WalletService {
  constructor(
    private readonly walletCoreService: WalletCoreService,
    private readonly walletPnlService: WalletPnlService,
    private readonly walletPortfolioService: WalletPortfolioService,
    private readonly walletAnalyticsService: WalletAnalyticsService,
    private readonly walletContextService: WalletContextService,
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

  async getWalletFeatures(address: string): Promise<WalletFeaturesResponse> {
    const [summary, riskMetrics, holdTime, activity] = await Promise.all([
      this.getWalletSummary(address),
      this.getRiskMetrics(address),
      this.getHoldTimeMetrics(address),
      this.getActivityMetrics(address),
    ]);

    return {
      summary,
      risk: {
        profitFactor: riskMetrics.profitFactor,
        maxDrawdown: riskMetrics.maxDrawdown,
        returnStdDev: riskMetrics.returnStdDev,
        concentrationRisk: riskMetrics.concentrationRisk,
      },
      holdTime,
      activity,
    };
  }

  async getWalletContext(address: string): Promise<WalletContextResponse> {
    return this.walletContextService.getWalletContext(address);
  }

  async getDexMetrics(
    address: string,
    debug = false,
  ): Promise<WalletDexMetricsResult> {
    return this.walletAnalyticsService.getDexMetrics(address, debug);
  }

  async getTokenCategoryMetrics(
    address: string,
  ): Promise<WalletTokenCategoryMetricsResponse> {
    return this.walletAnalyticsService.getTokenCategoryMetrics(address);
  }

  async getTokenFlow(address: string): Promise<WalletTokenFlowResponse> {
    return this.walletPortfolioService.getTokenFlow(address);
  }

  async getNetFlow(address: string): Promise<WalletNetFlowResponse> {
    return this.walletPortfolioService.getNetFlow(address);
  }

  async getLedger(address: string): Promise<WalletLedgerResponse> {
    return this.walletPortfolioService.getLedger(address);
  }

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
    return this.walletPortfolioService.getPortfolio(address);
  }

  async getHoldings(address: string): Promise<WalletHoldingsResponse> {
    return this.walletPortfolioService.getHoldings(address);
  }

  async getActivityMetrics(
    address: string,
  ): Promise<WalletActivityMetricsResponse> {
    return this.walletAnalyticsService.getActivityMetrics(address);
  }

  async getHoldTimeMetrics(
    address: string,
  ): Promise<WalletHoldTimeMetricsResponse> {
    return this.walletAnalyticsService.getHoldTimeMetrics(address);
  }

  async getRiskMetrics(
    address: string,
    debug = false,
  ): Promise<WalletRiskMetricsResult> {
    return this.walletAnalyticsService.getRiskMetrics(address, debug);
  }
}