import { Injectable } from '@nestjs/common';
import { TokenCategory } from '../constants/token-categories';
import {
	HolderWalletScoreBreakdown,
	HolderWalletScoreDebugData,
	Trade,
	TraderWalletScoreBreakdown,
	TraderWalletScoreDebugData,
	WalletActivityMetricsResponse,
	WalletHolderScoreAssetSelectionDebug,
	WalletHolderScoreConvictionDebug,
	WalletHolderScorePortfolioQualityDebug,
	WalletHolderScorePortfolioSizeDebug,
	WalletContextResponse,
	WalletDexMetricsResponse,
	WalletConfidenceFields,
	WalletHoldTimeMetricsResponse,
	WalletPortfolioItem,
	WalletRiskMetricsResponse,
	WalletScoreBand,
	WalletScoreConsistencyDebug,
	WalletScoreDimensionDebugSummary,
	WalletScoreDebugResponse,
	WalletScoreDimensionBreakdown,
	WalletScoreExplanation,
	WalletScoreGateStatus,
	WalletScoreExperienceDebug,
	WalletScoreMarketAdaptabilityDebug,
	WalletScoreMetricDebug,
	WalletScorePortfolioDebug,
	WalletScoreProfitabilityDebug,
	WalletScoreRealizedPnLQualityDebug,
	WalletScoreRiskManagementDebug,
	WalletScoreResponse,
	WalletScoreResult,
	WalletScoreWeightedRoiDebug,
	WalletSummaryResponse,
	WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletConfidenceService } from './wallet-confidence.service';
import { WalletContextService } from './wallet-context.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';
import { WalletPricingService } from './wallet-pricing.service';

interface ScoreBracket {
	min: number;
	score: number;
}

interface InvertedScoreBracket {
	max: number;
	score: number;
}

interface ScoreDimensionResult<TDebug extends WalletScoreDimensionDebugSummary> {
	score: number;
	debug: TDebug;
}

@Injectable()
export class WalletScoringService {
	private static readonly TRADER_WEIGHTED_ROI_MAX = 25;
	private static readonly TRADER_REALIZED_PNL_QUALITY_MAX = 15;
	private static readonly TRADER_CONSISTENCY_MAX = 15;
	private static readonly TRADER_RISK_MANAGEMENT_MAX = 20;
	private static readonly TRADER_PORTFOLIO_QUALITY_MAX = 10;
	private static readonly TRADER_EXPERIENCE_MAX = 10;
	private static readonly TRADER_MARKET_ADAPTABILITY_MAX = 5;
	private static readonly TRADER_GAMBLER_PENALTY = 12;
	private static readonly HOLDER_PORTFOLIO_QUALITY_MAX = 35;
	private static readonly HOLDER_CONVICTION_MAX = 30;
	private static readonly HOLDER_PORTFOLIO_SIZE_MAX = 20;
	private static readonly HOLDER_ASSET_SELECTION_MAX = 15;

	constructor(
		private readonly walletPnlService: WalletPnlService,
		private readonly walletAnalyticsService: WalletAnalyticsService,
		private readonly walletContextService: WalletContextService,
		private readonly walletPortfolioService: WalletPortfolioService,
		private readonly walletConfidenceService: WalletConfidenceService,
		private readonly walletPricingService: WalletPricingService,
	) {}

	getTraderWeightedRoiValue(
		summary: WalletSummaryResponse,
		risk: WalletRiskMetricsResponse,
	): number {
		const sampleSizeMultiplierValue = this.resolveWeightedRoiSampleSizeMultiplier(
			summary.total_swaps,
		);
		const qualityMultiplierValue = this.resolveWeightedRoiQualityMultiplier(
			summary.avgWinRate,
			risk.profitFactor,
		);

		return this.computeWeightedRoiValue(
			summary.avgROI,
			sampleSizeMultiplierValue,
			qualityMultiplierValue,
		);
	}

	async getWalletScore(
		address: string,
		debug = false,
	): Promise<WalletScoreResult> {
		const [context, summary, portfolioResult] = await Promise.all([
			this.walletContextService.getWalletContext(address),
			this.walletPnlService.getWalletSummary(address),
			this.walletPortfolioService.getPortfolioWithAvailability(address),
		]);

		const { portfolio, balancesAvailable } = portfolioResult;
		const scoringEligiblePortfolio = this.filterScoringEligibleHoldings(portfolio);
		const scoredAt = new Date().toISOString();

		if (!context.isTraderWallet) {
			const confidenceProfile = await this.walletConfidenceService.getConfidence(
				address,
				{ summary },
			);
			const positiveValueHoldings = this.filterHoldingsByUsdValue(
				scoringEligiblePortfolio,
				0,
			);

			if (positiveValueHoldings.length === 0) {
				const response: WalletScoreResponse = {
					address: summary.address,
					score: 0,
					scorePath: 'holder',
					...confidenceProfile,
					band: 'Unscored',
					breakdown: this.createEmptyHolderBreakdown(),
					scoreExplanation: this.createScoreExplanation(
						[],
						['No valued holdings were found.'],
						'Wallet has no priced holdings to score yet.',
					),
					gateStatus: 'Empty Wallet',
					balancesAvailable,
					scoredAt,
				};

				if (!debug) {
					return response;
				}

				return {
					...response,
					debug: this.createEmptyHolderScoreDebug(),
				};
			}

			const tokenCategories =
				await this.walletAnalyticsService.getTokenCategoryMetrics(address);

			return this.scoreHolder(
				summary.address,
				scoringEligiblePortfolio,
				tokenCategories,
				balancesAvailable,
				scoredAt,
				confidenceProfile,
				debug,
			);
		}

		const [activity, risk, holdTime, tokenCategories, dexMetrics, trades] =
			await Promise.all([
				this.walletAnalyticsService.getActivityMetrics(address),
				this.walletAnalyticsService.getRiskMetrics(address),
				this.walletAnalyticsService.getHoldTimeMetrics(address),
				this.walletAnalyticsService.getTokenCategoryMetrics(address),
				this.walletAnalyticsService.getDexMetrics(address),
				this.walletPnlService.getTrades(address),
			]);

		const tradingSpanDays = this.computeTradingSpanDays(trades);
		const confidenceProfile = await this.walletConfidenceService.getConfidence(
			address,
			{
				summary,
				activity,
				holdTime,
				trades,
			},
		);
		const gateStatus = this.resolveGateStatus(context, summary, activity);

		if (gateStatus !== 'Eligible') {
			const response: WalletScoreResponse = {
				address: summary.address,
				score: 0,
				scorePath: 'trader',
				...confidenceProfile,
				band: 'Unscored',
				breakdown: this.createEmptyTraderBreakdown(),
				scoreExplanation: this.createScoreExplanation(
					[],
					[`Score not computed: ${gateStatus}.`],
					`Trader score is unavailable because gate status is ${gateStatus}.`,
				),
				gateStatus,
				balancesAvailable,
				scoredAt,
			};

			if (!debug) {
				return response;
			}

			return {
				...response,
				debug: this.createEmptyTraderScoreDebug(),
			};
		}

		const portfolioQualityResult = this.scorePortfolioQuality(
			summary,
			holdTime,
			tokenCategories,
			scoringEligiblePortfolio,
		);
		const traderWeightedRoiResult = this.scoreTraderWeightedROI(summary, risk);
		const realizedPnlQualityResult = this.scoreRealizedPnLQuality(summary, risk);
		const consistencyResult = this.scoreConsistency(summary, activity, risk);
		const riskManagementResult = this.scoreRiskManagement(risk, summary, tokenCategories);
		const experienceResult = this.scoreExperience(
			summary,
			tradingSpanDays,
			activity,
			dexMetrics,
		);
		const marketAdaptabilityResult = this.scoreMarketAdaptability(
			dexMetrics,
			tokenCategories,
		);

		const breakdown: TraderWalletScoreBreakdown = {
			traderWeightedROI: this.createDimensionBreakdown(
				traderWeightedRoiResult.score,
				WalletScoringService.TRADER_WEIGHTED_ROI_MAX,
			),
			realizedPnLQuality: this.createDimensionBreakdown(
				realizedPnlQualityResult.score,
				WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
			),
			profitability: this.createDimensionBreakdown(
				traderWeightedRoiResult.score + realizedPnlQualityResult.score,
				WalletScoringService.TRADER_WEIGHTED_ROI_MAX +
					WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
			),
			consistency: this.createDimensionBreakdown(
				consistencyResult.score,
				WalletScoringService.TRADER_CONSISTENCY_MAX,
			),
			riskManagement: this.createDimensionBreakdown(
				riskManagementResult.score,
				WalletScoringService.TRADER_RISK_MANAGEMENT_MAX,
			),
			portfolioQuality: this.createDimensionBreakdown(
				portfolioQualityResult.score,
				WalletScoringService.TRADER_PORTFOLIO_QUALITY_MAX,
			),
			experience: this.createDimensionBreakdown(
				experienceResult.score,
				WalletScoringService.TRADER_EXPERIENCE_MAX,
			),
			marketAdaptability: this.createDimensionBreakdown(
				marketAdaptabilityResult.score,
				WalletScoringService.TRADER_MARKET_ADAPTABILITY_MAX,
			),
		};
		const traderWeightedRoiValue =
			traderWeightedRoiResult.debug.traderWeightedROI.value ?? 0;
		const gamblerPenalty = this.resolveGamblerPenalty(
			risk.profitFactor,
			summary.total_swaps,
		);
		const rawScore = this.calculateTotalScore(breakdown);
		const adjustedScore = Math.max(0, rawScore - gamblerPenalty);
		const hardCappedScore = this.applyWeightedRoiHardCap(
			adjustedScore,
			traderWeightedRoiValue,
		);
		const score = Math.round(hardCappedScore);
		const uncappedBand = this.resolveTraderBand(score);
		const band = this.applyWeightedRoiBandCap(uncappedBand, traderWeightedRoiValue);
		const scoreExplanation = this.buildTraderScoreExplanation(
			score,
			band,
			breakdown,
			traderWeightedRoiValue,
			risk,
			summary,
			gamblerPenalty,
		);
		const response: WalletScoreResponse = {
			address: summary.address,
			score,
			scorePath: 'trader',
			...confidenceProfile,
			band,
			breakdown,
			scoreExplanation,
			gateStatus,
			balancesAvailable,
			scoredAt,
		};

		if (!debug) {
			return response;
		}

		return {
			...response,
			debug: {
				traderWeightedROI: traderWeightedRoiResult.debug,
				realizedPnLQuality: realizedPnlQualityResult.debug,
				profitability: this.createLegacyProfitabilityDebug(
					traderWeightedRoiResult,
					realizedPnlQualityResult,
				),
				consistency: consistencyResult.debug,
				riskManagement: riskManagementResult.debug,
				portfolio: portfolioQualityResult.debug,
				portfolioQuality: portfolioQualityResult.debug,
				experience: experienceResult.debug,
				marketAdaptability: marketAdaptabilityResult.debug,
			},
		} satisfies WalletScoreDebugResponse;
	}

	private scoreHolder(
		address: string,
		portfolio: WalletPortfolioItem[],
		tokenCategories: WalletTokenCategoryMetricsResponse,
		balancesAvailable: boolean,
		scoredAt: string,
		confidenceProfile: WalletConfidenceFields,
		debug: boolean,
	): WalletScoreResult {
		const positiveValueHoldings = this.filterHoldingsByUsdValue(portfolio, 0);
		const nonDustHoldings = this.filterHoldingsByUsdValue(portfolio, 1);
		const qualityAssetPercent = this.calculateQualityAssetPercent(tokenCategories);
		const uniqueTokenCount = this.countUniquePortfolioTokens(nonDustHoldings);
		const categoryDiversity = tokenCategories.categoryDiversity;
		const memecoinHoldingPercent = tokenCategories.memecoinHoldingPercent;
		const avgHoldingDaysValue = this.computeAverageHoldingDays(positiveValueHoldings);
		const longestHoldDaysValue = this.computeLongestHoldingDays(positiveValueHoldings);
		const holdingsInProfitPercentValue = this.computeHoldingsInProfitPercent(
			positiveValueHoldings,
		);
		const avgUnrealizedRoiValue = this.computeAverageUnrealizedRoi(
			positiveValueHoldings,
		);
		const totalPortfolioUsdValue = this.computeTotalPortfolioUsd(positiveValueHoldings);
		const largestPositionUsdValue = this.computeLargestPositionUsd(
			positiveValueHoldings,
		);
		const nonDustCountValue = nonDustHoldings.length;
		const hasEthValue = this.hasEthExposure(portfolio) ? 1 : 0;

		const qualityAssetPercentMetric = this.createMetricDebug(
			qualityAssetPercent,
			this.bracketScore(qualityAssetPercent, [
				{ min: 80, score: 12 },
				{ min: 60, score: 9 },
				{ min: 40, score: 6 },
				{ min: 20, score: 3 },
			]),
		);
		const categoryDiversityMetric = this.createMetricDebug(
			categoryDiversity,
			this.bracketScore(categoryDiversity, [
				{ min: 4, score: 8 },
				{ min: 3, score: 6 },
				{ min: 2, score: 4 },
				{ min: 1, score: 2 },
			]),
		);
		const uniqueTokenCountMetric = this.createMetricDebug(
			uniqueTokenCount,
			this.bracketScore(uniqueTokenCount, [
				{ min: 8, score: 8 },
				{ min: 5, score: 6 },
				{ min: 3, score: 4 },
				{ min: 2, score: 2 },
			]),
		);
		const memecoinHoldingPercentMetric = this.createMetricDebug(
			memecoinHoldingPercent,
			this.invertedBracketScore(memecoinHoldingPercent, [
				{ max: 4.999, score: 7 },
				{ max: 14.999, score: 5 },
				{ max: 29.999, score: 3 },
				{ max: 49.999, score: 1 },
			]),
		);
		const portfolioQualityRaw =
			qualityAssetPercentMetric.weightedContribution +
			categoryDiversityMetric.weightedContribution +
			uniqueTokenCountMetric.weightedContribution +
			memecoinHoldingPercentMetric.weightedContribution;
		const portfolioQualityResult: ScoreDimensionResult<WalletHolderScorePortfolioQualityDebug> =
			{
				score: portfolioQualityRaw,
				debug: {
					...this.createDimensionDebugSummary(
						portfolioQualityRaw,
						WalletScoringService.HOLDER_PORTFOLIO_QUALITY_MAX,
					),
					qualityAssetPercent: qualityAssetPercentMetric,
					categoryDiversity: categoryDiversityMetric,
					uniqueTokenCount: uniqueTokenCountMetric,
					memecoinHoldingPercent: memecoinHoldingPercentMetric,
				},
			};

		const avgHoldingDaysMetric = this.createMetricDebug(
			avgHoldingDaysValue,
			this.bracketScore(avgHoldingDaysValue, [
				{ min: 365.0001, score: 12 },
				{ min: 180.0001, score: 9 },
				{ min: 90.0001, score: 6 },
				{ min: 30.0001, score: 3 },
			]),
		);
		const longestHoldDaysMetric = this.createMetricDebug(
			longestHoldDaysValue,
			this.bracketScore(longestHoldDaysValue, [
				{ min: 730.0001, score: 8 },
				{ min: 365.0001, score: 6 },
				{ min: 180.0001, score: 4 },
				{ min: 90.0001, score: 2 },
			]),
		);
		const holdingsInProfitPercentMetric = this.createMetricDebug(
			holdingsInProfitPercentValue,
			this.bracketScore(holdingsInProfitPercentValue, [
				{ min: 70.0001, score: 6 },
				{ min: 50.0001, score: 4 },
				{ min: 30.0001, score: 2 },
			]),
		);
		const avgUnrealizedRoiMetric = this.createMetricDebug(
			avgUnrealizedRoiValue,
			this.bracketScore(avgUnrealizedRoiValue, [
				{ min: 50.0001, score: 4 },
				{ min: 20.0001, score: 3 },
				{ min: 0.0001, score: 2 },
			]),
		);
		const convictionRaw =
			avgHoldingDaysMetric.weightedContribution +
			longestHoldDaysMetric.weightedContribution +
			holdingsInProfitPercentMetric.weightedContribution +
			avgUnrealizedRoiMetric.weightedContribution;
		const convictionResult: ScoreDimensionResult<WalletHolderScoreConvictionDebug> = {
			score: convictionRaw,
			debug: {
				...this.createDimensionDebugSummary(
					convictionRaw,
					WalletScoringService.HOLDER_CONVICTION_MAX,
				),
				avgHoldingDays: avgHoldingDaysMetric,
				longestHoldDays: longestHoldDaysMetric,
				holdingsInProfitPercent: holdingsInProfitPercentMetric,
				avgUnrealizedROI: avgUnrealizedRoiMetric,
			},
		};

		const totalPortfolioUsdMetric = this.createMetricDebug(
			totalPortfolioUsdValue,
			this.bracketScore(totalPortfolioUsdValue, [
				{ min: 100000.0001, score: 10 },
				{ min: 10000.0001, score: 7 },
				{ min: 1000.0001, score: 4 },
				{ min: 100.0001, score: 2 },
			]),
		);
		const largestPositionUsdMetric = this.createMetricDebug(
			largestPositionUsdValue,
			this.bracketScore(largestPositionUsdValue, [
				{ min: 50000.0001, score: 6 },
				{ min: 5000.0001, score: 4 },
				{ min: 500.0001, score: 2 },
				{ min: 50.0001, score: 1 },
			]),
		);
		const nonDustCountMetric = this.createMetricDebug(
			nonDustCountValue,
			this.bracketScore(nonDustCountValue, [
				{ min: 5, score: 4 },
				{ min: 3, score: 3 },
				{ min: 2, score: 2 },
				{ min: 1, score: 1 },
			]),
		);
		const portfolioSizeRaw =
			totalPortfolioUsdMetric.weightedContribution +
			largestPositionUsdMetric.weightedContribution +
			nonDustCountMetric.weightedContribution;
		const portfolioSizeResult: ScoreDimensionResult<WalletHolderScorePortfolioSizeDebug> =
			{
				score: portfolioSizeRaw,
				debug: {
					...this.createDimensionDebugSummary(
						portfolioSizeRaw,
						WalletScoringService.HOLDER_PORTFOLIO_SIZE_MAX,
					),
					totalPortfolioUsd: totalPortfolioUsdMetric,
					largestPositionUsd: largestPositionUsdMetric,
					nonDustCount: nonDustCountMetric,
					portfolioSizeMultiplier: this.createMetricDebug(0, 0),
				},
			};

		const blueChipHoldingPercentMetric = this.createMetricDebug(
			tokenCategories.blueChipHoldingPercent,
			this.bracketScore(tokenCategories.blueChipHoldingPercent, [
				{ min: 50.0001, score: 6 },
				{ min: 30.0001, score: 4 },
				{ min: 15.0001, score: 2 },
			]),
		);
		const stablecoinHoldingPercentMetric = this.createMetricDebug(
			tokenCategories.stablecoinHoldingPercent,
			this.bracketScore(tokenCategories.stablecoinHoldingPercent, [
				{ min: 20.0001, score: 5 },
				{ min: 10.0001, score: 3 },
				{ min: 5.0001, score: 2 },
			]),
		);
		const hasEthMetric = this.createMetricDebug(hasEthValue, hasEthValue > 0 ? 4 : 0);
		const assetSelectionRaw =
			blueChipHoldingPercentMetric.weightedContribution +
			stablecoinHoldingPercentMetric.weightedContribution +
			hasEthMetric.weightedContribution;
		const assetSelectionResult: ScoreDimensionResult<WalletHolderScoreAssetSelectionDebug> =
			{
				score: assetSelectionRaw,
				debug: {
					...this.createDimensionDebugSummary(
						assetSelectionRaw,
						WalletScoringService.HOLDER_ASSET_SELECTION_MAX,
					),
					blueChipHoldingPercent: blueChipHoldingPercentMetric,
					stablecoinHoldingPercent: stablecoinHoldingPercentMetric,
					hasEth: hasEthMetric,
				},
			};

		const breakdown: HolderWalletScoreBreakdown = {
			portfolioQuality: this.createDimensionBreakdown(
				portfolioQualityResult.score,
				WalletScoringService.HOLDER_PORTFOLIO_QUALITY_MAX,
			),
			conviction: this.createDimensionBreakdown(
				convictionResult.score,
				WalletScoringService.HOLDER_CONVICTION_MAX,
			),
			portfolioSize: this.createDimensionBreakdown(
				portfolioSizeResult.score,
				WalletScoringService.HOLDER_PORTFOLIO_SIZE_MAX,
			),
			assetSelection: this.createDimensionBreakdown(
				assetSelectionResult.score,
				WalletScoringService.HOLDER_ASSET_SELECTION_MAX,
			),
		};
		const rawScore = this.calculateTotalScore(breakdown);
		const portfolioSizeMultiplier = this.resolveHolderPortfolioSizeMultiplier(
			totalPortfolioUsdValue,
		);
		const score = Math.round(rawScore * portfolioSizeMultiplier);
		const band = this.resolveHolderBand(score);
		const response: WalletScoreResponse = {
			address,
			score,
			scorePath: 'holder',
			...confidenceProfile,
			band,
			breakdown,
			scoreExplanation: this.buildHolderScoreExplanation(score, band, breakdown),
			gateStatus: 'Eligible (Holder)',
			balancesAvailable,
			scoredAt,
		};

		if (!debug) {
			return response;
		}

		const holderDebug: HolderWalletScoreDebugData = {
			portfolioQuality: portfolioQualityResult.debug,
			conviction: convictionResult.debug,
			portfolioSize: {
				...portfolioSizeResult.debug,
				portfolioSizeMultiplier: this.createMetricDebug(
					portfolioSizeMultiplier,
					Math.round(rawScore * portfolioSizeMultiplier),
				),
			},
			assetSelection: assetSelectionResult.debug,
		};

		return {
			...response,
			debug: holderDebug,
		} satisfies WalletScoreDebugResponse;
	}

	private resolveGateStatus(
		context: WalletContextResponse,
		summary: WalletSummaryResponse,
		activity: WalletActivityMetricsResponse,
	): WalletScoreGateStatus {
		if (!context.isTraderWallet) {
			return 'Not a Trader Wallet';
		}

		if (summary.total_swaps < 5) {
			return 'Insufficient Data';
		}

		if (activity.tradingSpanRatio === 0) {
			return 'No Trading Activity';
		}

		return 'Eligible';
	}


	private scoreTraderWeightedROI(
		summary: WalletSummaryResponse,
		risk: WalletRiskMetricsResponse,
	): ScoreDimensionResult<WalletScoreWeightedRoiDebug> {
		const sampleSizeMultiplierValue = this.resolveWeightedRoiSampleSizeMultiplier(
			summary.total_swaps,
		);
		const qualityMultiplierValue = this.resolveWeightedRoiQualityMultiplier(
			summary.avgWinRate,
			risk.profitFactor,
		);
		const traderWeightedRoiValue = this.computeWeightedRoiValue(
			summary.avgROI,
			sampleSizeMultiplierValue,
			qualityMultiplierValue,
		);

		const traderWeightedROI = this.createMetricDebug(
			traderWeightedRoiValue,
			this.bracketScore(traderWeightedRoiValue, [
				{ min: 80, score: 25 },
				{ min: 50, score: 21 },
				{ min: 25, score: 16 },
				{ min: 10, score: 11 },
				{ min: 0, score: 7 },
				{ min: -10, score: 4 },
				{ min: -20, score: 2 },
				{ min: -40, score: 1 },
			]),
		);
		const avgROI = this.createMetricDebug(summary.avgROI, 0);
		const sampleSizeMultiplier = this.createMetricDebug(sampleSizeMultiplierValue, 0);
		const qualityMultiplier = this.createMetricDebug(qualityMultiplierValue, 0);
		const raw = traderWeightedROI.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_WEIGHTED_ROI_MAX,
				),
				traderWeightedROI,
				avgROI,
				sampleSizeMultiplier,
				qualityMultiplier,
			},
		};
	}

	private scoreRealizedPnLQuality(
		summary: WalletSummaryResponse,
		risk: WalletRiskMetricsResponse,
	): ScoreDimensionResult<WalletScoreRealizedPnLQualityDebug> {
		const totalRealizedPnL = this.createMetricDebug(
			summary.totalRealizedPnL,
			this.bracketScore(summary.totalRealizedPnL, [
				{ min: 10000, score: 6 },
				{ min: 2500, score: 5 },
				{ min: 500, score: 4 },
				{ min: 100, score: 3 },
				{ min: 1, score: 2 },
			]),
		);
		const profitFactor = this.createMetricDebug(
			risk.profitFactor,
			this.bracketScore(risk.profitFactor, [
				{ min: 2, score: 5 },
				{ min: 1.5, score: 4 },
				{ min: 1.1, score: 3 },
				{ min: 0.8, score: 2 },
				{ min: 0.5, score: 1 },
			]),
		);
		const bestWorstRatioValue = this.computeBestWorstRatio(summary);
		const bestWorstRatio = this.createMetricDebug(
			bestWorstRatioValue,
			this.bracketScore(bestWorstRatioValue, [
				{ min: 4, score: 4 },
				{ min: 2, score: 3 },
				{ min: 1, score: 2 },
				{ min: 0.5, score: 1 },
			]),
		);

		const raw =
			totalRealizedPnL.weightedContribution +
			profitFactor.weightedContribution +
			bestWorstRatio.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
				),
				totalRealizedPnL,
				profitFactor,
				bestWorstRatio,
			},
		};
	}

	private scoreConsistency(
		summary: WalletSummaryResponse,
		activity: WalletActivityMetricsResponse,
		risk: WalletRiskMetricsResponse,
	): ScoreDimensionResult<WalletScoreConsistencyDebug> {
		const profitableTokenRateValue = this.computeProfitableTokenRate(summary);
		const avgWinRate = this.createMetricDebug(
			summary.avgWinRate,
			this.bracketScore(summary.avgWinRate, [
				{ min: 70, score: 4 },
				{ min: 55, score: 3 },
				{ min: 45, score: 2 },
				{ min: 35, score: 1 },
			]),
		);
		const returnStdDev = this.createMetricDebug(
			risk.returnStdDev,
			this.invertedBracketScore(risk.returnStdDev, [
				{ max: 15, score: 4 },
				{ max: 30, score: 3 },
				{ max: 50, score: 2 },
				{ max: 80, score: 1 },
			]),
		);
		const burstinessScore = this.createMetricDebug(
			activity.burstinessScore,
			this.invertedBracketScore(activity.burstinessScore, [
				{ max: 0.5, score: 3 },
				{ max: 1, score: 2 },
				{ max: 1.5, score: 1 },
			]),
		);
		const profitableTokenRate = this.createMetricDebug(
			profitableTokenRateValue,
			this.bracketScore(profitableTokenRateValue, [
				{ min: 0.75, score: 4 },
				{ min: 0.6, score: 3 },
				{ min: 0.45, score: 2 },
				{ min: 0.3, score: 1 },
			]),
		);
		const raw =
			avgWinRate.weightedContribution +
			returnStdDev.weightedContribution +
			burstinessScore.weightedContribution +
			profitableTokenRate.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_CONSISTENCY_MAX,
				),
				avgWinRate,
				returnStdDev,
				burstinessScore,
				profitableTokenRate,
			},
		};
	}

	private scoreRiskManagement(
		risk: WalletRiskMetricsResponse,
		summary: WalletSummaryResponse,
		tokenCategories: WalletTokenCategoryMetricsResponse,
	): ScoreDimensionResult<WalletScoreRiskManagementDebug> {
		const drawdownRatio = risk.maxDrawdown / Math.max(summary.totalRealizedPnL, 100);
		const maxDrawdown = this.createMetricDebug(
			drawdownRatio,
			this.invertedBracketScore(drawdownRatio, [
				{ max: 0.1, score: 6 },
				{ max: 0.25, score: 4 },
				{ max: 0.5, score: 2 },
				{ max: 1.0, score: 1 },
			]),
		);
		const concentrationRisk = this.createMetricDebug(
			risk.concentrationRisk,
			this.invertedBracketScore(risk.concentrationRisk, [
				{ max: 20, score: 4 },
				{ max: 35, score: 3 },
				{ max: 50, score: 2 },
				{ max: 70, score: 1 },
			]),
		);
		const memecoinTradePercent = this.createMetricDebug(
			tokenCategories.memecoinTradePercent,
			this.invertedBracketScore(tokenCategories.memecoinTradePercent, [
				{ max: 10, score: 4 },
				{ max: 25, score: 3 },
				{ max: 40, score: 2 },
				{ max: 60, score: 1 },
			]),
		);
		const stablecoinHoldingPercent = this.createMetricDebug(
			tokenCategories.stablecoinHoldingPercent,
			this.bracketScore(tokenCategories.stablecoinHoldingPercent, [
				{ min: 20, score: 3 },
				{ min: 10, score: 2 },
				{ min: 5, score: 1 },
			]),
		);
		const worstTradeImpactValue = this.computeWorstTradeImpact(summary);
		const worstTradeImpact = this.createMetricDebug(
			worstTradeImpactValue,
			this.invertedBracketScore(worstTradeImpactValue, [
				{ max: 0.1, score: 3 },
				{ max: 0.3, score: 2 },
				{ max: 0.5, score: 1 },
			]),
		);
		const raw =
			maxDrawdown.weightedContribution +
			concentrationRisk.weightedContribution +
			memecoinTradePercent.weightedContribution +
			stablecoinHoldingPercent.weightedContribution +
			worstTradeImpact.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_RISK_MANAGEMENT_MAX,
				),
				maxDrawdown,
				concentrationRisk,
				memecoinTradePercent,
				stablecoinHoldingPercent,
				worstTradeImpact,
			},
		};
	}

	private scorePortfolioQuality(
		summary: WalletSummaryResponse,
		holdTime: WalletHoldTimeMetricsResponse,
		tokenCategories: WalletTokenCategoryMetricsResponse,
		portfolio: WalletPortfolioItem[],
	): ScoreDimensionResult<WalletScorePortfolioDebug> {
		const qualityAssetPercent = this.calculateQualityAssetPercent(tokenCategories);
		const profitableTokenPercent = this.roundDecimal(
			this.computeProfitableTokenRate(summary) * 100,
		);
		const uniqueTokens = this.countUniquePortfolioTokens(portfolio);
		const categoryDiversity = this.createMetricDebug(
			tokenCategories.categoryDiversity,
			this.bracketScore(tokenCategories.categoryDiversity, [
				{ min: 5, score: 2 },
				{ min: 3, score: 1.5 },
				{ min: 2, score: 1 },
			]),
		);
		const qualityAssetPercentMetric = this.createMetricDebug(
			qualityAssetPercent,
			this.bracketScore(qualityAssetPercent, [
				{ min: 70, score: 3 },
				{ min: 50, score: 2 },
				{ min: 30, score: 1 },
			]),
		);
		const avgHoldHours = this.createMetricDebug(
			holdTime.avgHoldHours,
			this.bracketScore(holdTime.avgHoldHours, [
				{ min: 720, score: 1 },
				{ min: 168, score: 0.75 },
				{ min: 72, score: 0.5 },
				{ min: 24, score: 0.25 },
			]),
		);
		const profitableTokenPercentMetric = this.createMetricDebug(
			profitableTokenPercent,
			this.bracketScore(profitableTokenPercent, [
				{ min: 70, score: 2 },
				{ min: 50, score: 1.5 },
				{ min: 30, score: 1 },
			]),
		);
		const uniqueTokensMetric = this.createMetricDebug(
			uniqueTokens,
			this.bracketScore(uniqueTokens, [
				{ min: 10, score: 2 },
				{ min: 6, score: 1.5 },
				{ min: 3, score: 1 },
			]),
		);
		const rawPortfolioScore =
			categoryDiversity.weightedContribution +
			qualityAssetPercentMetric.weightedContribution +
			avgHoldHours.weightedContribution +
			profitableTokenPercentMetric.weightedContribution +
			uniqueTokensMetric.weightedContribution;

		return {
			score: rawPortfolioScore,
			debug: {
				...this.createDimensionDebugSummary(
					rawPortfolioScore,
					WalletScoringService.TRADER_PORTFOLIO_QUALITY_MAX,
				),
				qualityAssetPercent: qualityAssetPercentMetric,
				profitableTokenPercent: profitableTokenPercentMetric,
				categoryDiversity,
				uniqueTokens: uniqueTokensMetric,
				avgHoldHours,
			},
		};
	}

	private calculateQualityAssetPercent(
		tokenCategories: WalletTokenCategoryMetricsResponse,
	): number {
		const trustedCategories = new Set<string>([
			TokenCategory.BLUE_CHIP,
			TokenCategory.STABLECOIN,
			TokenCategory.DEFI,
			TokenCategory.LST_LRT,
			TokenCategory.RWA,
		]);
		const holdingsByCategory = Object.entries(
			tokenCategories.currentHoldingsByCategory,
		);
		const totalHoldingsUsd = holdingsByCategory.reduce(
			(total, [, usdValue]) => total + usdValue,
			0,
		);

		if (totalHoldingsUsd <= 0) {
			return 0;
		}

		const trustedHoldingsUsd = holdingsByCategory.reduce(
			(total, [category, usdValue]) =>
				trustedCategories.has(category) ? total + usdValue : total,
			0,
		);

		return this.roundDecimal((trustedHoldingsUsd / totalHoldingsUsd) * 100);
	}

	private countUniquePortfolioTokens(portfolio: WalletPortfolioItem[]): number {
		return new Set(
			portfolio
				.filter((holding) => this.isScoringEligibleHolding(holding))
				.map((holding) =>
				holding.contractAddress?.toLowerCase() ?? holding.token.trim().toLowerCase(),
				),
		).size;
	}

	private scoreExperience(
		summary: WalletSummaryResponse,
		tradingSpanDays: number,
		activity: WalletActivityMetricsResponse,
		dexMetrics: WalletDexMetricsResponse,
	): ScoreDimensionResult<WalletScoreExperienceDebug> {
		const tradingSpanDaysMetric = this.createMetricDebug(
			tradingSpanDays,
			this.bracketScore(tradingSpanDays, [
				{ min: 365, score: 4 },
				{ min: 180, score: 3 },
				{ min: 90, score: 2 },
				{ min: 30, score: 1 },
			]),
		);
		const tradingSpanRatio = this.createMetricDebug(
			activity.tradingSpanRatio,
			this.bracketScore(activity.tradingSpanRatio, [
				{ min: 0.65, score: 3 },
				{ min: 0.4, score: 2 },
				{ min: 0.2, score: 1 },
			]),
		);
		const sampleAdequacyValue = this.resolveSampleAdequacy(summary);
		const sampleAdequacy = this.createMetricDebug(
			sampleAdequacyValue,
			this.bracketScore(sampleAdequacyValue, [
				{ min: 0.9, score: 3 },
				{ min: 0.65, score: 2 },
				{ min: 0.4, score: 1 },
			]),
		);
		const totalSwaps = this.createMetricDebug(
			summary.total_swaps,
			0,
		);
		const dexDiversity = this.createMetricDebug(
			dexMetrics.dexDiversity,
			0,
		);
		const raw =
			tradingSpanDaysMetric.weightedContribution +
			tradingSpanRatio.weightedContribution +
			sampleAdequacy.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_EXPERIENCE_MAX,
				),
				tradingSpanDays: tradingSpanDaysMetric,
				tradingSpanRatio,
				sampleAdequacy,
				totalSwaps,
				dexDiversity,
			},
		};
	}

	private scoreMarketAdaptability(
		dexMetrics: WalletDexMetricsResponse,
		tokenCategories: WalletTokenCategoryMetricsResponse,
	): ScoreDimensionResult<WalletScoreMarketAdaptabilityDebug> {
		const dexDiversity = this.createMetricDebug(
			dexMetrics.dexDiversity,
			this.bracketScore(dexMetrics.dexDiversity, [
				{ min: 5, score: 2 },
				{ min: 3, score: 1.5 },
				{ min: 2, score: 1 },
				{ min: 1, score: 0.5 },
			]),
		);
		const primaryDexShare = this.createMetricDebug(
			dexMetrics.primaryDexShare,
			this.invertedBracketScore(dexMetrics.primaryDexShare, [
				{ max: 35, score: 2 },
				{ max: 55, score: 1 },
				{ max: 75, score: 0.5 },
			]),
		);
		const categoryDiversity = this.createMetricDebug(
			tokenCategories.categoryDiversity,
			this.bracketScore(tokenCategories.categoryDiversity, [
				{ min: 5, score: 1 },
				{ min: 3, score: 0.75 },
				{ min: 2, score: 0.5 },
			]),
		);
		const raw =
			dexDiversity.weightedContribution +
			primaryDexShare.weightedContribution +
			categoryDiversity.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.TRADER_MARKET_ADAPTABILITY_MAX,
				),
				dexDiversity,
				primaryDexShare,
				categoryDiversity,
			},
		};
	}

	private createEmptyTraderScoreDebug(): TraderWalletScoreDebugData {
		const emptyPortfolioDebug: WalletScorePortfolioDebug = {
			...this.createDimensionDebugSummary(
				0,
				WalletScoringService.TRADER_PORTFOLIO_QUALITY_MAX,
			),
			qualityAssetPercent: this.createMetricDebug(0, 0),
			profitableTokenPercent: this.createMetricDebug(0, 0),
			categoryDiversity: this.createMetricDebug(0, 0),
			uniqueTokens: this.createMetricDebug(0, 0),
			avgHoldHours: this.createMetricDebug(0, 0),
		};

		return {
			traderWeightedROI: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_WEIGHTED_ROI_MAX,
				),
				traderWeightedROI: this.createMetricDebug(0, 0),
				avgROI: this.createMetricDebug(0, 0),
				sampleSizeMultiplier: this.createMetricDebug(0, 0),
				qualityMultiplier: this.createMetricDebug(0, 0),
			},
			realizedPnLQuality: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
				),
				totalRealizedPnL: this.createMetricDebug(0, 0),
				profitFactor: this.createMetricDebug(0, 0),
				bestWorstRatio: this.createMetricDebug(0, 0),
			},
			profitability: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_WEIGHTED_ROI_MAX +
						WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
				),
				totalRealizedPnL: this.createMetricDebug(0, 0),
				avgROI: this.createMetricDebug(0, 0),
				profitFactor: this.createMetricDebug(0, 0),
				bestWorstRatio: this.createMetricDebug(0, 0),
			},
			consistency: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_CONSISTENCY_MAX,
				),
				avgWinRate: this.createMetricDebug(0, 0),
				returnStdDev: this.createMetricDebug(0, 0),
				burstinessScore: this.createMetricDebug(0, 0),
				profitableTokenRate: this.createMetricDebug(0, 0),
			},
			riskManagement: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_RISK_MANAGEMENT_MAX,
				),
				maxDrawdown: this.createMetricDebug(0, 0),
				concentrationRisk: this.createMetricDebug(0, 0),
				memecoinTradePercent: this.createMetricDebug(0, 0),
				stablecoinHoldingPercent: this.createMetricDebug(0, 0),
				worstTradeImpact: this.createMetricDebug(0, 0),
			},
			portfolio: emptyPortfolioDebug,
			portfolioQuality: emptyPortfolioDebug,
			experience: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_EXPERIENCE_MAX,
				),
				tradingSpanDays: this.createMetricDebug(0, 0),
				tradingSpanRatio: this.createMetricDebug(0, 0),
				sampleAdequacy: this.createMetricDebug(0, 0),
				totalSwaps: this.createMetricDebug(0, 0),
				dexDiversity: this.createMetricDebug(0, 0),
			},
			marketAdaptability: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.TRADER_MARKET_ADAPTABILITY_MAX,
				),
				dexDiversity: this.createMetricDebug(0, 0),
				primaryDexShare: this.createMetricDebug(0, 0),
				categoryDiversity: this.createMetricDebug(0, 0),
			},
		};
	}

	private createEmptyHolderScoreDebug(): HolderWalletScoreDebugData {
		return {
			portfolioQuality: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.HOLDER_PORTFOLIO_QUALITY_MAX,
				),
				qualityAssetPercent: this.createMetricDebug(0, 0),
				categoryDiversity: this.createMetricDebug(0, 0),
				uniqueTokenCount: this.createMetricDebug(0, 0),
				memecoinHoldingPercent: this.createMetricDebug(0, 0),
			},
			conviction: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.HOLDER_CONVICTION_MAX,
				),
				avgHoldingDays: this.createMetricDebug(0, 0),
				longestHoldDays: this.createMetricDebug(0, 0),
				holdingsInProfitPercent: this.createMetricDebug(0, 0),
				avgUnrealizedROI: this.createMetricDebug(0, 0),
			},
			portfolioSize: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.HOLDER_PORTFOLIO_SIZE_MAX,
				),
				totalPortfolioUsd: this.createMetricDebug(0, 0),
				largestPositionUsd: this.createMetricDebug(0, 0),
				nonDustCount: this.createMetricDebug(0, 0),
				portfolioSizeMultiplier: this.createMetricDebug(0, 0),
			},
			assetSelection: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.HOLDER_ASSET_SELECTION_MAX,
				),
				blueChipHoldingPercent: this.createMetricDebug(0, 0),
				stablecoinHoldingPercent: this.createMetricDebug(0, 0),
				hasEth: this.createMetricDebug(0, 0),
			},
		};
	}

	private createDimensionDebugSummary(
		raw: number,
		maxScore: number,
	): WalletScoreDimensionDebugSummary {
		return {
			raw,
			final: raw,
			maxScore,
		};
	}

	private createMetricDebug(
		value: number,
		score: number,
	): WalletScoreMetricDebug {
		return {
			value: Number.isFinite(value) ? this.roundDecimal(value) : null,
			score,
			weightedContribution: score,
		};
	}

	private computeProfitableTokenRate(summary: WalletSummaryResponse): number {
		const resolvedTokens = summary.profitableTokens + summary.losingTokens;

		if (resolvedTokens === 0) {
			return 0;
		}

		return summary.profitableTokens / resolvedTokens;
	}

	private computeTradingSpanDays(trades: Trade[]): number {
		if (trades.length < 2) {
			return 0;
		}

		const sortedTrades = [...trades].sort(
			(left, right) => left.timestamp - right.timestamp,
		);
		const firstTradeTimestamp = sortedTrades[0]?.timestamp ?? 0;
		const lastTradeTimestamp = sortedTrades[sortedTrades.length - 1]?.timestamp ?? 0;
		const secondsInDay = 24 * 60 * 60;

		return this.roundDecimal(
			Math.max(lastTradeTimestamp - firstTradeTimestamp, 0) / secondsInDay,
		);
	}

	private calculateTotalScore(breakdown: TraderWalletScoreBreakdown | HolderWalletScoreBreakdown): number {
		if ('traderWeightedROI' in breakdown) {
			return (
				breakdown.traderWeightedROI.score +
				breakdown.realizedPnLQuality.score +
				breakdown.consistency.score +
				breakdown.riskManagement.score +
				breakdown.portfolioQuality.score +
				breakdown.experience.score +
				breakdown.marketAdaptability.score
			);
		}

		return (
			breakdown.portfolioQuality.score +
			breakdown.conviction.score +
			breakdown.portfolioSize.score +
			breakdown.assetSelection.score
		);
	}

	private resolveTraderBand(score: number): WalletScoreBand {
		if (score >= 91) {
			return 'Exceptional';
		}

		if (score >= 76) {
			return 'Elite';
		}

		if (score >= 61) {
			return 'Skilled';
		}

		if (score >= 41) {
			return 'Capable';
		}

		if (score >= 21) {
			return 'Developing';
		}

		return 'Unproven';
	}

	private resolveHolderBand(score: number): WalletScoreBand {
		if (score >= 91) {
			return 'Institutional';
		}

		if (score >= 76) {
			return 'Premium';
		}

		if (score >= 61) {
			return 'Strong';
		}

		if (score >= 41) {
			return 'Solid';
		}

		if (score >= 21) {
			return 'Basic';
		}

		return 'Dormant';
	}

	private resolveWeightedRoiSampleSizeMultiplier(totalSwaps: number): number {
		if (totalSwaps >= 150) {
			return 1.4;
		}

		if (totalSwaps >= 75) {
			return 1.25;
		}

		if (totalSwaps >= 30) {
			return 1.1;
		}

		if (totalSwaps >= 10) {
			return 1;
		}

		return 0.85;
	}

	private resolveWeightedRoiQualityMultiplier(
		avgWinRate: number,
		profitFactor: number,
	): number {
		const winRateFactor = this.clamp(avgWinRate / 100, 0.2, 1.1);
		const profitFactorScaled = this.clamp(profitFactor / 1.5, 0.2, 1.2);

		return this.roundDecimal((winRateFactor * 0.55) + (profitFactorScaled * 0.45));
	}

	private computeWeightedRoiValue(
		avgRoi: number,
		sampleSizeMultiplier: number,
		qualityMultiplier: number,
	): number {
		const base = avgRoi * sampleSizeMultiplier;

		if (base >= 0) {
			return this.roundDecimal(base * qualityMultiplier);
		}

		const defensiveDivisor = Math.max(qualityMultiplier, 0.35);

		return this.roundDecimal(base / defensiveDivisor);
	}

	private resolveSampleAdequacy(summary: WalletSummaryResponse): number {
		const resolvedTokenCount = summary.profitableTokens + summary.losingTokens;
		const swapCoverage = this.clamp(summary.total_swaps / 40, 0, 1);
		const tokenCoverage = this.clamp(resolvedTokenCount / 10, 0, 1);

		return this.roundDecimal((swapCoverage * 0.7) + (tokenCoverage * 0.3));
	}

	private resolveGamblerPenalty(profitFactor: number, totalSwaps: number): number {
		if (profitFactor >= 0.5 || totalSwaps <= 50) {
			return 0;
		}

		if (totalSwaps >= 150) {
			return WalletScoringService.TRADER_GAMBLER_PENALTY + 3;
		}

		if (totalSwaps >= 100) {
			return WalletScoringService.TRADER_GAMBLER_PENALTY + 1;
		}

		return WalletScoringService.TRADER_GAMBLER_PENALTY;
	}

	private applyWeightedRoiHardCap(score: number, traderWeightedRoiValue: number): number {
		if (traderWeightedRoiValue < -40) {
			return Math.min(score, 25);
		}

		return score;
	}

	private applyWeightedRoiBandCap(
		band: WalletScoreBand,
		traderWeightedRoiValue: number,
	): WalletScoreBand {
		if (traderWeightedRoiValue >= -20) {
			return band;
		}

		const traderBandOrder: WalletScoreBand[] = [
			'Unproven',
			'Developing',
			'Capable',
			'Skilled',
			'Elite',
			'Exceptional',
		];
		const bandIndex = traderBandOrder.indexOf(band);

		if (bandIndex <= 1 || bandIndex === -1) {
			return band;
		}

		return 'Developing';
	}

	private createLegacyProfitabilityDebug(
		traderWeightedRoiResult: ScoreDimensionResult<WalletScoreWeightedRoiDebug>,
		realizedPnlQualityResult: ScoreDimensionResult<WalletScoreRealizedPnLQualityDebug>,
	): WalletScoreProfitabilityDebug {
		const raw = traderWeightedRoiResult.score + realizedPnlQualityResult.score;

		return {
			...this.createDimensionDebugSummary(
				raw,
				WalletScoringService.TRADER_WEIGHTED_ROI_MAX +
					WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
			),
			totalRealizedPnL: realizedPnlQualityResult.debug.totalRealizedPnL,
			avgROI: traderWeightedRoiResult.debug.avgROI,
			profitFactor: realizedPnlQualityResult.debug.profitFactor,
			bestWorstRatio: realizedPnlQualityResult.debug.bestWorstRatio,
		};
	}

	private buildTraderScoreExplanation(
		score: number,
		band: WalletScoreBand,
		breakdown: TraderWalletScoreBreakdown,
		traderWeightedRoiValue: number,
		risk: WalletRiskMetricsResponse,
		summary: WalletSummaryResponse,
		gamblerPenalty: number,
	): WalletScoreExplanation {
		const positives: string[] = [];
		const negatives: string[] = [];

		if (breakdown.traderWeightedROI.score >= 16) {
			positives.push('Weighted ROI remained strong after sample and quality weighting.');
		}

		if (breakdown.consistency.score >= 10) {
			positives.push('Consistency metrics indicate repeatable execution quality.');
		}

		if (breakdown.riskManagement.score >= 12) {
			positives.push('Risk management metrics stayed in a healthy range.');
		}

		if (breakdown.marketAdaptability.score >= 3) {
			positives.push('Market adaptability is supported by venue and category diversification.');
		}

		if (traderWeightedRoiValue < 0) {
			negatives.push('Weighted ROI is negative after activity and quality adjustment.');
		}

		if (risk.profitFactor < 1) {
			negatives.push('Profit factor below 1 means losses outweighed gains.');
		}

		if (gamblerPenalty > 0) {
			negatives.push(
				`Gambler penalty applied (-${gamblerPenalty}) because profit factor is below 0.5 with more than 50 swaps.`,
			);
		}

		if (traderWeightedRoiValue < -40) {
			negatives.push('Hard cap applied: traderWeightedROI below -40 limits maximum score to 25.');
		} else if (traderWeightedRoiValue < -20) {
			negatives.push('Band cap applied: traderWeightedROI below -20 limits maximum band to Developing.');
		}

		const summaryText = `Trader score is ${score}/100 (${band}) based on weighted ROI, realized PnL quality, consistency, risk control, portfolio quality, experience, and market adaptability. Trader score uses traderWeightedROI adjusted for sample size and trade quality.`;

		return this.createScoreExplanation(positives, negatives, summaryText);
	}

	private buildHolderScoreExplanation(
		score: number,
		band: WalletScoreBand,
		breakdown: HolderWalletScoreBreakdown,
	): WalletScoreExplanation {
		const positives: string[] = [];
		const negatives: string[] = [];

		if (breakdown.portfolioQuality.score >= 22) {
			positives.push('Portfolio quality reflects strong category and asset composition.');
		}

		if (breakdown.conviction.score >= 18) {
			positives.push('Holding behavior shows conviction and patience.');
		}

		if (breakdown.portfolioSize.score < 6) {
			negatives.push('Portfolio size remains small, which limits the holder score ceiling.');
		}

		if (breakdown.assetSelection.score < 5) {
			negatives.push('Asset selection quality is still developing.');
		}

		const summaryText = `Holder score is ${score}/100 (${band}) based on portfolio quality, conviction, portfolio size, and asset selection.`;

		return this.createScoreExplanation(positives, negatives, summaryText);
	}

	private createScoreExplanation(
		positives: string[],
		negatives: string[],
		summary: string,
	): WalletScoreExplanation {
		return {
			positives: [...new Set(positives.filter((item) => item.trim().length > 0))],
			negatives: [...new Set(negatives.filter((item) => item.trim().length > 0))],
			summary,
		};
	}

	private createDimensionBreakdown(
		score: number,
		maxScore: number,
	): WalletScoreDimensionBreakdown {
		return {
			score,
			maxScore,
		};
	}

	private createEmptyTraderBreakdown(): TraderWalletScoreBreakdown {
		return {
			traderWeightedROI: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_WEIGHTED_ROI_MAX,
			),
			realizedPnLQuality: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
			),
			profitability: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_WEIGHTED_ROI_MAX +
					WalletScoringService.TRADER_REALIZED_PNL_QUALITY_MAX,
			),
			consistency: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_CONSISTENCY_MAX,
			),
			riskManagement: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_RISK_MANAGEMENT_MAX,
			),
			portfolioQuality: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_PORTFOLIO_QUALITY_MAX,
			),
			experience: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_EXPERIENCE_MAX,
			),
			marketAdaptability: this.createDimensionBreakdown(
				0,
				WalletScoringService.TRADER_MARKET_ADAPTABILITY_MAX,
			),
		};
	}

	private createEmptyHolderBreakdown(): HolderWalletScoreBreakdown {
		return {
			portfolioQuality: this.createDimensionBreakdown(
				0,
				WalletScoringService.HOLDER_PORTFOLIO_QUALITY_MAX,
			),
			conviction: this.createDimensionBreakdown(
				0,
				WalletScoringService.HOLDER_CONVICTION_MAX,
			),
			portfolioSize: this.createDimensionBreakdown(
				0,
				WalletScoringService.HOLDER_PORTFOLIO_SIZE_MAX,
			),
			assetSelection: this.createDimensionBreakdown(
				0,
				WalletScoringService.HOLDER_ASSET_SELECTION_MAX,
			),
		};
	}

	private resolveHolderPortfolioSizeMultiplier(totalPortfolioUsd: number): number {
		if (totalPortfolioUsd >= 1000) {
			return 1.0;
		}

		if (totalPortfolioUsd >= 100) {
			return 0.85;
		}

		if (totalPortfolioUsd >= 10) {
			return 0.6;
		}

		if (totalPortfolioUsd >= 1) {
			return 0.35;
		}

		return 0.1;
	}

	private filterHoldingsByUsdValue(
		portfolio: WalletPortfolioItem[],
		minimumUsdValue: number,
	): WalletPortfolioItem[] {
		return portfolio.filter((holding) => {
			if (!this.isScoringEligibleHolding(holding)) {
				return false;
			}

			const usdValue = this.parseNumericString(holding.usdValue);

			return usdValue !== null && usdValue > minimumUsdValue;
		});
	}

	private computeAverageHoldingDays(portfolio: WalletPortfolioItem[]): number {
		const values = portfolio
			.map((holding) => holding.holdingDays)
			.filter((value): value is number => value !== null && Number.isFinite(value));

		if (values.length === 0) {
			return 0;
		}

		return this.roundDecimal(
			values.reduce((total, value) => total + value, 0) / values.length,
		);
	}

	private computeLongestHoldingDays(portfolio: WalletPortfolioItem[]): number {
		const values = portfolio
			.map((holding) => holding.holdingDays)
			.filter((value): value is number => value !== null && Number.isFinite(value));

		if (values.length === 0) {
			return 0;
		}

		return this.roundDecimal(Math.max(...values));
	}

	private computeHoldingsInProfitPercent(portfolio: WalletPortfolioItem[]): number {
		const pnlValues = portfolio
			.map((holding) => this.parseNumericString(holding.pnl))
			.filter((value): value is number => value !== null);

		if (pnlValues.length === 0) {
			return 0;
		}

		const holdingsInProfit = pnlValues.filter((value) => value > 0).length;

		return this.roundDecimal((holdingsInProfit / pnlValues.length) * 100);
	}

	private computeAverageUnrealizedRoi(portfolio: WalletPortfolioItem[]): number {
		const roiValues = portfolio
			.map((holding) => this.parseNumericString(holding.roi))
			.filter((value): value is number => value !== null);

		if (roiValues.length === 0) {
			return 0;
		}

		return this.roundDecimal(
			roiValues.reduce((total, value) => total + value, 0) / roiValues.length,
		);
	}

	private computeTotalPortfolioUsd(portfolio: WalletPortfolioItem[]): number {
		return this.roundDecimal(
			portfolio.reduce((total, holding) => {
				const usdValue = this.parseNumericString(holding.usdValue);

				return total + (usdValue ?? 0);
			}, 0),
		);
	}

	private computeLargestPositionUsd(portfolio: WalletPortfolioItem[]): number {
		const usdValues = portfolio
			.map((holding) => this.parseNumericString(holding.usdValue))
			.filter((value): value is number => value !== null);

		if (usdValues.length === 0) {
			return 0;
		}

		return this.roundDecimal(Math.max(...usdValues));
	}

	private hasEthExposure(portfolio: WalletPortfolioItem[]): boolean {
		return portfolio.some((holding) => {
			if (!this.isScoringEligibleHolding(holding)) {
				return false;
			}

			const token = holding.token.trim().toUpperCase();

			return token === 'ETH' || token === 'WETH';
		});
	}

	private filterScoringEligibleHoldings(
		portfolio: WalletPortfolioItem[],
	): WalletPortfolioItem[] {
		return portfolio.filter((holding) => this.isScoringEligibleHolding(holding));
	}

	private isScoringEligibleHolding(holding: WalletPortfolioItem): boolean {
		if (holding.tokenQualityLabel === 'spoofed_major_symbol') {
			return false;
		}

		return !this.walletPricingService.isSpoofedMajorSymbol(
			holding.token,
			holding.contractAddress,
		);
	}

	private parseNumericString(value: string | null | undefined): number | null {
		if (value === null || value === undefined || value.trim() === '') {
			return null;
		}

		const parsed = Number(value);

		return Number.isFinite(parsed) ? parsed : null;
	}

	private bracketScore(value: number, brackets: ScoreBracket[]): number {
		if (!Number.isFinite(value)) {
			return 0;
		}

		const sorted = [...brackets].sort((a, b) => b.min - a.min);

		for (const bracket of sorted) {
			if (value >= bracket.min) {
				return bracket.score;
			}
		}

		return 0;
	}

	private invertedBracketScore(
		value: number,
		brackets: InvertedScoreBracket[],
	): number {
		if (!Number.isFinite(value)) {
			return 0;
		}

		const sorted = [...brackets].sort((a, b) => a.max - b.max);

		for (const bracket of sorted) {
			if (value <= bracket.max) {
				return bracket.score;
			}
		}

		return 0;
	}

	private computeBestWorstRatio(summary: WalletSummaryResponse): number {
		const absWorst = Math.abs(summary.worstTrade);

		if (absWorst === 0) {
			return summary.bestTrade > 0 ? 10 : 0;
		}

		return this.roundDecimal(summary.bestTrade / absWorst);
	}

	private computeWorstTradeImpact(summary: WalletSummaryResponse): number {
		const absWorst = Math.abs(summary.worstTrade);
		const denominator = Math.max(summary.totalRealizedPnL, 1);

		return this.roundDecimal(absWorst / denominator);
	}

	private clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	private roundDecimal(value: number, decimals = 2): number {
		if (!Number.isFinite(value)) {
			return NaN;
		}

		return Number(value.toFixed(decimals));
	}
}