import { Controller, Get, Param, Query } from '@nestjs/common';
import { ChainbaseService } from './services/chainbase.service';
import {
  AnalyzedHolder,
  HolderAggregationService,
} from './services/holder-aggregation.service';
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteScorerService } from './services/lite-scorer.service';

@Controller('token')
export class TokenController {
  constructor(
    private readonly chainbase: ChainbaseService,
    private readonly liteIngestion: LiteIngestionService,
    private readonly liteFeature: LiteFeatureService,
    private readonly liteClassifier: LiteClassifierService,
    private readonly liteScorer: LiteScorerService,
    private readonly holderAggregation: HolderAggregationService,
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

  // GET /token/:address/overview?chain=ethereum
  // Tests the full pipeline: fetch holders, analyze top 5, aggregate metrics
  @Get(':address/overview')
  async getTokenOverview(
    @Param('address') address: string,
    @Query('chain') chain: string = 'ethereum',
  ) {
    // 1. Fetch top 20 holders from Chainbase
    const { holders } = await this.chainbase.getTopHolders(address, chain, 20);

    // 2. Analyze first 5 holders only (for speed during testing)
    const analyzed: AnalyzedHolder[] = [];
    for (const holder of holders.slice(0, 5)) {
      const transfers = await this.liteIngestion.getRecentTransfers(
        holder.walletAddress,
        chain,
        200,
      );
      const features = this.liteFeature.extractFeatures(
        transfers,
        holder.walletAddress,
        chain,
      );
      const classification = this.liteClassifier.classify(features);
      const score = this.liteScorer.score(features);
      analyzed.push({ ...holder, classification, score });
    }

    // 3. Aggregate
    const quality = this.holderAggregation.computeQualityMetrics(analyzed);
    const distribution = this.holderAggregation.computeDistribution(holders, '0');
    const callouts = this.holderAggregation.generateRiskCallouts(
      quality,
      distribution,
    );

    return {
      contractAddress: address,
      chain,
      quality,
      distribution,
      callouts,
      analyzedHolders: analyzed,
    };
  }
}
