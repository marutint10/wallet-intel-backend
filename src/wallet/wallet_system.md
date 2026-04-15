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
- return live on-chain holdings from Moralis balances endpoints
- return live enriched portfolio analytics
- return DB-backed reconstructed balances as a ledger view
- return wallet summary metrics
- return wallet context classification before higher-level scoring
- return wallet risk metrics
- return wallet hold-time metrics from completed FIFO trade lots
- return wallet activity metrics from stored trade history
- return aggregated wallet features combining summary and analytics views

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
- delegate risk, hold-time, and activity analytics to `WalletAnalyticsService`
- delegate wallet archetype/context detection to `WalletContextService`
- compose the unified wallet features response from existing service methods

### WalletAnalyticsService

This is the wallet-level analytics layer.

Responsibilities:

- compute risk metrics from realized trade PnL and portfolio concentration
- compute hold-time metrics from completed FIFO buy/sell lot matches only
- compute activity metrics from chronologically ordered stored trades
- expose reusable analytics methods for the facade and controller layer

### WalletContextService

This is the pre-scoring wallet context layer.

Responsibilities:

- detect whether an address behaves like an `EOA` or `Contract` from on-chain bytecode
- detect likely Gnosis Safe wallets with a Safe proxy bytecode heuristic when possible
- classify whether the wallet qualifies as a trader from summary swap count
- infer simple operational-treasury and bot-like subtypes from summary and activity metrics
- return reasoning and confidence for downstream scoring decisions

### WalletCoreService

This is the ingestion and normalization layer.

Responsibilities:

- configure the Moralis client
- fetch ERC-20 transfers and wallet history
- fetch live native and ERC-20 balances
- refresh only new blocks when DB data already exists
- normalize raw provider payloads into `NormalizedTransaction`
- persist normalized transactions into Postgres
- return stored normalized transactions
- expose transaction entities to downstream services
- build trade entries from normalized token amounts

### WalletPricingService

This is the pricing layer.

Responsibilities:

- fetch current ERC-20 prices from CoinGecko
- fetch current ETH/USD price from CoinGecko
- fetch historical trade prices from DefiLlama with CoinGecko fallback
- fetch historical transfer-in market prices from DefiLlama only
- infer one missing swap-leg price when the opposite side is priced

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

- fetch live raw holdings from Moralis balances endpoints
- compute the live enriched portfolio view
- compute the DB-backed reconstructed ledger view
- compute token flow and net flow from normalized history
- compute holding duration and cost basis analytics from FIFO lots
- compute current-price-based unrealized PnL and ROI

### Placeholder services

The following services still exist as placeholders for future architecture work:

- `PortfolioService`
- `PnlService`
- `ScoringService`
- `ClassificationService`

They are registered in the module but are not the main runtime path for current wallet analytics.

## 3. Module wiring

`WalletModule` registers:

- `WalletController`
- `WalletCoreService`
- `WalletPricingService`
- `WalletPnlService`
- `WalletPortfolioService`
- `WalletService`
- the placeholder services listed above
- the TypeORM repository for `TransactionEntity`

## 4. Configuration

Current config values:

- `PORT`
- `MORALIS_API_KEY`
- `COINGECKO_API_KEY`
- `ETH_RPC_URL`
- `DATABASE_URL`

The app is currently Ethereum-focused.
Moralis calls use `chain: 'eth'`.

## 5. External providers and how we use them

### Moralis

Moralis is used for both history ingestion and live holdings.

Current usage:

- ERC-20 transfers
- wallet history for native ETH transfers
- native balance endpoint
- ERC-20 balances endpoint

Moralis is the source for blockchain activity and current on-chain balances.

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
- `decimals?`
- `contractAddress?`

Important note:

- `pnl` and `roi` on this endpoint are unrealized metrics for the current remaining position
- when live pricing is unavailable, `currentPrice`, `usdValue`, `pnl`, and `roi` return `null`, and `priceUnavailable` returns `true`

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

`getHoldings()` does not reconstruct balances from DB.

It fetches:

- native ETH balance from Moralis native balance endpoint
- ERC-20 balances from Moralis ERC-20 balances endpoint

Current behavior:

- convert raw balances using token decimals
- include native ETH as `ETH`
- exclude zero balances
- trim trailing zeros

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

It combines three inputs:

1. live balances from Moralis
2. current market prices from CoinGecko
3. normalized stored history for holding analytics and cost basis

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
- cached DB data is used when refresh fails
- missing historical trade pricing can remain `0`, and one missing swap leg may still be inferred from its priced counterpart
- live holdings pricing failures do not force zero-valued market fields; portfolio items return `null` market-derived values and `priceUnavailable = true`
- transfer-in estimated basis falls back to `null` when unsupported
- duplicate inserts are ignored safely

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
4. `src/wallet/services/wallet-pricing.service.ts`
5. `src/wallet/services/wallet-pnl.service.ts`
6. `src/wallet/services/wallet-analytics.service.ts`
7. `src/wallet/services/wallet-portfolio.service.ts`
8. `src/wallet/transaction.entity.ts`
9. `src/wallet/wallet.types.ts`

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

This document should describe the current implementation, not an older version and not a future design.