import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { ChainbaseService } from './chainbase.service';
import { LiteIngestionService } from './lite-ingestion.service';
import { LiteFeatureService } from './lite-feature.service';
import { LiteClassifierService } from './lite-classifier.service';
import { LiteScorerService } from './lite-scorer.service';
import {
  HolderAggregationService,
  AnalyzedHolder,
} from './holder-aggregation.service';

@Injectable()
export class TokenAnalysisService {
  private readonly logger = new Logger(TokenAnalysisService.name);

  constructor(
    @InjectRepository(TokenAnalysisEntity)
    private readonly tokenRepo: Repository<TokenAnalysisEntity>,
    private readonly chainbase: ChainbaseService,
    private readonly ingestion: LiteIngestionService,
    private readonly feature: LiteFeatureService,
    private readonly classifier: LiteClassifierService,
    private readonly scorer: LiteScorerService,
    private readonly aggregation: HolderAggregationService,
    private readonly config: ConfigService,
  ) {}

  // --- START ANALYSIS (saves status=processing, runs in background) ---
  async startAnalysis(
    contractAddress: string,
    chain: string,
  ): Promise<TokenAnalysisEntity> {
    const address = contractAddress.toLowerCase();

    // Upsert with status=processing
    await this.tokenRepo.upsert(
      {
        contractAddress: address,
        chain,
        status: 'processing',
        errorMessage: null,
        updatedAt: new Date(),
      },
      ['contractAddress', 'chain'],
    );

    const entity = await this.tokenRepo.findOne({
      where: { contractAddress: address, chain },
    });

    if (!entity) {
      throw new Error(`Unable to initialize analysis row for ${address} on ${chain}`);
    }

    // Run analysis in background - do not await
    void this.runAnalysis(address, chain).catch(async (err: unknown) => {
      const errorMessage = this.getErrorMessage(err);
      this.logger.error(`Analysis failed for ${address}: ${errorMessage}`);
      await this.tokenRepo.update(
        { contractAddress: address, chain },
        {
          status: 'error',
          errorMessage,
          updatedAt: new Date(),
        },
      );
    });

    return entity;
  }

  // --- GET RESULT ---
  async getResult(
    contractAddress: string,
    chain: string,
  ): Promise<TokenAnalysisEntity | null> {
    return this.tokenRepo.findOne({
      where: { contractAddress: contractAddress.toLowerCase(), chain },
    });
  }

  // --- CORE ANALYSIS PIPELINE ---
  private async runAnalysis(contractAddress: string, chain: string): Promise<void> {
    this.logger.log(`Starting analysis for ${contractAddress} on ${chain}`);

    const configuredBatchSize = Number(
      this.config.get<string>('TOKEN_ANALYSIS_BATCH_SIZE') ?? '5',
    );
    const configuredDelayMs = Number(
      this.config.get<string>('TOKEN_ANALYSIS_BATCH_DELAY_MS') ?? '1500',
    );
    const batchSize =
      Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
        ? Math.floor(configuredBatchSize)
        : 5;
    const batchDelayMs =
      Number.isFinite(configuredDelayMs) && configuredDelayMs >= 0
        ? configuredDelayMs
        : 1500;

    // Step 1: Fetch top 100 holders from Chainbase
    const { holders } = await this.chainbase.getTopHolders(contractAddress, chain, 100);
    this.logger.log(`Fetched ${holders.length} holders for ${contractAddress}`);

    // Step 2: Analyze each holder in batches of 5
    const analyzed: AnalyzedHolder[] = [];

    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (holder) => {
          try {
            const transfers = await this.ingestion.getRecentTransfers(
              holder.walletAddress,
              chain,
              200,
            );
            const features = this.feature.extractFeatures(
              transfers,
              holder.walletAddress,
              chain,
            );
            const classification = this.classifier.classify(features);
            const score = this.scorer.score(features);

            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              classification,
              score,
            } as AnalyzedHolder;
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to analyze ${holder.walletAddress}: ${this.getErrorMessage(err)}`,
            );
            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              classification: null,
              score: null,
            } as AnalyzedHolder;
          }
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          analyzed.push(result.value);
        }
      }

      // Respect Etherscan rate limits between batches
      if (i + batchSize < holders.length) {
        await this.sleep(batchDelayMs);
      }

      this.logger.log(
        `Analyzed ${Math.min(i + batchSize, holders.length)}/${holders.length} holders`,
      );
    }

    // Step 3: Aggregate results
    const quality = this.aggregation.computeQualityMetrics(analyzed);
    const distribution = this.aggregation.computeDistribution(holders, '0');
    const callouts = this.aggregation.generateRiskCallouts(quality, distribution);

    // Step 4: Save to database
    await this.tokenRepo.upsert(
      {
        contractAddress,
        chain,
        totalHolders: holders.length,
        holdersData: analyzed,
        qualityMetrics: quality,
        distribution,
        riskCallouts: callouts,
        status: 'done',
        errorMessage: null,
        updatedAt: new Date(),
      },
      ['contractAddress', 'chain'],
    );

    this.logger.log(`Analysis complete for ${contractAddress}. Saved to DB.`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }
}
