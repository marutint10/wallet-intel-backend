import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ConfigService } from '@nestjs/config';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { ChainbaseService } from './chainbase.service';
import { LiteIngestionService } from './lite-ingestion.service';
import { LiteFeatureService } from './lite-feature.service';
import { LiteClassifierService } from './lite-classifier.service';
import { LiteScorerService } from './lite-scorer.service';
import { LitePricingService } from './lite-pricing.service';
import { LitePortfolioService } from './lite-portfolio.service';
import type { HoldingsProfile } from './lite-portfolio.service';
import { LitePnlService } from './lite-pnl.service';
import { TokenIntelligenceService } from './token-intelligence.service';
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
    private readonly pricing: LitePricingService,
    private readonly portfolio: LitePortfolioService,
    private readonly pnl: LitePnlService,
    private readonly intelligence: TokenIntelligenceService,
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
    const address = contractAddress.toLowerCase();
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
    const { holders } = await this.chainbase.getTopHolders(address, chain, 100);
    this.logger.log(`Fetched ${holders.length} holders for ${contractAddress}`);

    // ========== PHASE 1: Token Metadata ==========
    const tokenMetadata = await this.intelligence.getTokenMetadata(
      contractAddress,
      chain,
    );
    this.logger.log(
      `Token: ${tokenMetadata.symbol || 'unknown'} | ` +
        `Supply: ${tokenMetadata.totalSupplyFormatted || 'unknown'} | ` +
        `Liquidity: $${tokenMetadata.liquidityUsd || 0} | ` +
        `Deployer: ${tokenMetadata.deployer || 'unknown'} | ` +
        `Owner: ${tokenMetadata.owner || 'unknown'}`,
    );

    // Keep using LitePricingService for token price (cached)
    const tokenPrice = await this.pricing.getTokenPrice(contractAddress, chain);
    this.logger.log(
      `Token price: $${tokenPrice.priceUsd} (source: ${tokenPrice.source})`,
    );

    const enrichedHolders = holders.map((holder) => {
      const balanceNum = Number.parseFloat(holder.balance);
      const usdValue = Number.isFinite(balanceNum)
        ? Math.round(balanceNum * tokenPrice.priceUsd * 100) / 100
        : 0;

      return {
        ...holder,
        usdValue,
        tokenPrice: tokenPrice.priceUsd,
      };
    });

    // ========== PHASE 2: Classify All Holders + Detect Team ==========
    const { classifications, teamDetection } =
      await this.intelligence.classifyHolders(
      enrichedHolders.map((holder) => ({
        walletAddress: holder.walletAddress,
        balance: holder.balance,
        rank: holder.rank,
        usdValue: holder.usdValue || 0,
      })),
      tokenMetadata,
      chain,
    );
    this.logger.log(
      `Holders classified: ${classifications.size} total | ` +
        `Team wallets: ${teamDetection.teamWalletCount} (${teamDetection.teamTotalPctOfSupply.toFixed(1)}% supply) | ` +
        `Risk: ${teamDetection.riskLevel}`,
    );

    // ========== PHASE 3: Batch Analysis Loop ==========
    const analyzedHolders: AnalyzedHolder[] = [];

    for (let i = 0; i < enrichedHolders.length; i += batchSize) {
      const batch = enrichedHolders.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (holder) => {
          const filter = classifications.get(holder.walletAddress.toLowerCase());

          if (filter && !filter.shouldAnalyze) {
            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: filter.label,
              walletLabelDetail: filter.labelDetail || null,
              isTeamLinked: filter.isTeamLinked,
              teamConnectionPath: filter.teamConnectionPath || null,
              labelConfidence: filter.labelConfidence,
              labelEvidence: filter.labelEvidence,
              teamConnectionScore: filter.teamConnectionScore,
              classification: null,
              score: null,
              portfolio: null,
              pnl: null,
            } as AnalyzedHolder;
          }

          try {
            const transfers = await this.ingestion.getRecentTransfers(
              holder.walletAddress,
              chain,
              200,
            );

            let holdingsProfile: HoldingsProfile | null = null;
            if (holder.rank <= 50) {
              try {
                holdingsProfile = await this.portfolio.getPortfolioContext(
                  holder.walletAddress,
                  address,
                  holder.usdValue,
                  chain,
                );
              } catch (err: unknown) {
                this.logger.warn(
                  `Portfolio fetch failed for ${holder.walletAddress}: ${this.getErrorMessage(err)}`,
                );
              }
            }

            const features = this.feature.extractFeatures(
              transfers,
              holder.walletAddress,
              chain,
              holdingsProfile?.holdingTokenCount,
              1,
              holdingsProfile,
            );
            const swaps = this.feature.extractSwaps(transfers, holder.walletAddress);
            const pnlMetrics = await this.pnl.computePnl(swaps, chain);
            const classification = this.classifier.classify(features, pnlMetrics);
            const score = this.scorer.score(features, pnlMetrics);

            const pnlSummary =
              pnlMetrics.trades.length > 0
                ? {
                    totalPnlUsd: pnlMetrics.totalRealizedPnlUsd,
                    winRate: pnlMetrics.winRate,
                    avgRoi: pnlMetrics.avgRoiPercent,
                    profitFactor: pnlMetrics.profitFactor,
                    tradeCount: pnlMetrics.trades.length,
                    largestWin: pnlMetrics.largestWinUsd,
                    largestLoss: pnlMetrics.largestLossUsd,
                  }
                : null;

            const existingAnalysisResult = {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              classification,
              score,
              portfolio: holdingsProfile,
              pnl: pnlSummary,
            };

            return {
              ...existingAnalysisResult,
              walletLabel: filter?.label || 'eoa',
              walletLabelDetail: filter?.labelDetail || null,
              isTeamLinked: filter?.isTeamLinked || false,
              teamConnectionPath: filter?.teamConnectionPath || null,
              labelConfidence: filter?.labelConfidence ?? 50,
              labelEvidence: filter?.labelEvidence ?? [],
              teamConnectionScore: filter?.teamConnectionScore ?? 0,
            } as AnalyzedHolder;
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to analyze ${holder.walletAddress}: ${this.getErrorMessage(err)}`,
            );
            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: filter?.label ?? 'eoa',
              walletLabelDetail: filter?.labelDetail ?? null,
              isTeamLinked: filter?.isTeamLinked || false,
              teamConnectionPath: filter?.teamConnectionPath || null,
              labelConfidence: filter?.labelConfidence ?? 50,
              labelEvidence: filter?.labelEvidence ?? [],
              teamConnectionScore: filter?.teamConnectionScore ?? 0,
              classification: null,
              score: null,
              portfolio: null,
              pnl: null,
              error: this.getErrorMessage(err),
            } as AnalyzedHolder;
          }
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          analyzedHolders.push(result.value);
        }
      }

      // Respect Etherscan rate limits between batches
      if (i + batchSize < enrichedHolders.length) {
        await this.sleep(batchDelayMs);
      }

      this.logger.log(
        `Analyzed ${Math.min(i + batchSize, enrichedHolders.length)}/${enrichedHolders.length} holders`,
      );
    }

    // Step 3: Aggregate results
    const quality = this.aggregation.computeQualityMetrics(
      analyzedHolders,
      tokenMetadata.totalSupply ?? '0',
      tokenMetadata.totalSupplyFormatted,
    );
    const distribution = this.aggregation.computeDistribution(
      holders,
      tokenMetadata.totalSupply ?? '0',
      tokenMetadata.totalSupplyFormatted,
    );
    const callouts = this.aggregation.generateRiskCallouts(
      quality,
      distribution,
      analyzedHolders,
      teamDetection,
    );
    const qualityWithPrice = {
      ...quality,
      tokenPriceUsd: tokenPrice.priceUsd,
      priceSource: tokenPrice.source,
      priceFetchedAt: tokenPrice.fetchedAt,
      priceConfidence: tokenPrice.confidence,
      totalSupply: tokenMetadata.totalSupplyFormatted?.toString() || null,
      circulatingSupply: tokenMetadata.circulatingSupply || null,
      liquidityUsd: tokenMetadata.liquidityUsd,
      liquidityPairs: tokenMetadata.liquidityPairs,
      deployer: tokenMetadata.deployer,
      owner: tokenMetadata.owner,
      metadataSource: tokenMetadata.source,
      teamDetection,
    };
    const qualityMetrics =
      qualityWithPrice as unknown as QueryDeepPartialEntity<
        Record<string, unknown> | null
      >;
    const distributionMetrics =
      distribution as unknown as QueryDeepPartialEntity<
        Record<string, unknown> | null
      >;

    // Step 4: Save to database
    await this.tokenRepo.update(
      { contractAddress: address, chain },
      {
        tokenName: tokenMetadata.name,
        tokenSymbol: tokenMetadata.symbol,
        totalHolders: enrichedHolders.length,
        holdersData: analyzedHolders,
        qualityMetrics,
        distribution: distributionMetrics,
        riskCallouts: callouts,
        status: 'done',
        errorMessage: null,
        updatedAt: new Date(),
      },
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
