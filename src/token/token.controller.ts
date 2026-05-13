import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ChainbaseService } from './services/chainbase.service';
import {
  DashboardSummaryResponse,
  DashboardSummaryService,
} from './services/dashboard-summary.service';
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteScorerService } from './services/lite-scorer.service';
import { TokenAiSummaryService } from './services/token-ai-summary.service';
import {
  type ChartTimeframe,
  TokenChartService,
} from './services/token-chart.service';
import { TokenAnalysisService } from './services/token-analysis.service';
import { TokenDeepAnalysisService } from './services/token-deep-analysis.service';

// Lightweight response shape returned by GET /token/:address/dashboard when the
// analysis row exists but has not yet completed. Frontend should keep polling
// the same endpoint until status becomes 'done'.
interface DashboardProcessingResponse {
  status: string;
  contractAddress: string;
  chain: string;
  updatedAt: Date;
}

@Controller('token')
export class TokenController {
  private readonly logger = new Logger(TokenController.name);

  private isEvmContractAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/i.test(address.trim());
  }

  constructor(
    private readonly chainbase: ChainbaseService,
    private readonly liteIngestion: LiteIngestionService,
    private readonly liteFeature: LiteFeatureService,
    private readonly liteClassifier: LiteClassifierService,
    private readonly liteScorer: LiteScorerService,
    private readonly tokenAnalysis: TokenAnalysisService,
    private readonly dashboardSummary: DashboardSummaryService,
    private readonly tokenAiSummary: TokenAiSummaryService,
    private readonly tokenDeepAnalysis: TokenDeepAnalysisService,
    private readonly tokenChart: TokenChartService,
  ) {}

  // GET /token/:address/holders?chain=ethereum
  // Tests that Chainbase returns top holders for any token contract
  @Get(':address/holders')
  async getHolders(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const result = await this.chainbase.getTopHolders(address, chain, 200);
    return {
      contractAddress: address,
      chain,
      totalHolders: result.totalHolders,
      holders: result.holders.slice(0, 20),
    };
  }

  // GET /token/wallet/:address/transfers?chain=ethereum
  @Get('wallet/:address/transfers')
  async getWalletTransfers(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const transfers = await this.liteIngestion.getRecentTransfers(
      address,
      chain,
      200,
    );
    return {
      walletAddress: address,
      chain,
      totalTransfers: transfers.length,
      transfers: transfers.slice(0, 10),
    };
  }

  // GET /token/wallet/:address/features?chain=ethereum
  @Get('wallet/:address/features')
  async getWalletFeatures(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const transfers = await this.liteIngestion.getRecentTransfers(
      address,
      chain,
      200,
    );
    const features = this.liteFeature.extractFeatures(transfers, address, chain);
    return features;
  }

  // GET /token/wallet/:address/classify?chain=ethereum
  @Get('wallet/:address/classify')
  async classifyWallet(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const transfers = await this.liteIngestion.getRecentTransfers(
      address,
      chain,
      200,
    );
    const features = this.liteFeature.extractFeatures(transfers, address, chain);
    const classification = this.liteClassifier.classify(features);
    return { features, classification };
  }

  // GET /token/wallet/:address/score?chain=ethereum
  @Get('wallet/:address/score')
  async scoreWallet(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const transfers = await this.liteIngestion.getRecentTransfers(
      address,
      chain,
      200,
    );
    const features = this.liteFeature.extractFeatures(transfers, address, chain);
    const classification = this.liteClassifier.classify(features);
    const score = this.liteScorer.score(features);
    return { score, classification };
  }

  // POST /token/analyze
  // Starts background analysis for a token contract
  @Post('analyze')
  async analyzeToken(@Body() body: { contractAddress: string; chain?: string }) {
    const chain = body.chain ?? 'ethereum';
    const entity = await this.tokenAnalysis.startAnalysis(
      body.contractAddress,
      chain,
    );
    return {
      id: entity.id,
      contractAddress: entity.contractAddress,
      chain: entity.chain,
      status: entity.status,
      message: 'Analysis started. Poll GET /token/:address for results.',
    };
  }

  // POST /token/:address/deep-analysis/trigger?chain=ethereum
  @Post(':address/deep-analysis/trigger')
  async triggerTokenDeepAnalysis(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    if (!this.isEvmContractAddress(address)) {
      throw new HttpException(
        { message: 'Invalid contract address' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.tokenDeepAnalysis.triggerDeepAnalysis(address, chain);
  }

  // GET /token/:address/deep-analysis?chain=ethereum
  @Get(':address/deep-analysis')
  async getTokenDeepAnalysis(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    if (!this.isEvmContractAddress(address)) {
      throw new HttpException(
        { message: 'Invalid contract address' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.tokenDeepAnalysis.getDeepAnalysis(address, chain);
  }

  // GET /token/:address/chart?chain=ethereum&timeframe=7d
  @Get(':address/chart')
  async getTokenChart(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const allowed: ChartTimeframe[] = ['24h', '7d', '30d', '90d', '1y', 'all'];
    const chartTf: ChartTimeframe = allowed.includes(timeframe as ChartTimeframe)
      ? (timeframe as ChartTimeframe)
      : '7d';
    return this.tokenChart.getChart(address, chain, chartTf);
  }

  // GET /token/:address?chain=ethereum
  // Returns analysis result - poll this until status=done
  @Get(':address')
  async getTokenAnalysis(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    const result = await this.tokenAnalysis.getResult(address, chain);
    if (!result) {
      return {
        status: 'not_found',
        message: 'No analysis found. POST /token/analyze to start.',
      };
    }
    return result;
  }

  // GET /token/:address/dashboard?chain=ethereum
  // Presentation-layer endpoint. Reshapes the persisted analysis row into a
  // frontend-ready dashboard payload via DashboardSummaryService. Never runs
  // analytics or touches additional DB rows beyond the same getResult lookup
  // used by GET /token/:address.
  @Get(':address/dashboard')
  async getTokenDashboard(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ): Promise<DashboardSummaryResponse | DashboardProcessingResponse> {
    const result = await this.tokenAnalysis.getResult(address, chain);

    if (!result) {
      throw new HttpException(
        {
          status: 'not_found',
          message: 'No analysis found for token',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    if (result.status !== 'done') {
      return {
        status: result.status,
        contractAddress: result.contractAddress,
        chain: result.chain,
        updatedAt: result.updatedAt,
      };
    }

    this.logger.debug(
      `[token-dashboard] build contract=${result.contractAddress} chain=${result.chain}`,
    );

    try {
      const [dashboard, aiSummary] = await Promise.all([
        Promise.resolve(this.dashboardSummary.buildDashboardSummary(result)),
        this.tokenAiSummary.generateSummary(result),
      ]);
      return { ...dashboard, aiSummary };
    } catch (err: unknown) {
      // DashboardSummaryService is designed to never throw, but if a bug or
      // an unexpected JSONB shape ever causes one to escape, we surface a
      // generic 500 and keep stack traces out of the response.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[token-dashboard] transformation_failed contract=${result.contractAddress} chain=${result.chain} error=${errorMessage}`,
      );
      throw new HttpException(
        {
          status: 'error',
          message: 'Failed to build dashboard response',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
