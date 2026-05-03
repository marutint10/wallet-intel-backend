import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { isEvmAddress } from '../shared/validators/address.validator';
import {
  SupportedChain,
  normalizeSupportedChain,
} from '../shared/constants/chains';
import {
  StoredWalletTransactionsResponse,
  Trade,
  UnifiedIntelligenceResponse,
  WalletActivityMetricsResponse,
  WalletClassificationResult,
  WalletContextResponse,
  WalletDexMetricsResult,
  WalletFeaturesResponse,
  WalletHoldingsResponse,
  WalletHoldTimeMetricsResponse,
  WalletIntelligenceResult,
  WalletLedgerResponse,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletRiskMetricsResult,
  WalletScoreOrTriageResult,
  WalletSummaryResponse,
  WalletTokenCategoryMetricsResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from './wallet.types';
import { UnifiedIntelligenceService } from './services/unified-intelligence.service';
import { WalletService } from './services/wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly unifiedIntelligenceService: UnifiedIntelligenceService,
  ) {}

  @Get(':address/holdings')
  async getHoldings(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletHoldingsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getHoldings(address, resolvedChain);
  }

  @Get(':address/portfolio')
  async getPortfolio(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletPortfolioResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getPortfolio(address, resolvedChain);
  }

  @Get(':address/ledger')
  async getLedger(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletLedgerResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getLedger(address, resolvedChain);
  }

  @Get(':address/net-flow')
  async getNetFlow(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletNetFlowResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getNetFlow(address, resolvedChain);
  }

  @Get(':address/token-flow')
  async getTokenFlow(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletTokenFlowResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getTokenFlow(address, resolvedChain);
  }

  @Get(':address/summary')
  async getWalletSummary(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletSummaryResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletSummary(address, resolvedChain);
  }

  @Get(':address/features')
  async getWalletFeatures(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletFeaturesResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletFeatures(address, resolvedChain);
  }

  @Get(':address/context')
  async getWalletContext(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletContextResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletContext(address, resolvedChain);
  }

  @Get(':address/intelligence')
  async getWalletIntelligence(
    @Param('address') address: string,
    @Query('lite') lite?: string,
    @Query('verbose') verbose?: string,
    @Query('chain') chain?: string,
  ): Promise<WalletIntelligenceResult | UnifiedIntelligenceResponse> {
    if (!isEvmAddress(address)) {
      throw new BadRequestException('Invalid EVM wallet address');
    }

    if (!chain || chain.trim().length === 0) {
      return this.unifiedIntelligenceService.getUnifiedIntelligence(address);
    }

    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletIntelligence(
      address,
      {
        lite: this.parseBooleanQueryFlag(lite),
        verbose: this.parseBooleanQueryFlag(verbose),
      },
      resolvedChain,
    );
  }

  @Get(':address/score')
  async getWalletScore(
    @Param('address') address: string,
    @Query('debug') debug?: string,
    @Query('chain') chain?: string,
  ): Promise<WalletScoreOrTriageResult> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletScore(
      address,
      debug === 'true',
      resolvedChain,
    );
  }

  @Get(':address/classification')
  async getClassification(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletClassificationResult> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getClassification(address, resolvedChain);
  }

  @Get(':address/dex-metrics')
  async getDexMetrics(
    @Param('address') address: string,
    @Query('debug') debug?: string,
    @Query('chain') chain?: string,
  ): Promise<WalletDexMetricsResult> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getDexMetrics(
      address,
      debug === 'true',
      resolvedChain,
    );
  }

  @Get(':address/token-categories')
  async getTokenCategoryMetrics(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletTokenCategoryMetricsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getTokenCategoryMetrics(address, resolvedChain);
  }

  @Get(':address/transactions')
  async getStoredTransactions(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<StoredWalletTransactionsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getStoredTransactions(address, resolvedChain);
  }

  @Get(':address/trades')
  async getTrades(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<Trade[]> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getTrades(address, resolvedChain);
  }

  @Get(':address/priced-trades')
  async getPricedTrades(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ) {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getPricedTrades(address, resolvedChain);
  }

  @Get(':address/pnl')
  async getPnL(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletPnLResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getPnL(address, resolvedChain);
  }

  @Get(':address/risk-metrics')
  async getRiskMetrics(
    @Param('address') address: string,
    @Query('debug') debug?: string,
    @Query('chain') chain?: string,
  ): Promise<WalletRiskMetricsResult> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getRiskMetrics(
      address,
      debug === 'true',
      resolvedChain,
    );
  }

  @Get(':address/hold-time-metrics')
  async getHoldTimeMetrics(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletHoldTimeMetricsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getHoldTimeMetrics(address, resolvedChain);
  }

  @Get(':address/activity-metrics')
  async getActivityMetrics(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletActivityMetricsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getActivityMetrics(address, resolvedChain);
  }

  @Get(':address')
  async getWalletData(
    @Param('address') address: string,
    @Query('chain') chain?: string,
  ): Promise<WalletTransactionsResponse> {
    const resolvedChain = this.validateRequest(address, chain);

    return this.walletService.getWalletData(address, resolvedChain);
  }

  private validateRequest(address: string, chain?: string): SupportedChain {
    if (!isEvmAddress(address)) {
      throw new BadRequestException('Invalid EVM wallet address');
    }

    const resolvedChain = normalizeSupportedChain(chain);

    if (!resolvedChain) {
      throw new BadRequestException(
        'Unsupported chain. Use ethereum, base, bsc, or polygon.',
      );
    }

    return resolvedChain;
  }

  private parseBooleanQueryFlag(value?: string): boolean {
    if (!value) {
      return false;
    }

    const normalizedValue = value.trim().toLowerCase();

    return normalizedValue === 'true' || normalizedValue === '1';
  }
}