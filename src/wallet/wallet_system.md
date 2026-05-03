# Wallet System

This document explains the wallet module as it exists today.

It should be treated as a living architecture note.
If wallet behavior changes, this file should change in the same task.

## 1. What the wallet module does

The wallet module has three jobs:

1. ingest wallet history from external providers
2. normalize and store that history in Postgres
3. build analytics and portfolio views on top of normalized data

Current capabilities:

- support Ethereum, Base, BSC, and Polygon through a `chain` query parameter that defaults to `ethereum`
- fetch wallet transaction history from Moralis
- normalize ERC-20 and native chain activity into one internal format
- persist normalized transactions in Postgres
- serve stored normalized transactions
- classify normalized transactions as `transfer`, `swap`, `wrap`, `unwrap`, `liquidity_add`, `liquidity_remove`, `stake`, `unstake`, `staking_wrap`, `staking_unwrap`, `yield_split`, `yield_merge`, `receipt_mint`, `receipt_burn`, `protocol_transform`, `bridge_out`, `bridge_in`, `lending_deposit`, `lending_withdraw`, `borrow`, `repay`, `vault_deposit`, `vault_withdraw`, or `reward_claim`
- build trades from swap transactions
- attach historical prices to trades
- infer one missing swap-leg price from the priced counterpart trade
- calculate realized FIFO PnL metrics
- calculate token flow and net flow from stored transactions
- return live on-chain holdings via direct RPC using Multicall3 batched balance reads and a wallet-scoped known-token registry
- return live enriched portfolio analytics with per-asset display tier classification
- return DB-backed reconstructed balances as a ledger view
- return wallet summary metrics
- return wallet context classification before higher-level scoring
- return higher-level wallet behavior classification for trader and holder wallets
- return wallet risk metrics
- return wallet hold-time metrics from completed FIFO trade lots
- return wallet activity metrics from stored trade history
- return DEX router usage analytics from stored swap recipients
- return token category analytics from priced trades and current portfolio holdings
- return aggregated wallet features combining summary and analytics views
- return a V1 smart-money score using fixed bracket scoring on existing analytics outputs
- return unified intelligence responses with trust signals, pricing coverage, lifetime trade-volume metrics, and curated/visible portfolio slices

## 2. Current architecture

The wallet module is now split into focused services.

### WalletController

Owns the HTTP API under `/wallet`.

Responsibilities:

- validate EVM addresses
- validate and normalize supported chain aliases (`ethereum`, `base`, `bsc`, `polygon`)
- call the correct facade method
- return the response

The controller does not contain business logic.

### WalletService

This is a thin facade.

Responsibilities:

- expose a clean public service surface to the controller
- delegate ingestion calls to `WalletCoreService`
- delegate PnL calls to `WalletPnlService`
- delegate holdings, ledger, and portfolio calls to `WalletPortfolioService`
- delegate risk, hold-time, and activity analytics to `WalletAnalyticsService`
- delegate wallet archetype/context detection to `WalletContextService`
- run contract and operational triage through `WalletTriageService` before score and behavior classification endpoints
- delegate wallet behavior classification to `ClassificationService`
- delegate V1 smart-money scoring to `WalletScoringService`
- compose the unified wallet features response from existing service methods
- compose single-chain wallet intelligence responses across context, summary, metrics, score, classification, and portfolio surfaces
- shape intelligence payload verbosity by stripping or retaining reasoning fields depending on `verbose`
- cache explicit-chain `/wallet/:address/intelligence?chain=...` responses in-memory (chain+wallet+query keyed) with `5-minute` TTL to reduce repeated recomputation

### UnifiedIntelligenceService

This is the cross-chain composition layer for the flagship intelligence endpoint when no `chain` query parameter is supplied.

Responsibilities:

- fetch Ethereum, Base, BSC, and Polygon single-chain intelligence in parallel through `WalletService.getWalletIntelligence()`
- enforce a 45-second timeout per chain and return partial unified results when at least one chain succeeds
- merge visible holdings while preserving chain identity on each holding row
- aggregate summary, PnL, risk, hold-time, activity, portfolio, and cumulative PnL data across successful chains
- compute a unified score weighted by trading activity and portfolio value
- compute unified classification from the dominant trader chain, or by portfolio value for holder-only wallets
- generate a cross-chain AI narrative through `WalletAiService.generateUnifiedAnalysis()`
- cache unified results under `unified:{address}` for 24 hours

### WalletAnalyticsService

This is the wallet-level analytics layer.

Responsibilities:

- compute risk metrics from realized trade PnL and portfolio concentration
- compute hold-time metrics from completed FIFO buy/sell lot matches only
- compute activity metrics from chronologically ordered stored trades
- compute DEX router usage metrics from stored swap transaction recipients
- compute token category analytics from existing priced trade and portfolio methods
- expose reusable analytics methods for the facade and controller layer

### HybridHoldingsService

This is the live on-chain holdings layer.

Responsibilities:

- maintain per-chain ethers.js `JsonRpcProvider` instances from chain config/profile defaults
- read live native balance for the selected chain
- read live ERC-20 balances in batches of 150 via the Multicall3 contract at `0xcA11bde05977b3631167028862bE2a173976CA11`
- discover which ERC-20 tokens a wallet holds by consulting chain-scoped `wallet_known_tokens` rows
- fall back to a transaction scan when no `wallet_known_tokens` rows exist for the wallet, and backfill the table asynchronously
- maintain a 5-minute in-memory holdings cache per chain+wallet address
- sync `wallet_known_tokens` after ingestion when new transactions arrive via `syncKnownTokens()`
- expose `clearCache()` and `clearAllCache()` for targeted or global cache invalidation

### WalletContextService

This is the pre-scoring wallet context layer.

Responsibilities:

- reuse canonical triage output for contract subtype and operational non-trader routing
- classify whether the wallet qualifies as a trader from summary swap count
- infer bot-like subtype from activity metrics when no triage override is present
- return reasoning and confidence for downstream scoring decisions

### WalletTriageService

This is the contract-and-operational triage layer that runs before score and classification.

Responsibilities:

- detect smart contracts from on-chain bytecode (`eth_getCode`)
- classify contract wallets into `Vesting / Distribution`, `Treasury / Multisig`, `Exchange / Custody`, or `Unknown Contract`
- classify transfer-heavy EOAs with zero swaps as `Operational/Treasury` non-trader wallets
- return a triage payload: `walletType`, `walletSubtype`, `traderEligible`, `scorePath`, confidence fields, `score`, `scoreBand`, and `reasoning`
- short-circuit triaged wallets so trader scoring and trader archetype classification are skipped
- use a per-chain RPC provider pool for bytecode checks

### WalletScoringService

This is the V1 smart-money scoring layer.

Responsibilities:

- reuse existing context, summary, activity, risk, DEX, and token-category service methods
- apply score gate rules before scoring ineligible trader wallets
- score trader wallets across `traderWeightedROI`, `realizedPnLQuality`, `consistency`, `riskManagement`, `portfolioQuality`, `experience`, and `marketAdaptability`
- include legacy `profitability` in the score breakdown as `traderWeightedROI + realizedPnLQuality`
- score holder wallets across portfolio quality, conviction, portfolio size, and asset selection
- apply holder score scaling by portfolio size and liquidity-confidence filtering
- apply trader guardrails including gambler penalty plus weighted-ROI score/band hard caps
- return narrative `scoreExplanation` with positives, negatives, and summary
- return `balancesAvailable` so downstream consumers can distinguish empty holdings from unavailable live balances
- delegate confidence estimation to `WalletConfidenceService`
- return a structured score response with dimension breakdowns and explicit `scorePath` (`trader` or `holder`)

### WalletConfidenceService

This is the confidence estimation layer used by both score and classification responses.

Responsibilities:

- compute `confidenceScore` (`0-100`) and `confidenceLabel` (`low`, `medium`, `high`)
- return confidence reasoning for downstream explanation (`confidenceReasoning`)
- weight confidence dimensions as:
	- data quality `30%` (parsed transaction coverage + usable priced trade coverage)
	- wallet age `20%` (days since first stored transaction)
	- swap sample size `30%` (total swaps + active trading days)
	- signal consistency `20%` (hold-time stability, repeated behavior, activity variance)
- apply confidence label mapping: `0-39 = low`, `40-69 = medium`, `70-100 = high`

### ClassificationService

This is the higher-level behavior-classification layer.

Responsibilities:

- classify trader wallets into archetypes such as `Diamond Hand`, `Swing Trader`, `Day Trader`, `Rotation Trader`, `Meme Hunter`, `Bot / Automated`, `Accumulator`, and `Whale`
- classify holder wallets into archetypes such as `Diamond Hands`, `Blue Chip Maximalist`, `Diversified Holder`, `Stablecoin Parker`, `DeFi Strategist`, `Whale Holder`, and `Dust Wallet`
- fall back to `Empty Wallet` when live balances are unavailable or no positive-value holdings exist for non-trader wallets
- return a structured classification response with confidence, traits, risk profile, secondary types, and score breakdowns per archetype

### WalletCoreService

This is the ingestion and normalization layer.

Responsibilities:

- configure the Moralis client
- resolve Moralis chain ids from `src/shared/constants/chains.ts`
- rotate between up to two Moralis API keys on HTTP 401; mark exhausted keys for 1 hour before retrying
- log configured key count at startup
- fetch ERC-20 transfers and wallet history
- refresh only new blocks when DB data already exists
- scope all reads, inserts, and latest-block checks by `chain_id`
- normalize raw provider payloads into `NormalizedTransaction`
- classify each normalized transaction with a priority-ordered semantic rule set covering wraps, liquidity events, staking, yield split/merge, receipt mint/burn, protocol transforms, bridge flows, lending/vault flows, reward claims, transfer, and swap
- emit `debug`-level logs for key semantic detections keyed by transaction hash
- enforce a hard ingestion cap per wallet using `TX_FETCH_LIMIT` (default `1000`) during paginated provider fetches
- persist normalized transactions into Postgres; only non-`unknown` transactions are saved
- return stored normalized transactions
- expose transaction entities to downstream services
- build trade entries from normalized token amounts
- call `HybridHoldingsService.syncKnownTokens()` after each successful ingestion pass

### WalletPricingService

This is the pricing layer.

Responsibilities:

- fetch current ERC-20 prices from CoinGecko
- fetch current native-token USD price from CoinGecko
- fetch current token market signals by combining DefiLlama, DexScreener, and CoinGecko
- fetch historical trade prices from DefiLlama with CoinGecko fallback
- fetch historical transfer-in market prices from DefiLlama only
- infer one missing swap-leg price when the opposite side is priced
- cache historical prices in memory for 24 hours; cache live prices for 5 minutes
- deduplicate in-flight historical and live price requests so concurrent callers share one network call
- store negative-cache entries for confirmed no-data misses to avoid repeated failed lookups
- limit DefiLlama concurrency to 5 simultaneous requests with 100 ms inter-request spacing
- retry DefiLlama 429 responses with exponential backoff (2 s first retry, 4 s second retry, 2 retries maximum)
- apply provider-level circuit breakers (`defillama`, `coingecko`, `dexscreener`) with 30-second cooldown when 6 rate-limit hits occur within a 30-second window
- build CoinGecko, DefiLlama, and DexScreener requests from the selected chain profile
- scope live, historical, inferred-price, unsupported-token, and liquidity caches by chain where they can collide

### WalletPnlService

This is the realized trading analytics layer.

Responsibilities:

- build trades from stored swap transactions
- attach historical prices to trades
- compute realized FIFO PnL per token
- compute realized ROI, win rate, best trade, and worst trade
- expose completed FIFO matched trade lots for downstream analytics reuse
- compute wallet summary metrics from stored transactions and realized PnL
- classify profitable and losing tokens from realized PnL sign only, with zero-PnL tokens treated as neutral

### WalletPortfolioService

This is the holdings and portfolio analytics layer.

Responsibilities:

- fetch live raw holdings via `HybridHoldingsService`
- compute the live enriched portfolio view
- classify each portfolio item into a display tier using `PortfolioTierClassifier`
- compute the DB-backed reconstructed ledger view
- compute token flow and net flow from normalized history
- compute holding duration and cost basis analytics from FIFO lots
- compute current-price-based unrealized PnL and ROI
- enforce null `holdingSince`, `holdingDays`, `avgBuyPrice`, and ROI semantics when no transaction history is available

### PortfolioTierClassifier

This is a pure stateless classification module (`portfolio-tier.classifier.ts`).

Responsibilities:

- classify each portfolio item into one of four display tiers: `core`, `active`, `secondary`, or `hidden`
- compute a token quality score (`0-100`) and quality label (`visible`, `speculative`, `hidden`, or `spoofed_major_symbol`) from pricing, liquidity, trade history, spam signals, and trusted-token signals
- attach an optional `hiddenReason` string to items classified as `hidden`
- operate without side effects; accepts portfolio item fields and a set of traded token symbols as inputs

### Placeholder services

The following services still exist as placeholders for future architecture work:

- `PortfolioService`
- `PnlService`

They are registered in the module but are not the main runtime path for current wallet analytics.

## 3. Module wiring

`WalletModule` registers:

- `WalletController`
- `WalletAnalyticsService`
- `WalletContextService`
- `WalletCoreService`
- `WalletPricingService`
- `WalletPnlService`
- `WalletPortfolioService`
- `HybridHoldingsService`
- `WalletTriageService`
- `ClassificationService`
- `WalletScoringService`
- `WalletConfidenceService`
- `WalletService`
- the placeholder services listed above
- the TypeORM repository for `TransactionEntity`
- the TypeORM repository for `WalletKnownTokenEntity`

RPC providers are created inside `HybridHoldingsService` and `WalletTriageService` per supported chain.

## 4. Configuration

Current config values:

- `PORT`
- `MORALIS_API_KEY` or `MORALIS_API_KEY_1` — first Moralis API key (interchangeable; `MORALIS_API_KEY_1` takes precedence when both are set)
- `MORALIS_API_KEY_2` (or legacy fallback `MORALIS_API_URL_2`) — optional second Moralis API key for key rotation
- `COINGECKO_API_KEY`
- `ETH_RPC_URL`
- `BASE_RPC_URL`
- `BSC_RPC_URL`
- `POLYGON_RPC_URL`
- `DATABASE_URL`
- `DATABASE_SSL` (`1|true|yes|on` => enabled)
- `DATABASE_CONNECTION_TIMEOUT_MS`
- `TX_FETCH_LIMIT` (code constant in `src/config/constants.ts`, default `1000`)

Supported chain metadata is centralized in `src/shared/constants/chains.ts`.
The default chain is `ethereum`.
Moralis calls use the selected profile's Moralis chain id (`0x1`, `0x2105`, `0x38`, or `0x89`).

## 5. External providers and how we use them

### Moralis

Moralis is used for history ingestion and as a secondary live-balance fallback.

Current usage:

- ERC-20 transfers
- wallet history for native chain transfers
- fallback native and ERC-20 balances when `HybridHoldingsService` fails in portfolio/holdings loading

WalletCoreService rotates between two configured API keys.
When a key returns HTTP 401, it is marked exhausted for 1 hour before being retried.

### Direct RPC and Multicall3

Live on-chain balances are now fetched via direct per-chain `JsonRpcProvider` connections and the Multicall3 contract.

Current usage:

- native balance via `provider.getBalance()`
- ERC-20 balances batched through Multicall3 `aggregate3()` in groups of 150
- wallet bytecode lookup for `WalletTriageService` contract/EOA triage

### DefiLlama

DefiLlama is the primary historical pricing source.

Current usage:

- historical trade pricing
- historical market pricing for transfer-in lots
- live token price inputs for portfolio quality/pricing signal composition

### DexScreener

DexScreener is used as a market-signal source.

Current usage:

- live token price fallback signals for portfolio valuation when available
- per-token liquidity (`liquidityUsd`) used in portfolio quality and holder-score scaling filters

### CoinGecko

CoinGecko is used for:

- current ERC-20 USD prices
- current native-token USD price
- fallback historical trade pricing for supported trusted-major tokens when DefiLlama has no answer
- live token pricing fallback input for token market signals

## 6. Database model

The `transactions` table stores normalized wallet transactions.

Important stored fields:

- chain id (`ethereum`, `base`, `bsc`, or `polygon`)
- wallet address
- transaction hash
- block number
- timestamp
- from address
- to address
- type: one of `transfer`, `swap`, `wrap`, `unwrap`, `liquidity_add`, `liquidity_remove`, `stake`, `unstake`, `staking_wrap`, `staking_unwrap`, `yield_split`, `yield_merge`, `receipt_mint`, `receipt_burn`, `protocol_transform`, `bridge_out`, `bridge_in`, `lending_deposit`, `lending_withdraw`, `borrow`, `repay`, `vault_deposit`, `vault_withdraw`, `reward_claim` (`unknown` is not persisted)
- inputs: tokens leaving the wallet
- outputs: tokens entering the wallet

Important rules:

- one row per `chain_id + wallet_address + transaction_hash`
- duplicate inserts are ignored safely
- `inputs` and `outputs` are stored as JSONB arrays

Why we store normalized data:

- provider payloads are noisy and provider-specific
- normalized data is easier to reason about
- most analytics can run from stored history
- we can recover from temporary upstream failures

The `wallet_known_tokens` table stores the set of ERC-20 tokens a wallet has interacted with.

Important stored fields:

- chain_id
- wallet_address
- contract_address
- symbol
- decimals
- first_seen_at
- last_seen_at
- seen_count

Important rules:

- one row per `chain_id + wallet_address + contract_address`
- upserted from `syncKnownTokens()` after each ingestion pass
- `HybridHoldingsService` reads this table to know which ERC-20s to query balances for
- falls back to a transaction scan when no rows exist for the wallet, then backfills asynchronously

Schema changes are applied by `npm run db:migrate:chains`, which executes `migrations/202605030001_add_chain_id_to_wallet_tables.sql` against `DATABASE_URL`.

## 7. Core data model

### NormalizedTransaction

This is the internal transaction format used across the module.

- `inputs` means tokens leaving the wallet
- `outputs` means tokens entering the wallet
- `type` is inferred after normalization

### Trade

Trades are built only from normalized transactions of type `swap`.

- swap inputs become `SELL`
- swap outputs become `BUY`

Each trade includes:

- token
- trade type
- normalized amount
- decimals
- contract address
- unix timestamp

### PricedTrade

`PricedTrade` is a `Trade` plus a historical `price`.

## 8. Current endpoint map

All wallet endpoints accept an optional `chain` query parameter.
Supported values and aliases are normalized by `normalizeSupportedChain()`:

- `ethereum`, `eth`, `mainnet`
- `base`
- `bsc`, `bnb`, `binance`
- `polygon`, `matic`, `pol`

For all endpoints except `/wallet/:address/intelligence`, omitting `chain` uses `ethereum`.
For `/wallet/:address/intelligence`, omitting `chain` returns the unified multi-chain report.

### GET /wallet/:address

Main ingestion endpoint.

Behavior:

1. check the newest stored block for the wallet
2. if cached data exists, do a lightweight Moralis freshness check
3. fetch only new pages when newer blocks exist
4. normalize raw results into `NormalizedTransaction`
5. persist new normalized transactions
6. return the stored normalized view

If Moralis is unavailable and cached data exists, the service falls back to DB.

### GET /wallet/:address/holdings

Returns live raw token balances from blockchain balance endpoints.

Response intent:

- raw current balances only
- no DB reconstruction
- no pricing
- no holding analytics

Current response fields:

- `token`
- `amount`
- `contractAddress?`
- `decimals?`

### GET /wallet/:address/portfolio

Returns the live enriched portfolio view.

This is the main presentation endpoint for current holdings analytics.

It is built from:

- live balances from `HybridHoldingsService` (direct RPC + Multicall3), with Moralis fallback when needed
- current token market signals from `WalletPricingService` (DefiLlama + DexScreener + CoinGecko), plus ETH/USD from CoinGecko
- normalized stored history for holding analytics and cost basis

Current response fields:

- `token`
- `amount`
- `usdValue`
- `allocation`
- `holdingSince`
- `holdingDays`
- `avgBuyPrice`
- `currentPrice`
- `pnl`
- `roi`
- `priceUnavailable`
- `displayTier`
- `tokenQualityScore?`
- `tokenQualityLabel?`
- `priceSources?`
- `liquidityUsd?`
- `hiddenReason?`
- `decimals?`
- `contractAddress?`

Important note:

- `pnl` and `roi` on this endpoint are unrealized metrics for the current remaining position
- when live pricing is unavailable, `currentPrice`, `usdValue`, `pnl`, and `roi` return `null`, and `priceUnavailable` returns `true`
- `displayTier` classifies each asset for UI rendering: `core` (primary), `active` (speculative but currently relevant), `secondary` (lower-priority visible), `hidden` (suppressed)
- `hiddenReason` is only present when `displayTier = hidden` and explains why the asset was suppressed

### GET /wallet/:address/ledger

Returns the DB-backed reconstructed balance view.

This endpoint represents the old portfolio behavior.

It is built from stored normalized history only:

- token flow from DB
- net flow = `in - out`
- human-readable balance formatting

This is useful when we want a ledger-style position view derived from stored history instead of live chain balances.

### GET /wallet/:address/token-flow

Returns total incoming and outgoing raw amounts per token from stored normalized transactions.

### GET /wallet/:address/net-flow

Returns `in - out` per token from stored normalized transactions.

### GET /wallet/:address/transactions

Returns stored normalized transactions only.
No fresh ingestion is triggered here.

### GET /wallet/:address/trades

Returns trades built from stored swap transactions.

### GET /wallet/:address/priced-trades

Returns trades plus historical prices.

### GET /wallet/:address/pnl

Returns realized FIFO PnL metrics built from priced trades.

Current fields per token:

- `realizedPnL`
- `roi`
- `winRate`
- `bestTrade`
- `worstTrade`

### GET /wallet/:address/summary

Returns wallet-level summary metrics derived from stored transactions and realized PnL output.

Current fields:

- total transactions
- total swaps
- total transfers
- unique tokens interacted with
- total realized PnL
- average ROI
- average win rate
- best trade
- worst trade
- profitable token count
- losing token count

Important notes:

- profitable token count is the number of tokens in the realized `/pnl` output with `realizedPnL > 0`
- losing token count is the number of tokens in the realized `/pnl` output with `realizedPnL < 0`
- tokens with `realizedPnL = 0` are neutral and excluded from both counts
- profitable token count plus losing token count cannot exceed the number of traded tokens represented in `/pnl`

### GET /wallet/:address/features

Returns a nested wallet features response built from existing service methods.

Current shape:

- `summary`
- `risk`
- `holdTime`
- `activity`

Important notes:

- this endpoint reuses the same summary and analytics methods used by the dedicated endpoints
- the `risk` block returns the base risk response shape, not the optional debug extension

### GET /wallet/:address/intelligence

Returns either a unified multi-chain intelligence payload or an explicit single-chain intelligence payload.

Behavior:

- `GET /wallet/:address/intelligence` returns unified mode across Ethereum, Base, BSC, and Polygon
- `GET /wallet/:address/intelligence?chain=ethereum|base|bsc|polygon` returns the existing single-chain response shape
- single-chain behavior is unchanged for explicit `chain` requests
- unified mode includes `mode: "unified"`, `chainsAnalyzed`, `chainsWithActivity`, `chainErrors`, `partialResult`, and `perChain`

Current base response fields:

- `address`
- `analyzedAt`
- `context`
- `summary`
- `metrics`
- `score`
- `classification`
- `aiSummary`
- `deepAnalysis`
- `portfolio`
- `visiblePortfolio`
- `portfolioSummary`
- `features`

Supported query params:

- `chain=ethereum|base|bsc|polygon`
	- returns the existing single-chain intelligence response
	- if omitted, the endpoint returns unified multi-chain mode instead
- `lite=true` (or `lite=1`)
	- applies to explicit single-chain requests
- `verbose=true` (or `verbose=1`)
	- applies to explicit single-chain requests
	- includes reasoning fields in `context` and triage responses
	- includes `confidenceReasoning` in score/classification responses
	- includes `features.rawFeatureMetrics` (risk, hold-time, and activity raw metrics)
	- on full (non-lite) responses, includes `hiddenPortfolio` and `fullPortfolio`

Current behavior notes:

- this endpoint reuses existing wallet services instead of introducing new scoring or classification engines
- it avoids duplicate response assembly work by reusing one fetched summary/activity snapshot for context+features composition
- smart-contract triage is evaluated once; when triage applies, both score and classification preserve the existing triage payload behavior
- `portfolio` in intelligence is a curated default list (`visiblePortfolio` plus top speculative additions)
- `metrics` includes ROI/PnL metrics, capital base, portfolio scale, lifetime trade-volume metrics, pricing coverage, and trust signals
- `aiSummary` and `deepAnalysis` are only returned by the intelligence endpoint surface; score and classification endpoints do not include them
- explicit-chain responses are cached in-memory by `chain + address + lite + verbose` key with `5-minute` TTL to reduce repeated heavy computations
- unified responses are cached through `UnifiedIntelligenceService` by `unified:{address}` with 24-hour TTL

Dual AI layer details:

- service: `WalletAiService`
- summary model provider: Gemini
	- primary model: `gemini-2.5-flash`
	- automatic fallback model: `gemini-2.5-flash-lite`
	- cache key: `ai_summary:{address}` (lowercased address)
	- cache TTL: `86400` seconds (24 hours)
	- fallback cache TTL: `1800` seconds (30 minutes)
	- usage tier: free tier
	- output role: short data narration (2-3 sentence summary)
	- response quality gate: rejects empty/truncated outputs (for example `MAX_TOKENS` partial completions) before accepting/caching
- deep analysis model provider: Claude (`claude-sonnet-4-6`)
	- cache key: `ai_analysis:{address}` (lowercased address)
	- cache TTL: `86400` seconds (24 hours)
	- fallback cache TTL: `1800` seconds (30 minutes)
	- usage tier: paid
	- output role: structured analytical JSON
	- parse hardening: supports direct JSON, fenced JSON, and first-object extraction before fallback
- unified AI analysis model provider: Claude (`claude-sonnet-4-6`)
	- cache key: `unified_ai:{address}` (lowercased address)
	- cache TTL: `86400` seconds (24 hours)
	- output role: cross-chain summary plus structured `UnifiedDeepAnalysis`
	- failure behavior: returns `aiSummary = null` and `deepAnalysis = null` while preserving the unified metrics response
- prompt paths for both summary and deep analysis:
	- path 1 for trader/holder intelligence payloads
	- path 2 for triage payloads (`triage_contract` / `triage_operational` or `traderEligible = false`)
- holdings context uses top 3 entries from `visiblePortfolio` sorted by `usdValue` descending; if fewer than 3 holdings exist, all available entries are used
- deep analysis JSON output shapes:
	- `WalletDeepAnalysis` (trader/holder wallets): `strategyDiagnosis`, `skillVsLuck`, `hiddenRisks`, `copyTradeVerdict`, `behavioralEdge`, `oneSentenceTruth`
	- `WalletTriageDeepAnalysis` (triage wallets): `entityDiagnosis`, `holdingAssessment`, `notablePattern`, `oneSentenceTruth`
- AI failure isolation and resilience:
	- `aiSummary` and `deepAnalysis` are computed independently and cached independently
	- provider errors in one field do not block the other or the main intelligence payload
	- when external AI providers fail, deterministic local fallback content is returned and short-TTL cached to avoid repeated transient failures

ROI field naming transition (intelligence payload):

- canonical metric keys:
	- `metrics.realizedRoi`
	- `metrics.unrealizedRoi`
	- `metrics.averageTradeRoi`
	- `metrics.medianTradeRoi`
	- `metrics.scoreAdjustedRoi`
- canonical summary key:
	- `summary.averageTradeRoi`
- canonical label and warning keys:
	- `metrics.roiLabels.realizedRoi`, `averageTradeRoi`, `medianTradeRoi`, `unrealizedRoi`, `scoreAdjustedRoi`
	- `metrics.roiSampleWarnings.realizedRoi`, `averageTradeRoi`, `medianTradeRoi`, `unrealizedRoi`, `scoreAdjustedRoi`
- temporary deprecated aliases are still emitted for backward compatibility:
	- `realizedCapitalROI` -> `realizedRoi`
	- `openPortfolioROI` -> `unrealizedRoi`
	- `averagePerTradeROI` -> `averageTradeRoi`
	- `medianTradeROI` -> `medianTradeRoi`
	- `scoreAdjustedROI` -> `scoreAdjustedRoi`

Deprecation note:

- aliases are transitional and should be removed after downstream clients migrate to the canonical `*Roi` keys.

### GET /wallet/:address/context

Returns wallet archetype/context classification intended to run before smart-money scoring.

Current fields:

- `walletType`
- `walletSubtype`
- `isTraderWallet`
- `classificationConfidence`
- `reasoning`

Current behavior notes:

- triage is evaluated first; when triage applies, context returns triage wallet type/subtype and forces `isTraderWallet = false`
- when triage does not apply, context defaults to `walletType = EOA`
- `isTraderWallet = true` when `total_swaps >= 3`
- `walletSubtype = Automated/Bot-like` when `tradesPerActiveDay > 20` and `avgTradeGapHours < 1`; otherwise subtype is `null`
- `classificationConfidence` is derived from triage confidence (`confidenceScore / 100`) on triage paths, or from context heuristics on non-triage EOAs

### GET /wallet/:address/score

Returns either triage output (contract or operational EOA) or the V1 smart-money score derived from existing analytics endpoints and context classification.

Current fields:

- triage response (contract or operational EOA):
	- `walletType`
	- `walletSubtype`
	- `traderEligible` (`false`)
	- `scorePath`
	- `confidence`
	- `confidenceLabel`
	- `confidenceScore`
	- `confidenceReason`
	- `confidenceReasoning`
	- `score` (`null`)
	- `scoreBand` (`null`)
	- `reasoning`
- score response for EOAs:
	- `address`
	- `score`
	- `scorePath`
	- `confidence`
	- `confidenceLabel`
	- `confidenceScore`
	- `confidenceReason`
	- `confidenceReasoning`
	- `band`
	- `breakdown`
	- `scoreExplanation`
	- `gateStatus`
	- `balancesAvailable`
	- `scoredAt`

Current behavior notes:

- contract wallets are triaged first and return the short-circuit triage payload
- EOAs continue through the existing scoring pipeline unchanged
- confidence now uses the shared weighted model from `WalletConfidenceService`
- trader gate order is `Not a Trader Wallet` -> `Insufficient Data` -> `No Trading Activity`
- trader wallets that pass gating return `gateStatus = Eligible`
- non-trader wallets with positive-value holdings are scored on a holder path and return `gateStatus = Eligible (Holder)`
- non-trader wallets with no positive-value holdings return `gateStatus = Empty Wallet`, `score = 0`, `band = Unscored`, and zeroed holder breakdowns
- trader scoring uses seven primary weighted dimensions: `traderWeightedROI 25`, `realizedPnLQuality 15`, `consistency 15`, `riskManagement 20`, `portfolioQuality 10`, `experience 10`, `marketAdaptability 5`
- `profitability` is retained in the breakdown/debug surface as a legacy aggregate (`traderWeightedROI + realizedPnLQuality`)
- holder scoring uses four weighted dimensions: portfolio quality `35`, conviction `30`, portfolio size `20`, asset selection `15`
- holder scores are scaled by a portfolio-size multiplier before band assignment
- holder portfolio-size scaling excludes low-confidence holdings from scale inputs only (`totalPortfolioUsd`, `largestPositionUsd`, multiplier input):
	- exclude holding when `liquidityUsd < 5000`
	- exclude holding when `liquidityUsd` is unavailable and `priceSources` contains only `dexscreener`
- trader realized PnL quality applies tiny-sample dampening (scoring path only, based on realized trade count):
	- `profitFactor`: `< 5 trades => 1.0`, `5-9 trades => min(actual, 2.5)`, `>= 10 trades => actual`
	- `bestWorstRatio`: `< 5 trades => 1.0`, `5-9 trades => min(actual, 2.0)`, `>= 10 trades => actual`
- trader guardrails include gambler penalty (`profitFactor < 0.5` and swaps > 50) and weighted-ROI hard caps (`traderWeightedROI < -20` band cap, `< -40` score cap)
- raw analytics endpoints remain unchanged; dampening is applied only inside `/wallet/:address/score` scoring calculations
- `balancesAvailable` is `false` when live balances could not be loaded, which lets score consumers distinguish provider availability problems from a true empty wallet
- `GET /wallet/:address/score?debug=true` returns the base response plus per-dimension debug metrics for the active scoring path

### GET /wallet/:address/classification

Returns either triage output (contract or operational EOA) or a higher-level wallet behavior classification built on top of context, analytics, and holdings data.

Current fields:

- triage response (contract or operational EOA):
	- `walletType`
	- `walletSubtype`
	- `traderEligible` (`false`)
	- `scorePath`
	- `confidence`
	- `confidenceLabel`
	- `confidenceScore`
	- `confidenceReason`
	- `confidenceReasoning`
	- `score` (`null`)
	- `scoreBand` (`null`)
	- `reasoning`
- classification response for EOAs:
	- `address`
	- `type`
	- `primaryType`
	- `primaryScore`
	- `confidence`
	- `confidenceLabel`
	- `confidenceScore`
	- `confidenceReason`
	- `confidenceReasoning`
	- `description`
	- `traits`
	- `riskProfile`
	- `secondaryTypes`
	- `scoreBreakdown`
	- `allScores`
	- `classifiedAt`

Current behavior notes:

- contract wallets are triaged first and return the short-circuit triage payload
- EOAs continue through the existing classification pipeline unchanged
- low-confidence classifications are softened and explicitly marked as directional
- trader wallets are classified with a weighted-archetype system into `Diamond Hand`, `Swing Trader`, `Day Trader`, `Rotation Trader`, `Meme Hunter`, `Bot / Automated`, `Accumulator`, and `Whale`
- holder wallets are classified with a weighted-archetype system over live portfolio composition, holding duration, unrealized posture, and category exposure
- non-trader wallets with no positive-value holdings, or with unavailable live balances, fall back to `Empty Wallet`
- the response returns the winning archetype in both `type` and `primaryType`
- `traits` is capped to the top five narrative traits for the selected archetype
- `secondaryTypes` contains up to two additional nearby archetypes when their scores remain materially close to the winner

### GET /wallet/:address/risk-metrics

Returns wallet-level risk metrics derived from realized trades and current portfolio concentration.

Current fields:

- `profitFactor`
- `maxDrawdown`
- `returnStdDev`
- `concentrationRisk`

Current behavior notes:

- if total positive realized PnL is greater than `0` and there are no losing trades, `profitFactor` returns capped value `10`
- if both positive and negative realized PnL totals are `0`, `profitFactor` returns `0`
- `GET /wallet/:address/risk-metrics?debug=true` returns the base response plus intermediate arrays and concentration inputs used for inspection

### GET /wallet/:address/hold-time-metrics

Returns hold-duration analytics for completed FIFO trade lots only.

Current fields:

- `avgHoldHours`
- `medianHoldHours`
- `holdBuckets`

Current hold buckets:

- `under1h`
- `under24h`
- `under7d`
- `over7d`

Important notes:

- open or still-unclosed positions are ignored
- chronological ordering is preserved by reusing the FIFO pairing flow from realized PnL processing

### GET /wallet/:address/activity-metrics

Returns trade-frequency and activity metrics built from stored trades.

Current fields:

- `tradesPerActiveDay`
- `tradesPerLifetimeDay`
- `avgTradeGapHours`
- `burstinessScore`
- `tradingSpanRatio`

Current behavior notes:

- `tradesPerActiveDay = total trades / active trading days`
- `tradesPerLifetimeDay = total trades / wallet age in days`
- `avgTradeGapHours` uses consecutive chronological trade gaps only
- `burstinessScore = stddev(gaps) / mean(gaps)` with divide-by-zero protection
- `tradingSpanRatio = (last trade timestamp - first trade timestamp) / wallet age`

### GET /wallet/:address/dex-metrics

Returns DEX router usage metrics built from stored normalized swap transactions.

Current fields:

- `tradesPerDex`
- `primaryDex`
- `primaryDexShare`
- `dexDiversity`
- `unknownDexPercent`

Current behavior notes:

- the service inspects `to_address` on each stored swap transaction as the router target
- known router addresses are matched from the selected chain's lowercase lookup table
- unmatched swap recipients are counted under `Unknown`
- `dexDiversity` excludes `Unknown`
- `GET /wallet/:address/dex-metrics?debug=true` also returns `unknownRouterAddresses`, grouped by unmatched `to_address` frequency descending

### GET /wallet/:address/token-categories

Returns token category analytics built from existing priced trades and current portfolio holdings.

Current fields:

- `tradesByCategory`
- `historicalVolumeByCategory`
- `dominantTradingCategory`
- `categoryDiversity`
- `memecoinTradePercent`
- `blueChipTradePercent`
- `stablecoinTradePercent`
- `currentHoldingsByCategory`
- `dominantHoldingCategory`
- `memecoinHoldingPercent`
- `blueChipHoldingPercent`
- `stablecoinHoldingPercent`

Current behavior notes:

- each priced trade is classified with `classifyToken(contractAddress, token, chain)`
- category volume uses `price * amount` and ignores trades without usable price
- current holdings allocation aggregates `usdValue` by category and ignores `null` holdings values
- stablecoin trade share is volume-based, while memecoin and blue chip trade shares are trade-count-based
- holdings percentages are USD-allocation based and ignore holdings with unavailable `usdValue`

## 9. Main ingestion flow

This is the flow behind `GET /wallet/:address`.

### Step 1: validate address and chain

The controller validates the EVM address and normalizes the requested chain.
Invalid input or unsupported chains throw `BadRequestException`.

### Step 2: check cached state

`WalletCoreService` looks up the latest stored block for the wallet.

Two cases:

- no stored data yet
- stored data already exists

### Step 3: check Moralis freshness

If cached data exists, the service fetches only the first page from Moralis.
This acts as a freshness check.

If Moralis is not ahead of the DB, the service serves DB data.

If Moralis has newer blocks, the service fetches only transactions above the newest stored block.

### Step 4: normalize raw history

Moralis native history and ERC-20 transfers use different payloads.
We normalize both into `NormalizedTransaction`.

During normalization we:

- group entries by transaction hash
- create one normalized transaction per hash
- push outgoing assets into `inputs`
- push incoming assets into `outputs`
- merge repeated token entries inside the same transaction
- classify the transaction using the full semantic rule set (transfer/swap, wraps, liquidity, staking, yield, protocol-transform, bridge, lending/vault, reward)

### Step 5: save and return stored view

The service persists normalized transactions and then returns the stored representation.

This keeps the output stable regardless of the raw provider payload.

## 10. Transaction classification rules

Rules are applied in priority order. The first match wins.

### Empty payload guard

**unknown** — no inputs and no outputs; these transactions are not persisted.

### One-sided flow rules

**repay** — inputs exist, outputs are empty, and `to` is a known lending protocol address.

**bridge_out** — inputs exist, outputs are empty, and either `to` is a known bridge address or the transfer matches a bridge-out heuristic (base-asset-like input with no wallet-side return leg).

**vault_deposit** — inputs exist, outputs are empty, `to` is a known vault address, and at least one input is base-asset-like.

**bridge_in** — outputs exist, inputs are empty, and `from` is a known bridge address.

**borrow** — outputs exist, inputs are empty, and `from` is a known lending protocol address.

**yield_split** — outputs exist, inputs are empty, `from` is the zero address, and any output matches yield token patterns (`YT-`, `PT-`, `SY-`).

**receipt_mint** — outputs exist, inputs are empty, `from` is the zero address, and any output looks like a lending receipt or vault share.

**reward_claim** — outputs exist, inputs are empty, and either (a) `from` is the zero address with non-yield/non-receipt outputs, (b) `from` is a known reward distributor, or (c) outputs are reward-like by symbol/name heuristics.

**vault_withdraw** — outputs exist, inputs are empty, `from` is a known vault address, and at least one output is base-asset-like.

**transfer** — fallback for one-sided flows that match none of the above.

### Two-sided flow rules

**wrap** — single-token native asset input and single-token wrapped-native output.

**unwrap** — single-token wrapped-native input and single-token native asset output.

**liquidity_add** — two or more distinct input tokens and exactly one LP-like output (`LP`, `UNI-V2`, `PAIR`, `POOL`, `BPT`, `SLP`, `Cake-LP`, case-insensitive).

**liquidity_remove** — exactly one LP-like input and two or more distinct output tokens.

**yield_split** — inputs contain a Pendle base/restaked asset and outputs contain a yield token.

**yield_merge** — inputs contain a yield token and outputs contain a Pendle base/restaked asset.

**receipt_mint / reward_claim** — when `from` is zero address in a two-sided payload: yield outputs => `yield_split`; receipt-like outputs => `receipt_mint`; otherwise `reward_claim`.

**receipt_burn / yield_merge** — when `to` is zero address: yield token present on either side => `yield_merge`; otherwise `receipt_burn`.

**lending_deposit** — single input/output pair where input is base-asset-like and output is lending-receipt-like.

**lending_withdraw** — single input/output pair where input is lending-receipt-like and output is base-asset-like.

**vault_deposit** — single input/output pair where input is base-asset-like and output is vault-share-like.

**vault_withdraw** — single input/output pair where input is vault-share-like and output is base-asset-like.

**staking_wrap** — staking derivative in, wrapped staking derivative out.

**staking_unwrap** — wrapped staking derivative in, unwrapped staking derivative out.

**stake** — staking base asset in, staking derivative out.

**unstake** — staking derivative in, staking base asset out.

**protocol_transform** — single input/output pair that maps to the same economic asset group with different wrappers/representations.

**bridge_out / bridge_in** — two-sided fallback when `to`/`from` matches known bridge addresses.

**transfer** — same single token on both sides.

**swap** — fallback for all other two-sided flows.

Trade conversion rule: only `swap` transactions are converted into trades by `WalletPnlService`. Every other stored type is excluded from trade reconstruction and realized PnL.

## 11. How live holdings work

`getHoldings()` is served by `HybridHoldingsService` first, with Moralis fallback when needed.

It fetches:

- native chain balance via `provider.getBalance()` using the selected chain RPC URL
- ERC-20 balances via batched Multicall3 `aggregate3()` calls in groups of 150

Token discovery:

1. `HybridHoldingsService` looks up `wallet_known_tokens` rows for the wallet address
2. if rows exist, their `contract_address` entries are used as the ERC-20 candidate list
3. if no rows exist, the service falls back to scanning stored `transactions` for token contract addresses, then asynchronously backfills the `wallet_known_tokens` table

Current behavior:

- convert raw balances using token decimals
- include the selected chain's native asset symbol (`ETH`, `BNB`, or `POL`)
- exclude zero balances
- trim trailing zeros
- cache results in memory for 5 minutes per chain+wallet address
- if hybrid loading fails, `WalletPortfolioService` falls back to Moralis native/ERC-20 balances
- if Moralis keys are exhausted during fallback, holdings return empty and `balancesAvailable = false` for score/classification gating

This endpoint is the source for the live portfolio pipeline.

## 12. How ledger works

`getLedger()` uses stored normalized history.

Pipeline:

1. read stored transactions
2. sum token inputs and outputs separately
3. compute `net = in - out`
4. format the net amount into a human-readable balance

This is the historical reconstructed position view.

It is different from live holdings because DB history can be incomplete, delayed, or intentionally reflect only what has been ingested so far.

## 13. How trades are built

Trades are built only from stored `swap` transactions.

For each swap transaction:

- every input becomes a `SELL`
- every output becomes a `BUY`

Amounts are normalized into human-readable token units using decimals.

## 14. Historical pricing rules

### Trade pricing

For priced trades, the lookup order is:

1. DefiLlama historical price
2. CoinGecko historical fallback for supported tokens
3. if still missing, keep price `0`

### Missing swap-leg inference

If a swap has exactly two trades at the same timestamp and exactly one side has price `0`, the module may infer the missing side price from the priced counterpart.

This is conservative on purpose.

### Transfer-in lot pricing

Transfer-in holdings lots now use estimated historical market price instead of automatically returning unknown cost basis.

Lookup rule:

1. DefiLlama historical market price at receive timestamp
2. if missing, keep estimated price as `null`

This means transfer-ins now often contribute to average cost basis when DefiLlama supports the asset.

## 15. Realized FIFO PnL flow

`WalletPnlService.getPnL()` processes priced trades from oldest to newest.

Per token, the service keeps a FIFO buy queue.

### On BUY

Push a buy lot into the token queue.

### On SELL

Consume the oldest buy lots first.

For each match:

- `matchedAmount = min(sellAmount, oldestBuy.amount)`
- `matchedPnL = (sellPrice - buyPrice) * matchedAmount`
- `matchedCostBasis = buyPrice * matchedAmount`

The service also tracks:

- realized PnL
- realized ROI
- win rate
- best trade
- worst trade

This endpoint is strictly realized PnL.
It does not calculate unrealized position performance.

Completed FIFO lot matches from this same queueing logic are also reused by `WalletAnalyticsService` for hold-time analytics.

## 16. Live portfolio analytics flow

`WalletPortfolioService.getPortfolio()` is the enriched live holdings pipeline.

It combines four inputs:

1. live balances from `HybridHoldingsService`
2. token market signals from DefiLlama, DexScreener, and CoinGecko plus native-token USD pricing from CoinGecko
3. normalized stored history for holding analytics and cost basis
4. stored swap transactions for traded-token signals used in tier classification

### Step 1: fetch live holdings

The service calls `getHoldings()`.

### Step 2: fetch current prices

The service fetches:

- token market signals by contract address (price + liquidity + source provenance) from DefiLlama, DexScreener, and CoinGecko
- current native-token/USD price from CoinGecko

These are used for:

- `currentPrice`
- `usdValue`
- unrealized `pnl`
- unrealized `roi`

If live pricing is unavailable for a holding, market-derived fields do not fall back to zero.
That holding returns:

- `currentPrice = null`
- `usdValue = null`
- `pnl = null`
- `roi = null`
- `priceUnavailable = true`

### Step 3: rebuild current holding lots from normalized history

The service refreshes history best-effort, then reads stored normalized transactions in chronological order.

It builds FIFO lots per token.

For each incoming token amount:

- create a lot
- attach acquisition timestamp
- attach acquisition price
- mark cost basis type

Current cost basis type rules:

- swap-acquired lot => `actual`
- transfer-in lot => `estimated`

For each outgoing token amount:

- consume the oldest lots first

This preserves reset and partial-sell behavior.

### Step 4: align lots to current live balance

The live balance from the holdings pipeline (`HybridHoldingsService` primary, Moralis fallback) is treated as the current source of truth.
Rebuilt lots are trimmed to match the current balance.

This protects the analytics from minor ingestion gaps or stale stored state.

### Step 5: derive enriched metrics

For each currently held token:

- `usdValue = amount * currentPrice` when `currentPrice` exists
- `allocation = usdValue / totalPortfolioValue * 100`
- `holdingSince` = timestamp of the oldest remaining lot
- `holdingDays` = days between `holdingSince` and now
- `avgBuyPrice` = weighted average acquisition price of remaining lots only
- `pnl = (currentPrice - avgBuyPrice) * amount` when both `currentPrice` and `avgBuyPrice` exist
- `roi = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100` when both `currentPrice` and `avgBuyPrice` exist
- `priceUnavailable = true` when live price lookup fails for the holding

Important behavior:

- reset logic is respected because fully sold lots are removed from FIFO state
- partial sells preserve the original acquisition date and basis of remaining lot fragments
- if no usable remaining lots exist, holding analytics return `null`
- if average buy price is unknown, unrealized `pnl` and `roi` return `null`
- if current price is unavailable, `currentPrice`, `usdValue`, `pnl`, and `roi` return `null` instead of implying a real zero market price

### Step 6: classify display tier

After all enriched metrics are computed, each portfolio item is passed to `classifyPortfolioTier()` together with wallet tier signals and per-token market signals.

Classification model:

- first, hard-hide spoofed major symbols (`tokenQualityLabel = spoofed_major_symbol`)
- assign guaranteed `core` visibility for material major/stable assets (for example high-value `ETH/WETH/BTC/stable` holdings)
- compute `tokenQualityScore` (`0-100`) from price availability, liquidity, recency/history of trading activity, trusted-token signals, spam keywords, dust/low-value signals, and airdrop-pattern signals
- map score to quality label:
	- `>= 70` => `visible`
	- `35-69.99` => `speculative`
	- `< 35` => `hidden`
- map label to display tier:
	- `visible` => `core`
	- `speculative` => `active` when recent/material/liquid, otherwise `secondary`
	- `hidden` => `hidden` with `hiddenReason`

All raw fields are preserved on every item. Tier metadata fields (`displayTier`, `tokenQualityScore`, `tokenQualityLabel`, `priceSources`, `liquidityUsd`, and optional `hiddenReason`) are appended.

## 17. Average buy price rules

`avgBuyPrice` is calculated from current remaining lots only.

This means we do not blindly average all historical buys.

Example:

- buy 10 ETH at 1000
- sell 10 ETH
- buy 5 ETH at 2000

Current `avgBuyPrice` is based only on the second lot.

If any remaining lot lacks usable acquisition price, average buy price becomes `null`.

## 18. Reliability and fallback behavior

Current resilience rules:

- Moralis client uses timeouts
- Moralis history fetch retries once
- Moralis key rotation: on HTTP 401 the active key is marked exhausted for 1 hour and the other key is tried immediately; `MoralisKeysExhaustedError` is thrown when both keys are exhausted at the same time
- cached DB data is used when Moralis refresh fails
- missing historical trade pricing can remain `0`, and one missing swap leg may still be inferred from its priced counterpart
- live holdings pricing failures do not force zero-valued market fields; portfolio items return `null` market-derived values and `priceUnavailable = true`
- transfer-in estimated basis falls back to `null` when unsupported
- duplicate inserts are ignored safely
- historical price cache (24h TTL) and live price cache (5 min TTL) prevent redundant provider calls
- in-flight request deduplication ensures concurrent callers share one outstanding network request instead of issuing duplicates
- negative-cache entries for confirmed no-data misses avoid repeated failed DefiLlama lookups
- DefiLlama concurrency is capped at 5 simultaneous requests with 100 ms spacing to stay within rate limits
- DefiLlama 429 responses trigger exponential backoff (2 s then 4 s, 2 retries maximum)
- pricing providers (`defillama`, `coingecko`, `dexscreener`) use circuit breakers with a 30-second cooldown when 6 rate-limit hits are observed within a 30-second window
- `HybridHoldingsService` maintains a 5-minute in-memory cache per wallet; a cache miss triggers a full RPC + Multicall3 refresh

## 19. Current assumptions and limits

### Multi-chain protocol heuristics

Storage, provider calls, pricing, native assets, DEX router lookup, token categories, and caches are chain-aware for Ethereum, Base, BSC, and Polygon.
Some deeper semantic protocol address sets for bridge/lending/vault/reward classification are still Ethereum-first; non-Ethereum chains fall back to token-flow heuristics where protocol address lists have not been curated yet.

### Classification is heuristic

Transaction semantic detection is still rule-based and address/token-heuristic driven.
Complex or newly deployed DeFi protocols can still require future rule expansion.

### Stored history is important

Portfolio analytics depend on normalized stored history for duration and cost basis.
If ingestion is incomplete, analytics may be partially missing even when live balances are available.

### Transfer-in cost basis is estimated, not proven

For transfers, we use historical market price at receive time when available.
This improves intelligence, but it is still an estimate rather than true executed basis.

### TypeORM sync mode

TypeORM `synchronize` is disabled.
Apply schema changes with explicit migrations, currently `npm run db:migrate:chains` for the `chain_id` migration.

## 20. Suggested mental model

Think of the module as five layers:

1. provider ingestion
2. normalization and storage
3. realized trade analytics
4. wallet-level analytics
5. live holdings and portfolio analytics

That mental model matches the current service split.

## 21. Best file reading order

Recommended reading order for a new developer:

1. `src/wallet/wallet.controller.ts`
2. `src/wallet/services/wallet.service.ts`
3. `src/wallet/services/wallet-core.service.ts`
4. `src/wallet/services/hybrid-holdings.service.ts`
5. `src/wallet/services/wallet-pricing.service.ts`
6. `src/wallet/services/wallet-pnl.service.ts`
7. `src/wallet/services/wallet-analytics.service.ts`
8. `src/wallet/services/wallet-portfolio.service.ts`
9. `src/wallet/services/portfolio-tier.classifier.ts`
10. `src/wallet/transaction.entity.ts`
11. `src/wallet/entities/wallet-known-token.entity.ts`
12. `src/wallet/wallet.types.ts`

## 22. Update rule for this document

Whenever any of the following change, update this file in the same task:

- endpoint behavior or naming
- provider usage
- normalization rules
- transaction classification logic
- pricing lookup order
- FIFO lot logic
- wallet analytics fields and aggregation behavior
- cost basis logic
- portfolio analytics fields
- database schema for wallet data
- live holdings provider or token discovery strategy

This document should describe the current implementation, not an older version and not a future design.