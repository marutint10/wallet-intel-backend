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
import { LitePnlService } from './lite-pnl.service';
import { WalletFilterService } from './wallet-filter.service';
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
    private readonly walletFilter: WalletFilterService,
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

    const tokenPrice = await this.pricing.getTokenPrice(address, chain);
    this.logger.log(
      `Token price: $${tokenPrice.priceUsd} (source: ${tokenPrice.source})`,
    );

    let tokenName: string | null = null;
    let tokenSymbol: string | null = null;
    let totalSupply: string | null = null;

    try {
      const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
      const dexResp = await fetch(dexUrl);
      if (dexResp.ok) {
        const dexData = (await dexResp.json()) as {
          pairs?: Array<{
            baseToken?: { address?: string; name?: string; symbol?: string };
            quoteToken?: { address?: string; name?: string; symbol?: string };
          }>;
        };
        const pair = dexData.pairs?.[0];

        if (pair?.baseToken?.address?.toLowerCase() === address) {
          tokenName = pair.baseToken.name ?? null;
          tokenSymbol = pair.baseToken.symbol ?? null;
        } else if (pair?.quoteToken?.address?.toLowerCase() === address) {
          tokenName = pair.quoteToken.name ?? null;
          tokenSymbol = pair.quoteToken.symbol ?? null;
        }
      }
    } catch {
      // non-critical metadata enrichment
    }

    try {
      const platformMap: Record<string, string> = {
        ethereum: 'ethereum',
        polygon: 'polygon-pos',
        bsc: 'binance-smart-chain',
        base: 'base',
      };
      const platform = platformMap[chain.toLowerCase()];

      if (platform) {
        const cgUrl = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}`;
        const cgResp = await fetch(cgUrl);

        if (cgResp.ok) {
          const cgData = (await cgResp.json()) as {
            name?: string;
            symbol?: string;
            market_data?: { total_supply?: number | string | null };
          };

          if (cgData.market_data?.total_supply !== undefined && cgData.market_data?.total_supply !== null) {
            totalSupply = String(cgData.market_data.total_supply);
          }
          if (!tokenName && cgData.name) {
            tokenName = cgData.name;
          }
          if (!tokenSymbol && cgData.symbol) {
            tokenSymbol = cgData.symbol.toUpperCase();
          }
        }
      }
    } catch {
      // non-critical supply enrichment
    }

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

    const filterResults = await this.walletFilter.filterWallets(
      enrichedHolders.map((holder) => ({
        address: holder.walletAddress,
        usdValue: holder.usdValue || 0,
      })),
      chain,
    );

    // Step 2: Analyze each holder in batches of 5
    const analyzed: AnalyzedHolder[] = [];

    for (let i = 0; i < enrichedHolders.length; i += batchSize) {
      const batch = enrichedHolders.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (holder) => {
          const filter = filterResults.get(holder.walletAddress.toLowerCase());

          if (filter && !filter.shouldAnalyze) {
            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: filter.label,
              walletLabelDetail: filter.labelDetail || null,
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
            const features = this.feature.extractFeatures(
              transfers,
              holder.walletAddress,
              chain,
            );
            const swaps = this.feature.extractSwaps(transfers, holder.walletAddress);
            const pnlMetrics = await this.pnl.computePnl(swaps, chain);
            const classification = this.classifier.classify(features, pnlMetrics);
            const score = this.scorer.score(features, pnlMetrics);

            let portfolioContext = null;
            if (holder.rank <= 50) {
              try {
                portfolioContext = await this.portfolio.getPortfolioContext(
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

            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: 'eoa',
              walletLabelDetail: null,
              classification,
              score,
              portfolio: portfolioContext,
              pnl: pnlSummary,
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
          analyzed.push(result.value);
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
    const quality = this.aggregation.computeQualityMetrics(analyzed);
    const distribution = this.aggregation.computeDistribution(
      holders,
      totalSupply ?? '0',
    );
    const callouts = this.aggregation.generateRiskCallouts(
      quality,
      distribution,
      analyzed,
    );
    const qualityWithPrice = {
      ...quality,
      tokenPriceUsd: tokenPrice.priceUsd,
      priceSource: tokenPrice.source,
      priceFetchedAt: tokenPrice.fetchedAt,
      priceConfidence: tokenPrice.confidence,
      totalSupply,
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
        tokenName,
        tokenSymbol,
        totalHolders: enrichedHolders.length,
        holdersData: analyzed,
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
