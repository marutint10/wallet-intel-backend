import { Injectable } from '@nestjs/common';
import { TokenCategory } from '../constants/token-categories';
import {
	Trade,
	WalletActivityMetricsResponse,
	WalletContextResponse,
	WalletDexMetricsResponse,
	WalletHoldTimeMetricsResponse,
	WalletPortfolioItem,
	WalletRiskMetricsResponse,
	WalletScoreBand,
	WalletScoreBreakdown,
	WalletScoreConfidence,
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
	WalletSummaryResponse,
	WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
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

interface PortfolioQualityScoreResult {
	score: number;
	debug: WalletScorePortfolioDebug;
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

	constructor(
		private readonly walletPnlService: WalletPnlService,
		private readonly walletAnalyticsService: WalletAnalyticsService,
		private readonly walletContextService: WalletContextService,
		private readonly walletPortfolioService: WalletPortfolioService,
	) {}

	async getWalletScore(
		address: string,
		debug = false,
	): Promise<WalletScoreResult> {
		const [context, summary, activity, risk, holdTime, tokenCategories, dexMetrics, trades, portfolio] =
			await Promise.all([
				this.walletContextService.getWalletContext(address),
				this.walletPnlService.getWalletSummary(address),
				this.walletAnalyticsService.getActivityMetrics(address),
				this.walletAnalyticsService.getRiskMetrics(address),
				this.walletAnalyticsService.getHoldTimeMetrics(address),
				this.walletAnalyticsService.getTokenCategoryMetrics(address),
				this.walletAnalyticsService.getDexMetrics(address),
				this.walletPnlService.getTrades(address),
				this.walletPortfolioService.getPortfolio(address),
			]);

		const tradingSpanDays = this.computeTradingSpanDays(trades);
		const confidence = this.computeConfidence(
			summary.total_swaps,
			tradingSpanDays,
		);
		const gateStatus = this.resolveGateStatus(context, summary, activity);
		const scoredAt = new Date().toISOString();

		if (gateStatus !== 'Eligible') {
			const response: WalletScoreResponse = {
				address: summary.address,
				score: 0,
				confidence,
				band: 'Unscored',
				breakdown: this.createEmptyBreakdown(),
				gateStatus,
				scoredAt,
			};

			if (!debug) {
				return response;
			}

			return {
				...response,
				debug: this.createEmptyScoreDebug(),
			};
		}

		const portfolioQualityResult = this.scorePortfolioQuality(
			summary,
			holdTime,
			tokenCategories,
			portfolio,
		);
		const profitabilityResult = this.scoreProfitability(summary);
		const consistencyResult = this.scoreConsistency(summary, activity);
		const riskManagementResult = this.scoreRiskManagement(risk);
		const experienceResult = this.scoreExperience(
			summary,
			tradingSpanDays,
			dexMetrics,
		);

		const breakdown: WalletScoreBreakdown = {
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
			confidence,
			band: this.resolveBand(score),
			breakdown,
			gateStatus,
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

	private computeConfidence(
		totalSwaps: number,
		tradingSpanDays: number,
	): WalletScoreConfidence {
		if (totalSwaps >= 50 && tradingSpanDays >= 90) {
			return 'high';
		}

		if (totalSwaps >= 15 && tradingSpanDays >= 30) {
			return 'medium';
		}

		return 'low';
	}

	private scoreProfitability(
		summary: WalletSummaryResponse,
	): ScoreDimensionResult<WalletScoreProfitabilityDebug> {
		const totalRealizedPnL = this.createMetricDebug(
			summary.totalRealizedPnL,
			this.bracketScore(summary.totalRealizedPnL, [
				{ min: 5000, score: 12 },
				{ min: 1000, score: 9 },
				{ min: 100, score: 6 },
				{ min: 1, score: 3 },
			]),
		);
		const avgROI = this.createMetricDebug(
			summary.avgROI,
			this.bracketScore(summary.avgROI, [
				{ min: 50, score: 10 },
				{ min: 25, score: 7 },
				{ min: 10, score: 4 },
				{ min: 1, score: 2 },
			]),
		);
		const avgWinRate = this.createMetricDebug(
			summary.avgWinRate,
			this.bracketScore(summary.avgWinRate, [
				{ min: 70, score: 8 },
				{ min: 55, score: 6 },
				{ min: 45, score: 4 },
				{ min: 35, score: 2 },
			]),
		);
		const raw =
			totalRealizedPnL.weightedContribution +
			avgROI.weightedContribution +
			avgWinRate.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.PROFITABILITY_MAX,
				),
				totalRealizedPnL,
				avgROI,
				avgWinRate,
			},
		};
	}

	private scoreConsistency(
		summary: WalletSummaryResponse,
		activity: WalletActivityMetricsResponse,
	): ScoreDimensionResult<WalletScoreConsistencyDebug> {
		const profitableTokenRateValue = this.computeProfitableTokenRate(summary);
		const tradingSpanRatio = this.createMetricDebug(
			activity.tradingSpanRatio,
			this.bracketScore(activity.tradingSpanRatio, [
				{ min: 0.6, score: 10 },
				{ min: 0.35, score: 7 },
				{ min: 0.15, score: 4 },
				{ min: 0.05, score: 2 },
			]),
		);
		const burstinessScore = this.createMetricDebug(
			activity.burstinessScore,
			this.invertedBracketScore(activity.burstinessScore, [
				{ max: 0.5, score: 4 },
				{ max: 1, score: 3 },
				{ max: 1.5, score: 2 },
				{ max: 2.5, score: 1 },
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
			tradingSpanRatio.weightedContribution +
			burstinessScore.weightedContribution +
			profitableTokenRate.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.CONSISTENCY_MAX,
				),
				tradingSpanRatio,
				burstinessScore,
				profitableTokenRate,
			},
		};
	}

	private scoreRiskManagement(
		risk: WalletRiskMetricsResponse,
	): ScoreDimensionResult<WalletScoreRiskManagementDebug> {
		const profitFactor = this.createMetricDebug(
			risk.profitFactor,
			this.bracketScore(risk.profitFactor, [
				{ min: 2, score: 5 },
				{ min: 1.5, score: 4 },
				{ min: 1.2, score: 2 },
				{ min: 1, score: 1 },
			]),
		);
		const maxDrawdown = this.createMetricDebug(
			risk.maxDrawdown,
			this.invertedBracketScore(risk.maxDrawdown, [
				{ max: 15, score: 7 },
				{ max: 30, score: 5 },
				{ max: 50, score: 3 },
				{ max: 70, score: 1 },
			]),
		);
		const concentrationRisk = this.createMetricDebug(
			risk.concentrationRisk,
			this.invertedBracketScore(risk.concentrationRisk, [
				{ max: 20, score: 5 },
				{ max: 35, score: 4 },
				{ max: 50, score: 3 },
				{ max: 70, score: 1 },
			]),
		);
		const returnStdDev = this.createMetricDebug(
			risk.returnStdDev,
			this.invertedBracketScore(risk.returnStdDev, [
				{ max: 20, score: 3 },
				{ max: 40, score: 2 },
				{ max: 70, score: 1 },
			]),
		);
		const raw =
			profitFactor.weightedContribution +
			maxDrawdown.weightedContribution +
			concentrationRisk.weightedContribution +
			returnStdDev.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.RISK_MANAGEMENT_MAX,
				),
				profitFactor,
				maxDrawdown,
				concentrationRisk,
				returnStdDev,
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
				{ min: 168, score: 1 },
				{ min: 72, score: 1 },
				{ min: 24, score: 1 },
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
				{ min: 8, score: 2 },
				{ min: 5, score: 2 },
				{ min: 2, score: 1 },
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
		dexMetrics: WalletDexMetricsResponse,
	): ScoreDimensionResult<WalletScoreExperienceDebug> {
		const totalSwaps = this.createMetricDebug(
			summary.total_swaps,
			this.bracketScore(summary.total_swaps, [
				{ min: 100, score: 7 },
				{ min: 50, score: 5 },
				{ min: 15, score: 3 },
				{ min: 5, score: 1 },
			]),
		);
		const tradingSpanDaysMetric = this.createMetricDebug(
			tradingSpanDays,
			this.bracketScore(tradingSpanDays, [
				{ min: 180, score: 6 },
				{ min: 90, score: 5 },
				{ min: 30, score: 3 },
				{ min: 7, score: 1 },
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
			totalSwaps.weightedContribution +
			tradingSpanDaysMetric.weightedContribution +
			dexDiversity.weightedContribution;

		return {
			score: raw,
			debug: {
				...this.createDimensionDebugSummary(
					raw,
					WalletScoringService.EXPERIENCE_MAX,
				),
				totalSwaps,
				tradingSpanDays: tradingSpanDaysMetric,
				dexDiversity,
			},
		};
	}

	private createEmptyScoreDebug(): WalletScoreDebugResponse['debug'] {
		return {
			profitability: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.PROFITABILITY_MAX,
				),
				totalRealizedPnL: this.createMetricDebug(0, 0),
				avgROI: this.createMetricDebug(0, 0),
				avgWinRate: this.createMetricDebug(0, 0),
			},
			consistency: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.CONSISTENCY_MAX,
				),
				tradingSpanRatio: this.createMetricDebug(0, 0),
				burstinessScore: this.createMetricDebug(0, 0),
				profitableTokenRate: this.createMetricDebug(0, 0),
			},
			riskManagement: {
				...this.createDimensionDebugSummary(
					0,
					WalletScoringService.RISK_MANAGEMENT_MAX,
				),
				profitFactor: this.createMetricDebug(0, 0),
				maxDrawdown: this.createMetricDebug(0, 0),
				concentrationRisk: this.createMetricDebug(0, 0),
				returnStdDev: this.createMetricDebug(0, 0),
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
				totalSwaps: this.createMetricDebug(0, 0),
				tradingSpanDays: this.createMetricDebug(0, 0),
				dexDiversity: this.createMetricDebug(0, 0),
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
			value: this.roundDecimal(value),
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

	private calculateTotalScore(breakdown: WalletScoreBreakdown): number {
		return (
			breakdown.profitability.score +
			breakdown.consistency.score +
			breakdown.riskManagement.score +
			breakdown.portfolioQuality.score +
			breakdown.experience.score
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

	private createEmptyBreakdown(): WalletScoreBreakdown {
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

	private bracketScore(value: number, brackets: ScoreBracket[]): number {
		if (!Number.isFinite(value)) {
			return 0;
		}

		for (const bracket of brackets) {
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

		for (const bracket of brackets) {
			if (value <= bracket.max) {
				return bracket.score;
			}
		}

		return 0;
	}

	private roundDecimal(value: number, decimals = 2): number {
		if (!Number.isFinite(value)) {
			return 0;
		}

		return Number(value.toFixed(decimals));
	}
}