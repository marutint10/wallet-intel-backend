import { Injectable, Logger } from '@nestjs/common';
import { TokenCategory } from '../constants/token-categories';
import {
	Trade,
	WalletActivityMetricsResponse,
	WalletClassification,
	WalletDexMetricsResponse,
	WalletHoldTimeBuckets,
	WalletHoldTimeMetricsResponse,
	WalletRiskMetricsResponse,
	WalletSummaryResponse,
	WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

type TraderType =
	| 'Diamond Hand'
	| 'Swing Trader'
	| 'Day Trader'
	| 'Sniper'
	| 'Degen / Ape'
	| 'Bot / Automated'
	| 'Whale'
	| 'Paper Hand'
	| 'Accumulator'
	| 'DeFi Strategist';

interface WeightedCondition {
	score: number;
	weight: number;
}

interface ClassificationInputs {
	summary: WalletSummaryResponse;
	holdTime: WalletHoldTimeMetricsResponse;
	activity: WalletActivityMetricsResponse;
	tokenCategories: WalletTokenCategoryMetricsResponse;
	dexMetrics: WalletDexMetricsResponse;
	risk: WalletRiskMetricsResponse;
	trades: Trade[];
	buySellRatio: number;
	sellRatio: number;
	totalHolds: number;
	avgTradeSize: number;
	under1hRatio: number;
	shortHoldRatio: number;
	defiTradePercent: number;
}

@Injectable()
export class ClassificationService {
	private readonly logger = new Logger(ClassificationService.name);

	constructor(
		private readonly walletPnlService: WalletPnlService,
		private readonly walletAnalyticsService: WalletAnalyticsService,
		private readonly walletPortfolioService: WalletPortfolioService,
	) {}

	async getClassification(address: string): Promise<WalletClassification> {
		const [summary, holdTime, activity, tokenCategories, dexMetrics, risk, trades] =
			await Promise.all([
				this.walletPnlService.getWalletSummary(address),
				this.walletAnalyticsService.getHoldTimeMetrics(address),
				this.walletAnalyticsService.getActivityMetrics(address),
				this.walletAnalyticsService.getTokenCategoryMetrics(address),
				this.walletAnalyticsService.getDexMetrics(address),
				this.walletAnalyticsService.getRiskMetrics(address),
				this.walletPnlService.getTrades(address),
			]);

		const normalizedAddress = summary.address ?? address.toLowerCase();

		if (summary.total_swaps < 3) {
			this.logger.debug({
				address: normalizedAddress,
				classificationScores: {},
				selectedPrimary: 'Insufficient Data',
				confidence: 'low',
			});

			return {
				address: normalizedAddress,
				primaryType: 'Insufficient Data',
				primaryScore: 0,
				confidence: 'low',
				secondaryTypes: [],
				allScores: {},
				classifiedAt: new Date().toISOString(),
			};
		}

		const totalHolds = this.computeTotalHolds(holdTime.holdBuckets);
		const input: ClassificationInputs = {
			summary,
			holdTime,
			activity,
			tokenCategories,
			dexMetrics,
			risk,
			trades,
			buySellRatio: this.computeBuySellRatio(trades),
			sellRatio: this.computeSellRatio(trades),
			totalHolds,
			avgTradeSize:
				Math.abs(summary.totalRealizedPnL) / Math.max(summary.total_swaps, 1),
			under1hRatio:
				totalHolds > 0 ? holdTime.holdBuckets.under1h / totalHolds : 0,
			shortHoldRatio:
				totalHolds > 0
					? (holdTime.holdBuckets.under1h + holdTime.holdBuckets.under24h) /
						totalHolds
					: 0,
			defiTradePercent: this.computeCategoryTradePercent(
				tokenCategories,
				TokenCategory.DEFI,
			),
		};

		const scoreEntries: Array<[TraderType, number]> = [
			['Diamond Hand', this.scoreDiamondHand(input)],
			['Swing Trader', this.scoreSwingTrader(input)],
			['Day Trader', this.scoreDayTrader(input)],
			['Sniper', this.scoreSniper(input)],
			['Degen / Ape', this.scoreDegenApe(input)],
			['Bot / Automated', this.scoreBotAutomated(input)],
			['Whale', this.scoreWhale(input)],
			['Paper Hand', this.scorePaperHand(input)],
			['Accumulator', this.scoreAccumulator(input)],
			['DeFi Strategist', this.scoreDefiStrategist(input)],
		];
		const rankedScores = [...scoreEntries].sort((left, right) => {
			if (right[1] === left[1]) {
				return left[0].localeCompare(right[0]);
			}

			return right[1] - left[1];
		});
		const [primaryType, primaryScore] = rankedScores[0] ?? ['Diamond Hand', 0];
		const secondScore = rankedScores[1]?.[1] ?? 0;
		const primaryThreshold = primaryScore * 0.6;
		const confidence = this.computeConfidence(primaryScore, secondScore);
		const allScores = Object.fromEntries(scoreEntries);

		this.logger.debug({
			address: normalizedAddress,
			classificationScores: allScores,
			selectedPrimary: primaryType,
			confidence,
		});

		return {
			address: normalizedAddress,
			primaryType,
			primaryScore,
			confidence,
			secondaryTypes:
				primaryScore > 0
					? rankedScores
							.slice(1)
							.filter(([, score]) => score >= primaryThreshold)
							.slice(0, 2)
							.map(([type]) => type)
					: [],
			allScores,
			classifiedAt: new Date().toISOString(),
		};
	}

	private computeBuySellRatio(trades: Trade[]): number {
		const buyCount = trades.filter((trade) => trade.type === 'BUY').length;
		const sellCount = trades.filter((trade) => trade.type === 'SELL').length;

		return this.roundDecimal(buyCount / Math.max(sellCount, 1));
	}

	private computeTotalHolds(holdBuckets: WalletHoldTimeBuckets): number {
		return (
			holdBuckets.under1h +
			holdBuckets.under24h +
			holdBuckets.under7d +
			holdBuckets.over7d
		);
	}

	private computeSellRatio(trades: Trade[]): number {
		const sellCount = trades.filter((trade) => trade.type === 'SELL').length;

		return this.roundDecimal(sellCount / Math.max(trades.length, 1));
	}

	private scoreDiamondHand(input: ClassificationInputs): number {
		const over7dRatio =
			input.totalHolds > 0 ? input.holdTime.holdBuckets.over7d / input.totalHolds : 0;
		const maxScore = input.holdTime.medianHoldHours < 168 ? 30 : 100;

		return Math.min(
			this.weightedScore([
			{
				score: this.scoreGreaterThan(input.holdTime.medianHoldHours, [
					{ threshold: 2160, score: 100 },
					{ threshold: 720, score: 60 },
				]),
				weight: 0.35,
			},
			{
				score: this.scoreGreaterThan(over7dRatio, [
					{ threshold: 0.5, score: 100 },
					{ threshold: 0.3, score: 60 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreLessThan(input.summary.tokens_interacted, [
					{ threshold: 10, score: 100 },
					{ threshold: 20, score: 50 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterThan(input.tokenCategories.blueChipTradePercent, [
					{ threshold: 40, score: 100 },
					{ threshold: 20, score: 50 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreLessThan(input.activity.tradesPerActiveDay, [
					{ threshold: 2, score: 100 },
					{ threshold: 5, score: 50 },
				]),
				weight: 0.1,
			},
			]),
			maxScore,
		);
	}

	private scoreSwingTrader(input: ClassificationInputs): number {
		return this.weightedScore([
			{
				score: this.scoreRange(input.holdTime.medianHoldHours, [
					{ min: 24, max: 720, score: 100 },
					{ min: 12, max: 1440, score: 50 },
				]),
				weight: 0.35,
			},
			{
				score: this.scoreRange(input.activity.tradesPerActiveDay, [
					{ min: 1, max: 10, score: 100 },
					{ min: 0.5, max: 15, score: 50 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreRange(input.activity.burstinessScore, [
					{ min: 0.5, max: 2, score: 100 },
					{ min: 0.3, max: 3, score: 50 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterThan(input.summary.avgWinRate, [
					{ threshold: 45, score: 100 },
					{ threshold: 35, score: 60 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterOrEqual(input.tokenCategories.categoryDiversity, [
					{ threshold: 3, score: 100 },
					{ threshold: 2, score: 50 },
				]),
				weight: 0.15,
			},
		]);
	}

	private scoreDayTrader(input: ClassificationInputs): number {
		if (input.holdTime.medianHoldHours > 48) {
			return 0;
		}

		return this.weightedScore([
			{
				score: this.scoreRange(input.holdTime.medianHoldHours, [
					{ min: 1, max: 24, score: 100 },
					{ min: 0.5, max: 48, score: 50 },
				]),
				weight: 0.45,
			},
			{
				score: this.scoreGreaterThan(input.activity.tradesPerActiveDay, [
					{ threshold: 3, score: 100 },
					{ threshold: 2, score: 60 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreGreaterThan(input.activity.tradingSpanRatio, [
					{ threshold: 0.5, score: 100 },
					{ threshold: 0.3, score: 60 },
					{ threshold: 0.15, score: 30 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterThan(input.summary.total_swaps, [
					{ threshold: 50, score: 100 },
					{ threshold: 25, score: 60 },
					{ threshold: 10, score: 30 },
				]),
				weight: 0.2,
			},
		]);
	}

	private scoreSniper(input: ClassificationInputs): number {
		if (input.holdTime.medianHoldHours > 4) {
			return 0;
		}

		return this.weightedScore([
			{
				score: this.scoreLessThan(input.holdTime.medianHoldHours, [
					{ threshold: 1, score: 100 },
					{ threshold: 4, score: 60 },
				]),
				weight: 0.3,
			},
			{
				score: this.scoreGreaterThan(input.under1hRatio, [
					{ threshold: 0.3, score: 100 },
					{ threshold: 0.15, score: 60 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreGreaterThan(input.summary.avgWinRate, [
					{ threshold: 50, score: 100 },
					{ threshold: 40, score: 60 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreGreaterThan(input.tokenCategories.memecoinTradePercent, [
					{ threshold: 40, score: 100 },
					{ threshold: 20, score: 60 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterThan(input.summary.avgROI, [
					{ threshold: 20, score: 100 },
					{ threshold: 10, score: 60 },
				]),
				weight: 0.1,
			},
		]);
	}

	private scoreDegenApe(input: ClassificationInputs): number {
		if (input.tokenCategories.memecoinTradePercent < 10) {
			return 0;
		}

		return this.weightedScore([
			{
				score: this.scoreGreaterThan(input.tokenCategories.memecoinTradePercent, [
					{ threshold: 60, score: 100 },
					{ threshold: 40, score: 70 },
					{ threshold: 20, score: 40 },
				]),
				weight: 0.3,
			},
			{
				score: this.scoreLessThan(input.holdTime.medianHoldHours, [
					{ threshold: 48, score: 100 },
					{ threshold: 168, score: 50 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreGreaterThan(input.activity.burstinessScore, [
					{ threshold: 2, score: 100 },
					{ threshold: 1, score: 60 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreLessThan(input.summary.avgWinRate, [
					{ threshold: 35, score: 100 },
					{ threshold: 45, score: 60 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreLessThan(input.tokenCategories.categoryDiversity, [
					{ threshold: 3, score: 100 },
					{ threshold: 4, score: 50 },
				]),
				weight: 0.15,
			},
		]);
	}

	private scoreBotAutomated(input: ClassificationInputs): number {
		const primaryDex = input.dexMetrics.primaryDex?.toLowerCase() ?? '';
		const usesAggregatorDex =
			primaryDex.includes('1inch') || primaryDex.includes('0x');

		return this.weightedScore([
			{
				score: this.scoreLessThan(input.activity.burstinessScore, [
					{ threshold: 0.3, score: 100 },
					{ threshold: 0.5, score: 70 },
				]),
				weight: 0.3,
			},
			{
				score: this.scoreGreaterThan(input.activity.tradesPerActiveDay, [
					{ threshold: 20, score: 100 },
					{ threshold: 10, score: 60 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreLessThan(input.activity.avgTradeGapHours, [
					{ threshold: 1, score: 100 },
					{ threshold: 2, score: 60 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreLessThan(input.risk.returnStdDev, [
					{ threshold: 10, score: 100 },
					{ threshold: 20, score: 60 },
				]),
				weight: 0.15,
			},
			{
				score: usesAggregatorDex ? 100 : 0,
				weight: 0.1,
			},
		]);
	}

	private scoreWhale(input: ClassificationInputs): number {
		const hasWhaleScaleSignal =
			input.summary.totalRealizedPnL > 10000 || input.avgTradeSize > 1000;

		if (!hasWhaleScaleSignal) {
			return 0;
		}

		return this.weightedScore([
			{
				score: this.scoreGreaterThan(input.summary.totalRealizedPnL, [
					{ threshold: 100000, score: 100 },
					{ threshold: 50000, score: 70 },
					{ threshold: 10000, score: 40 },
				]),
				weight: 0.4,
			},
			{
				score: this.scoreGreaterThan(
					input.risk.concentrationRisk,
					[
						{ threshold: 60, score: 80 },
						{ threshold: 40, score: 50 },
					],
					20,
				),
				weight: 0.3,
			},
			{
				score: this.scoreGreaterThan(input.avgTradeSize, [
					{ threshold: 1000, score: 100 },
					{ threshold: 500, score: 60 },
					{ threshold: 100, score: 30 },
				]),
				weight: 0.3,
			},
		]);
	}

	private scorePaperHand(input: ClassificationInputs): number {
		if (input.summary.avgWinRate > 50) {
			return 0;
		}

		return this.weightedScore([
			{
				score: this.scoreLessThan(input.holdTime.medianHoldHours, [
					{ threshold: 72, score: 100 },
					{ threshold: 168, score: 50 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreLessThan(input.summary.avgWinRate, [
					{ threshold: 30, score: 100 },
					{ threshold: 40, score: 60 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreLessThan(input.risk.profitFactor, [
					{ threshold: 0.8, score: 100 },
					{ threshold: 1, score: 60 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreGreaterThan(input.risk.returnStdDev, [
					{ threshold: 100, score: 100 },
					{ threshold: 50, score: 60 },
				]),
				weight: 0.15,
			},
			{
				score: this.scoreGreaterThan(input.shortHoldRatio, [
					{ threshold: 0.5, score: 100 },
					{ threshold: 0.3, score: 60 },
				]),
				weight: 0.1,
			},
		]);
	}

	private scoreAccumulator(input: ClassificationInputs): number {
		return this.weightedScore([
			{
				score: this.scoreGreaterThan(input.buySellRatio, [
					{ threshold: 3, score: 100 },
					{ threshold: 2, score: 60 },
				]),
				weight: 0.35,
			},
			{
				score: this.scoreGreaterThan(input.holdTime.medianHoldHours, [
					{ threshold: 720, score: 100 },
					{ threshold: 168, score: 50 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreLessThan(input.summary.tokens_interacted, [
					{ threshold: 10, score: 100 },
					{ threshold: 15, score: 50 },
				]),
				weight: 0.2,
			},
			{
				score: this.scoreLessThan(input.sellRatio, [
					{ threshold: 0.3, score: 100 },
					{ threshold: 0.4, score: 60 },
				]),
				weight: 0.2,
			},
		]);
	}

	private scoreDefiStrategist(input: ClassificationInputs): number {
		if (input.tokenCategories.dominantTradingCategory !== TokenCategory.DEFI) {
			return 0;
		}

		return this.weightedScore([
			{
				score: 100,
				weight: 0.3,
			},
			{
				score: this.scoreGreaterOrEqual(input.dexMetrics.dexDiversity, [
					{ threshold: 4, score: 100 },
					{ threshold: 3, score: 70 },
					{ threshold: 2, score: 40 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreGreaterThan(input.tokenCategories.blueChipTradePercent, [
					{ threshold: 50, score: 100 },
					{ threshold: 30, score: 70 },
					{ threshold: 15, score: 40 },
				]),
				weight: 0.25,
			},
			{
				score: this.scoreGreaterThan(input.summary.avgWinRate, [
					{ threshold: 50, score: 100 },
					{ threshold: 40, score: 60 },
				]),
				weight: 0.2,
			},
		]);
	}

	private computeCategoryTradePercent(
		tokenCategories: WalletTokenCategoryMetricsResponse,
		category: TokenCategory,
	): number {
		const totalTrades = Object.values(tokenCategories.tradesByCategory).reduce(
			(total, value) => total + value,
			0,
		);
		const categoryTrades = tokenCategories.tradesByCategory[category] ?? 0;

		if (totalTrades <= 0) {
			return 0;
		}

		return this.roundDecimal((categoryTrades / totalTrades) * 100);
	}

	private computeConfidence(
		topScore: number,
		secondScore: number,
	): 'low' | 'medium' | 'high' {
		const gap = (topScore - secondScore) / Math.max(topScore, 1);

		if (gap > 0.4) {
			return 'high';
		}

		if (gap > 0.2) {
			return 'medium';
		}

		return 'low';
	}

	private weightedScore(conditions: WeightedCondition[]): number {
		const score = conditions.reduce(
			(total, condition) => total + this.clampScore(condition.score) * condition.weight,
			0,
		);

		return this.clampScore(score);
	}

	private scoreGreaterThan(
		value: number,
		thresholds: Array<{ threshold: number; score: number }>,
		defaultScore = 0,
	): number {
		if (!Number.isFinite(value)) {
			return defaultScore;
		}

		for (const entry of thresholds) {
			if (value > entry.threshold) {
				return entry.score;
			}
		}

		return defaultScore;
	}

	private scoreGreaterOrEqual(
		value: number,
		thresholds: Array<{ threshold: number; score: number }>,
		defaultScore = 0,
	): number {
		if (!Number.isFinite(value)) {
			return defaultScore;
		}

		for (const entry of thresholds) {
			if (value >= entry.threshold) {
				return entry.score;
			}
		}

		return defaultScore;
	}

	private scoreLessThan(
		value: number,
		thresholds: Array<{ threshold: number; score: number }>,
		defaultScore = 0,
	): number {
		if (!Number.isFinite(value)) {
			return defaultScore;
		}

		for (const entry of thresholds) {
			if (value < entry.threshold) {
				return entry.score;
			}
		}

		return defaultScore;
	}

	private scoreRange(
		value: number,
		ranges: Array<{ min: number; max: number; score: number }>,
		defaultScore = 0,
	): number {
		if (!Number.isFinite(value)) {
			return defaultScore;
		}

		for (const entry of ranges) {
			if (value >= entry.min && value <= entry.max) {
				return entry.score;
			}
		}

		return defaultScore;
	}

	private clampScore(score: number): number {
		return this.roundDecimal(Math.min(100, Math.max(0, score)));
	}

	private roundDecimal(value: number): number {
		return Math.round((value + Number.EPSILON) * 100) / 100;
	}
}