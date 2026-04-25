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

- fetch wallet transaction history from Moralis
- normalize ERC-20 and native ETH activity into one internal format
- persist normalized transactions in Postgres
- serve stored normalized transactions
- classify normalized transactions as `transfer` or `swap`
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

## 2. Current architecture

The wallet module is now split into focused services.

### WalletController

Owns the HTTP API under `/wallet`.

Responsibilities:

- validate Ethereum addresses
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
- delegate live holdings to `HybridHoldingsService`
- delegate risk, hold-time, and activity analytics to `WalletAnalyticsService`
- delegate wallet archetype/context detection to `WalletContextService`
- delegate wallet behavior classification to `ClassificationService`
- delegate V1 smart-money scoring to `WalletScoringService`
- compose the unified wallet features response from existing service methods

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

- read live native ETH balance from an ethers.js `JsonRpcProvider`
- read live ERC-20 balances in batches of 150 via the Multicall3 contract at `0xcA11bde05977b3631167028862bE2a173976CA11`
- discover which ERC-20 tokens a wallet holds by consulting the `wallet_known_tokens` table
- fall back to a transaction scan when no `wallet_known_tokens` rows exist for the wallet, and backfill the table asynchronously
- maintain a 5-minute in-memory holdings cache per wallet address
- sync `wallet_known_tokens` after ingestion when new transactions arrive via `syncKnownTokens()`
- expose `clearCache()` and `clearAllCache()` for targeted or global cache invalidation

### WalletContextService

This is the pre-scoring wallet context layer.

Responsibilities:

- detect whether an address behaves like an `EOA` or `Contract` from on-chain bytecode
- detect likely Gnosis Safe wallets with a Safe proxy bytecode heuristic when possible
- classify whether the wallet qualifies as a trader from summary swap count
- infer simple operational-treasury and bot-like subtypes from summary and activity metrics
- return reasoning and confidence for downstream scoring decisions

### WalletScoringService

This is the V1 smart-money scoring layer.

Responsibilities:

- reuse existing context, summary, activity, risk, DEX, and token-category service methods
- apply score gate rules before scoring ineligible trader wallets
- score trader wallets across profitability, consistency, risk management, portfolio quality, and experience
- score holder wallets across portfolio quality, conviction, portfolio size, and asset selection
- return `balancesAvailable` so downstream consumers can distinguish empty holdings from unavailable live balances
- assign confidence from swap count and trading-span coverage for traders, and from portfolio breadth, size, and holding duration for holders
- return a structured score response with dimension breakdowns

### ClassificationService

This is the higher-level behavior-classification layer.

Responsibilities:

- classify trader wallets into narrative archetypes such as `Diamond Hand`, `Swing Trader`, `Sniper`, or `DeFi Strategist`
- classify holder wallets into archetypes such as `Blue Chip Maximalist`, `Diversified Holder`, or `Dust Wallet`
- fall back to `Empty Wallet` when live balances are unavailable or no positive-value holdings exist for non-trader wallets
- return a structured classification response with confidence, traits, risk profile, secondary types, and score breakdowns per archetype

### WalletCoreService

This is the ingestion and normalization layer.

Responsibilities:

- configure the Moralis client
- rotate between up to two Moralis API keys on HTTP 401; mark exhausted keys for 1 hour before retrying
- log configured key count at startup
- fetch ERC-20 transfers and wallet history
- refresh only new blocks when DB data already exists
- normalize raw provider payloads into `NormalizedTransaction`
- persist normalized transactions into Postgres
- return stored normalized transactions
- expose transaction entities to downstream services
- build trade entries from normalized token amounts
- call `HybridHoldingsService.syncKnownTokens()` after each successful ingestion pass

### WalletPricingService

This is the pricing layer.

Responsibilities:

- fetch current ERC-20 prices from CoinGecko
- fetch current ETH/USD price from CoinGecko
- fetch historical trade prices from DefiLlama with CoinGecko fallback
- fetch historical transfer-in market prices from DefiLlama only
- infer one missing swap-leg price when the opposite side is priced
- cache historical prices in memory for 24 hours; cache live prices for 5 minutes
- deduplicate in-flight historical and live price requests so concurrent callers share one network call
- store negative-cache entries for confirmed no-data misses to avoid repeated failed lookups
- limit DefiLlama concurrency to 5 simultaneous requests with 100 ms inter-request spacing
- retry DefiLlama 429 responses with exponential backoff (2 s first retry, 4 s second retry, 2 retries maximum)
- engage a global 15-second DefiLlama cooldown when 5 or more 429s are received within a 10-second window

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

### PortfolioTierClassifier

This is a pure stateless classification module (`portfolio-tier.classifier.ts`).

Responsibilities:

- classify each portfolio item into one of three display tiers: `core`, `secondary`, or `hidden`
- use token pricing, allocation, symbol allowlist, spam keyword detection, symbol length, trade history, and known-protocol contract lookup as classification signals
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
- `ClassificationService`
- `WalletScoringService`
- `WalletService`
- the placeholder services listed above
- the TypeORM repository for `TransactionEntity`
- the TypeORM repository for `WalletKnownTokenEntity`
- a `JsonRpcProvider` factory bound to the configured `ETH_RPC_URL`

## 4. Configuration

Current config values:

- `PORT`
- `MORALIS_API_KEY` or `MORALIS_API_KEY_1` — first Moralis API key (interchangeable; `MORALIS_API_KEY_1` takes precedence when both are set)
- `MORALIS_API_KEY_2` — optional second Moralis API key for key rotation
- `COINGECKO_API_KEY`
- `ETH_RPC_URL`
- `DATABASE_URL`
- `DATABASE_SSL`
- `DATABASE_CONNECTION_TIMEOUT_MS`

The app is currently Ethereum-focused.
Moralis calls use `chain: 'eth'`.

## 5. External providers and how we use them

### Moralis

Moralis is used for history ingestion only.

Current usage:

- ERC-20 transfers
- wallet history for native ETH transfers

Moralis is no longer used for live balance fetching.
WalletCoreService rotates between two configured API keys.
When a key returns HTTP 401, it is marked exhausted for 1 hour before being retried.

### Direct RPC and Multicall3

Live on-chain balances are now fetched via a direct `JsonRpcProvider` connection and the Multicall3 contract.

Current usage:

- native ETH balance via `provider.getBalance()`
- ERC-20 balances batched through Multicall3 `aggregate3()` in groups of 150
- wallet bytecode lookup for `WalletContextService` address-type detection

### DefiLlama

DefiLlama is the primary historical pricing source.

Current usage:

- historical trade pricing
- historical market pricing for transfer-in lots

### CoinGecko

CoinGecko is used for:

- current ERC-20 USD prices
- current ETH/USD price
- fallback historical trade pricing for supported tokens when DefiLlama has no answer

## 6. Database model

The `transactions` table stores normalized wallet transactions.

Important stored fields:

- wallet address
- transaction hash
- block number
- timestamp
- from address
- to address
- type: `transfer` or `swap`
- inputs: tokens leaving the wallet
- outputs: tokens entering the wallet

Important rules:

- one row per `wallet_address + transaction_hash`
- duplicate inserts are ignored safely
- `inputs` and `outputs` are stored as JSONB arrays

Why we store normalized data:

- provider payloads are noisy and provider-specific
- normalized data is easier to reason about
- most analytics can run from stored history
- we can recover from temporary upstream failures

The `wallet_known_tokens` table stores the set of ERC-20 tokens a wallet has interacted with.

Important stored fields:

- wallet_address
- contract_address
- symbol
- decimals
- first_seen_at
- last_seen_at
- seen_count

Important rules:

- one row per `wallet_address + contract_address`
- upserted from `syncKnownTokens()` after each ingestion pass
- `HybridHoldingsService` reads this table to know which ERC-20s to query balances for
- falls back to a transaction scan when no rows exist for the wallet, then backfills asynchronously

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

- live balances from Moralis
- current prices from CoinGecko
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
- `hiddenReason?`
- `decimals?`
- `contractAddress?`

Important note:

- `pnl` and `roi` on this endpoint are unrealized metrics for the current remaining position
- when live pricing is unavailable, `currentPrice`, `usdValue`, `pnl`, and `roi` return `null`, and `priceUnavailable` returns `true`
- `displayTier` classifies each asset for UI rendering: `core` (show prominently), `secondary` (show in expanded section), `hidden` (collapse or omit)
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

### GET /wallet/:address/context

Returns wallet archetype/context classification intended to run before smart-money scoring.

Current fields:

- `walletType`
- `walletSubtype`
- `isTraderWallet`
- `classificationConfidence`
- `reasoning`

Current behavior notes:

- `walletType` is derived from `eth_getCode`: bytecode present => `Contract`, otherwise `EOA`
- Gnosis Safe detection uses a heuristic bytecode pattern check for the Safe proxy `masterCopy()` selector
- `isTraderWallet = true` when `total_swaps >= 3`
- `walletSubtype = Operational/Treasury` when `txCount > 50`, `transferRatio > 80%`, and `swaps <= 2`
- `walletSubtype = Automated/Bot-like` when `tradesPerActiveDay > 20` and `avgTradeGapHours < 1`
- Gnosis Safe subtype takes precedence over the treasury and bot-like heuristic labels because it is a stronger structural signal

### GET /wallet/:address/score

Returns the V1 smart-money score derived from existing analytics endpoints and context classification.

Current fields:

- `address`
- `score`
- `confidence`
- `band`
- `breakdown`
- `gateStatus`
- `balancesAvailable`
- `scoredAt`

Current behavior notes:

- trader gate order is `Not a Trader Wallet` -> `Insufficient Data` -> `No Trading Activity`
- trader wallets that pass gating return `gateStatus = Eligible`
- non-trader wallets with positive-value holdings are scored on a holder path and return `gateStatus = Eligible (Holder)`
- non-trader wallets with no positive-value holdings return `gateStatus = Empty Wallet`, `score = 0`, `band = Unscored`, and zeroed holder breakdowns
- trader confidence uses fixed thresholds: `high` for `swaps >= 50` and `tradingSpanDays >= 90`, `medium` for `swaps >= 15` and `tradingSpanDays >= 30`, else `low`
- trader scoring uses five weighted dimensions: profitability `30`, consistency `20`, risk management `20`, portfolio quality `15`, experience `15`
- holder scoring uses four weighted dimensions: portfolio quality `35`, conviction `30`, portfolio size `20`, asset selection `15`
- holder scores are scaled by a portfolio-size multiplier before band assignment
- `balancesAvailable` is `false` when live balances could not be loaded, which lets score consumers distinguish provider availability problems from a true empty wallet
- `GET /wallet/:address/score?debug=true` returns the base response plus per-dimension debug metrics for the active scoring path

### GET /wallet/:address/classification

Returns a higher-level wallet behavior classification built on top of context, analytics, and holdings data.

Current fields:

- `address`
- `type`
- `primaryType`
- `primaryScore`
- `confidence`
- `description`
- `traits`
- `riskProfile`
- `secondaryTypes`
- `allScores`
- `classifiedAt`

Current behavior notes:

- trader wallets are classified with a weighted-archetype system over summary, hold-time, activity, DEX, risk, and token-category signals
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
- known Ethereum DEX router addresses are matched from a lowercase lookup table
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

- each priced trade is classified with `classifyToken(contractAddress, token)`
- category volume uses `price * amount` and ignores trades without usable price
- current holdings allocation aggregates `usdValue` by category and ignores `null` holdings values
- stablecoin trade share is volume-based, while memecoin and blue chip trade shares are trade-count-based
- holdings percentages are USD-allocation based and ignore holdings with unavailable `usdValue`

## 9. Main ingestion flow

This is the flow behind `GET /wallet/:address`.

### Step 1: validate address

The controller validates the Ethereum address.
Invalid input throws `BadRequestException`.

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
- classify the transaction as `transfer` or `swap`

### Step 5: save and return stored view

The service persists normalized transactions and then returns the stored representation.

This keeps the output stable regardless of the raw provider payload.

## 10. Transaction classification rules

Current rules are intentionally lightweight.

- inputs + outputs with different tokens => `swap`
- only one side present => `transfer`
- inputs + outputs of the same token => `transfer`

This works well for many common wallet events, but it is still a heuristic.

## 11. How live holdings work

`getHoldings()` is now served by `HybridHoldingsService`, not Moralis.

It fetches:

- native ETH balance via `provider.getBalance()` using the configured `ETH_RPC_URL`
- ERC-20 balances via batched Multicall3 `aggregate3()` calls in groups of 150

Token discovery:

1. `HybridHoldingsService` looks up `wallet_known_tokens` rows for the wallet address
2. if rows exist, their `contract_address` entries are used as the ERC-20 candidate list
3. if no rows exist, the service falls back to scanning stored `transactions` for token contract addresses, then asynchronously backfills the `wallet_known_tokens` table

Current behavior:

- convert raw balances using token decimals
- include native ETH as `ETH`
- exclude zero balances
- trim trailing zeros
- cache results in memory for 5 minutes per wallet address

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
2. current market prices from CoinGecko
3. normalized stored history for holding analytics and cost basis
4. stored swap transactions for traded-token signals used in tier classification

### Step 1: fetch live holdings

The service calls `getHoldings()`.

### Step 2: fetch current prices

The service fetches:

- current ERC-20 prices by contract address
- current ETH/USD price

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

The live balance from Moralis is treated as the current source of truth.
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

After all enriched metrics are computed, each portfolio item is passed to `classifyPortfolioTier()` together with the wallet's traded-token symbol set.

Tier rules:

**core** — assigned when any of the following are true:
- `usdValue > 0`
- `allocation > 0`
- `currentPrice` is present
- symbol is in the core allowlist: `ETH WETH USDC USDT DAI WBTC AAVE LINK UNI LDO OP ARB`

**hidden** — checked next, assigned when any of the following are true:
- token symbol contains a spam keyword: `claim`, `reward`, `receive at`, `visit`, `airdrop`, `bonus`, `free`
- token symbol length exceeds 20 characters
- token is fully unpriced (`priceUnavailable`, `allocation = 0`, `usdValue = null`) with no swap trade history and no match in the known-protocol contract map
- token amount is below the dust threshold (0.001) with no swap trade history and no known-protocol contract match

**secondary** — assigned to everything that is not core and not hidden:
- `priceUnavailable = true` AND (`SY-`/`YT-`/`PT-` prefix OR amount ≥ 0.001)

**fallback hidden** — any item that passes none of the above positive secondary conditions.

All raw fields are preserved on every item. `displayTier` and optionally `hiddenReason` are appended. No items are removed from the response.

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
- a global 15-second DefiLlama cooldown is engaged when 5 or more 429 responses are received within a 10-second window
- `HybridHoldingsService` maintains a 5-minute in-memory cache per wallet; a cache miss triggers a full RPC + Multicall3 refresh

## 19. Current assumptions and limits

### Ethereum only

The module currently assumes Ethereum mainnet behavior.

### Classification is heuristic

`transfer` vs `swap` detection is still rule-based.
Complex DeFi patterns may need more advanced classification later.

### Stored history is important

Portfolio analytics depend on normalized stored history for duration and cost basis.
If ingestion is incomplete, analytics may be partially missing even when live balances are available.

### Transfer-in cost basis is estimated, not proven

For transfers, we use historical market price at receive time when available.
This improves intelligence, but it is still an estimate rather than true executed basis.

### TypeORM sync mode

TypeORM is still running with development-friendly sync behavior.
Production should move to migrations.

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