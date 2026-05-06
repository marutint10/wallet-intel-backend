import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ChainbaseService } from './services/chainbase.service';
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteScorerService } from './services/lite-scorer.service';
import { TokenAnalysisService } from './services/token-analysis.service';

@Controller('token')
export class TokenController {
  constructor(
    private readonly chainbase: ChainbaseService,
    private readonly liteIngestion: LiteIngestionService,
    private readonly liteFeature: LiteFeatureService,
    private readonly liteClassifier: LiteClassifierService,
    private readonly liteScorer: LiteScorerService,
    private readonly tokenAnalysis: TokenAnalysisService,
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
}
