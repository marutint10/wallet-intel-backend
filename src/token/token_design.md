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
- normalize transfer direction and amounts into one lite transfer format
- detect swap-like behavior from transfer groups inside the same transaction hash
- compute behavioral features from transfers (hold times, burstiness, category exposure, activity)
- classify wallet behavior into lite archetypes
- score wallet quality on a fixed 0-100 scale with confidence and band
- aggregate analyzed holder results into token-level quality/distribution/risk callouts
- attach current USD price and per-holder usdValue to holder rows
- compute portfolio context for top holders via Alchemy balances and batch pricing
- compute lite realized PnL from detected swaps and feed profitability into classification/scoring
- run full token analysis asynchronously and persist output in Postgres
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
- enrich holder rows with usdValue, top-holder portfolio context, and lite PnL summaries
- aggregate holder-level analytics into token-level metrics
- persist status done/error and payload into token_analyses

Status lifecycle:

- processing: set immediately when analysis starts
- done: set after successful pipeline completion and save
- error: set when any uncaught pipeline failure occurs

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

Notes:

- if provider API key is missing, returns empty transfer list and logs warning
- unsupported chain throws an error

### LiteFeatureService

File: src/token/services/lite-feature.service.ts

Responsibilities:

- detect swaps by grouping transfers per txHash
- expose normalized swap rows for PnL reconstruction
- require both IN and OUT legs, and different token contracts, to mark as swap
- estimate hold times using FIFO lot matching
- compute behavior metrics:
  - activity (swap count, span, trades/day, avg gaps, burstiness)
  - hold-time stats (median + buckets)
  - token preference mix (memecoin/bluechip/stablecoin)
  - portfolio diversity placeholders (holding token count, chain count)

Notes:

- token categories are currently inline in this service (not imported from shared constants yet)

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

Gating:

- returns Insufficient Data when swapCount < 3 or matchedLotCount < 2

### LiteScorerService

File: src/token/services/lite-scorer.service.ts

Responsibilities:

- compute a 0-100 score from weighted dimensions:
  - consistency
  - riskManagement
  - portfolioQuality
  - experience
  - activity
  - profitability (when PnL data is available)
- return score band and confidence

Bands:

- 90-100: Elite Smart Money
- 75-89: Strong Trader
- 60-74: Good Trader
- 40-59: Average
- 0-39: Weak / Risky

Gating:

- returns Insufficient Data when swapCount < 3

### HolderAggregationService

File: src/token/services/holder-aggregation.service.ts

Responsibilities:

- compute quality metrics from analyzed holders
- compute distribution metrics (holder buckets, top concentration, gini)
- compute category-split concentration metrics for eoaHolders, teamLinked, exchanges, contractsAndPools, vestingLocked, burnDead, and dust
- generate risk/positive/info callouts
- add callouts for low retail holder concentration and high-confidence team detection

Output families:

- qualityMetrics
- distribution
- riskCallouts
- categoryConcentration (inside qualityMetrics)

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
   - process holders in batches (default size 5, delay 1500ms)
   - for each holder: transfers -> features -> classification -> score
   - aggregate holder outputs into quality/distribution/callouts
   - upsert final analysis row with status=done
4. client polls GET /token/:address?chain=... until done/error

Current runtime note:

- production orchestrator uses TokenIntelligenceService for holder classification, team detection, and token metadata before running lite analysis on EOA holders

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

## 5. Data model and migrations

Migration file:

- migrations/202605060001_create_token_tables.sql

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
- ETHERSCAN_API_KEY (ethereum, polygon transfer ingestion)
- ALCHEMY_API_KEY (base, bsc transfer ingestion)
- DATABASE_URL

Optional tuning keys:

- TOKEN_ANALYSIS_BATCH_SIZE (default 5)
- TOKEN_ANALYSIS_BATCH_DELAY_MS (default 1500)

Current .env.example already includes:

- CHAINBASE_API_KEY
- ETHERSCAN_API_KEY
- DATABASE_URL

Manual note:

- add ALCHEMY_API_KEY to your local env for base/bsc support in lite ingestion

## 7. How analysis persistence works

The orchestrator saves output into token_analyses JSONB columns:

- holders_data: per-holder analyzed rows (classification + score)
- quality_metrics: aggregated holder quality metrics plus tokenPriceUsd, priceSource, and PnL aggregation
- distribution: concentration/distribution metrics
- risk_callouts: generated token-level insights

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

## 9. Current limitations and known gaps

- only first two Chainbase pages are currently fetched
- wallet-level holdingTokenCount and holdingChainCount in features are placeholders unless provided by caller
- tracked token scheduling and whale alert execution logic is not implemented yet

## 10. How to run and verify

### Apply migration

Example:

- node scripts/run-sql-migration.js migrations/202605060001_create_token_tables.sql

### Start analysis

1. POST /token/analyze with contractAddress and optional chain
2. poll GET /token/:address?chain=... until status is done or error

### Debug each stage quickly

1. GET /token/:address/holders
2. GET /token/wallet/:address/transfers
3. GET /token/wallet/:address/features
4. GET /token/wallet/:address/classify
5. GET /token/wallet/:address/score

## 11. Pipeline Upgrades (Post-MVP)

### LitePricingService

File: src/token/services/lite-pricing.service.ts

- DexScreener primary, CoinGecko fallback
- 5-minute in-memory cache
- batch pricing for portfolio valuation
- historical price fetching via DefiLlama (primary) with CoinGecko range fallback
- hour-rounded in-memory cache for historical prices (permanent, prices do not change)
- 150ms minimum spacing between DefiLlama calls
- used by LitePnlService for accurate swap-time valuation
- used by: orchestrator holder USD values, portfolio service, PnL service

### LitePortfolioService

File: src/token/services/lite-portfolio.service.ts

- fetches full token balances via Alchemy getTokenBalances
- prices holdings via batch CoinGecko
- computes: totalPortfolioUsd, trackedTokenWeight, diversificationScore
- only runs for top 50 holders for API cost management

### LitePnlService

File: src/token/services/lite-pnl.service.ts

- FIFO position lot reconstruction from detected swaps
- swap valuation priority: stablecoin-side first, DefiLlama historical second, CoinGecko historical third, current price last resort
- outputs: realized PnL, win rate, profit factor, ROI, largest win/loss
- feeds into classifier Smart Money/Paper Hand/Degen/Bot signals and scorer profitability dimension
- matches wallet module's DefiLlama-first historical pricing strategy

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
