# Wallet System

This file explains how the wallet module works in simple words.

The goal is to keep this as a living document.
Whenever we add or change wallet logic, we should update this file so another developer can understand the system quickly.

## 1. What this module does

The wallet module reads wallet activity from external APIs, converts it into our own clean format, stores it in Postgres, and then builds useful wallet views on top of that data.

Today the module can do these things:

- fetch wallet transaction history
- normalize raw blockchain data into one internal transaction format
- store normalized transactions in the database
- return stored transactions
- classify transactions as transfer or swap
- build trades from swaps
- add historical prices to trades
- infer a missing swap price from the priced counterpart trade
- calculate FIFO-based realized PnL per token
- compute token flow, net flow, portfolio, and portfolio USD value
- return a wallet summary

## 2. Main idea of the architecture

We use one main service for the whole wallet system.

High-level flow:

1. Client calls a wallet API route.
2. Controller validates the wallet address.
3. Controller calls WalletService.
4. WalletService either:
   - fetches fresh data from Moralis and stores normalized results, or
   - falls back to already stored data from Postgres.
5. WalletService builds higher-level outputs from stored normalized transactions.

This means the database is our internal source of truth after normalization.
External APIs are only used to fetch raw data and price information.

## 3. Folder overview

### wallet.module.ts

Registers the wallet controller, wallet service, and TypeORM repository for the transactions table.

### wallet.controller.ts

Defines the HTTP endpoints under `/wallet`.
It only does light work:

- validate Ethereum address
- call the correct service method
- return the response

Business logic stays in the service.

### wallet.service.ts

This is the core of the system.
It handles:

- fetching raw wallet data from Moralis
- retry and fallback behavior
- transaction normalization
- transaction type detection
- database persistence
- trade building
- trade pricing
- FIFO realized PnL calculation
- portfolio and summary calculations

### transaction.entity.ts

Defines the `transactions` table.
Each row is one normalized blockchain transaction for one wallet.

Important stored fields:

- wallet address
- transaction hash
- block number
- timestamp
- from address
- to address
- type: `transfer` or `swap`
- inputs: tokens that left the wallet
- outputs: tokens that entered the wallet

### wallet.types.ts

Defines the shared response and data types used by the controller and service.

## 4. App-level wiring

The wallet module is loaded by `AppModule`.

Important app pieces:

- `ConfigModule` loads env-based configuration
- `TypeOrmModule` connects to Postgres
- `WalletModule` adds wallet APIs

Current config values:

- `PORT`
- `MORALIS_API_KEY`
- `COINGECKO_API_KEY`
- `DATABASE_URL`

The app starts in `main.ts` with CORS enabled.

## 5. External services we use

### Moralis

Moralis is the main source for raw wallet history.

We use it to fetch:

- ERC-20 transfers
- wallet history for native ETH transfers

Moralis is used only for raw transaction data.

### DeFi Llama

DeFi Llama is the first source for historical token pricing in `getPricedTrades`.

### CoinGecko

CoinGecko is used in two ways:

- portfolio spot prices for current USD values
- fallback historical prices when DeFi Llama has no historical price

## 6. Database model

The `transactions` table stores normalized wallet transactions.

Why we store normalized data:

- raw API data is noisy and provider-specific
- normalized data is easier to query and reuse
- most wallet analytics can run from DB without calling Moralis again

Important database rules:

- one row per wallet + transaction hash
- unique constraint prevents duplicate saves
- `inputs` and `outputs` are stored as JSONB arrays

## 7. Core data model

### NormalizedTransaction

This is our internal transaction shape.

- `inputs` means tokens leaving the wallet
- `outputs` means tokens entering the wallet
- `type` is decided after normalization

### Trade

A trade is created only from swap transactions.

- swap input entries become `SELL` trades
- swap output entries become `BUY` trades

Each trade has:

- token
- buy/sell type
- normalized amount
- decimals
- contract address
- unix timestamp

### PricedTrade

This is just a trade plus a `price` field.

## 8. Endpoints and what each one returns

### GET /wallet/:address

Main ingestion endpoint.

What it does:

1. checks if we already have transactions in DB
2. if yes, checks Moralis for newer blocks
3. fetches only new data when possible
4. normalizes and stores new transactions
5. returns stored normalized transactions

If Moralis is down and we already have cached data, the system falls back to DB.

### GET /wallet/:address/stored

Returns stored normalized transactions only.
No fresh fetch is done here.

### GET /wallet/:address/summary

Builds a simple summary from stored transactions.

Returns:

- total transactions
- total swaps
- total transfers
- number of unique tokens touched

### GET /wallet/:address/token-flow

Builds token in/out totals from stored transactions.

### GET /wallet/:address/net-flow

Returns `in - out` for each token.

### GET /wallet/:address/portfolio

Returns human-readable token balances from net flow.

### GET /wallet/:address/usd

Adds current USD prices to the portfolio view.

### GET /wallet/:address/trades

Builds trades from stored swap transactions.

### GET /wallet/:address/priced-trades

Builds trades and then adds historical prices.

### GET /wallet/:address/pnl

Builds FIFO-based realized PnL from priced trades.

### Service method: getPnL(address)

Builds FIFO-based realized PnL from priced trades.

It returns data in this shape:

- token => `{ realizedPnL }`

## 9. Detailed request flow for the main wallet endpoint

This is the most important system flow.

### Step 1: validate address

The controller checks if the input is a valid Ethereum address.
If invalid, it throws `BadRequestException`.

### Step 2: check latest stored block

The service checks the newest block number already stored for that wallet.

Two cases:

- no stored data exists yet
- stored data already exists

### Step 3: fetch from Moralis

If stored data exists, we first fetch only the latest page from Moralis.
This is a quick freshness check.

If Moralis has no newer block than what we already stored, we return DB data directly.

If Moralis has newer blocks, we fetch only transactions above the latest stored block.

If no stored data exists, we fetch the full wallet history.

### Step 4: normalize raw data

Moralis returns ERC-20 transfers and native transfers in different formats.
We convert both into one common internal shape.

During normalization we:

- group entries by transaction hash
- create one `NormalizedTransaction` per hash
- push outgoing assets into `inputs`
- push incoming assets into `outputs`
- merge repeated token entries inside the same transaction
- decide if the transaction is a `transfer` or `swap`

### Step 5: detect transaction type

Rules used now:

- if a transaction has both inputs and outputs and the tokens are different, it is a `swap`
- if it only has one side, it is a `transfer`
- if it has both sides but the token is the same on both sides, it is treated as a `transfer`

### Step 6: save normalized transactions

The system stores normalized transactions into Postgres.
Duplicate inserts are ignored because of the unique wallet+hash constraint.

### Step 7: return stored view

After saving, the endpoint returns data from the database, not directly from raw API output.

This keeps response shape consistent.

## 10. How transfer direction is decided

Direction is based on wallet address comparison.

- if the wallet is the sender, the token goes to `inputs`
- if the wallet is the receiver, the token goes to `outputs`

For native transfers, Moralis may already provide direction info.
If present, we use it.

## 11. How trades are built

Trades are built only from normalized transactions whose type is `swap`.

For each swap transaction:

- every input token becomes a `SELL` trade
- every output token becomes a `BUY` trade

Amounts are converted from raw integer units into human-readable token amounts using token decimals.

Example:

- input: 100 USDC
- output: 0.04 ETH

This becomes:

- SELL 100 USDC
- BUY 0.04 ETH

Both trades share the same timestamp because they come from the same swap.

## 12. How historical pricing works

`getPricedTrades()` does pricing in two stages.

### Stage 1: direct historical price lookup

For each trade:

1. try DeFi Llama historical price
2. if not found, try CoinGecko historical fallback for supported tokens
3. if still not found, keep price as `0`

There is also a simple in-memory cache inside the request so the same token+timestamp is not priced many times.

### Stage 2: infer missing swap price from counterpart trade

Some swaps have one priced side and one unpriced side.
This usually happens when the market data provider has no listing for one token.

We now handle that case after direct pricing.

Logic:

1. group priced trades by timestamp
2. treat a valid swap pair as exactly two trades at that timestamp
3. ensure one is `BUY` and one is `SELL`
4. only continue if exactly one trade has price `0`
5. compute the known USD value
6. infer the missing side price from the other side

Formula:

- `knownUsdValue = knownTrade.amount * knownTrade.price`
- `missingPrice = knownUsdValue / missingTrade.amount`

When we do nothing:

- both sides already have prices
- both sides are missing prices
- there are not exactly two trades at that timestamp
- both trades are the same type
- amount is invalid or zero

This keeps the inference conservative and avoids accidental bad pricing.

## 13. How FIFO realized PnL works

`getPnL()` uses the output of `getPricedTrades()`.

Important rule:

- trades are processed oldest to newest

For each token, the system keeps a FIFO buy queue.

Each buy lot stores:

- amount
- price

### On BUY

The buy lot is pushed into that token's queue.

### On SELL

The sell amount is matched against the oldest buy lots first.

For each match:

- `matchedAmount = min(sellAmount, oldestBuy.amount)`
- `pnl += (sellPrice - buyPrice) * matchedAmount`

Then:

- reduce the oldest buy amount
- reduce the remaining sell amount
- remove the buy lot if it is fully consumed

### Edge behavior

- if a sell happens before any buy, the unmatched sell is skipped safely
- partial sells are handled by reducing the oldest lot and continuing only if needed
- unrealized PnL is not calculated here
- average-cost logic is not used here

This means the current PnL engine is strictly realized FIFO PnL.

## 14. How portfolio and USD views work

The flow is layered.

### Token flow

For every token we track:

- total incoming amount
- total outgoing amount

### Net flow

Net flow is:

- `in - out`

### Portfolio

Portfolio converts net flow into human-readable token balances.

### Portfolio USD

Portfolio USD takes the portfolio balances and multiplies them by current token prices.

Current rules:

- ETH uses Ethereum price lookup
- ERC-20 tokens use contract-address-based CoinGecko lookup
- if no price is found, USD value becomes `0`

## 15. Reliability and fallback behavior

The system is built to keep working even when external APIs are unstable.

Current protections:

- Moralis client has timeout configured
- paginated fetch has retry once behavior
- if refresh fails and cached DB data exists, we return DB data
- if pricing fails, we return zero prices instead of crashing the whole request
- duplicate transaction saves are ignored safely

This is important because wallet analytics depends on third-party providers.

## 16. Current assumptions and limits

These are important for future developers.

### Chain support

Right now the Moralis fetch uses `chain: 'eth'`.
So this module is currently Ethereum-focused.

### Transaction classification is simple

The current `transfer` vs `swap` detection is rule-based and lightweight.
It works for many standard cases, but not all complex DeFi patterns.

### Historical price coverage is incomplete

Some tokens will still have no direct market listing.
We partly solve this with counterpart price inference for simple 2-leg swaps.

### Pricing inference is conservative

We only infer when there is a clear one-known one-missing pair.
This avoids incorrect prices for complex transactions.

### Realized PnL depends on historical prices

FIFO PnL is only as good as the trade prices feeding into it.
If a token still has no usable historical price, that trade will not contribute useful PnL.

### Database sync mode

TypeORM is using `synchronize: true` right now.
That is convenient during early development, but in a mature production setup we should move to migrations.

## 17. How to extend this module safely

If you add new wallet features, follow this order:

1. decide whether the feature should use raw provider data or normalized DB data
2. prefer building new analytics on top of normalized stored transactions
3. if you change normalization rules, check all downstream endpoints
4. if you add a new transaction type or trade rule, update this document
5. if you add new pricing logic, document the exact fallback order

## 18. Suggested mental model for new developers

If you are new to this codebase, think of the wallet system in 3 layers:

### Layer 1: ingestion

Fetch raw wallet activity from providers.

### Layer 2: normalization and storage

Convert raw provider-specific data into our internal format and store it.

### Layer 3: analytics

Build trades, pricing, FIFO PnL, flows, balances, and summaries from stored normalized data.

If you understand these 3 layers, the whole module becomes much easier to work with.

## 19. Files a developer should read first

If someone joins the project, this is the best reading order:

1. `src/wallet/wallet.controller.ts`
2. `src/wallet/wallet.service.ts`
3. `src/wallet/transaction.entity.ts`
4. `src/wallet/wallet.types.ts`
5. `src/app.module.ts`
6. `src/config/configuration.ts`

## 20. Update rule for this document

Whenever we change any of the below, update this file in the same PR or task:

- endpoint behavior
- normalization rules
- transaction classification logic
- pricing logic
- PnL logic
- external provider usage
- database schema for wallet data
- portfolio or summary calculations

This document should always explain the current system, not the intended future system.