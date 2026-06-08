import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ConfigService } from '@nestjs/config';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import { ChainbaseService } from './chainbase.service';
import {
  FAST_MODE_TRANSFER_LIMIT,
  LiteIngestionService,
} from './lite-ingestion.service';
import { LiteFeatureService } from './lite-feature.service';
import { LiteClassifierService } from './lite-classifier.service';
import { LiteScorerService } from './lite-scorer.service';
import { LitePricingService } from './lite-pricing.service';
import { LitePortfolioService } from './lite-portfolio.service';
import type { HoldingsProfile } from './lite-portfolio.service';
import { LitePnlService } from './lite-pnl.service';
import type { WalletPnlMetrics } from './lite-pnl.service';
import { TokenIntelligenceService } from './token-intelligence.service';
import {
  TOP_HOLDERS_FETCH_LIMIT,
  TOP_HOLDERS_PORTFOLIO_RANK_LIMIT,
} from '../constants/token-analysis-limits';
import {
  HolderAggregationService,
  AnalyzedHolder,
  HolderPnlSummary,
} from './holder-aggregation.service';
import {
  TokenAnalysisTargetValidation,
  TokenTargetValidatorService,
} from './token-target-validator.service';
import {
  ContractSafetyReport,
  TokenContractSafetyService,
} from './token-contract-safety.service';
import { TokenMarketContextService } from './token-market-context.service';
import { TokenOffchainCredibilityService } from './token-offchain-credibility.service';

// FAST_MODE = true enables the B2B holder-intelligence path:
//   * skip LitePnlService entirely (no realized PnL reconstruction)
//   * skip historical pricing (LitePnlService is its only consumer)
//   * truncate transfer history to FAST_MODE_TRANSFER_LIMIT per wallet
//   * use lightweight hold-duration heuristics in LiteFeatureService
// Set FAST_MODE = false to restore full historical analysis when we ship the
// deep wallet-analysis mode. LitePnlService is intentionally still wired up so
// flipping this flag is a one-line change.
const FAST_MODE = true;

function generateShareId(): string {
  return randomBytes(6).toString('hex');
}

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
    private readonly targetValidator: TokenTargetValidatorService,
    private readonly contractSafety: TokenContractSafetyService,
    private readonly marketContext: TokenMarketContextService,
    private readonly offChainCredibility: TokenOffchainCredibilityService,
  ) {}

  // --- START ANALYSIS (saves status=processing, runs in background) ---
  async startAnalysis(
    contractAddress: string,
    chain: string,
  ): Promise<{
    entity: TokenAnalysisEntity;
    validation: TokenAnalysisTargetValidation;
  }> {
    const address = contractAddress.trim().toLowerCase();
    const validation = await this.targetValidator.validate(address, chain);

    if (!validation.canAnalyze) {
      await this.tokenRepo.upsert(
        {
          contractAddress: address,
          chain,
          status: 'not_token',
          errorMessage: validation.message,
          qualityMetrics: {
            targetValidation: {
              kind: validation.kind,
              addressType: validation.addressType,
              title: validation.title,
              message: validation.message,
            },
          },
          updatedAt: new Date(),
        },
        ['contractAddress', 'chain'],
      );

      const blocked = await this.tokenRepo.findOne({
        where: { contractAddress: address, chain },
      });

      if (!blocked) {
        throw new Error(`Unable to persist not_token row for ${address} on ${chain}`);
      }

      return { entity: blocked, validation };
    }

    const existing = await this.tokenRepo.findOne({
      where: { contractAddress: address, chain },
    });
    const shareId = existing?.shareId ?? generateShareId();

    // Upsert with status=processing
    await this.tokenRepo.upsert(
      {
        contractAddress: address,
        chain,
        shareId,
        status: 'processing',
        errorMessage: null,
        qualityMetrics: null,
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

    return { entity, validation };
  }

  extractTargetValidation(
    entity: TokenAnalysisEntity,
  ): TokenAnalysisTargetValidation | null {
    if (entity.status !== 'not_token') {
      return null;
    }

    const metrics = entity.qualityMetrics as
      | {
          targetValidation?: {
            kind?: TokenAnalysisTargetValidation['kind'];
            addressType?: TokenAnalysisTargetValidation['addressType'];
            title?: string;
            message?: string;
          };
        }
      | null
      | undefined;

    const stored = metrics?.targetValidation;
    if (stored?.title && stored.message && stored.addressType && stored.kind) {
      return {
        kind: stored.kind,
        addressType: stored.addressType,
        canAnalyze: false,
        title: stored.title,
        message: stored.message,
      };
    }

    return {
      kind: 'non_token_contract',
      addressType: 'contract',
      canAnalyze: false,
      title: 'Not a token contract',
      message:
        entity.errorMessage ??
        'This address cannot be analyzed as an ERC-20 token contract.',
    };
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

  async findByShareId(shareId: string): Promise<TokenAnalysisEntity | null> {
    return this.tokenRepo.findOne({
      where: { shareId: shareId.toLowerCase() },
    });
  }

  async refreshContractSafety(
    contractAddress: string,
    chain: string,
  ): Promise<ContractSafetyReport> {
    const address = contractAddress.trim().toLowerCase();
    const existing = await this.tokenRepo.findOne({
      where: { contractAddress: address, chain },
    });
    const quality = (existing?.qualityMetrics ?? {}) as Record<string, unknown>;

    const report = await this.contractSafety.analyzeContract(address, chain, {
      owner: typeof quality.owner === 'string' ? quality.owner : null,
      name: existing?.tokenName ?? null,
      symbol: existing?.tokenSymbol ?? null,
    });

    if (existing) {
      const qualityMetrics = {
        ...quality,
        contractSafety: report,
      } as unknown as QueryDeepPartialEntity<Record<string, unknown> | null>;

      await this.tokenRepo.update(
        { contractAddress: address, chain },
        {
          qualityMetrics,
          updatedAt: new Date(),
        },
      );
    }

    return report;
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

    // Step 1: Fetch top holders from Chainbase
    const { holders } = await this.chainbase.getTopHolders(
      address,
      chain,
      TOP_HOLDERS_FETCH_LIMIT,
    );
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

    const contractSafetyReport = await this.contractSafety.analyzeContract(
      address,
      chain,
      {
        owner: tokenMetadata.owner,
        name: tokenMetadata.name,
        symbol: tokenMetadata.symbol,
      },
    );
    this.logger.log(
      `Contract safety: score=${contractSafetyReport.score ?? 'n/a'} ` +
        `risk=${contractSafetyReport.riskLevel} verified=${contractSafetyReport.verifiedSource}`,
    );

    // Keep using LitePricingService for token price (cached)
    const tokenPrice = await this.pricing.getTokenPrice(contractAddress, chain);
    this.logger.log(
      `Token price: $${tokenPrice.priceUsd} (source: ${tokenPrice.source})`,
    );

    const tokenDecimals =
      tokenMetadata.decimals !== null && tokenMetadata.decimals >= 0
        ? tokenMetadata.decimals
        : 18;

    const enrichedHolders = holders.map((holder) => {
      const rawBalance = holder.balance;
      const normalizedBalance = this.formatUnits(rawBalance, tokenDecimals);
      const balanceNum = Number.parseFloat(normalizedBalance);
      const usdValue = Number.isFinite(balanceNum)
        ? Math.round(balanceNum * tokenPrice.priceUsd * 100) / 100
        : 0;

      return {
        ...holder,
        rawBalance,
        balance: Number.isFinite(balanceNum) ? normalizedBalance : '0',
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

    const stakingRelatedContracts = this.detectStakingRelatedContracts(
      enrichedHolders,
      classifications,
      tokenMetadata.symbol,
    );
    if (stakingRelatedContracts.size > 0) {
      this.logger.log(
        `Staking-related contracts detected for ${tokenMetadata.symbol ?? 'token'}: ${stakingRelatedContracts.size}`,
      );
    }

    // ========== PHASE 3: Batch Analysis Loop ==========
    const analyzedHolders: AnalyzedHolder[] = [];

    for (let i = 0; i < enrichedHolders.length; i += batchSize) {
      const batch = enrichedHolders.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (holder) => {
          const filter = classifications.get(holder.walletAddress.toLowerCase());
          const holdingsProfile = await this.fetchHolderPortfolioContext(
            holder.walletAddress,
            holder.rank,
            address,
            holder.usdValue,
            chain,
            filter?.label,
            stakingRelatedContracts,
            tokenMetadata.symbol,
          );

          if (filter && !filter.shouldAnalyze) {
            return {
              walletAddress: holder.walletAddress,
              balance: holder.balance,
              rawBalance: holder.rawBalance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: filter.label,
              walletLabelDetail: filter.labelDetail || null,
              knownLabel: filter.knownLabel ?? null,
              isTeamLinked: filter.isTeamLinked,
              teamConnectionPath: filter.teamConnectionPath || null,
              labelConfidence: filter.labelConfidence,
              labelEvidence: filter.labelEvidence,
              teamConnectionScore: filter.teamConnectionScore,
              classification: null,
              score: null,
              portfolio: holdingsProfile,
              pnl: null,
            } as AnalyzedHolder;
          }

          try {
            // Per-wallet timing instrumentation. Makes FAST_MODE latency
            // measurable and easy to benchmark in production logs.
            const transferLimit = FAST_MODE ? FAST_MODE_TRANSFER_LIMIT : 200;
            const tTransfersStart = Date.now();
            const transfers = await this.ingestion.getRecentTransfers(
              holder.walletAddress,
              chain,
              transferLimit,
              FAST_MODE,
            );
            const tTransfers = Date.now() - tTransfersStart;

            const tFeaturesStart = Date.now();
            const features = this.feature.extractFeatures(
              transfers,
              holder.walletAddress,
              chain,
              holdingsProfile?.holdingTokenCount,
              1,
              holdingsProfile,
              FAST_MODE,
              address,
            );
            const tFeatures = Date.now() - tFeaturesStart;

            // FAST_MODE bypass: skip LitePnlService and historical pricing.
            // LitePnlService remains wired up so non-fast-mode callers still
            // work, but in FAST_MODE we always pass pnl = null downstream.
            let pnlMetrics: WalletPnlMetrics | null = null;
            if (!FAST_MODE) {
              const swaps = this.feature.extractSwaps(
                transfers,
                holder.walletAddress,
              );
              pnlMetrics = await this.pnl.computePnl(swaps, chain);
            }

            const tClassifyStart = Date.now();
            const classification = this.classifier.classify(features, pnlMetrics);
            const score = this.scorer.score(features, pnlMetrics);
            const tClassify = Date.now() - tClassifyStart;

            this.logger.debug(
              `[timing] wallet=${holder.walletAddress} rank=${holder.rank} ` +
                `transfers_ms=${tTransfers} features_ms=${tFeatures} ` +
                `classify_ms=${tClassify} fastMode=${FAST_MODE}`,
            );

            const pnlSummary: HolderPnlSummary | null =
              pnlMetrics && pnlMetrics.trades.length > 0
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
              rawBalance: holder.rawBalance,
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
              knownLabel: filter?.knownLabel ?? null,
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
              rawBalance: holder.rawBalance,
              rank: holder.rank,
              usdValue: holder.usdValue,
              tokenPrice: holder.tokenPrice,
              walletLabel: filter?.label ?? 'eoa',
              walletLabelDetail: filter?.labelDetail ?? null,
              knownLabel: filter?.knownLabel ?? null,
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
      analyzedHolders,
      tokenMetadata.totalSupply ?? '0',
      tokenMetadata.totalSupplyFormatted,
    );
    const callouts = this.aggregation.generateRiskCallouts(
      quality,
      distribution,
      analyzedHolders,
      teamDetection,
    );
    const qualityBase = {
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
      contractSafety: contractSafetyReport,
    };

    const marketContextReport = await this.marketContext.buildReport({
      contractAddress: address,
      chain,
      qualityMetrics: qualityBase,
      distribution,
      holdersData: analyzedHolders,
    });
    this.logger.log(
      `Market context: score=${marketContextReport.score ?? 'n/a'} ` +
        `tier=${marketContextReport.maturityTier} risk=${marketContextReport.riskLevel}`,
    );

    let offChainCredibilityReport = null;
    try {
      offChainCredibilityReport = await this.offChainCredibility.buildReport({
        tokenName: tokenMetadata.name,
        tokenSymbol: tokenMetadata.symbol,
        contractAddress: address,
        chain,
        existingMetadata: {
          website: null,
          liquidityUsd: tokenMetadata.liquidityUsd,
          liquidityPairs: tokenMetadata.liquidityPairs,
          metadataSource: tokenMetadata.source,
        },
      });
      this.logger.log(
        `Off-chain credibility: score=${offChainCredibilityReport.score ?? 'n/a'} ` +
          `tier=${offChainCredibilityReport.credibilityTier} risk=${offChainCredibilityReport.riskLevel}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Off-chain credibility failed for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const qualityWithPrice = {
      ...qualityBase,
      marketContext: marketContextReport,
      offChainCredibility: offChainCredibilityReport,
    };
    const qualityMetrics =
      qualityWithPrice as unknown as QueryDeepPartialEntity<
        Record<string, unknown> | null
      >;
    const distributionMetrics =
      distribution as unknown as QueryDeepPartialEntity<
        Record<string, unknown> | null
      >;

    // Step 4: Save to database.
    // Token metadata is always persisted as nullable strings so a partial
    // metadata response never blocks the analysis from completing. This
    // covers initial insert, re-analysis, and the processing -> done lifecycle.
    const persistedTokenName = tokenMetadata?.name ?? null;
    const persistedTokenSymbol = tokenMetadata?.symbol ?? null;

    this.logger.debug(
      `[token-analysis] persist metadata symbol=${persistedTokenSymbol ?? 'null'} name=${persistedTokenName ?? 'null'}`,
    );

    try {
      await this.tokenRepo.update(
        { contractAddress: address, chain },
        {
          tokenName: persistedTokenName,
          tokenSymbol: persistedTokenSymbol,
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
    } catch (err: unknown) {
      // Persisting must not abort the pipeline silently. We log and rethrow so
      // the outer runAnalysis() catch sets status=error with the message.
      this.logger.error(
        `[token-analysis] persistence failed for ${address}: ${this.getErrorMessage(err)}`,
      );
      throw err;
    }

    this.logger.log(`Analysis complete for ${contractAddress}. Saved to DB.`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private detectStakingRelatedContracts(
    holders: Array<{ walletAddress: string }>,
    classifications: Awaited<
      ReturnType<TokenIntelligenceService['classifyHolders']>
    >['classifications'],
    tokenSymbol: string | null | undefined,
  ): Set<string> {
    const stakingRelatedContracts = new Set<string>();
    const symbolLower = (tokenSymbol ?? '').trim().toLowerCase();
    if (!symbolLower) {
      return stakingRelatedContracts;
    }

    for (const holder of holders) {
      const filter = classifications.get(holder.walletAddress.toLowerCase());
      if (filter?.label !== 'generic_contract') {
        continue;
      }

      const knownLabel = (filter.knownLabel ?? '').toLowerCase();
      if (
        knownLabel.includes(symbolLower) ||
        knownLabel.includes('stake') ||
        knownLabel.includes('silo') ||
        knownLabel.includes('vault')
      ) {
        stakingRelatedContracts.add(holder.walletAddress.toLowerCase());
      }
    }

    return stakingRelatedContracts;
  }

  private async fetchHolderPortfolioContext(
    walletAddress: string,
    rank: number,
    trackedTokenAddress: string,
    trackedTokenUsdValue: number,
    chain: string,
    holderLabel?: string,
    stakingRelatedContracts: ReadonlySet<string> = new Set(),
    trackedTokenSymbol?: string | null,
  ): Promise<HoldingsProfile | null> {
    if (holderLabel === 'exchange' || holderLabel === 'cex_deposit') {
      return null;
    }

    if (rank > TOP_HOLDERS_PORTFOLIO_RANK_LIMIT) {
      return null;
    }

    try {
      return await this.portfolio.getPortfolioContext(
        walletAddress,
        trackedTokenAddress,
        trackedTokenUsdValue,
        chain,
        stakingRelatedContracts,
        trackedTokenSymbol,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Portfolio fetch failed for ${walletAddress}: ${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }

  private formatUnits(rawValue: string, decimals: number): string {
    try {
      const normalizedDecimals = Math.max(0, decimals);
      const base = BigInt(10) ** BigInt(normalizedDecimals);
      const amount = BigInt(rawValue || '0');
      const whole = amount / base;
      const fraction = amount % base;

      if (normalizedDecimals === 0) {
        return whole.toString();
      }

      const fractionText = fraction
        .toString()
        .padStart(normalizedDecimals, '0')
        .replace(/0+$/, '');

      return fractionText.length > 0
        ? `${whole.toString()}.${fractionText}`
        : whole.toString();
    } catch {
      return '0';
    }
  }
}
