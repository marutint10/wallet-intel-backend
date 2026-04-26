import { Injectable, Logger } from '@nestjs/common';
import { TokenCategory } from '../constants/token-categories';
import {
	Trade,
	WalletActivityMetricsResponse,
	WalletClassification,
	WalletConfidenceFields,
	WalletDexMetricsResponse,
	WalletHoldTimeBuckets,
	WalletHoldTimeMetricsResponse,
	WalletPortfolioItem,
	WalletRiskMetricsResponse,
	WalletSummaryResponse,
	WalletTokenCategoryMetricsResponse,
} from '../wallet.types';
import { WalletAnalyticsService } from './wallet-analytics.service';
import {
	TraderArchetype,
	TraderArchetypeInputs,
	scoreTraderArchetypes,
} from './classification/trader-archetype.scorer';
import { WalletConfidenceService } from './wallet-confidence.service';
import { WalletContextService } from './wallet-context.service';
import { WalletPnlService } from './wallet-pnl.service';
import { WalletPortfolioService } from './wallet-portfolio.service';

type TraderType = TraderArchetype;

type HolderType =
	| 'Diamond Hands'
	| 'Blue Chip Maximalist'
	| 'DeFi Strategist'
	| 'Stablecoin Parker'
	| 'Diversified Holder'
	| 'Memecoin Collector'
	| 'Whale Holder'
	| 'Micro Holder'
	| 'Accumulator'
	| 'Dust Wallet';

type ClassificationRiskProfile = 'conservative' | 'moderate' | 'aggressive';

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

interface TraderNarrativeInputs {
	summary: WalletSummaryResponse;
	holdTime: WalletHoldTimeMetricsResponse;
	activity: WalletActivityMetricsResponse;
	tokenCategories: WalletTokenCategoryMetricsResponse;
	risk: WalletRiskMetricsResponse;
	buySellRatio: number;
	sellRatio: number;
	capitalBaseUsd: number;
}

interface HolderClassificationInputs {
	summary: WalletSummaryResponse;
	portfolio: WalletPortfolioItem[];
	tokenCategories: WalletTokenCategoryMetricsResponse;
	totalPortfolioUsd: number;
	uniqueTokens: number;
	avgHoldingDays: number;
	longestHoldDays: number;
	holdingsInProfitPercent: number;
	blueChipPercent: number;
	stablecoinPercent: number;
	memecoinPercent: number;
	defiPercent: number;
	lstPercent: number;
	categoryCount: number;
	maxCategoryPercent: number;
	largestPositionUsd: number;
}

interface ClassificationNarrative {
	description: string;
	traits: string[];
	riskProfile: ClassificationRiskProfile;
}

@Injectable()
export class ClassificationService {
	private readonly logger = new Logger(ClassificationService.name);

	constructor(
		private readonly walletPnlService: WalletPnlService,
		private readonly walletAnalyticsService: WalletAnalyticsService,
		private readonly walletContextService: WalletContextService,
		private readonly walletPortfolioService: WalletPortfolioService,
		private readonly walletConfidenceService: WalletConfidenceService,
	) {}

	async getClassification(address: string): Promise<WalletClassification> {
		const [context, summary, tokenCategories, portfolioResult] = await Promise.all([
			this.walletContextService.getWalletContext(address),
			this.walletPnlService.getWalletSummary(address),
			this.walletAnalyticsService.getTokenCategoryMetrics(address),
			this.walletPortfolioService.getPortfolioWithAvailability(address),
		]);
		const normalizedAddress = summary.address ?? address.toLowerCase();

		if (!context.isTraderWallet) {
			const confidenceProfile = await this.walletConfidenceService.getConfidence(
				address,
				{ summary },
			);

			return this.classifyHolder(
				normalizedAddress,
				context,
				summary,
				portfolioResult.portfolio,
				tokenCategories,
				portfolioResult.balancesAvailable,
				confidenceProfile,
			);
		}

		const [holdTime, activity, risk, trades] = await Promise.all([
			this.walletAnalyticsService.getHoldTimeMetrics(address),
			this.walletAnalyticsService.getActivityMetrics(address),
			this.walletAnalyticsService.getRiskMetrics(address),
			this.walletPnlService.getTrades(address),
		]);
		const confidenceProfile = await this.walletConfidenceService.getConfidence(
			address,
			{
				summary,
				activity,
				holdTime,
				trades,
			},
		);

		return this.classifyTrader(
			normalizedAddress,
			summary,
			holdTime,
			activity,
			tokenCategories,
			risk,
			trades,
			portfolioResult.portfolio,
			confidenceProfile,
		);
	}

	private classifyTrader(
		address: string,
		summary: WalletSummaryResponse,
		holdTime: WalletHoldTimeMetricsResponse,
		activity: WalletActivityMetricsResponse,
		tokenCategories: WalletTokenCategoryMetricsResponse,
		risk: WalletRiskMetricsResponse,
		trades: Trade[],
		portfolio: WalletPortfolioItem[],
		confidenceProfile: WalletConfidenceFields,
	): WalletClassification {
		const buySellRatio = this.computeBuySellRatio(trades);
		const sellRatio = this.computeSellRatio(trades);
		const totalPortfolioUsd = this.computeTotalPortfolioUsd(
			this.filterPortfolioByUsdValue(portfolio, 0),
		);
		const traderInputs: TraderArchetypeInputs = {
			totalSwaps: summary.total_swaps,
			tradesPerActiveDay: activity.tradesPerActiveDay,
			medianHoldHours: holdTime.medianHoldHours,
			avgHoldHours: holdTime.avgHoldHours,
			tokensInteracted: summary.tokens_interacted,
			blueChipTradeRatio: tokenCategories.blueChipTradePercent / 100,
			memecoinTradeRatio: tokenCategories.memecoinTradePercent / 100,
			concentrationRisk: risk.concentrationRisk / 100,
			burstinessScore: activity.burstinessScore,
			tradingSpanRatio: activity.tradingSpanRatio,
			sellRatio,
			buySellRatio,
			repeatedEntryExitRatio: this.computeRepeatedEntryExitRatio(trades),
			capitalBaseUsd: Math.max(totalPortfolioUsd, Math.abs(summary.totalRealizedPnL)),
		};
		const archetypeScores = scoreTraderArchetypes(traderInputs);
		const allScores = archetypeScores.scoreBreakdown;

		this.logger.debug({
			address,
			classificationScores: allScores,
			selectedPrimary: archetypeScores.primaryType,
			confidence: confidenceProfile.confidence,
			confidenceScore: confidenceProfile.confidenceScore,
		});
		const narrative = this.buildTraderNarrative(archetypeScores.primaryType, {
			summary,
			holdTime,
			activity,
			tokenCategories,
			risk,
			buySellRatio,
			sellRatio,
			capitalBaseUsd: traderInputs.capitalBaseUsd,
		});

		return this.buildClassificationResponse({
			address,
			type: archetypeScores.primaryType,
			primaryScore: archetypeScores.primaryScore,
			confidenceProfile,
			description: narrative.description,
			traits: narrative.traits,
			riskProfile: narrative.riskProfile,
			secondaryTypes: archetypeScores.secondaryTypes,
			allScores,
		});
	}

	private classifyHolder(
		address: string,
		context: { walletType: string },
		summary: WalletSummaryResponse,
		portfolio: WalletPortfolioItem[],
		tokenCategories: WalletTokenCategoryMetricsResponse,
		balancesAvailable: boolean,
		confidenceProfile: WalletConfidenceFields,
	): WalletClassification {
		const positiveValueHoldings = this.filterPortfolioByUsdValue(portfolio, 0);

		if (!balancesAvailable || positiveValueHoldings.length === 0) {
			return this.buildClassificationResponse({
				address,
				type: 'Empty Wallet',
				primaryScore: 0,
				confidenceProfile,
				description:
					'Wallet has no priced holdings and no meaningful trading activity, so it is classified as an empty wallet.',
				traits: [
					`${context.walletType} wallet`,
					'No positive-value holdings',
					'No trader activity detected',
				],
				riskProfile: 'conservative',
				secondaryTypes: [],
				allScores: {},
			});
		}

		const totalPortfolioUsd = this.computeTotalPortfolioUsd(positiveValueHoldings);
		const uniqueTokens = this.countUniquePortfolioTokens(positiveValueHoldings);
		const avgHoldingDays = this.computeAverageHoldingDays(positiveValueHoldings);
		const longestHoldDays = this.computeLongestHoldingDays(positiveValueHoldings);
		const holdingsInProfitPercent = this.computeHoldingsInProfitPercent(
			positiveValueHoldings,
		);
		const categoryCount = this.countHoldingCategories(tokenCategories);
		const maxCategoryPercent = this.computeLargestHoldingCategoryPercent(
			tokenCategories,
		);
		const input: HolderClassificationInputs = {
			summary,
			portfolio: positiveValueHoldings,
			tokenCategories,
			totalPortfolioUsd,
			uniqueTokens,
			avgHoldingDays,
			longestHoldDays,
			holdingsInProfitPercent,
			blueChipPercent: tokenCategories.blueChipHoldingPercent,
			stablecoinPercent: tokenCategories.stablecoinHoldingPercent,
			memecoinPercent: tokenCategories.memecoinHoldingPercent,
			defiPercent: this.computeHoldingCategoryPercent(
				tokenCategories,
				TokenCategory.DEFI,
			),
			lstPercent: this.computeHoldingCategoryPercent(
				tokenCategories,
				TokenCategory.LST_LRT,
			),
			categoryCount,
			maxCategoryPercent,
			largestPositionUsd: this.computeLargestPositionUsd(positiveValueHoldings),
		};

		const scoreEntries: Array<[HolderType, number]> = [
			['Diamond Hands', this.scoreHolderDiamondHands(input)],
			['Blue Chip Maximalist', this.scoreHolderBlueChipMaximalist(input)],
			['DeFi Strategist', this.scoreHolderDefiStrategist(input)],
			['Stablecoin Parker', this.scoreHolderStablecoinParker(input)],
			['Diversified Holder', this.scoreHolderDiversifiedHolder(input)],
			['Memecoin Collector', this.scoreHolderMemecoinCollector(input)],
			['Whale Holder', this.scoreHolderWhaleHolder(input)],
			['Micro Holder', this.scoreHolderMicroHolder(input)],
			['Accumulator', this.scoreHolderAccumulator(input)],
			['Dust Wallet', this.scoreHolderDustWallet(input)],
		];
		const rankedScores = [...scoreEntries].sort((left, right) => {
			if (right[1] === left[1]) {
				return left[0].localeCompare(right[0]);
			}

			return right[1] - left[1];
		});
		const [primaryType, primaryScore] = rankedScores[0] ?? ['Micro Holder', 0];
		const allScores = Object.fromEntries(scoreEntries);
		const narrative = this.buildHolderNarrative(primaryType, input);

		this.logger.debug({
			address,
			classificationScores: allScores,
			selectedPrimary: primaryType,
			confidence: confidenceProfile.confidence,
			confidenceScore: confidenceProfile.confidenceScore,
		});

		return this.buildClassificationResponse({
			address,
			type: primaryType,
			primaryScore,
			confidenceProfile,
			description: narrative.description,
			traits: narrative.traits,
			riskProfile: narrative.riskProfile,
			secondaryTypes:
				primaryScore > 0
					? rankedScores
							.slice(1)
							.filter(([, score]) => score >= primaryScore * 0.6)
							.slice(0, 2)
							.map(([type]) => type)
					: [],
			allScores,
		});
	}

	private buildClassificationResponse(input: {
		address: string;
		type: string;
		primaryScore: number;
		confidenceProfile: WalletConfidenceFields;
		description: string;
		traits: string[];
		riskProfile: ClassificationRiskProfile;
		secondaryTypes: string[];
		allScores: Record<string, number>;
	}): WalletClassification {
		const isLowConfidence = input.confidenceProfile.confidenceLabel === 'low';
		const description = isLowConfidence
			? this.softenLowConfidenceDescription(input.description)
			: input.description;
		const traits = isLowConfidence
			? [
				'Low-confidence classification; interpret as directional rather than definitive.',
				...input.traits,
			]
			: input.traits;

		return {
			address: input.address,
			type: input.type,
			primaryType: input.type,
			primaryScore: this.clampScore(input.primaryScore),
			...input.confidenceProfile,
			description,
			traits: traits.slice(0, 5),
			riskProfile: input.riskProfile,
			secondaryTypes: input.secondaryTypes,
			scoreBreakdown: input.allScores,
			allScores: input.allScores,
			classifiedAt: new Date().toISOString(),
		};
	}

	private softenLowConfidenceDescription(description: string): string {
		const trimmedDescription = description.trim();

		if (!trimmedDescription) {
			return 'Likely wallet behavior inferred from limited and noisy signals.';
		}

		return `${trimmedDescription} This is a tentative classification because confidence is currently low.`;
	}

	private buildTraderNarrative(
		type: TraderType,
		input: TraderNarrativeInputs,
	): ClassificationNarrative {
		switch (type) {
			case 'Diamond Hand':
				return {
					description: `Long-horizon trader with ${this.formatDays(input.holdTime.medianHoldHours / 24)} median holds, low turnover cadence, and strong blue-chip preference (${this.formatPercent(input.tokenCategories.blueChipTradePercent)}).`,
					traits: [
						`Median hold ${this.formatDays(input.holdTime.medianHoldHours / 24)}`,
						`${this.formatNumber(input.activity.tradesPerActiveDay)} trades/day`,
						`${this.formatPercent(input.tokenCategories.blueChipTradePercent)} blue-chip trades`,
						`${this.formatNumber(input.summary.tokens_interacted)} tokens interacted`,
					],
					riskProfile: 'conservative',
				};
			case 'Swing Trader':
				return {
					description: `Medium-term trader balancing 1-30 day hold windows with moderate activity (${this.formatNumber(input.activity.tradesPerActiveDay)} trades/day) and repeated position recycling.`,
					traits: [
						`Median hold ${this.formatDays(input.holdTime.medianHoldHours / 24)}`,
						`${this.formatNumber(input.activity.tradesPerActiveDay)} trades/day`,
						`${this.formatPercent(input.summary.avgWinRate)} win rate`,
					],
					riskProfile: 'moderate',
				};
			case 'Day Trader':
				return {
					description: `Short-horizon trader with sub-24h median holds and high execution frequency across ${this.formatNumber(input.summary.total_swaps)} swaps.`,
					traits: [
						`Median hold ${this.formatHours(input.holdTime.medianHoldHours)}`,
						`${this.formatNumber(input.activity.tradesPerActiveDay)} trades/day`,
						`${this.formatNumber(input.summary.total_swaps)} swaps`,
					],
					riskProfile: 'aggressive',
				};
			case 'Rotation Trader':
				return {
					description: `High-churn rotation profile moving capital across many assets, with broad token coverage (${this.formatNumber(input.summary.tokens_interacted)} tokens) and sustained swap flow.`,
					traits: [
						`${this.formatNumber(input.summary.tokens_interacted)} tokens interacted`,
						`${this.formatNumber(input.summary.total_swaps)} swaps`,
						`${this.formatDays(input.holdTime.avgHoldHours / 24)} avg hold`,
					],
					riskProfile: 'moderate',
				};
			case 'Meme Hunter':
				return {
					description: `Speculative narrative-driven trader with heavy memecoin flow (${this.formatPercent(input.tokenCategories.memecoinTradePercent)}) and bursty execution behavior.`,
					traits: [
						`${this.formatPercent(input.tokenCategories.memecoinTradePercent)} memecoin trades`,
						`${this.formatNumber(input.activity.burstinessScore)} burstiness`,
						`${this.formatNumber(input.summary.tokens_interacted)} tokens interacted`,
					],
					riskProfile: 'aggressive',
				};
			case 'Bot / Automated':
				return {
					description: `Systematic execution pattern with very high trade cadence, low timing variance, and repeatable behavior signatures.`,
					traits: [
						`${this.formatNumber(input.activity.tradesPerActiveDay)} trades/day`,
						`${this.formatNumber(input.activity.burstinessScore)} burstiness score`,
						`${this.formatPercent(input.activity.tradingSpanRatio * 100)} trading span ratio`,
					],
					riskProfile: 'moderate',
				};
			case 'Whale':
				return {
					description: `Capital-heavy profile with estimated capital base around ${this.formatUsd(input.capitalBaseUsd)} and concentrated risk posture (${this.formatPercent(input.risk.concentrationRisk)}).`,
					traits: [
						`${this.formatUsd(input.capitalBaseUsd)} estimated capital base`,
						`${this.formatPercent(input.risk.concentrationRisk)} concentration risk`,
						`${this.formatNumber(input.summary.total_swaps)} swaps`,
					],
					riskProfile: 'moderate',
				};
			case 'Accumulator':
				return {
					description: `Net-buyer profile showing recurring buys, low sell pressure, and long-hold behavior consistent with staged accumulation.`,
					traits: [
						`${this.formatNumber(input.buySellRatio)} buy/sell ratio`,
						`${this.formatPercent((1 - input.sellRatio) * 100)} non-sell activity`,
						`${this.formatDays(input.holdTime.avgHoldHours / 24)} avg hold`,
					],
					riskProfile: 'moderate',
				};
			default:
				return {
					description: `Balanced active trader profile inferred from mixed holding windows and diversified execution patterns.`,
					traits: [
						`${this.formatNumber(input.summary.total_swaps)} swaps`,
						`${this.formatDays(input.holdTime.medianHoldHours / 24)} median hold`,
						`${this.formatPercent(input.tokenCategories.blueChipTradePercent)} blue-chip trades`,
					],
					riskProfile: 'moderate',
				};
		}
	}

	private buildHolderNarrative(
		type: HolderType,
		input: HolderClassificationInputs,
	): ClassificationNarrative {
		switch (type) {
			case 'Diamond Hands':
				return {
					description: `Long-term conviction holder with an average holding period of ${this.formatDays(input.avgHoldingDays)} and a portfolio value of ${this.formatUsd(input.totalPortfolioUsd)}. ${this.formatPercent(input.holdingsInProfitPercent)} of priced holdings are currently in profit.`,
					traits: [
						`Avg hold ${this.formatDays(input.avgHoldingDays)}`,
						`${this.formatUsd(input.totalPortfolioUsd)} portfolio`,
						`${this.formatPercent(input.holdingsInProfitPercent)} holdings in profit`,
						`${this.formatPercent(input.blueChipPercent)} blue-chip exposure`,
					],
					riskProfile: 'conservative',
				};
			case 'Blue Chip Maximalist':
				return {
					description: `Concentrated holder with ${this.formatPercent(input.blueChipPercent)} of capital in established assets across ${this.formatNumber(input.uniqueTokens)} tokens.`,
					traits: [
						`${this.formatPercent(input.blueChipPercent)} blue-chip allocation`,
						`${this.formatNumber(input.uniqueTokens)} tracked tokens`,
						`${this.formatUsd(input.totalPortfolioUsd)} portfolio value`,
					],
					riskProfile: 'conservative',
				};
			case 'DeFi Strategist':
				return {
					description: `Holder focused on protocol and yield-bearing assets, with ${this.formatPercent(input.defiPercent + input.lstPercent)} combined DeFi and staking exposure across ${this.formatNumber(input.uniqueTokens)} positions.`,
					traits: [
						`${this.formatPercent(input.defiPercent)} DeFi exposure`,
						`${this.formatPercent(input.lstPercent)} LST/LRT exposure`,
						`${this.formatNumber(input.uniqueTokens)} tokens held`,
					],
					riskProfile: 'moderate',
				};
			case 'Stablecoin Parker':
				return {
					description: `Capital is largely parked in stable assets, with ${this.formatPercent(input.stablecoinPercent)} of current holdings in stablecoins and limited risk-on exposure.`,
					traits: [
						`${this.formatPercent(input.stablecoinPercent)} stablecoins`,
						`${this.formatUsd(input.totalPortfolioUsd)} portfolio value`,
						`${this.formatNumber(input.uniqueTokens)} held tokens`,
					],
					riskProfile: 'conservative',
				};
			case 'Diversified Holder':
				return {
					description: `Broadly diversified holder spread across ${this.formatNumber(input.categoryCount)} categories with no single category above ${this.formatPercent(input.maxCategoryPercent)}.`,
					traits: [
						`${this.formatNumber(input.categoryCount)} categories`,
						`${this.formatPercent(input.maxCategoryPercent)} largest category share`,
						`${this.formatNumber(input.uniqueTokens)} tokens held`,
					],
					riskProfile: 'moderate',
				};
			case 'Memecoin Collector':
				return {
					description: `Speculative holder with ${this.formatPercent(input.memecoinPercent)} of holdings tied to memecoins and narrative-driven assets.`,
					traits: [
						`${this.formatPercent(input.memecoinPercent)} memecoin exposure`,
						`${this.formatUsd(input.totalPortfolioUsd)} portfolio value`,
						`${this.formatNumber(input.uniqueTokens)} tokens held`,
					],
					riskProfile: 'aggressive',
				};
			case 'Whale Holder':
				return {
					description: `Large passive holder controlling ${this.formatUsd(input.totalPortfolioUsd)} in assets, with the largest single position worth ${this.formatUsd(input.largestPositionUsd)}.`,
					traits: [
						`${this.formatUsd(input.totalPortfolioUsd)} total value`,
						`${this.formatUsd(input.largestPositionUsd)} largest position`,
						`${this.formatNumber(input.uniqueTokens)} tracked holdings`,
					],
					riskProfile: 'moderate',
				};
			case 'Micro Holder':
				return {
					description: `Small portfolio holder still early in the accumulation curve, with total holdings of ${this.formatUsd(input.totalPortfolioUsd)} across ${this.formatNumber(input.uniqueTokens)} tokens.`,
					traits: [
						`${this.formatUsd(input.totalPortfolioUsd)} portfolio value`,
						`${this.formatNumber(input.uniqueTokens)} tokens held`,
						`${this.formatNumber(input.summary.total_transfers)} incoming/outgoing transfers`,
					],
					riskProfile: 'moderate',
				};
			case 'Accumulator':
				return {
					description: `Passive accumulator receiving tokens without active trading, with ${this.formatNumber(input.summary.total_transfers)} transfers and zero swaps recorded.`,
					traits: [
						`${this.formatNumber(input.summary.total_transfers)} transfers`,
						'No swaps recorded',
						`${this.formatNumber(input.uniqueTokens)} tokens accumulated`,
					],
					riskProfile: 'moderate',
				};
			case 'Dust Wallet':
			default:
				return {
					description: `Wallet holds only negligible value at ${this.formatUsd(input.totalPortfolioUsd)}, which is consistent with a dust wallet rather than an actively managed portfolio.`,
					traits: [
						`${this.formatUsd(input.totalPortfolioUsd)} total value`,
						`${this.formatNumber(input.uniqueTokens)} tiny positions`,
						`${this.formatPercent(input.stablecoinPercent)} stablecoin share`,
					],
					riskProfile: 'conservative',
				};
		}
	}

	private scoreHolderDiamondHands(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.avgHoldingDays, [
				{ min: 365.0001, score: 30 },
				{ min: 180.0001, score: 20 },
				{ min: 90.0001, score: 10 },
			]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 10000.0001, score: 25 },
					{ min: 1000.0001, score: 18 },
					{ min: 100.0001, score: 10 },
				]) +
				this.bracketScore(input.holdingsInProfitPercent, [
					{ min: 70.0001, score: 25 },
					{ min: 50.0001, score: 18 },
					{ min: 30.0001, score: 10 },
				]) +
				this.bracketScore(input.blueChipPercent, [
					{ min: 80.0001, score: 20 },
					{ min: 60.0001, score: 12 },
					{ min: 40.0001, score: 6 },
				]),
		);
	}

	private scoreHolderBlueChipMaximalist(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.blueChipPercent, [
				{ min: 90.0001, score: 35 },
				{ min: 70.0001, score: 25 },
				{ min: 50.0001, score: 12 },
			]) +
				this.scoreLessOrEqual(input.uniqueTokens, [
					{ threshold: 2, score: 25 },
					{ threshold: 5, score: 20 },
					{ threshold: 8, score: 10 },
				]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 1000.0001, score: 20 },
					{ min: 250.0001, score: 15 },
					{ min: 50.0001, score: 10 },
				]) +
				this.scoreLessThan(input.categoryCount, [
					{ threshold: 3, score: 20 },
					{ threshold: 5, score: 10 },
				]),
		);
	}

	private scoreHolderDefiStrategist(input: HolderClassificationInputs): number {
		const defiBlend = input.defiPercent + input.lstPercent;

		return this.clampScore(
			this.bracketScore(defiBlend, [
				{ min: 70.0001, score: 40 },
				{ min: 40.0001, score: 28 },
				{ min: 20.0001, score: 12 },
			]) +
				this.bracketScore(input.uniqueTokens, [
					{ min: 6, score: 25 },
					{ min: 3, score: 18 },
					{ min: 2, score: 8 },
				]) +
				this.bracketScore(input.categoryCount, [
					{ min: 4, score: 20 },
					{ min: 3, score: 14 },
					{ min: 2, score: 8 },
				]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 1000.0001, score: 15 },
					{ min: 100.0001, score: 10 },
					{ min: 10.0001, score: 5 },
				]),
		);
	}

	private scoreHolderStablecoinParker(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.stablecoinPercent, [
				{ min: 80.0001, score: 50 },
				{ min: 50.0001, score: 35 },
				{ min: 30.0001, score: 15 },
			]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 10000.0001, score: 20 },
					{ min: 1000.0001, score: 10 },
					{ min: 100.0001, score: 5 },
				]) +
				this.scoreLessOrEqual(input.uniqueTokens, [
					{ threshold: 3, score: 15 },
					{ threshold: 6, score: 8 },
				]) +
				this.scoreLessThan(input.blueChipPercent, [
					{ threshold: 20, score: 15 },
					{ threshold: 40, score: 5 },
				]),
		);
	}

	private scoreHolderDiversifiedHolder(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.categoryCount, [
				{ min: 6, score: 35 },
				{ min: 4, score: 25 },
				{ min: 3, score: 10 },
			]) +
				this.scoreLessThan(input.maxCategoryPercent, [
					{ threshold: 35, score: 30 },
					{ threshold: 50, score: 20 },
					{ threshold: 60, score: 10 },
				]) +
				this.bracketScore(input.uniqueTokens, [
					{ min: 8, score: 20 },
					{ min: 4, score: 12 },
					{ min: 3, score: 6 },
				]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 500.0001, score: 15 },
					{ min: 100.0001, score: 10 },
					{ min: 10.0001, score: 5 },
				]),
		);
	}

	private scoreHolderMemecoinCollector(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.memecoinPercent, [
				{ min: 70.0001, score: 55 },
				{ min: 40.0001, score: 35 },
				{ min: 20.0001, score: 15 },
			]) +
				this.bracketScore(input.uniqueTokens, [
					{ min: 5, score: 15 },
					{ min: 3, score: 8 },
				]) +
				this.scoreLessThan(input.avgHoldingDays, [
					{ threshold: 30, score: 15 },
					{ threshold: 90, score: 8 },
				]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 100.0001, score: 10 },
					{ min: 10.0001, score: 5 },
				]) +
				this.bracketScore(input.holdingsInProfitPercent, [
					{ min: 50.0001, score: 5 },
					{ min: 30.0001, score: 2 },
				]),
		);
	}

	private scoreHolderWhaleHolder(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.totalPortfolioUsd, [
				{ min: 500000.0001, score: 60 },
				{ min: 100000.0001, score: 45 },
				{ min: 50000.0001, score: 30 },
				{ min: 10000.0001, score: 15 },
			]) +
				this.bracketScore(input.largestPositionUsd, [
					{ min: 100000.0001, score: 20 },
					{ min: 50000.0001, score: 15 },
					{ min: 10000.0001, score: 10 },
				]) +
				this.bracketScore(input.blueChipPercent, [
					{ min: 40.0001, score: 10 },
					{ min: 20.0001, score: 5 },
				]) +
				this.bracketScore(input.avgHoldingDays, [
					{ min: 90.0001, score: 10 },
					{ min: 30.0001, score: 5 },
				]),
		);
	}

	private scoreHolderMicroHolder(input: HolderClassificationInputs): number {
		if (input.totalPortfolioUsd < 1) {
			return 0;
		}

		return this.clampScore(
			this.scoreLessThan(input.totalPortfolioUsd, [
				{ threshold: 10, score: 55 },
				{ threshold: 25, score: 35 },
				{ threshold: 50, score: 20 },
			]) +
				this.scoreLessOrEqual(input.uniqueTokens, [
					{ threshold: 3, score: 20 },
					{ threshold: 5, score: 10 },
				]) +
				this.scoreLessThan(input.avgHoldingDays, [
					{ threshold: 90, score: 10 },
					{ threshold: 180, score: 5 },
				]) +
				this.bracketScore(input.summary.total_transfers, [
					{ min: 1, score: 10 },
				]) +
				this.bracketScore(input.uniqueTokens, [
					{ min: 1, score: 5 },
				]),
		);
	}

	private scoreHolderAccumulator(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.bracketScore(input.summary.total_transfers, [
				{ min: 20, score: 40 },
				{ min: 5, score: 25 },
				{ min: 1, score: 10 },
			]) +
				(input.summary.total_swaps === 0 ? 25 : input.summary.total_swaps <= 2 ? 10 : 0) +
				this.bracketScore(input.uniqueTokens, [
					{ min: 5, score: 15 },
					{ min: 2, score: 10 },
				]) +
				this.bracketScore(input.avgHoldingDays, [
					{ min: 30.0001, score: 10 },
					{ min: 7.0001, score: 5 },
				]) +
				this.bracketScore(input.totalPortfolioUsd, [
					{ min: 50.0001, score: 10 },
					{ min: 10.0001, score: 5 },
				]),
		);
	}

	private scoreHolderDustWallet(input: HolderClassificationInputs): number {
		return this.clampScore(
			this.scoreLessThan(input.totalPortfolioUsd, [
				{ threshold: 0.1, score: 70 },
				{ threshold: 1, score: 50 },
				{ threshold: 5, score: 20 },
			]) +
				this.scoreLessOrEqual(input.uniqueTokens, [
					{ threshold: 3, score: 10 },
				]) +
				(input.summary.total_swaps === 0 ? 10 : 0) +
				this.bracketScore(input.summary.total_transfers, [
					{ min: 1, score: 10 },
				]) +
				this.bracketScore(input.stablecoinPercent, [
					{ min: 50.0001, score: 10 },
				]),
		);
	}

	private computeBuySellRatio(trades: Trade[]): number {
		const buyCount = trades.filter((trade) => trade.type === 'BUY').length;
		const sellCount = trades.filter((trade) => trade.type === 'SELL').length;

		return this.roundDecimal(buyCount / Math.max(sellCount, 1));
	}

	private computeRepeatedEntryExitRatio(trades: Trade[]): number {
		if (trades.length === 0) {
			return 0;
		}

		const sideByToken = new Map<string, Set<Trade['type']>>();

		for (const trade of trades) {
			const tokenKey = trade.contractAddress?.toLowerCase() ?? trade.token.toLowerCase();
			const sides = sideByToken.get(tokenKey) ?? new Set<Trade['type']>();
			sides.add(trade.type);
			sideByToken.set(tokenKey, sides);
		}

		if (sideByToken.size === 0) {
			return 0;
		}

		const repeatedTokens = Array.from(sideByToken.values()).filter(
			(sides) => sides.has('BUY') && sides.has('SELL'),
		).length;

		return this.roundDecimal(repeatedTokens / sideByToken.size);
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

	private bracketScore(
		value: number,
		brackets: Array<{ min: number; score: number }>,
	): number {
		if (!Number.isFinite(value)) {
			return 0;
		}

		const sorted = [...brackets].sort((left, right) => right.min - left.min);

		for (const bracket of sorted) {
			if (value >= bracket.min) {
				return bracket.score;
			}
		}

		return 0;
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

	private scoreLessOrEqual(
		value: number,
		thresholds: Array<{ threshold: number; score: number }>,
		defaultScore = 0,
	): number {
		if (!Number.isFinite(value)) {
			return defaultScore;
		}

		for (const entry of thresholds) {
			if (value <= entry.threshold) {
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

	private filterPortfolioByUsdValue(
		portfolio: WalletPortfolioItem[],
		minimumUsdValue: number,
	): WalletPortfolioItem[] {
		return portfolio.filter((item) => {
			const usdValue = this.parseNumericValue(item.usdValue);

			return usdValue !== null && usdValue > minimumUsdValue;
		});
	}

	private computeTotalPortfolioUsd(portfolio: WalletPortfolioItem[]): number {
		return this.roundDecimal(
			portfolio.reduce((total, item) => {
				const usdValue = this.parseNumericValue(item.usdValue);

				return total + (usdValue ?? 0);
			}, 0),
		);
	}

	private computeLargestPositionUsd(portfolio: WalletPortfolioItem[]): number {
		const usdValues = portfolio
			.map((item) => this.parseNumericValue(item.usdValue))
			.filter((value): value is number => value !== null);

		if (usdValues.length === 0) {
			return 0;
		}

		return this.roundDecimal(Math.max(...usdValues));
	}

	private computeAverageHoldingDays(portfolio: WalletPortfolioItem[]): number {
		const values = portfolio
			.map((item) => item.holdingDays)
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
			.map((item) => item.holdingDays)
			.filter((value): value is number => value !== null && Number.isFinite(value));

		if (values.length === 0) {
			return 0;
		}

		return this.roundDecimal(Math.max(...values));
	}

	private computeHoldingsInProfitPercent(portfolio: WalletPortfolioItem[]): number {
		const pnlValues = portfolio
			.map((item) => this.parseNumericValue(item.pnl))
			.filter((value): value is number => value !== null);

		if (pnlValues.length === 0) {
			return 0;
		}

		const inProfitCount = pnlValues.filter((value) => value > 0).length;

		return this.roundDecimal((inProfitCount / pnlValues.length) * 100);
	}

	private computeHoldingCategoryPercent(
		tokenCategories: WalletTokenCategoryMetricsResponse,
		category: TokenCategory,
	): number {
		const holdingsByCategory = tokenCategories.currentHoldingsByCategory;
		const totalHoldingsUsd = Object.values(holdingsByCategory).reduce(
			(total, value) => total + value,
			0,
		);

		if (totalHoldingsUsd <= 0) {
			return 0;
		}

		return this.roundDecimal(
			((holdingsByCategory[category] ?? 0) / totalHoldingsUsd) * 100,
		);
	}

	private countHoldingCategories(
		tokenCategories: WalletTokenCategoryMetricsResponse,
	): number {
		return Object.values(tokenCategories.currentHoldingsByCategory).filter(
			(value) => Number.isFinite(value) && value > 0,
		).length;
	}

	private computeLargestHoldingCategoryPercent(
		tokenCategories: WalletTokenCategoryMetricsResponse,
	): number {
		const holdingsByCategory = Object.values(
			tokenCategories.currentHoldingsByCategory,
		).filter((value) => Number.isFinite(value) && value > 0);

		if (holdingsByCategory.length === 0) {
			return 0;
		}

		const totalHoldingsUsd = holdingsByCategory.reduce(
			(total, value) => total + value,
			0,
		);

		if (totalHoldingsUsd <= 0) {
			return 0;
		}

		return this.roundDecimal((Math.max(...holdingsByCategory) / totalHoldingsUsd) * 100);
	}

	private countUniquePortfolioTokens(portfolio: WalletPortfolioItem[]): number {
		return new Set(
			portfolio.map((holding) =>
				holding.contractAddress?.toLowerCase() ??
				holding.token.trim().toLowerCase(),
			),
		).size;
	}

	private parseNumericValue(value: string | null | undefined): number | null {
		if (value === null || value === undefined || value.trim() === '') {
			return null;
		}

		const parsed = Number(value);

		return Number.isFinite(parsed) ? parsed : null;
	}

	private formatUsd(value: number): string {
		if (!Number.isFinite(value)) {
			return '$0';
		}

		const maximumFractionDigits = Math.abs(value) >= 100 ? 0 : 2;

		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits,
		}).format(value);
	}

	private formatPercent(value: number): string {
		return `${this.roundDecimal(value)}%`;
	}

	private formatNumber(value: number): string {
		return `${this.roundDecimal(value)}`;
	}

	private formatHours(value: number): string {
		return `${this.roundDecimal(value)}h`;
	}

	private formatDays(value: number): string {
		return `${this.roundDecimal(value)}d`;
	}

	private clampScore(score: number): number {
		return this.roundDecimal(Math.min(100, Math.max(0, score)));
	}

	private roundDecimal(value: number): number {
		return Math.round((value + Number.EPSILON) * 100) / 100;
	}
}