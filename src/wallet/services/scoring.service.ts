import { Injectable } from '@nestjs/common';
import { TokenCategory } from '../constants/token-categories';
import {
	HolderWalletScoreBreakdown,
	HolderWalletScoreDebugData,
	Trade,
	TraderWalletScoreBreakdown,
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
	WalletScoreBreakdown,
	WalletScoreConsistencyDebug,
	WalletScoreDimensionDebugSummary,
	WalletScoreDebugResponse,
	WalletScoreDimensionBreakdown,
	WalletScoreGateStatus,
	WalletScoreExperienceDebug,
	WalletScoreMetricDebug,
	WalletScorePortfolioDebug,
	WalletScoreProfitabilityDebug,
	WalletScoreRiskManagementDebug,
	WalletScoreResponse,
	WalletScoreResult,
	WalletScoreDebugData,
	WalletSummaryResponse,
	WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletConfidenceService } from './wallet-confidence.service';
import { WalletContextService } from './wallet-context.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

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
	private static readonly PROFITABILITY_MAX = 30;
	private static readonly CONSISTENCY_MAX = 20;
	private static readonly RISK_MANAGEMENT_MAX = 20;
	private static readonly PORTFOLIO_QUALITY_MAX = 15;
	private static readonly EXPERIENCE_MAX = 15;
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
	) {}

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
		const scoredAt = new Date().toISOString();

		if (!context.isTraderWallet) {
			const confidenceProfile = await this.walletConfidenceService.getConfidence(
				address,
				{ summary },
			);
			const positiveValueHoldings = this.filterHoldingsByUsdValue(portfolio, 0);

			if (positiveValueHoldings.length === 0) {
				const response: WalletScoreResponse = {
					address: summary.address,
					score: 0,
					...confidenceProfile,
					band: 'Unscored',
					breakdown: this.createEmptyHolderBreakdown(),
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
				portfolio,
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
				...confidenceProfile,
				band: 'Unscored',
				breakdown: this.createEmptyTraderBreakdown(),
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
			portfolio,
		);
		const profitabilityResult = this.scoreProfitability(summary, risk);
		const consistencyResult = this.scoreConsistency(summary, activity, risk);
		const riskManagementResult = this.scoreRiskManagement(risk, summary, tokenCategories);
		const experienceResult = this.scoreExperience(
			summary,
			tradingSpanDays,
			activity,
			dexMetrics,
		);

		const breakdown: TraderWalletScoreBreakdown = {
			profitability: this.createDimensionBreakdown(
				profitabilityResult.score,
				WalletScoringService.PROFITABILITY_MAX,
			),
			consistency: this.createDimensionBreakdown(
				consistencyResult.score,
				WalletScoringService.CONSISTENCY_MAX,
			),
			riskManagement: this.createDimensionBreakdown(
				riskManagementResult.score,
				WalletScoringService.RISK_MANAGEMENT_MAX,
			),
			portfolioQuality: this.createDimensionBreakdown(
				portfolioQualityResult.score,
				WalletScoringService.PORTFOLIO_QUALITY_MAX,
			),
			experience: this.createDimensionBreakdown(
				experienceResult.score,
				WalletScoringService.EXPERIENCE_MAX,
			),
		};
		const score = this.calculateTotalScore(breakdown);
		const response: WalletScoreResponse = {
			address: summary.address,
			score,
			...confidenceProfile,
			band: this.resolveBand(score),
			breakdown,
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
				profitability: profitabilityResult.debug,
				consistency: consistencyResult.debug,
				riskManagement: riskManagementResult.debug,
				portfolio: portfolioQualityResult.debug,
				experience: experienceResult.debug,
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
		const response: WalletScoreResponse = {
			address,
			score,
			...confidenceProfile,
			band: this.resolveBand(score),
			breakdown,
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


	private scoreProfitability(
		summary: WalletSummaryResponse,
		risk: WalletRiskMetricsResponse,
	): ScoreDimensionResult<WalletScoreProfitabilityDebug> {
		const totalRealizedPnL = this.createMetricDebug(
			summary.totalRealizedPnL,
			this.bracketScore(summary.totalRealizedPnL, [
				{ min: 5000, score: 10 },
				{ min: 1000, score: 7 },
				{ min: 100, score: 4 },
				{ min: 1, score: 2 },
			]),
		);
		const avgROI = this.createMetricDebug(
			summary.avgROI,
			this.bracketScore(summary.avgROI, [
				{ min: 50, score: 9 },
				{ min: 25, score: 7 },
				{ min: 10, score: 4 },
				{ min: 1, score: 2 },
			]),
		);
		const profitFactor = this.createMetricDebug(
			risk.profitFactor,
			this.bracketScore(risk.profitFactor, [
				{ min: 3, score: 6 },
				{ min: 2, score: 5 },
				{ min: 1.5, score: 3 },
				{ min: 1, score: 1 },
			]),
		);
		const bestWorstRatioValue = this.computeBestWorstRatio(summary);
		const bestWorstRatio = this.createMetricDebug(
			bestWorstRatioValue,
			this.bracketScore(bestWorstRatioValue, [
				{ min: 3, score: 5 },
				{ min: 2, score: 4 },
				{ min: 1, score: 3 },
				{ min: 0.5, score: 1 },
			]),
		);
		const raw =
			totalRealizedPnL.weightedContribution +
			avgROI.weightedContribution +
			profitFactor.weightedContribution +
			bestWorstRatio.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.PROFITABILITY_MAX,
				),
				totalRealizedPnL,
				avgROI,
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
				{ min: 70, score: 7 },
				{ min: 55, score: 5 },
				{ min: 45, score: 3 },
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
				{ min: 0.75, score: 6 },
				{ min: 0.6, score: 4 },
				{ min: 0.45, score: 2 },
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
					WalletScoringService.CONSISTENCY_MAX,
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
					WalletScoringService.RISK_MANAGEMENT_MAX,
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
				{ min: 5, score: 3 },
				{ min: 3, score: 2 },
				{ min: 2, score: 1 },
			]),
		);
		const qualityAssetPercentMetric = this.createMetricDebug(
			qualityAssetPercent,
			this.bracketScore(qualityAssetPercent, [
				{ min: 70, score: 5 },
				{ min: 50, score: 3 },
				{ min: 30, score: 1 },
			]),
		);
		const avgHoldHours = this.createMetricDebug(
			holdTime.avgHoldHours,
			this.bracketScore(holdTime.avgHoldHours, [
				{ min: 720, score: 1.0 },
				{ min: 168, score: 0.75 },
				{ min: 72, score: 0.5 },
				{ min: 24, score: 0.25 },
			]),
		);
		const profitableTokenPercentMetric = this.createMetricDebug(
			profitableTokenPercent,
			this.bracketScore(profitableTokenPercent, [
				{ min: 70, score: 4 },
				{ min: 50, score: 2 },
				{ min: 30, score: 1 },
			]),
		);
		const uniqueTokensMetric = this.createMetricDebug(
			uniqueTokens,
			this.bracketScore(uniqueTokens, [
				{ min: 10, score: 2.0 },
				{ min: 6, score: 1.5 },
				{ min: 3, score: 1.0 },
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
					WalletScoringService.PORTFOLIO_QUALITY_MAX,
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
			portfolio.map((holding) =>
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
				{ min: 180, score: 5 },
				{ min: 90, score: 4 },
				{ min: 30, score: 2 },
				{ min: 7, score: 1 },
			]),
		);
		const tradingSpanRatio = this.createMetricDebug(
			activity.tradingSpanRatio,
			this.bracketScore(activity.tradingSpanRatio, [
				{ min: 0.6, score: 3 },
				{ min: 0.35, score: 2 },
				{ min: 0.15, score: 1 },
			]),
		);
		const totalSwaps = this.createMetricDebug(
			summary.total_swaps,
			this.bracketScore(summary.total_swaps, [
				{ min: 100, score: 5 },
				{ min: 50, score: 4 },
				{ min: 15, score: 2 },
				{ min: 5, score: 1 },
			]),
		);
		const dexDiversity = this.createMetricDebug(
			dexMetrics.dexDiversity,
			this.bracketScore(dexMetrics.dexDiversity, [
				{ min: 4, score: 2 },
				{ min: 2, score: 1 },
			]),
		);
		const raw =
			tradingSpanDaysMetric.weightedContribution +
			tradingSpanRatio.weightedContribution +
			totalSwaps.weightedContribution +
			dexDiversity.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.EXPERIENCE_MAX,
				),
				tradingSpanDays: tradingSpanDaysMetric,
				tradingSpanRatio,
				totalSwaps,
				dexDiversity,
			},
		};
	}

	private createEmptyTraderScoreDebug(): TraderWalletScoreBreakdown extends never
		? never
		: Extract<WalletScoreDebugData, { profitability: unknown }> {
		return {
			profitability: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.PROFITABILITY_MAX,
				),
				totalRealizedPnL: this.createMetricDebug(0, 0),
				avgROI: this.createMetricDebug(0, 0),
				profitFactor: this.createMetricDebug(0, 0),
				bestWorstRatio: this.createMetricDebug(0, 0),
			},
			consistency: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.CONSISTENCY_MAX,
				),
				avgWinRate: this.createMetricDebug(0, 0),
				returnStdDev: this.createMetricDebug(0, 0),
				burstinessScore: this.createMetricDebug(0, 0),
				profitableTokenRate: this.createMetricDebug(0, 0),
			},
			riskManagement: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.RISK_MANAGEMENT_MAX,
				),
				maxDrawdown: this.createMetricDebug(0, 0),
				concentrationRisk: this.createMetricDebug(0, 0),
				memecoinTradePercent: this.createMetricDebug(0, 0),
				stablecoinHoldingPercent: this.createMetricDebug(0, 0),
				worstTradeImpact: this.createMetricDebug(0, 0),
			},
			portfolio: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.PORTFOLIO_QUALITY_MAX,
				),
				qualityAssetPercent: this.createMetricDebug(0, 0),
				profitableTokenPercent: this.createMetricDebug(0, 0),
				categoryDiversity: this.createMetricDebug(0, 0),
				uniqueTokens: this.createMetricDebug(0, 0),
				avgHoldHours: this.createMetricDebug(0, 0),
			},
			experience: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.EXPERIENCE_MAX,
				),
				tradingSpanDays: this.createMetricDebug(0, 0),
				tradingSpanRatio: this.createMetricDebug(0, 0),
				totalSwaps: this.createMetricDebug(0, 0),
				dexDiversity: this.createMetricDebug(0, 0),
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
		if ('profitability' in breakdown) {
			return (
				breakdown.profitability.score +
				breakdown.consistency.score +
				breakdown.riskManagement.score +
				breakdown.portfolioQuality.score +
				breakdown.experience.score
			);
		}

		return (
			breakdown.portfolioQuality.score +
			breakdown.conviction.score +
			breakdown.portfolioSize.score +
			breakdown.assetSelection.score
		);
	}

	private resolveBand(score: number): WalletScoreBand {
		if (score >= 90) {
			return 'Elite';
		}

		if (score >= 75) {
			return 'Advanced';
		}

		if (score >= 60) {
			return 'Skilled';
		}

		if (score >= 40) {
			return 'Developing';
		}

		if (score >= 25) {
			return 'Early';
		}

		return 'Poor';
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
			profitability: this.createDimensionBreakdown(
				0,
				WalletScoringService.PROFITABILITY_MAX,
			),
			consistency: this.createDimensionBreakdown(
				0,
				WalletScoringService.CONSISTENCY_MAX,
			),
			riskManagement: this.createDimensionBreakdown(
				0,
				WalletScoringService.RISK_MANAGEMENT_MAX,
			),
			portfolioQuality: this.createDimensionBreakdown(
				0,
				WalletScoringService.PORTFOLIO_QUALITY_MAX,
			),
			experience: this.createDimensionBreakdown(
				0,
				WalletScoringService.EXPERIENCE_MAX,
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
			const token = holding.token.trim().toUpperCase();

			return token === 'ETH' || token === 'WETH';
		});
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

	private roundDecimal(value: number, decimals = 2): number {
		if (!Number.isFinite(value)) {
			return NaN;
		}

		return Number(value.toFixed(decimals));
	}
}