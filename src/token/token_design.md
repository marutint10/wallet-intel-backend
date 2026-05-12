# Token System Design

This document explains the token module as it exists today.

It should be treated as a living architecture note.
If token behavior changes, this file should be updated in the same task.

## 1. What we built so far

The token module currently has two layers:

1. wallet-level lite analytics (transfers -> features -> classification -> score)
2. token-level holder intelligence (top holders -> holder analytics -> aggregate token report)

Current capabilities:

- fetch top token holders from Chainbase
- fetch wallet ERC-20 transfer history from Etherscan (ethereum, polygon)
- fetch wallet ERC-20 transfer history from Alchemy (base, bsc)
- fetch wallet native gas-token balance (ETH / BNB / POL) via Alchemy eth_getBalance
- normalize transfer direction and amounts into one lite transfer format
- detect swap-like behavior from transfer groups inside the same transaction hash
- compute behavioral features from transfers (hold times, burstiness, category exposure, activity)
- in FAST_MODE: skip FIFO matching in favor of an O(N) per-token hold-duration estimator plus four derived features (walletAgeDays, daysSinceLastActivity, activityConsistencyScore, portfolioConcentrationScore)
- classify wallet behavior into lite archetypes with cadence + portfolio-mix signals (PnL boost is opportunistic, never required)
- score wallet quality on a fixed 0-100 scale with confidence and band; profitability dimension is optional and weights redistribute when PnL is absent
- aggregate analyzed holder results into token-level quality/distribution/risk callouts
- attach current USD price and per-holder usdValue to holder rows
- compute portfolio context for top holders via Alchemy balances + native balance + batch pricing
- batch price portfolio holdings via DefiLlama (primary) with CoinGecko fallback only for misses; every batch fetch has a 10s AbortController timeout and structured error logging
- compute lite realized PnL from detected swaps and feed profitability into classification/scoring (active only when FAST_MODE is disabled)
- run full token analysis asynchronously and persist output in Postgres with reliably populated tokenName / tokenSymbol metadata
- expose polling endpoints to fetch analysis status and final result
- provide an advanced token intelligence service for holder labeling, team-link detection, and richer token metadata collection

Important boundary:

- the new token analytics stack is self-contained in the token module and does not import the wallet module runtime path

## 2. Architecture

### TokenController

File: src/token/token.controller.ts

Owns HTTP routes under /token.

Responsibilities:

- expose debug and verification endpoints for each lite stage
- expose production async analysis start endpoint
- expose polling endpoint for persisted analysis results

### TokenAnalysisService (orchestrator)

File: src/token/services/token-analysis.service.ts

This is the production pipeline coordinator.

Responsibilities:

- initialize/refresh token_analyses row with status=processing
- run analysis in background without blocking request thread
- fetch top holders for the token
- fetch current token price once per analysis
- analyze holders in batches with delays (rate-limit friendly)
- enrich holder rows with usdValue, top-holder portfolio context, and (when not FAST_MODE) lite PnL summaries
- aggregate holder-level analytics into token-level metrics
- persist status done/error and payload into token_analyses, including defensively-nullable tokenName / tokenSymbol

FAST_MODE constant:

- declared at the top of the file as `const FAST_MODE = true`
- when true, the orchestrator passes FAST_MODE_TRANSFER_LIMIT (50) to the ingestion service, sets `fastMode = true` on LiteFeatureService, bypasses LitePnlService and historical pricing entirely, and emits `pnl: null` on every holder row
- flipping to `false` restores the full historical analysis path; LitePnlService remains wired up so no other code changes are needed
- emits per-wallet timing line: `[timing] wallet=... transfers_ms=... features_ms=... classify_ms=... fastMode=...`

Metadata persistence:

- computes `persistedTokenName = tokenMetadata?.name ?? null` and `persistedTokenSymbol = tokenMetadata?.symbol ?? null` before the final update
- emits `[token-analysis] persist metadata symbol=... name=...` debug log immediately before save
- final `tokenRepo.update` is wrapped in try/catch; persistence errors are logged at error level and rethrown so the outer catch sets status=error with errorMessage

Status lifecycle:

- processing: set immediately when analysis starts
- done: set after successful pipeline completion and save
- error: set when any uncaught pipeline failure occurs (including persistence failure)

### ChainbaseService

File: src/token/services/chainbase.service.ts

Responsibilities:

- map chain alias to Chainbase chain_id
- fetch top holders (paginated, currently first two pages)
- provide holder rows with walletAddress, balance, rank

Notes:

- supports: ethereum, polygon, bsc, base
- if CHAINBASE_API_KEY is missing, returns empty holders and logs warning

### LiteIngestionService

File: src/token/services/lite-ingestion.service.ts

Responsibilities:

- choose provider by chain:
  - Etherscan v2 for ethereum/polygon
  - Alchemy asset transfers for base/bsc
- normalize provider payloads into LiteTransfer shape
- compute direction IN/OUT based on target wallet
- fetch ERC-20 token balances for portfolio context via Alchemy getTokenBalances
- fetch native gas-token balance via Alchemy eth_getBalance (`getNativeBalance` method); returns `{ balanceWei, balanceFormatted, symbol }` and NEVER throws

Public API:

- `getRecentTransfers(walletAddress, chain, limit = 200, fastMode = false)` - when `fastMode` is true, the limit is capped to `FAST_MODE_TRANSFER_LIMIT` (50) and no pagination into older history occurs
- `getTokenBalances(walletAddress, chain)` - ERC-20 balances via Alchemy
- `getNativeBalance(walletAddress, chain)` - returns `{ balanceWei: string, balanceFormatted: number, symbol: string }`, chain->symbol map: ethereum/base->ETH, bsc->BNB, polygon->POL

Constants:

- `FAST_MODE_TRANSFER_LIMIT = 50` (exported) - the B2B holder-intelligence transfer cap

Notes:

- if provider API key is missing, returns empty transfer list and logs warning
- unsupported chain throws an error from `getRecentTransfers` but `getNativeBalance` returns a zero-balance result instead so portfolio generation never breaks
- emits `[timing] transfers walletAddress=... chain=... fastMode=... limit=... count=... duration_ms=...` debug log per `getRecentTransfers`
- emits `[timing] native_balance wallet=... chain=... duration_ms=...` debug log per `getNativeBalance` from a finally block so failure paths are still measured

### LiteFeatureService

File: src/token/services/lite-feature.service.ts

Responsibilities:

- detect swaps by grouping transfers per txHash
- expose normalized swap rows for PnL reconstruction
- require both IN and OUT legs, and different token contracts, to mark as swap
- compute behavior metrics:
  - activity (swap count, span, trades/day, avg gaps, burstiness)
  - hold-time stats (median + buckets)
  - token preference mix (memecoin/bluechip/stablecoin)
  - portfolio diversity placeholders (holding token count, chain count)

Public API:

- `extractFeatures(transfers, walletAddress, chain, holdingTokenCount?, holdingChainCount?, holdingsProfile?, fastMode = false)`
- `extractSwaps(transfers, walletAddress)` - unchanged, used only when FAST_MODE is disabled (for PnL input)

Hold-time strategy depends on fastMode:

- `fastMode = false` (default): full FIFO lot matching via `computeHoldTimes` over detected swap pairs - produces accurate per-position hold durations and `matchedLotCount`
- `fastMode = true`: O(N) per-token first/last-seen span estimator (`estimateLightweightHoldHours`) plus a round-trip-token proxy for `matchedLotCount` (`countRoundTripTokens`) - tolerates truncated transfer history and avoids the O(swaps * tokens) FIFO work

Derived features (always populated when transfers exist):

- `walletAgeDays` - seconds since oldest observed transfer, in days
- `daysSinceLastActivity` - seconds since newest observed transfer, in days
- `activityConsistencyScore` (0-100) - derived from burstiness + sustained-span signals; higher means steadier cadence
- `portfolioConcentrationScore` (0-100) - derived from max weight across trackedTokenWeight + topHoldings
- `fastModeApplied` - boolean flag echoed on the feature vector so downstream consumers can detect which path produced the row

Notes:

- token categories now come from src/token/constants/token-categories.ts via classifyTokenCategory(contractAddress, symbol)
- existing feature vector fields are preserved; the additions above are additive only

### Token Category Constants

File: src/token/constants/token-categories.ts

Responsibilities:

- centralize token category lookup by contract address and symbol fallback
- expose a single classifyTokenCategory(contractAddress, symbol) canonical entry point
- define token categories: bluechip, defi, meme, ai, gaming, infrastructure, stablecoin, rwa, other

Used by:

- LiteFeatureService for category-exposure percentages
- LitePortfolioService for topHolding category labels

### LiteClassifierService

File: src/token/services/lite-classifier.service.ts

Responsibilities:

- classify feature vector into archetypes:
  - Diamond Hand
  - Swing Trader
  - Day Trader
  - Degen
  - Bot / Automated
  - Accumulator
  - Whale
- return primary/secondary type, confidence, and human-readable reasoning
- portfolio-aware classification signals when HoldingsProfile data is available
- Degen is boosted by high meme allocation, extreme tracked-token concentration, and high portfolioConcentrationScore
- Diamond Hand and Accumulator are boosted by bluechip-heavy, diversified portfolios; Diamond Hand also boosted by walletAgeDays >= 365 with daysSinceLastActivity <= 60
- Bot / Automated is boosted by high activityConsistencyScore combined with tradesPerDay > 3
- PnL boosts (Smart Money, Paper Hand) apply opportunistically only when realized trades are available; they are NEVER required for a classification
- all portfolio signals are optional and skipped gracefully when holdings data is unavailable

Gating:

- returns Insufficient Data only when `swapCount < 3` and no usable PnL is available (matchedLotCount is no longer part of the gate so FAST_MODE wallets without FIFO still classify)

Confidence:

- driven by `swapCount`, `totalTransfers`, and `walletAgeDays` plus the score gap between primary and secondary archetype
- matchedLotCount is no longer required for high confidence

### LiteScorerService

File: src/token/services/lite-scorer.service.ts

Responsibilities:

- compute a 0-100 score from weighted dimensions:
  - consistency
  - riskManagement
  - portfolioQuality
  - experience
  - activity
  - profitability (OPTIONAL - only contributes when PnL data is available)
- return score band and confidence
- portfolioQuality uses real holdings data when available: diversification score, category quality (bluechip+defi+infrastructure allocation), stablecoin reserve bonus, token-count balance, and concentration penalty
- riskManagement includes a small portfolio risk signal adjustment (conservative/balanced bonus, degen penalty)
- consistency and activity dimensions use `Math.max(matchedLotCount, swapCount)` (or `swapCount/2` for activity) so FAST_MODE wallets without FIFO still earn full points from raw swap evidence
- falls back to placeholder-based scoring when holdings data is unavailable (typically rank 51-100)

Profitability redistribution (no-PnL path):

- when pnl is null, the profitability dimension contributes 0 and the formula `(rawTotal / maxRawTotal) * 100` redistributes the missing 30 points proportionally across consistency / riskManagement / portfolioQuality / experience / activity
- final score still spans the full 0-100 range

Bands:

- 90-100: Elite Smart Money
- 75-89: Strong Trader
- 60-74: Good Trader
- 40-59: Average
- 0-39: Weak / Risky

Gating:

- returns Insufficient Data when swapCount < 3 (matchedLotCount is no longer in the gate)

Confidence:

- driven by `swapCount`, `totalTransfers`, and `walletAgeDays`; NEVER reduced because PnL is missing

### HolderAggregationService

File: src/token/services/holder-aggregation.service.ts

Responsibilities:

- compute quality metrics from analyzed holders
- compute distribution metrics (holder buckets, top concentration, gini)
- compute category-split concentration metrics for eoaHolders, teamLinked, exchanges, contractsAndPools, vestingLocked, burnDead, and dust
- generate risk/positive/info callouts
- add callouts for low retail holder concentration and high-confidence team detection
- breakdown now separates bots (confirmed Bot / Automated classification) from unclassified (insufficient swap data for behavioral classification)
- Bot Activity Detected callout only fires for confirmed automated trading patterns, not wallets with insufficient data
- Limited Trading Data Available info callout fires when more than 50% of analyzed EOA holders lack swap history (common for transfer-heavy tokens)
- avgScore and qualityLabel are computed from scored holders only (score > 0), excluding Insufficient Data wallets from score averaging

Output families:

- qualityMetrics
- distribution
- riskCallouts
- categoryConcentration (inside qualityMetrics)

### DashboardSummaryService

File: src/token/services/dashboard-summary.service.ts

Layer: PRESENTATION ONLY. Sits on top of TokenAnalysisService output. Does NOT run analytics, does NOT touch the database, does NOT mutate analysis payloads, and does NOT change any existing API response shapes.

Purpose:

- transform a persisted `TokenAnalysisEntity` into a frontend-friendly DTO that powers the V1 B2B token intelligence dashboard
- give the frontend a single payload it can render without re-deriving anything (avgScore formatting, sentiment, holder-table shortening, breakdown percentages)
- keep dashboard concerns (formatting, sentiment, summary cards) out of the analytics engine so each layer evolves independently

Boundary rules:

- never throws on missing / partial / null analytics fields - degrades to `0`, `null`, `'Unknown'`, or empty arrays
- never re-computes analytics (no Gini, no PnL, no classification) - only re-shapes what is already in `qualityMetrics`, `distribution`, `holdersData`, and `riskCallouts`
- never persists anything - pure function over the entity

Public API:

- `buildDashboardSummary(analysis: TokenAnalysisEntity): DashboardSummaryResponse` - the single entry point

DashboardSummaryResponse shape (high level):

- `token` - contract, chain, token name/symbol/price (best-effort, may be null)
- `summaryCards` - 6 dashboard cards: Avg Holder Score, Smart Money Wallets, Top 10 Concentration, Decentralization Score, Team Allocation, Exchange Allocation. Each card has title, value, optional subtitle, optional sentiment (`positive` / `neutral` / `warning`)
- `holderQuality` - flat numeric summary (avgScore, qualityLabel, smartMoneyPct, convictionPct, activeTraderPct, degenPct, botPct)
- `holderQualityBreakdown` - per-archetype percentages of analyzed EOAs (diamondHands, accumulators, swingTraders, dayTraders, degens, bots, unclassified), all rounded to whole numbers
- `distribution` - flattened distribution summary (decentralizationScore, giniCoefficient, top10Pct, top50Pct, top100Pct)
- `holderTable` - `{ total, rows }` with ALL analyzed holders sorted by rank ascending. No 100-holder cap. Frontend pagination, filtering, and sorting are expected to run client-side
- `riskCallouts` - the existing `RiskCallout[]` from analytics, surfaced as-is

Sentiment rules (summary cards):

- positive: avgScore >= 75, decentralizationScore >= 70, smartMoneyPct >= 25
- warning: top10Pct >= 50, team allocation >= 25, exchange allocation >= 40, botPct >= 15
- otherwise: neutral

Smart money percentage:

- PRIMARY: when `qualityMetrics.pnlAggregation.smartMoneyCount > 0`, returns `round(smartMoneyCount / totalAnalyzedEOAs * 100)`
- FALLBACK: when no PnL data is available (FAST_MODE), returns `round(eoaHoldersWithScore>=75 / totalAnalyzedEOAs * 100)`

Holder table row mapping:

- `shortAddress`: 0x1234...cdef format via `shortenAddress`
- `balanceUsd`: `holder.usdValue ?? 0`
- `percentSupply`: derived from `holder.balance / qualityMetrics.totalSupply` when both are parseable, otherwise `0`
- `classification` / `confidence`: from `holder.classification` with null-safety
- `score`: `holder.score?.score ?? null`
- `portfolioRisk`: `holder.portfolio?.portfolioRiskSignal ?? null`
- `lastActiveDays`: `holder.features?.daysSinceLastActivity ?? null` (currently always null because features are not persisted on holder rows; included as forward-compatible)

Pure helper functions (all exported and unit-test friendly):

- `shortenAddress(address)`
- `formatPercent(value, digits = 1)`
- `safeNumber(value, fallback = 0)`
- `safeNumberOrNull(value)`
- `buildSummaryCards(...)`
- `computeHolderQualityBreakdown(...)`
- `buildDistributionSummary(...)`
- `formatUsd(value)`

Defensive contract:

- tolerates missing `qualityMetrics`, missing `distribution`, missing `pnlAggregation`, missing `teamDetection`, missing `holdersData`, missing `riskCallouts`
- tolerates partial holder rows (no classification, no score, no portfolio, no features)
- tolerates JSONB type-coerced values (numeric strings, null fields)
- defaults: `0` for numbers, `null` for nullable numbers, `'Unknown'` for missing labels, `[]` for missing collections

Wiring:

- registered in `TokenModule` providers
- no controller endpoints exposed yet (intentionally - this is plumbing for a future `/token/:address/dashboard` endpoint)
- does not import analytics services at runtime; only depends on the `TokenAnalysisEntity` shape and the existing `RiskCallout` type, so it carries no circular-dependency risk

### TokenModule wiring

File: src/token/token.module.ts

Registered providers:

- ChainbaseService
- LiteIngestionService
- LiteFeatureService
- LiteClassifierService
- LiteScorerService
- LitePricingService
- LitePortfolioService
- LitePnlService
- WalletFilterService
- HolderAggregationService
- TokenAnalysisService
- TokenIntelligenceService
- DashboardSummaryService

Registered entities:

- TokenAnalysisEntity
- TrackedTokenEntity
- WhaleSnapshotEntity
- WhaleAlertEntity

## 3. End-to-end flows

### A) Wallet lite pipeline (debug path)

1. fetch transfers for wallet
2. extract feature vector
3. classify feature vector
4. score feature vector

Exposed by:

- GET /token/wallet/:address/transfers
- GET /token/wallet/:address/features
- GET /token/wallet/:address/classify
- GET /token/wallet/:address/score

### B) Token async analysis pipeline (production path)

1. client calls POST /token/analyze with contractAddress + optional chain
2. service upserts token_analyses row as processing
3. background run starts:
   - fetch top holders (target 100)
   - TokenIntelligenceService labels every holder + runs team-detection
   - process EOA holders in batches (default size 5, delay 1500ms)
   - for each holder (FAST_MODE on): recent transfers (capped at 50) -> portfolio context including native bag -> features -> classification -> score, with `pnl = null`
   - for each holder (FAST_MODE off): recent transfers -> portfolio context -> features -> swaps -> realized PnL -> classification -> score, with full pnl summary
   - aggregate holder outputs into quality/distribution/callouts
   - upsert final analysis row with `tokenName` / `tokenSymbol` and status=done
4. client polls GET /token/:address?chain=... until done/error

Current runtime notes:

- production orchestrator uses TokenIntelligenceService for holder labeling, team detection, and token metadata before running lite analysis on EOA holders
- non-EOA holders (exchanges, contracts, burn, etc.) skip transfer fetch and classification but still appear in `holders_data` with labels and label evidence

Failure behavior:

- per-holder failures are tolerated (holder recorded with null classification/score)
- pipeline-level failures set status=error and errorMessage

## 4. API surface

### GET /token/:address/holders?chain=ethereum

Purpose:

- verify Chainbase holder fetch

Response:

- contractAddress
- chain
- totalHolders
- holders (top 20 preview from fetched set)

### GET /token/wallet/:address/transfers?chain=ethereum

Purpose:

- inspect normalized lite transfers

### GET /token/wallet/:address/features?chain=ethereum

Purpose:

- inspect extracted feature vector

### GET /token/wallet/:address/classify?chain=ethereum

Purpose:

- inspect classification and reasoning

### GET /token/wallet/:address/score?chain=ethereum

Purpose:

- inspect score and classification together

### POST /token/analyze

Purpose:

- start async token analysis

Body:

- contractAddress (required)
- chain (optional, defaults to ethereum)

Returns:

- id
- contractAddress
- chain
- status (processing)
- message with polling instruction

### GET /token/:address?chain=ethereum

Purpose:

- fetch current analysis state/result

Returns:

- not_found response when no row exists
- token_analyses row when present (processing/done/error)

### GET /token/:address/dashboard?chain=ethereum

Purpose:

- frontend-ready dashboard payload
- transforms the persisted `TokenAnalysisEntity` into a `DashboardSummaryResponse` via `DashboardSummaryService`
- intended for V1 B2B dashboard UI consumption
- intentionally avoids exposing raw analytics internals (no `holdersData` blob, no `qualityMetrics` blob) to frontend consumers

Implementation:

- reuses the same `TokenAnalysisService.getResult(address, chain)` lookup as `GET /token/:address` (no extra DB queries)
- the controller does NOT run analytics; transformation lives entirely in `DashboardSummaryService`
- emits structured debug log `[token-dashboard] build contract=... chain=...` immediately before transformation
- emits structured error log `[token-dashboard] transformation_failed contract=... chain=... error=...` on any unexpected throw from the summary service; the HTTP response never includes the underlying message

Response behavior:

- HTTP 404 with `{ status: 'not_found', message: 'No analysis found for token' }` when no analysis row exists for `(contractAddress, chain)`
- HTTP 200 with a lightweight processing payload when the row exists but `status !== 'done'`:
  - `{ status, contractAddress, chain, updatedAt }`
  - no dashboard transformation is attempted
  - frontend should poll the same endpoint until status becomes `done`
- HTTP 200 with the full `DashboardSummaryResponse` when `status === 'done'`
- HTTP 500 with `{ status: 'error', message: 'Failed to build dashboard response' }` if the summary service unexpectedly throws (defensive; in practice `DashboardSummaryService` is built to never throw)

Pagination / filtering / sorting:

- not implemented server-side. `holderTable` always returns every analyzed holder. Client-side handles pagination, sorting, and filtering.

## 5. Data model and migrations

Migration files:

- migrations/202605060001_create_token_tables.sql
- migrations/202605060003_add_token_name_symbol.sql (idempotent guard for token_name / token_symbol columns; widens token_symbol to VARCHAR(32) on legacy DBs)

Created tables:

- token_analyses
- tracked_tokens
- whale_snapshots
- whale_alerts

Primary runtime table today:

- token_analyses (used by TokenAnalysisService)

Entity files:

- src/token/entities/token-analysis.entity.ts
- src/token/entities/tracked-token.entity.ts
- src/token/entities/whale-snapshot.entity.ts
- src/token/entities/whale-alert.entity.ts

Current usage status:

- tracked_tokens, whale_snapshots, whale_alerts are scaffolded and mapped but not yet actively written by current endpoints

## 6. Configuration

Current required keys for token pipeline:

- CHAINBASE_API_KEY
- ETHERSCAN_API_KEY (ethereum, polygon transfer ingestion + token-intelligence contract lookups)
- ALCHEMY_API_KEY (base/bsc transfer ingestion + ERC-20 balances + native gas-token balance via eth_getBalance on all four chains)
- DATABASE_URL

Optional tuning keys:

- TOKEN_ANALYSIS_BATCH_SIZE (default 5)
- TOKEN_ANALYSIS_BATCH_DELAY_MS (default 1500)

Current .env.example already includes:

- CHAINBASE_API_KEY
- ETHERSCAN_API_KEY
- DATABASE_URL

Manual note:

- add ALCHEMY_API_KEY to your local env; without it ERC-20 balances and native balances both fall back to safe-empty results, and base/bsc transfer ingestion is disabled

## 7. How analysis persistence works

The orchestrator saves output into token_analyses JSONB and scalar columns:

- token_name / token_symbol: nullable scalar columns, written defensively (`tokenMetadata?.name ?? null` / `tokenMetadata?.symbol ?? null`) so partial metadata responses never block status=done
- total_holders: count of holders that were enriched
- holders_data: per-holder analyzed rows (classification + score)
- quality_metrics: aggregated holder quality metrics plus tokenPriceUsd, priceSource, and PnL aggregation
- distribution: concentration/distribution metrics
- risk_callouts: generated token-level insights

Defensive write path:

- emits `[token-analysis] persist metadata symbol=... name=...` debug log immediately before the final `tokenRepo.update`
- the `update` call is wrapped in try/catch; on failure the orchestrator logs at error level and rethrows so the outer `runAnalysis` catch sets status=error with errorMessage
- the schema is verified by `scripts/verify-token-metadata-schema.js` which prints column info and the latest 10 rows

TypeORM note:

- JSONB upsert payloads are typed through deep-partial types; the current implementation uses explicit deep-partial casting for quality/distribution payload assignment

## 8. Operational behavior

Rate limiting safeguards:

- Chainbase top holders fetch uses page requests with a delay between pages
- TokenAnalysisService holder analysis is batched with inter-batch delay

Resilience behavior:

- missing API keys return safe empty lists where appropriate
- individual holder failures do not abort full token analysis
- terminal failures are captured in errorMessage

## 8a. FAST_MODE (B2B holder-intelligence path)

Status: enabled by default. Set `FAST_MODE = false` in `src/token/services/token-analysis.service.ts` to restore the full historical analysis path.

When FAST_MODE is true:

- transfer history is capped at `FAST_MODE_TRANSFER_LIMIT` (50) most-recent ERC-20 transfers per wallet, no pagination into older history
- LitePnlService is bypassed entirely and `pnl` is `null` on every holder row
- no historical pricing calls are made (LitePnlService is the only consumer of historical prices)
- LiteFeatureService swaps the O(swaps * tokens) FIFO matcher for an O(N) per-token first/last-seen span estimator (`estimateLightweightHoldHours`) and a round-trip-token proxy for `matchedLotCount` (`countRoundTripTokens`)
- LiteFeatureService also populates four derived features: `walletAgeDays`, `daysSinceLastActivity`, `activityConsistencyScore` (0-100), `portfolioConcentrationScore` (0-100), plus a `fastModeApplied: true` flag

Classifier and scorer behavior under FAST_MODE:

- classification gate is now `swapCount < 3` only (matchedLotCount is no longer required)
- classifier consumes cadence, category mix, tracked-token concentration, diversification score, portfolio risk signal, and the new derived features
- classifier and scorer confidence are now driven by `swapCount`, `totalTransfers`, and `walletAgeDays` instead of `matchedLotCount`
- profitability dimension is optional: when `pnl` is null the weight redistributes proportionally across consistency/risk/portfolio/experience/activity so scores still span the full 0-100 range
- final-score confidence is NOT downgraded just because PnL is missing

Response shape is preserved:

- `AnalyzedHolder.pnl` may now be `null` for all holders; HolderAggregationService already tolerates this (callouts depending on PnL aggregation simply do not fire)
- `LiteFeatureVector` gains 4 new fields plus `fastModeApplied`; existing fields are unchanged

Per-wallet timing instrumentation:

- LiteIngestionService logs `[timing] transfers ... duration_ms=...` per `getRecentTransfers` call
- TokenAnalysisService logs `[timing] wallet=... transfers_ms=... features_ms=... classify_ms=...` per holder
- log level is debug

LitePnlService is intentionally still registered in TokenModule and untouched in code; flipping FAST_MODE is a single-constant change.

## 9. Current limitations and known gaps

- only first two Chainbase pages are currently fetched
- wallet-level holdingTokenCount and holdingChainCount in features are placeholders unless provided by caller
- tracked token scheduling and whale alert execution logic is not implemented yet
- portfolio holdings are capped at the top 50 holders for API-cost control
- ERC-20 transfers truncated to FAST_MODE_TRANSFER_LIMIT (50) most recent per wallet while FAST_MODE is enabled (this is a deliberate B2B trade-off, not a defect - see section 8a)
- LitePnlService is bypassed while FAST_MODE is enabled (deliberate, not a defect; flipping `FAST_MODE = false` restores it without any other changes)
- native gas-token balance is fetched per chain only (no cross-chain aggregation); native pricing failures cause the native bag to be skipped silently

## 10. How to run and verify

### Apply migrations

Run in order:

- `node scripts/run-sql-migration.js migrations/202605060001_create_token_tables.sql`
- `node scripts/run-sql-migration.js migrations/202605060003_add_token_name_symbol.sql`

### Verify schema

- `node scripts/verify-token-metadata-schema.js` prints `token_name` / `token_symbol` column info plus the latest 10 token_analyses rows

### Start analysis

1. POST /token/analyze with contractAddress and optional chain
2. poll GET /token/:address?chain=... until status is done or error

### Debug each stage quickly

1. GET /token/:address/holders
2. GET /token/wallet/:address/transfers
3. GET /token/wallet/:address/features
4. GET /token/wallet/:address/classify
5. GET /token/wallet/:address/score

### Inspect pricing / FAST_MODE log lines

Watch the dev-server console while an analysis runs for these structured log prefixes:

- `[defillama-batch] request requestedCount=... url=...` and matching `[defillama-batch] response requestedCount=... returnedCount=... elapsed_ms=...`
- `[defillama-batch] timeout | network_error | http_error | parse_error ...` on failures (HTTP errors include `status=` and `bodyPreview=...`)
- `[coingecko-batch] http_error | timeout | network_error url=... ...` only for tokens DefiLlama did not price
- `[dexscreener] request url=... timeout_ms=...` and `[dexscreener] response url=... status=... ok=... elapsed_ms=...`
- `[dexscreener] timeout | network_error | http_error | parse_error | no_matching_pairs | invalid_price ...` on failures
- `[timing] transfers walletAddress=... duration_ms=...` per ingestion call
- `[timing] native_balance wallet=... chain=... duration_ms=...` per native balance call
- `[timing] wallet=... transfers_ms=... features_ms=... classify_ms=... fastMode=...` per analyzed holder
- `[token-analysis] persist metadata symbol=... name=...` immediately before the final DB save
- `[portfolio] native holding added wallet=... symbol=... usdValue=...` when a native bag clears the $1 minimum

## 11. Pipeline Upgrades (Post-MVP)

### LitePricingService

File: src/token/services/lite-pricing.service.ts

Single-price path (`getTokenPrice`):

- DexScreener primary, CoinGecko fallback
- DexScreener call has a 10s `AbortController` timeout and emits structured log lines on every outcome: `[dexscreener] request | response | timeout | network_error | http_error | parse_error | no_matching_pairs | invalid_price | success`
- HTTP errors include `status=`, `statusText=`, and `bodyPreview=` (first 200 chars, single-line)
- 5-minute in-memory `priceCache`

Batch-price path (`getBatchPrices`):

- PRIMARY: DefiLlama batch current prices at `https://coins.llama.fi/prices/current/<chain:address,...>`; supports cross-chain in one call, chunked at 50 entries per request
- chain prefix map for DefiLlama: ethereum, polygon, bsc, base (each is its own prefix)
- FALLBACK: CoinGecko per-chain chunks of 100 with 2s inter-chunk sleep, called ONLY for addresses DefiLlama did not price
- every batch fetch (DefiLlama and CoinGecko) wraps in its own 10s `AbortController` timeout, with `clearTimeout` in `finally`
- DefiLlama calls go through `waitForDefiLlamaSlot` (150ms minimum spacing) so they cooperate with `getHistoricalPrice` rate limiting
- DefiLlama hits are cached with `source: 'defillama'`; CoinGecko hits remain `source: 'coingecko'`
- structured log prefixes: `[defillama-batch] request | response | timeout | network_error | http_error | parse_error`, `[coingecko-batch] http_error | timeout | network_error`

Historical-price path (`getHistoricalPrice`):

- DefiLlama historical primary, CoinGecko market_chart/range fallback
- hour-rounded permanent in-memory `historicalPriceCache`
- 150ms minimum spacing between DefiLlama calls
- used by LitePnlService for swap-time valuation (only when FAST_MODE is disabled)

TokenPriceResult.source union:

- `'dexscreener' | 'coingecko' | 'defillama' | 'fallback'` - the `'defillama'` value was added so batch hits cache with accurate provenance

Used by: orchestrator holder USD values, portfolio service (including native-token pricing), PnL service

### LitePortfolioService

File: src/token/services/lite-portfolio.service.ts

- fetches full ERC-20 balances via Alchemy `getTokenBalances`
- prices holdings via `LitePricingService.getBatchPrices` (DefiLlama-primary, CoinGecko-fallback)
- produces a formalized HoldingsProfile with categoryAllocations (bluechip/defi/meme/ai/gaming/infrastructure/stablecoin/rwa/other), portfolioRiskSignal, and per-holding category labels
- computes: totalPortfolioUsd, trackedTokenWeight, diversificationScore
- uses centralized src/token/constants/token-categories.ts for classification
- HoldingsProfile is fetched BEFORE feature extraction for top 50 holders so portfolio signals feed into classification and scoring
- only runs for top 50 holders for API cost management
- native gas-token balances (ETH on ethereum/base, BNB on bsc, POL on polygon) are resolved via `LiteIngestionService.getNativeBalance` and priced via `LitePricingService.getTokenPrice` using known native-token proxy addresses (`0xeee...eee` for ETH, `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` for BNB, `0x0000000000000000000000000000000000001010` for POL). The native bag is pushed into `holdings` BEFORE the ERC-20 loop so it automatically participates in totalPortfolioUsd, trackedTokenWeight, categoryAllocations (bluechip), topHoldings, diversificationScore, and portfolioRiskSignal
- native pricing failures degrade silently (holding is skipped, the rest of the profile still builds); the legacy empty-balances early-return now also requires `!nativeHolding` so ETH-only wallets are no longer reported as empty portfolios
- emits `[portfolio] native holding added wallet=... symbol=... usdValue=...` debug log when a native bag clears the $1 minimum

### LiteFeatureService

File: src/token/services/lite-feature.service.ts

- feature vector includes optional holdings-based fields: `trackedTokenWeight`, `portfolioDiversificationScore`, `holdingCategoryMix`, `portfolioRiskSignal` (populated when HoldingsProfile is available, i.e. top 50 holders)
- feature vector also includes FAST_MODE-derived fields: `walletAgeDays`, `daysSinceLastActivity`, `activityConsistencyScore`, `portfolioConcentrationScore`, `fastModeApplied`
- see section 2 LiteFeatureService for the full public API + hold-time strategy details

### LitePnlService

File: src/token/services/lite-pnl.service.ts

- FIFO position lot reconstruction from detected swaps
- swap valuation priority: stablecoin-side first, DefiLlama historical second, CoinGecko historical third, current price last resort
- outputs: realized PnL, win rate, profit factor, ROI, largest win/loss
- feeds into classifier Smart Money/Paper Hand boosts (opportunistic) and the scorer profitability dimension (additive 0-30 points) when active
- matches wallet module's DefiLlama-first historical pricing strategy
- currently bypassed at runtime because `FAST_MODE = true` in TokenAnalysisService; the service stays wired in TokenModule so flipping FAST_MODE re-engages it without code changes

### WalletFilterService

File: src/token/services/wallet-filter.service.ts

- labels wallets before analysis: exchange, contract, lp_pool, bridge, burn, dust, eoa
- static lookup maps for ~25 known exchanges, ~10 known routers/contracts, and burn addresses
- eth_getCode check via Alchemy for unknown addresses
- only eoa wallets proceed through full analysis pipeline
- reduces API calls and eliminates Insufficient Data spam on exchange-heavy tokens

### TokenIntelligenceService

File: src/token/services/token-intelligence.service.ts

- introduced as the advanced pre-analysis intelligence layer (token-side only, no wallet-module imports)
- provides richer holder labels:
  - eoa, exchange, cex_deposit, dex_router, dex_pool, bridge, burn, vesting, treasury, staking, generic_contract, deployer, owner, team_connected, dust
- provides token metadata collection from multiple sources:
  - DexScreener (pair liquidity, price context, fdv-derived supply estimate)
  - on-chain RPC reads via Alchemy (totalSupply, decimals, name, symbol, owner)
  - Etherscan contract creation lookup for deployer
  - CoinGecko fallback for missing metadata/supply fields
- provides team detection output:
  - seed-based link analysis from deployer/owner/treasury-connected controllers
  - transfer-counterparty scan (Etherscan) against top-holder set
  - team concentration risk scoring (low/medium/high/critical)
- includes internal caching:
  - eth_getCode contract detection cache
  - Etherscan contract-name cache
- degrades safely:
  - missing ALCHEMY_API_KEY: falls back to broad EOA labeling for unknown addresses
  - missing ETHERSCAN_API_KEY: skips deployer/sourcecode/team transfer scans
- evidence-based labeling: every holder classification includes labelConfidence (0-100), labelEvidence array with type/detail/weight/txHash/txCount, and teamConnectionScore (0-100)
- weighted team connection scoring: deployer transfers (0.9-0.98), owner transfers (0.85-0.92), treasury controllers (0.80), indirect counterparties (0.4-0.65), multi-signal boost
- team detection risk levels now factor in confidence: highConfidenceTeamPct drives critical/high thresholds instead of raw teamTotalPctOfSupply alone
- weak connections (teamConnectionScore < 30) are not marked as team-linked, preventing false positives from incidental interactions

Current integration status:

- service is registered in TokenModule
- TokenAnalysisService now invokes it as the active pre-analysis intelligence layer
