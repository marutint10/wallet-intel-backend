# Token System Design

This document explains the token module as it exists today.

It should be treated as a living architecture note.
If token behavior changes, this file should be updated in the same task.

## Recent changes (B2B holder intelligence pass)

Summary of the latest scoring, classification, and triage work (May 2026):

| Area | Change |
|------|--------|
| **Score bands (active)** | Day-trader labels replaced: Institutional / Premium / Strong / Solid / Developing |
| **Passive scoring** | `scoreHolderPortfolio` via `holder-scoring.engine`: quality 35, conviction 30, assetSelection 20, capitalScale 10, longevity 5 (0–100, Institutional/Premium eligible) |
| **Whale floors** | Portfolio USD ≥ $1M → min score **45**; ≥ $100K → min **30** |
| **Conviction floor** | Band **Conviction** (18/25); triggers at `trackedWeight ≥ 95%` OR (`≥ 80%` and `totalHoldingTokens ≤ 3`) for gas/airdrop side holdings |
| **Passive labels** | Passive Holder / Passive Investor → **Conviction Holder** / **Strategic Allocator** |
| **Unprofiled holders** | Insufficient Data → **Dormant Wallet** (classify + score band); dashboard shows `score: null` via `UNSCORED_SCORE_BANDS` |
| **Exchange triage** | Shared `known-exchange-addresses.ts`; production uses **TokenIntelligenceService** (not `WalletFilterService`); OKX Cold Wallet tagged |

**Source files touched:**

- `src/token/services/lite-scorer.service.ts` — B2B bands, `scorePortfolioOnly`, `UNSCORED_SCORE_BANDS`
- `src/token/services/lite-classifier.service.ts` — passive labels, Dormant Wallet gate
- `src/token/services/lite-feature.service.ts` — `hasPortfolioContext`, `withHoldingsProfile`, `trackedTokenCategory`
- `src/token/constants/known-exchange-addresses.ts` — canonical exchange map
- `src/token/services/token-intelligence.service.ts` — `lookupKnownExchange` in static triage
- `src/token/services/wallet-filter.service.ts` — delegates to shared exchange registry
- `src/token/services/holder-aggregation.service.ts` — EOA breakdown (`breakdown` + `breakdown.counts`), smart-money portfolio signal, composite `qualityLabel`
- `src/token/services/dashboard-summary.service.ts` — `UNSCORED_SCORE_BANDS`, `resolveQualityBreakdown`, circulating supply basis, `convictionHolders` / `dormant` breakdown buckets
- `src/token/services/token-analysis.service.ts` — passes token contract into `extractFeatures`

**Legacy vocabulary (persisted rows only):**

| Old | New |
|-----|-----|
| Elite Smart Money / Strong Trader / Good Trader / Average / Weak / Risky | Institutional / Premium / Strong / Solid / Developing |
| Passive Holder / Passive Investor | Conviction Holder / Strategic Allocator |
| Insufficient Data (classify or band) | Dormant Wallet |
| band Average on all-in floor | band **Conviction** |

Re-run `POST /token/analyze` after code or registry changes; cached `token_analyses` JSON does not self-update.

### Dashboard aggregation & portfolio fixes (May 2026)

| Area | Change |
|------|--------|
| **Smart Money (FAST_MODE)** | `pnlAggregation.portfolioSmartMoneyCount` — Diversified Whale ≥ $500K, $1M+ portfolio + score ≥ 40, or score ≥ 75; dashboard uses PnL count first, then portfolio count, then score fallback |
| **qualityMetrics.breakdown** | Single schema: behavioral keys are **% of analyzed EOAs** (largest-remainder, sum 100); raw counts in `breakdown.counts` (sum `totalAnalyzedEOAs`); structural keys (`exchanges`, `contractsPools`, …) are **% of all top holders** |
| **EOA behavioral set** | Breakdown loop uses `walletLabel === 'eoa'` or `team_connected` only; passive archetypes in `convictionHolders`; Swing/Day/Accumulator in `activeTraders`; Dormant / null / Insufficient Data in `dormant` |
| **categoryConcentration.eoaHolders** | `avgScore` matches `qualityMetrics.avgScore` (scored EOAs only, excludes Dormant zeros); adds `scoredCount` |
| **qualityLabel** | Composite: boosts/penalizes from loyalty % (conviction + diamond + active trader) vs degen+bot % before banding |
| **trackedTokenWeight** | Ecosystem USD = tracked token + derivative symbols (`st{SYM}`, `w{SYM}`, `{SYM}.e`, `{SYM}x`) + optional staking contract addresses from top-holder list |
| **percentSupply** | Prefers `circulatingSupply`, fallback `totalSupply`; holder rows expose `percentSupplyBasis`; `token.circulatingSupply` on dashboard DTO |
| **Etherscan contract names** | L1 memory + L2 `@nestjs/cache-manager` (24h, key `token:contract-name:{chainId}:{address}`); **only successful names cached** — rate-limit/API failures are not cached so treasury/keyword labels can recover on retry |
| **Dashboard resolver** | `resolveQualityBreakdown()` reads `breakdown.counts`, legacy `breakdownCounts`, detects legacy rows that stored counts in `breakdown` top-level |

**Source files (this pass):**

- `src/token/services/holder-aggregation.service.ts`
- `src/token/services/dashboard-summary.service.ts`
- `src/token/services/lite-portfolio.service.ts`
- `src/token/services/token-analysis.service.ts` — passes `tokenMetadata.symbol`, staking-contract set into portfolio
- `src/token/services/token-intelligence.service.ts` — persistent contract-name cache

**Known follow-up (not implemented):** portfolio-concentration Degen boost when `swapCount < 10` and `tradesPerDay < 0.05` (e.g. rank-36 edge case after staked-weight fix).

### Retail-scoped distribution & quality (May 2026)

| Area | Change |
|------|--------|
| **Holder buckets** | `holder-classification.ts` — `bucketHolder()` maps each holder to `retail` \| `exchange` \| `contract` \| `team` \| `burn` \| `lp` |
| **Distribution** | Headline Gini, decentralization, top10/50/100 % computed on **retail only**; `supplyBreakdown` shows % of total supply per bucket; `raw.*` keeps legacy all-holder view |
| **Quality** | `avgScore` and behavioral breakdown use **retail** EOAs only (`eoa`, not `team_connected`); adds `scoringBase`, `classificationBreakdown`, `classifiableRetailCount` |
| **Risk callouts** | Exchange-heavy supply → neutral info; concentration warnings use retail top-10; removed “low retail %” as a warning when CEX % is high |
| **Replay** | `npm run token:replay-aggregation` — reprocesses `holders_data` JSONB without Moralis refetch |

### Holder classify + score decision tree

```
For each top holder (after TokenIntelligenceService Phase 2):
│
├─ shouldAnalyze = false (exchange, burn, dust, router, …)
│    → walletLabel set, classification = null, score = null
│    → counts toward Exchange Allocation / category buckets, not avgScore
│
└─ shouldAnalyze = true (typically EOA)
     → transfers → extractFeatures(..., holdingsProfile?, fastMode, tokenContractAddress)
     │
     ├─ swapCount < 3
     │    ├─ hasPortfolioContext(features) = false
     │    │    → classify: Dormant Wallet
     │    │    → score: 0, band Dormant Wallet (dashboard score null)
     │    │
     │    └─ hasPortfolioContext = true  [rank ≤ 100, portfolio fetched]
     │         → classifyPassiveHolder() → Diversified Whale | Conviction Holder | Strategic Allocator
     │         → scorePortfolioOnly()
     │              ├─ conviction floor (≥95% weight OR ≥80% + ≤3 tokens) → band Conviction, 18|25
     │              └─ else formula (quality+quantity)×multiplier + whale floors → Strong|Solid|Developing (cap 60)
     │
     └─ swapCount ≥ 3
          → standard archetype classify + 0–100 score + full SCORE_BANDS
```

### Expected passive score outcomes (illustrative)

| Holder profile | Typical band | Notes |
|----------------|--------------|-------|
| ~$95M diversified whale, low tracked % | Solid (~48–53) | Max quantity points + full multiplier |
| ~$6.8M whale, moderate quality | Solid / Strong (up to 60) | Whale floor may lift to 45+ |
| All-in holder, ≥80% weight, ≤3 tokens | **Conviction** (18–25) | Bypasses formula |
| ~$5 dust wallet, clean % mix | Developing (~6–9) | `sizeMultiplier` 0.35 at &lt;$10 portfolio |
| Rank &gt; 100, no portfolio fetch | Dormant Wallet | No `hasPortfolioContext` |
| OKX Cold Wallet `0x611f…` | (none) | `walletLabel: exchange`, skipped |

## 1. What we built so far

The token module currently has four cooperating layers:

1. wallet-level lite analytics (transfers → features → classification → score)
2. token-level holder intelligence (top holders → holder analytics → aggregate token report)
3. dashboard presentation (pure reshape of `TokenAnalysisEntity` → `DashboardSummaryResponse`, plus optional Gemini short summary)
4. optional token deep analysis (Tavily web search + Claude structured JSON, persisted in `token_deep_analyses`, separate from the core analysis pipeline)

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
- classify passive holders (no DEX swaps) from portfolio context: Diversified Whale, Conviction Holder, Strategic Allocator when `hasPortfolioContext` is true (top 100); otherwise **Dormant Wallet**
- score wallet quality on a fixed 0-100 scale with institutional B2B bands; portfolio-only path capped at 60, blends percentage quality with absolute capital quantity + wallet-style size multiplier, conviction floor band for all-in holders
- active traders without PnL: experience (1.5×) and portfolioQuality (1.3×) boost replace the profitability slice
- aggregate analyzed holder results into token-level quality/distribution/risk callouts
- attach current USD price and per-holder usdValue to holder rows
- compute portfolio context for top holders via Alchemy balances + native balance + batch pricing
- batch price portfolio holdings via DefiLlama (primary) with CoinGecko fallback only for misses; every batch fetch has a 10s AbortController timeout and structured error logging
- compute lite realized PnL from detected swaps and feed profitability into classification/scoring (active only when FAST_MODE is disabled)
- run full token analysis asynchronously and persist output in Postgres with reliably populated tokenName / tokenSymbol metadata
- expose polling endpoints to fetch analysis status and final result
- triage every top holder via `TokenIntelligenceService` (static exchange registry, contract detection, team links) before lite analytics run
- provide an advanced token intelligence service for holder labeling, team-link detection, and richer token metadata collection
- expose `GET /token/:address/dashboard` for a frontend-ready dashboard DTO, including an `aiSummary` plain-text line produced by Gemini (cached via `@nestjs/cache-manager`, deterministic fallback when the key is missing or the model fails)
- expose `GET /api/export-pdf/:tokenId` to render a print-optimized frontend route via Puppeteer and stream an A4 PDF (`printBackground: true` for dark mode)
- expose async token **deep analysis**: trigger + poll endpoints backed by `token_deep_analyses` (parallel Tavily searches, Claude Sonnet JSON report, 48-hour freshness cache on completed rows; never blocks or breaks the main token analysis pipeline)

Important boundary:

- the new token analytics stack is self-contained in the token module and does not import the wallet module runtime path

### B2B vocabulary quick reference

| Layer | Labels / bands |
|-------|----------------|
| **Active-trader score bands** (0–100) | Institutional (90+), Premium (75+), Strong (60+), Solid (40+), Developing (&lt;40) |
| **Portfolio-only score bands** (cap 60) | Strong (60), Solid (40–59), Developing (&lt;40); **Conviction** (18–25 all-in floor) |
| **Unscored** (`UNSCORED_SCORE_BANDS`) | Dormant Wallet — dashboard `score: null`; legacy Insufficient Data rows treated the same |
| **Passive classification** | Diversified Whale, Conviction Holder, Strategic Allocator |
| **Structural classification** | Dormant Wallet (no DEX swaps, no portfolio context) |
| **Exchange triage** | `walletLabel: exchange` via `known-exchange-addresses.ts` — skips lite classify/score |

## 2. Architecture

### TokenController

File: src/token/token.controller.ts

Owns HTTP routes under /token.

Responsibilities:

- expose debug and verification endpoints for each lite stage
- expose production async analysis start endpoint
- expose polling endpoint for persisted analysis results
- expose `GET /token/:address/dashboard` (dashboard DTO + AI summary) when analysis is `done`
- expose `POST /token/:address/deep-analysis/trigger` and `GET /token/:address/deep-analysis` for optional deep research (EVM `0x` + 40 hex validation on these routes)

### TokenAnalysisService (orchestrator)

File: src/token/services/token-analysis.service.ts

This is the production pipeline coordinator.

Responsibilities:

- initialize/refresh token_analyses row with status=processing
- run analysis in background without blocking request thread
- fetch top holders for the token
- fetch current token price once per analysis
- **Phase 1:** `TokenIntelligenceService.getTokenMetadata` (deployer, owner, liquidity, supply)
- **Phase 2:** `TokenIntelligenceService.classifyHolders` — labels every holder; known exchanges/contracts/burn/dust get `shouldAnalyze: false`
- **Phase 3:** batch lite pipeline only for holders that pass triage (`shouldAnalyze: true`, typically `walletLabel: eoa`)
- enrich holder rows with usdValue, portfolio context for all top 100 holders (except CEX labels), and (when not FAST_MODE) lite PnL summaries
- aggregate holder-level analytics into token-level metrics
- persist status done/error and payload into token_analyses, including defensively-nullable tokenName / tokenSymbol

Holder row outcomes after triage:

| `shouldAnalyze` | `walletLabel` examples | lite classify/score | persisted fields |
|-----------------|------------------------|---------------------|------------------|
| `false` | `exchange`, `cex_deposit`, `burn`, `dust`, `dex_router`, … | skipped | `classification: null`, `score: null` |
| `true` | `eoa` (and team-linked EOAs) | full or passive path | populated when pipeline succeeds |

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

### Known exchange registry

File: src/token/constants/known-exchange-addresses.ts

- single canonical `KNOWN_EXCHANGE_ADDRESSES` map (**all keys lowercase**)
- `lookupKnownExchange(address)` — `.trim().toLowerCase()` before every lookup (checksum-safe)
- `isKnownExchangeAddress(address)` — boolean helper for skip lists
- **production path:** `TokenIntelligenceService.classifyByStaticRules` calls `lookupKnownExchange` first; match → `walletLabel: exchange`, `shouldAnalyze: false`, `labelConfidence: 99`
- notable entry: `0x611f7bf868a6212f871e89f7e44684045ddfb09d` → OKX Cold Wallet
- also imported by `WalletFilterService` (debug/legacy; not used by `POST /token/analyze`)
- **adding a new exchange:** update this file only, then **re-run** `POST /token/analyze` — cached `token_analyses` rows keep old labels until refreshed

### TokenIntelligenceService

File: src/token/services/token-intelligence.service.ts

Responsibilities (production pre-analysis layer):

- `getTokenMetadata(contract, chain)` — DexScreener, Alchemy RPC, Etherscan deployer, CoinGecko fallback
- `classifyHolders(holders, tokenMetadata, chain)` — returns `Map<lowercaseAddress, HolderFilterResult>` plus `teamDetection`
- static triage order in `classifyByStaticRules` (all addresses normalized to lowercase):
  1. burn addresses
  2. **known exchanges** (`lookupKnownExchange`)
  3. known DEX routers / bridges
  4. dust (`usdValue < 10`)
  5. deployer / owner matches
  6. else → async contract-name / eth_getCode heuristics for vesting, treasury, staking, generic contracts
- evidence fields on every label: `labelConfidence`, `labelEvidence[]`, `teamConnectionScore`, optional `teamConnectionPath`
- team detection: seed transfers from deployer/owner/treasury + Etherscan counterparty scan against top holders
- **contract name resolution** (`getContractName`): Etherscan `getsourcecode` → `ContractName`; used for treasury/vesting/staking keyword labels and `knownLabel` on `generic_contract` rows
  - **L1:** in-process map of successful names only (per `chainId:address`)
  - **L2:** `@nestjs/cache-manager`, key `token:contract-name:{chainId}:{address}`, TTL **24h**
  - **Not cached:** HTTP errors, empty responses, or missing API key — next run or same-run retry can succeed (avoids locking treasury wallets as generic_contract after a rate limit)

Holder labels (`HolderLabel`):

- `eoa`, `exchange`, `cex_deposit`, `dex_router`, `dex_pool`, `bridge`, `burn`, `vesting`, `treasury`, `staking`, `generic_contract`, `deployer`, `owner`, `team_connected`, `dust`

Integration:

- `TokenAnalysisService` Phase 2 runs before any per-wallet transfer fetch
- exchange/cex_deposit-labeled holders never hit `LiteClassifierService` / `LiteScorerService`, keep `portfolio: null` by design, and still appear in `holders_data` + exchange allocation metrics

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

- `extractFeatures(transfers, walletAddress, chain, holdingTokenCount?, holdingChainCount?, holdingsProfile?, fastMode = false, trackedTokenContractAddress?)`
- `extractSwaps(transfers, walletAddress)` - unchanged, used only when FAST_MODE is disabled (for PnL input)
- `hasPortfolioContext(features)` - exported helper; true when any of: `totalPortfolioUsd > 0`; any `holdingCategoryMix` bucket &gt; 0; or both `trackedTokenWeight` and `portfolioDiversificationScore` are numbers (portfolio merge ran). False without portfolio fetch (e.g. exchange labels) → passive path falls through to **Dormant Wallet**

Hold-time strategy depends on fastMode:

- `fastMode = false` (default): full FIFO lot matching via `computeHoldTimes` over detected swap pairs - produces accurate per-position hold durations and `matchedLotCount`
- `fastMode = true`: O(N) per-token first/last-seen span estimator (`estimateLightweightHoldHours`) plus a round-trip-token proxy for `matchedLotCount` (`countRoundTripTokens`) - tolerates truncated transfer history and avoids the O(swaps * tokens) FIFO work

Derived features (always populated when transfers exist):

- `walletAgeDays` - seconds since oldest observed transfer, in days
- `daysSinceLastActivity` - seconds since newest observed transfer, in days
- `activityConsistencyScore` (0-100) - derived from burstiness + sustained-span signals; higher means steadier cadence
- `portfolioConcentrationScore` (0-100) - derived from max weight across trackedTokenWeight + topHoldings
- `fastModeApplied` - boolean flag echoed on the feature vector so downstream consumers can detect which path produced the row

Portfolio enrichment (`withHoldingsProfile`):

- all portfolio fields are merged in one private helper so classifier/scorer gates see consistent data on both paths (zero transfers and full transfer history)
- when `holdingsProfile` is present, copies `categoryAllocations` → `holdingCategoryMix`, plus `totalPortfolioUsd`, `trackedTokenWeight`, `portfolioDiversificationScore`, `portfolioRiskSignal`
- when `trackedTokenContractAddress` is provided (production: token contract from `TokenAnalysisService`), sets `trackedTokenCategory` via `classifyTokenCategory(contract, symbol, chain)` so the scorer can subtract the analyzed token from its category bucket (typically `other` for unmapped tokens)

Optional holdings-based fields on `LiteFeatureVector` (top 100 holders with portfolio):

- `totalPortfolioUsd`, `trackedTokenWeight`, `portfolioDiversificationScore`, `holdingCategoryMix`, `portfolioRiskSignal`, `trackedTokenCategory`

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
  - Diversified Whale (passive / portfolio-only path)
  - Conviction Holder (passive / portfolio-only path)
  - Strategic Allocator (passive / portfolio-only path)
  - Dormant Wallet (structural: no DEX swaps and no portfolio context)
- return primary/secondary type, confidence, and human-readable reasoning
- portfolio-aware classification signals when HoldingsProfile data is available
- Degen is boosted by high meme allocation, extreme tracked-token concentration, and high portfolioConcentrationScore
- Diamond Hand and Accumulator are boosted by bluechip-heavy, diversified portfolios; Diamond Hand also boosted by walletAgeDays >= 365 with daysSinceLastActivity <= 60
- Bot / Automated is boosted by high activityConsistencyScore combined with tradesPerDay > 3
- PnL boosts (Smart Money, Paper Hand) apply opportunistically only when realized trades are available; they are NEVER required for a classification
- all portfolio signals are optional and skipped gracefully when holdings data is unavailable

Gating:

- when `swapCount < 3` and no usable PnL:
  - if `hasPortfolioContext(features)` → `classifyPassiveHolder()` (top-100 holders with portfolio fetch)
  - else → **Dormant Wallet** (`primaryScore: 0`, reasoning explains absent DEX profile)
- when `swapCount >= 3` (or usable PnL): standard archetype scoring (matchedLotCount is no longer part of the gate)

Passive holder rules (`classifyPassiveHolder`, evaluated in order):

| Label | Conditions |
|-------|------------|
| Diversified Whale | `(totalPortfolioUsd > 5M && trackedWeight < 30%)` OR `(totalPortfolioUsd > 500K && trackedWeight < 20% && diversification > 50)` OR `(totalPortfolioUsd > 1M && trackedWeight < 30% && bluechip > 50%)` |
| Conviction Holder | `trackedWeight >= 80%` |
| Strategic Allocator | `diversification > 30 && trackedWeight < 50%` |
| Conviction Holder (default) | else |

Passive confidence:

- Conviction Holder and Strategic Allocator: `medium` when `totalPortfolioUsd > 1M`, else `low`
- Diversified Whale always returns `medium`

Confidence (active traders, `swapCount >= 3`):

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
- portfolioQuality uses real holdings data when available: diversification score, category quality from **adjusted** category mix, stablecoin reserve bonus, token-count balance, and softened concentration adjustment
- category quality (Improvement 1): `buildAdjustedCategoryMix()` subtracts `trackedTokenWeight` from `trackedTokenCategory` bucket (default `other`) before computing bluechip+defi+infrastructure as a share of `(100 - trackedWeight)` — avoids penalizing holders who are mostly in the analyzed token
- concentration (B2B): `trackedWeight > 80%` → -2 (not -10); `> 50%` → -1; conviction bonus +5 when `trackedWeight > 80%` and `walletAgeDays > 90`
- riskManagement includes portfolio risk signal adjustment on active path (`conservative`/`balanced` bonus, `degen` penalty on active-trader scoring); portfolio-only path uses `aggressive` −3 instead
- exports `UNSCORED_SCORE_BANDS` (`Dormant Wallet`, legacy `Insufficient Data`) for `DashboardSummaryService` null-score handling
- consistency and activity dimensions use `Math.max(matchedLotCount, swapCount)` (or `swapCount/2` for activity) so FAST_MODE wallets without FIFO still earn full points from raw swap evidence
- falls back to placeholder-based scoring when holdings data is unavailable (typically ranks beyond portfolio limit)

Portfolio-only path (`scorePortfolioOnly`, when `swapCount < 3` and `hasPortfolioContext`):

Blends **percentage quality** with **absolute capital quantity** (B2B founders care about dollars commanded, not allocation % alone).

1. **Conviction floor** (bypasses formula): when `trackedWeight >= 95%` OR (`trackedWeight >= 80%` and (`!holdingCategoryMix` or `totalHoldingTokens <= 3`)), returns score **18** or **25** (`walletAgeDays > 180`), band **Conviction** — allows gas-token side holdings; ultra-concentrated holders skip generic scoring.

2. **Percentage dimensions:**
   - `portfolioQualityRaw` from `scorePortfolioQuality()` (0-100)
   - `riskManagementRaw` base 10; +5 conservative/balanced; -3 aggressive
   - `experiencePoints`: 8 if `walletAgeDays > 365`, 5 if `> 180`, else 0

3. **Quantity dimension** (`scorePortfolioQuantityPoints`, max **12**):
   - **Total wealth** (`totalPortfolioUsd`): >$1M +6, >$100K +4, >$10K +2, >$1K +1
   - **Tracked position USD** (`totalPortfolioUsd * trackedWeight/100`): >$100K +6, >$10K +4, >$1K +2, >$100 +1

4. **Size multiplier** (`resolvePortfolioSizeMultiplier`, mirrors wallet holder scoring):
   - `≥ $1,000` → 1.0 | `≥ $100` → 0.85 | `≥ $10` → 0.6 | `≥ $1` → 0.35 | `< $1` → 0.1
   - dust wallets with clean % splits still score low (e.g. ~$5 balance → ×0.35)

5. **Formula** (then clamp 0-60):
   - `totalPortfolioQualityScore = portfolioQualityRaw + quantityPoints` (max **112** = 100 + 12)
   - `base = (totalPortfolioQualityScore/112)*45 + (riskManagementRaw/15)*12 + experiencePoints`
   - `score = round(base * sizeMultiplier)`, min 0 max 60
   - **Whale protection floor:** `totalPortfolioUsd >= 1M` and score &lt; 45 → floor **45** (Solid); `>= 100K` and score &lt; 30 → floor **30**
   - denominator **112** (not 42) keeps mid/high holders from piling at the 60 cap when quality alone can reach 100

6. **Bands:** same `SCORE_BANDS` lookup as active traders; with cap 60, achievable bands are **Strong** (60), **Solid** (40-59), **Developing** (<40). Institutional/Premium require the 0-100 active path.

Breakdown: `portfolioQuality`, `riskManagement`, and `experience` reflect post-`sizeMultiplier` values so chart slices align with the displayed score.

Private helpers (portfolio-only path):

- `scorePortfolioQuantityPoints(totalPortfolioUsd, trackedTokenWeight)` — max 12, capped sum of wealth + position tiers
- `resolvePortfolioSizeMultiplier(totalPortfolioUsd)` — mirrors wallet module: 1.0 / 0.85 / 0.6 / 0.35 / 0.1

Profitability redistribution (active traders, no PnL):

- when `swapCount >= 3` and pnl is null, profitability contributes 0; experience (1.5×) and portfolioQuality (1.3×) are boosted so conviction wallets score ~55-70 without PnL
- when pnl is present: original 70/30 split unchanged

Bands (institutional B2B taxonomy, active-trader path 0-100):

- 90-100: **Institutional**
- 75-89: **Premium**
- 60-74: **Strong**
- 40-59: **Solid**
- 0-39: **Developing**
- portfolio-only path: capped at 60 → max band **Strong** on formula path; **Conviction** band on all-in floor (18-25); see Portfolio-only section above

Structural / unscored bands (`UNSCORED_SCORE_BANDS`):

- **Dormant Wallet** — `swapCount < 3`, no portfolio context (`score: 0` internally; dashboard shows `score: null`)
- **Insufficient Data** — legacy persisted rows only; treated like Dormant Wallet in dashboard/aggregation

Gating:

- when `swapCount < 3`:
  - if `hasPortfolioContext(features)` → `scorePortfolioOnly()`
  - else → **Dormant Wallet** (`score: 0`, band `Dormant Wallet`; dashboard shows `null` via `UNSCORED_SCORE_BANDS`)
- when `swapCount >= 3`: full multi-dimension score (matchedLotCount is no longer in the gate)

Confidence:

- active traders: driven by `swapCount`, `totalTransfers`, and `walletAgeDays`; NEVER reduced because PnL is missing
- portfolio-only path: always `low`

### HolderAggregationService

File: src/token/services/holder-aggregation.service.ts

Responsibilities:

- compute quality metrics from analyzed holders
- compute distribution metrics (holder buckets, top concentration, gini)
- compute category-split concentration metrics for eoaHolders, teamLinked, exchanges, contractsAndPools, vestingLocked, burnDead, and dust
- generate risk/positive/info callouts
- add callouts for low retail holder concentration and high-confidence team detection
- **qualityMetrics.breakdown** (behavioral, EOA-only: `eoa` + `team_connected`):
  - Top-level keys `convictionHolders`, `diamondHands`, `activeTraders`, `riskDegen`, `bots`, `dormant` are **percentages** (largest-remainder; sum **100**)
  - `breakdown.counts` holds the same keys as **raw wallet counts** (must sum to `totalAnalyzedEOAs`, typically 78 for top-100 analyze)
  - Archetype mapping: Conviction Holder / Diversified Whale / Strategic Allocator → `convictionHolders`; Diamond Hand → `diamondHands`; Swing Trader / Day Trader / Accumulator → `activeTraders`; Degen / Paper Hand → `riskDegen`; Bot / Automated → `bots`; Dormant Wallet / Insufficient Data / null classification → `dormant`
  - Structural keys `exchanges`, `contractsPools`, `teamConnected`, `burnDead`, `vestingLocked` are **% of all top holders** (not EOA denominator)
- **pnlAggregation**: `smartMoneyCount` (PnL win-rate + profit factor when FAST_MODE off); `portfolioSmartMoneyCount` (portfolio/score heuristic, always computed for EOAs)
- Bot Activity Detected callout only fires for confirmed automated trading patterns
- Limited Trading Data Available when &gt; 50% of behavioral EOAs are dormant/unprofiled; Partial Analysis Coverage when EOAs have `classification: null`
- `avgScore` / `topHolderAvgScore`: scored EOAs only (`score > 0`, not Dormant / Insufficient Data)
- `qualityLabel`: base bands on `avgScore`, adjusted by loyalty % vs degen+bot % (`computeQualityLabel`)
- `categoryConcentration.eoaHolders.avgScore`: same scored-EOA rule as `avgScore`; `scoredCount` for clarity

Example `qualityMetrics.breakdown` (illustrative — percentages ≠ counts):

```json
{
  "convictionHolders": 32,
  "diamondHands": 12,
  "activeTraders": 10,
  "riskDegen": 1,
  "bots": 0,
  "dormant": 45,
  "counts": {
    "convictionHolders": 25,
    "diamondHands": 9,
    "activeTraders": 8,
    "riskDegen": 1,
    "bots": 0,
    "dormant": 35
  },
  "exchanges": 12,
  "contractsPools": 8,
  "teamConnected": 5,
  "burnDead": 0,
  "vestingLocked": 0
}
```

Here `dormant: 45` means **45%** of EOAs (35/78), not 45 wallets. Frontend and AI layers should use `breakdown.counts` for raw composition and top-level behavioral keys for %.

Output families:

- qualityMetrics (includes `breakdown`, `pnlAggregation`, `categoryConcentration`, `circulatingSupply`, `teamDetection`, …)
- distribution
- riskCallouts

### DashboardSummaryService

File: src/token/services/dashboard-summary.service.ts

Layer: PRESENTATION ONLY for the structured dashboard fields. Sits on top of TokenAnalysisService output. Does NOT run analytics, does NOT touch the database, does NOT mutate analysis payloads. The HTTP response also includes `aiSummary`, which is merged in `TokenController` after this service returns (see TokenAiSummaryService).

Purpose:

- transform a persisted `TokenAnalysisEntity` into a frontend-friendly DTO that powers the V1 B2B token intelligence dashboard
- give the frontend a single payload it can render without re-deriving anything (avgScore formatting, sentiment, holder-table shortening, breakdown percentages)
- keep dashboard concerns (formatting, sentiment, summary cards) out of the analytics engine so each layer evolves independently
- export small pure helpers reused by AI layers: `RawHolder`, `safeNumber`, `safeNumberOrNull`, `safeString`, `computeSmartMoneyPct`, `computeHolderQualityBreakdown`, `buildDistributionSummary`, etc.
- imports `UNSCORED_SCORE_BANDS` from `LiteScorerService` for holder-table score nulling
- `isUnclassifiedHolderType(primaryType)` — true for null, **Dormant Wallet**, or legacy **Insufficient Data** (holder-quality breakdown bucket)

Boundary rules:

- never throws on missing / partial / null analytics fields - degrades to `0`, `null`, `'Unknown'`, or empty arrays
- never re-computes analytics (no Gini, no PnL, no classification) - only re-shapes what is already in `qualityMetrics`, `distribution`, `holdersData`, and `riskCallouts`
- never persists anything - pure function over the entity (Gemini summary caching is handled elsewhere)

Public API:

- `buildDashboardSummary(analysis: TokenAnalysisEntity): DashboardSummaryResponse` - the single entry point for cards/tables/metrics. Sets `aiSummary: null`; the controller overwrites `aiSummary` with `TokenAiSummaryService.generateSummary(analysis)`.

DashboardSummaryResponse shape (high level):

- `token` - contract, chain, token name/symbol/price (best-effort, may be null)
- `aiSummary` - plain-text holder-health summary (`string | null`). Populated by the controller in parallel with `buildDashboardSummary` when analysis status is `done`
- `summaryCards` - 6 dashboard cards: Avg Holder Score, Smart Money Wallets, Top 10 Concentration, Decentralization Score, Team Allocation, Exchange Allocation. Each card has title, value, optional subtitle, optional sentiment (`positive` / `neutral` / `warning`)
- `holderQuality` - flat numeric summary (avgScore, qualityLabel, smartMoneyPct, convictionPct, activeTraderPct, degenPct, botPct). `convictionPct` sums dashboard breakdown: convictionHolders + diamondHands + accumulators
- `holderQualityBreakdown` - per-archetype **percentages** of behavioral EOAs (`eoa` + `team_connected`): diamondHands, accumulators, swingTraders, dayTraders, degens, bots, **convictionHolders** (passive: Conviction Holder / Diversified Whale / Strategic Allocator), **dormant** (Dormant Wallet, Insufficient Data, null); largest-remainder rounding (sum 100)
- `distribution` - flattened distribution summary (decentralizationScore, giniCoefficient, top10Pct, top50Pct, top100Pct)
- `holderTable` - `{ total, rows }` with ALL analyzed holders sorted by rank ascending. No 100-holder cap. Frontend pagination, filtering, and sorting are expected to run client-side
- `riskCallouts` - the existing `RiskCallout[]` from analytics, surfaced as-is

Sentiment rules (summary cards):

- positive: avgScore >= 75, decentralizationScore >= 70, smartMoneyPct >= 25
- warning: top10Pct >= 50, team allocation >= 25, exchange allocation >= 40, botPct >= 15
- otherwise: neutral

Smart money percentage (`computeSmartMoneyPct`):

1. **PnL path:** `pnlAggregation.smartMoneyCount > 0` → `round(smartMoneyCount / totalAnalyzedEOAs * 100)`
2. **Portfolio path (FAST_MODE):** `portfolioSmartMoneyCount > 0` → `round(portfolioSmartMoneyCount / totalAnalyzedEOAs * 100)`
3. **Score fallback:** EOAs with lite `score >= 75` / totalAnalyzedEOAs

Behavioral breakdown for cards (`resolveQualityBreakdown`):

- Prefer `qualityMetrics.breakdown` top-level keys as **percentages**
- Raw counts from `qualityMetrics.breakdown.counts` (fallback: legacy `breakdownCounts` on old rows)
- Legacy detection: if top-level behavioral values sum to ~`totalAnalyzedEOAs` (not 100), treat as counts and recompute %

Holder table row mapping:

- `shortAddress`: 0x1234...cdef format via `shortenAddress`
- `balanceUsd`: `holder.usdValue ?? 0`
- `percentSupply`: `holder.balance / circulatingSupply` when present, else `totalSupply`; `percentSupplyBasis`: `'circulating' | 'total'`
- `token.circulatingSupply` exposed on dashboard `token` object (from `qualityMetrics.circulatingSupply`)
- `walletLabel` / `walletLabelDetail`: from intelligence triage (`exchange`, `eoa`, …); exchange rows show detail e.g. `OKX Cold Wallet`
- `classification` / `confidence`: from `holder.classification` with null-safety (`null` for exchange/burn/dust and other non-analyzed labels)
- `score`: numeric lite score when present; **`null`** when `holder.score.band` is in `UNSCORED_SCORE_BANDS` (`Dormant Wallet`, legacy `Insufficient Data`) so the UI does not show 0 as a real score
- `portfolioRisk`: `holder.portfolio?.portfolioRiskSignal ?? null` (always `null` for `exchange` / `cex_deposit`, by design)
- `lastActiveDays`: `holder.features?.daysSinceLastActivity ?? null` (currently always null because features are not persisted on holder rows; included as forward-compatible)

Pure helper functions (all exported and unit-test friendly):

- `shortenAddress(address)`
- `formatPercent(value, digits = 1)`
- `safeNumber(value, fallback = 0)`
- `safeNumberOrNull(value)`
- `safeString(value, fallback)`
- `buildSummaryCards(...)`
- `computeHolderQualityBreakdown(...)` — mirrors aggregation archetype buckets; includes `convictionHolders` + `dormant`
- `resolveQualityBreakdown(quality)` — persisted breakdown % + counts for dashboard cards
- `computeSmartMoneyPct(smartMoneyCount, portfolioSmartMoneyCount, totalAnalyzedEOAs, holders)`
- `resolveSupplyForPercent(circulating, total)` — supply basis for holder table
- `buildDistributionSummary(...)`
- `formatUsd(value)`
- exported `RawHolder` interface (lenient holder JSONB shape for breakdown / smart-money helpers)

Defensive contract:

- tolerates missing `qualityMetrics`, missing `distribution`, missing `pnlAggregation`, missing `teamDetection`, missing `holdersData`, missing `riskCallouts`
- tolerates partial holder rows (no classification, no score, no portfolio, no features)
- tolerates JSONB type-coerced values (numeric strings, null fields)
- defaults: `0` for numbers, `null` for nullable numbers, `'Unknown'` for missing labels, `[]` for missing collections

Wiring:

- registered in `TokenModule` providers
- consumed by `GET /token/:address/dashboard` via `TokenController` (together with `TokenAiSummaryService`)
- does not import analytics services at runtime; only depends on the `TokenAnalysisEntity` shape and the existing `RiskCallout` type, so it carries no circular-dependency risk

### TokenAiSummaryService

File: src/token/services/token-ai-summary.service.ts

Purpose:

- produce a short professional **plain-text** analyst blurb (4–5 sentences) from a minimal `TokenSummaryInput` derived from the same fields as the dashboard (holder quality, composition %, distribution, allocations, risk/positive signal titles)
- `buildSummaryInput` uses `resolveQualityBreakdown` / `computeSmartMoneyPct` with `portfolioSmartMoneyCount`; composition prompt lines use `convictionHolderArchetypePct` + `dormantPct` (not legacy `unclassifiedPct`)
- never break the dashboard: on Gemini failure or missing `GEMINI_API_KEY`, returns a deterministic fallback string

Implementation notes:

- uses `@google/generative-ai` with primary model `gemini-2.5-flash` and a lite fallback model; retry + minimum-length / sentence heuristics similar in spirit to `WalletAiService`
- caches responses with `@nestjs/cache-manager` under key `token:summary:{chain}:{contractAddress}` (24h TTL for successful summaries, shorter TTL for fallbacks)
- reads API key from `GEMINI_API_KEY` or `gemini.apiKey` via `ConfigService`

### TokenDeepAnalysisService

File: src/token/services/token-deep-analysis.service.ts

Purpose:

- optional **investment-style** narrative structured as JSON (`DeepAnalysisResult`): executive verdict, themed sections (overview, team, market, competitors, community, on-chain vs off-chain alignment, risks, structural signals), plus a fixed disclaimer
- combines on-chain summary input (logic duplicated from `TokenAiSummaryService` private `buildInput`, via `buildSummaryInput` in this service) with **Tavily** web search snippets, then calls **Anthropic Claude** (`claude-sonnet-4-5-20251001`, `max_tokens` 4000, `temperature` 0) with a short `system` instruction (JSON only) and a long user prompt containing on-chain block, web block, and required JSON schema
- persists run state and output in `token_deep_analyses` (`TokenDeepAnalysisEntity`), independent of `token_analyses`

Behavior:

- `triggerDeepAnalysis(address, chain)`: normalizes address to lowercase; if a row exists with `status=done` and `updatedAt` within **48 hours**, returns `{ status: 'cached' }`; otherwise upserts `pending` and **fire-and-forgets** `runDeepAnalysis` (errors logged, never thrown to caller); returns `{ status: 'queued' }` (or `{ status: 'error' }` only if the upsert path fails internally)
- `getDeepAnalysis(address, chain)`: returns `not_started` | `pending` | `processing` | `error` | `done` (+ `result`, `generatedAt` when done)
- `runDeepAnalysis`: sets `processing`, requires an existing `token_analyses` row with `status=done` (otherwise error), runs up to **7 Tavily queries in parallel** via `Promise.allSettled` (10s timeout per request, first hit per query, content capped at 500 chars), stores `queries` + `results` into `tavily_queries` JSONB on success, then calls Claude; malformed JSON or missing `overallVerdict` / `sections` → row `error` with message
- missing `TAVILY_API_KEY`: logs warning, continues with empty web results; missing `ANTHROPIC_API_KEY`: row `error` with `ANTHROPIC_API_KEY not configured`

### TokenModule wiring

File: src/token/token.module.ts

Imports:

- `CacheModule.register()` (shared in-memory cache store for token AI summary, Etherscan contract names, and chart data; can be pointed at Redis later via Nest cache config without changing callers)

Shared constants (not Nest providers):

- `src/token/constants/known-exchange-addresses.ts` — exchange triage map used by intelligence + wallet-filter
- `src/token/constants/token-categories.ts` — token category slugs for features/portfolio

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
- TokenAiSummaryService
- TokenDeepAnalysisService
- TokenPdfExportService

Registered controllers:

- TokenController
- ExportPdfController (`GET /api/export-pdf/:tokenId`)

Registered entities:

- TokenAnalysisEntity
- TokenDeepAnalysisEntity (mapped in module via `./entities/token-deep-analysis.entity`; barrel `entities/index.ts` may omit it)
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
   - Phase 1: token metadata (intelligence)
   - Phase 2: `classifyHolders` — static exchange lookup, contract/dust rules, team detection; builds `classifications` map keyed by **lowercase** address
   - Phase 3: batch loop — skip holders where `!filter.shouldAnalyze` (exchanges, routers, burn, dust, …); only EOAs fetch transfers
   - for each analyzed holder (FAST_MODE on): recent transfers (capped at 50) -> portfolio context (rank <= 100) -> `extractFeatures(..., holdingsProfile, FAST_MODE, tokenContractAddress)` -> classification -> score, with `pnl = null`; passive path when `swapCount < 3` and portfolio present
   - for each holder (FAST_MODE off): recent transfers -> portfolio context -> features -> swaps -> realized PnL -> classification -> score, with full pnl summary
   - aggregate holder outputs into quality/distribution/callouts
   - upsert final analysis row with `tokenName` / `tokenSymbol` and status=done
4. client polls GET /token/:address?chain=... until done/error

### C) Token deep analysis (optional path)

1. client completes token analysis (`token_analyses.status=done`) for `(contractAddress, chain)`
2. client calls `POST /token/:address/deep-analysis/trigger?chain=...` (EVM `0x` + 40 hex validation on `address`)
3. service returns `{ status: 'cached' }` if a fresh (`updatedAt` within 48h) `done` row already exists in `token_deep_analyses`, otherwise `{ status: 'queued' }` after upserting `pending`
4. background job sets `processing`, runs parallel Tavily searches + Claude, then writes `done` + `result` + `tavily_queries`, or `error` + `error_message`
5. client polls `GET /token/:address/deep-analysis?chain=...` until `done`, `error`, or `not_started`

Boundary: deep analysis never mutates `token_analyses`; failures stay in `token_deep_analyses`.

Current runtime notes:

- production orchestrator uses TokenIntelligenceService for holder labeling, team detection, and token metadata before running lite analysis on EOA holders
- known exchange addresses (see `known-exchange-addresses.ts`) are labeled in Phase 2 with `shouldAnalyze: false` — they never receive lite scores but count toward **Exchange Allocation** on the dashboard
- non-EOA holders (exchanges, contracts, burn, etc.) skip transfer fetch and classification but still appear in `holders_data` with `walletLabel`, `labelEvidence`, `classification: null`, `score: null`
- portfolio context is fetched for top-100 non-EOA holders except CEX labels; `exchange` / `cex_deposit` intentionally keep `portfolio: null` so portfolio USD and token share are hidden for custodial wallets

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

Query params (optional, mirrors production portfolio path):

- `trackedToken` - contract address of the token under analysis (enables portfolio fetch + passive holder classification)
- `trackedUsd` - USD value of this wallet's holding in that token
- `fastMode` - `true` (default) caps transfers at 50

### GET /token/wallet/:address/score?chain=ethereum

Purpose:

- inspect score and classification together

Query params: same as classify (`trackedToken`, `trackedUsd`, `fastMode`)

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
- the controller does NOT run analytics; structured fields come from `DashboardSummaryService.buildDashboardSummary`
- in parallel (same request), `TokenAiSummaryService.generateSummary(result)` produces `aiSummary` (plain `string`; deterministic fallback when Gemini is unavailable); failures there do not fail the HTTP request
- emits structured debug log `[token-dashboard] build contract=... chain=...` immediately before transformation
- emits structured error log `[token-dashboard] transformation_failed contract=... chain=... error=...` on any unexpected throw from the summary path; the HTTP response never includes the underlying message

Response behavior:

- HTTP 404 with `{ status: 'not_found', message: 'No analysis found for token' }` when no analysis row exists for `(contractAddress, chain)`
- HTTP 200 with a lightweight processing payload when the row exists but `status !== 'done'`:
  - `{ status, contractAddress, chain, updatedAt }`
  - no dashboard transformation is attempted
  - frontend should poll the same endpoint until status becomes `done`
- HTTP 200 with the full `DashboardSummaryResponse` when `status === 'done'` (includes `aiSummary` from Gemini or fallback)
- HTTP 500 with `{ status: 'error', message: 'Failed to build dashboard response' }` if the dashboard path unexpectedly throws (defensive; `DashboardSummaryService` is built to never throw)

Pagination / filtering / sorting:

- not implemented server-side. `holderTable` always returns every analyzed holder. Client-side handles pagination, sorting, and filtering.

### GET /api/export-pdf/:tokenId?chain=ethereum

Purpose:

- generate a downloadable PDF report for a token whose analysis is already `done`

Implementation:

- `ExportPdfController` → `TokenPdfExportService` (Puppeteer)
- requires env `FRONTEND_URL` and `INTERNAL_PRINT_SECRET`
- navigates to `{FRONTEND_URL}/report-print/{tokenId}?chain={chain}&secret={INTERNAL_PRINT_SECRET}`
- viewport 1440×900 @2x; `waitUntil: networkidle0` (30s timeout); optional wait for `.pdf-ready` (5s, logs warning if missing)
- PDF: A4, `printBackground: true`, 20/15/20/15 mm margins, no header/footer

Prerequisites:

- `tokenId` = EVM contract address (`0x` + 40 hex)
- analysis row must exist with `status=done` (otherwise HTTP 400)
- frontend must implement `/report-print/:tokenId` and validate `secret` query param against the same `INTERNAL_PRINT_SECRET`

Response:

- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename="WalletIntel_{symbol}_Report.pdf"`

### POST /token/:address/deep-analysis/trigger?chain=ethereum

Purpose:

- enqueue (or short-circuit cache) async token deep analysis backed by `token_deep_analyses`

Validation:

- `address` must match `^0x[0-9a-fA-F]{40}$` after trim; otherwise HTTP 400

Returns:

- `{ status: 'cached' }` when a `done` row exists and is newer than 48 hours
- `{ status: 'queued' }` after upserting `pending` and starting background processing
- `{ status: 'error' }` only if the trigger path cannot persist the queue row (internal catch; does not throw)

### GET /token/:address/deep-analysis?chain=ethereum

Purpose:

- poll deep analysis status and final JSON payload

Validation:

- same EVM contract regex as trigger

Returns:

- `DeepAnalysisStatusResponse`: `not_started` | `pending` | `processing` | `error` | `done` (with `result` + `generatedAt` when `done`)

## 5. Data model and migrations

Migration files:

- migrations/202605060001_create_token_tables.sql
- migrations/202605060003_add_token_name_symbol.sql (idempotent guard for token_name / token_symbol columns; widens token_symbol to VARCHAR(32) on legacy DBs)
- migrations/202605_create_token_deep_analyses.sql (`token_deep_analyses` for async deep analysis)

Created tables:

- token_analyses
- tracked_tokens
- whale_snapshots
- whale_alerts
- token_deep_analyses (status, JSON `result`, JSON `tavily_queries`, unique `(contract_address, chain)`)

Primary runtime table today:

- token_analyses (used by TokenAnalysisService)

Secondary table:

- token_deep_analyses (used only by TokenDeepAnalysisService; independent lifecycle)

Entity files:

- src/token/entities/token-analysis.entity.ts
- src/token/entities/token-deep-analysis.entity.ts
- src/token/entities/tracked-token.entity.ts
- src/token/entities/whale-snapshot.entity.ts
- src/token/entities/whale-alert.entity.ts

Current usage status:

- tracked_tokens, whale_snapshots, whale_alerts are scaffolded and mapped but not yet actively written by current endpoints
- token_deep_analyses is written by `POST /token/:address/deep-analysis/trigger` and background `TokenDeepAnalysisService`

## 6. Configuration

Current required keys for token pipeline:

- CHAINBASE_API_KEY
- ETHERSCAN_API_KEY (ethereum, polygon transfer ingestion + token-intelligence contract lookups)
- ALCHEMY_API_KEY (base/bsc transfer ingestion + ERC-20 balances + native gas-token balance via eth_getBalance on all four chains)
- DATABASE_URL

Optional keys (feature-gated):

- `GEMINI_API_KEY` (or `gemini.apiKey`) — short dashboard `aiSummary` via `TokenAiSummaryService` (fallback text when absent)
- `TAVILY_API_KEY` (or `tavily.apiKey`) — web snippets for token deep analysis (degraded on-chain-only prompt when absent)
- `ANTHROPIC_API_KEY` (or `anthropic.apiKey`) — required for deep analysis Claude call; missing key yields `token_deep_analyses.status=error` with message `ANTHROPIC_API_KEY not configured`

Optional tuning keys:

- TOKEN_ANALYSIS_BATCH_SIZE (default 5)
- TOKEN_ANALYSIS_BATCH_DELAY_MS (default 1500)

Current .env.example already includes:

- CHAINBASE_API_KEY
- ETHERSCAN_API_KEY
- DATABASE_URL
- TAVILY_API_KEY (commented stub for Tavily)

Manual note:

- add ALCHEMY_API_KEY to your local env; without it ERC-20 balances and native balances both fall back to safe-empty results, and base/bsc transfer ingestion is disabled
- add GEMINI_API_KEY for live Gemini summaries on the dashboard; add ANTHROPIC_API_KEY + TAVILY_API_KEY for full deep analysis quality

## 7. How analysis persistence works

The orchestrator saves output into token_analyses JSONB and scalar columns:

- token_name / token_symbol: nullable scalar columns, written defensively (`tokenMetadata?.name ?? null` / `tokenMetadata?.symbol ?? null`) so partial metadata responses never block status=done
- total_holders: count of holders that were enriched
- holders_data: per-holder analyzed rows (classification + score)
- quality_metrics: aggregated holder quality metrics plus tokenPriceUsd, priceSource, PnL aggregation (`smartMoneyCount`, `portfolioSmartMoneyCount`), `breakdown` (behavioral % + `breakdown.counts`), `circulatingSupply`, `teamDetection`, `categoryConcentration`
- distribution: concentration/distribution metrics
- risk_callouts: generated token-level insights

Deep analysis persistence (separate table):

- `token_deep_analyses` stores `status`, optional JSON `result` (Claude-shaped report), optional JSON `tavily_queries` (queries + snippets), and `error_message`; it is never written by `TokenAnalysisService`

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

- active traders (`swapCount >= 3`): standard archetype classify/score; matchedLotCount is no longer required for the gate
- passive holders (`swapCount < 3` + `hasPortfolioContext`): `classifyPassiveHolder()` / `scorePortfolioOnly()` — see LiteClassifierService and LiteScorerService sections
- classifier consumes cadence, category mix, tracked-token concentration, diversification score, portfolio risk signal, and the new derived features
- active-trader confidence is driven by `swapCount`, `totalTransfers`, and `walletAgeDays` instead of `matchedLotCount`
- when `pnl` is null and `swapCount >= 3`, experience (1.5×) and portfolioQuality (1.3×) boost replace the profitability slice so scores still reach ~55-70 for conviction wallets
- final-score confidence is NOT downgraded just because PnL is missing (active traders only)

Smart money without PnL:

- `HolderAggregationService` always sets `pnlAggregation.portfolioSmartMoneyCount` for behavioral EOAs (whale/portfolio/score rules above)
- Dashboard `computeSmartMoneyPct` uses portfolio count when `smartMoneyCount === 0` (typical under FAST_MODE)

Response shape is preserved:

- `AnalyzedHolder.pnl` may now be `null` for all holders; PnL-dependent callouts simply do not fire; portfolio smart-money callouts can still fire when `holdersWithPnlData === 0` if portfolio count is high enough (via score fallback path on dashboard only for the card; aggregation callout still keys off `holdersWithPnlData > 10` for PnL-based smart %)
- `LiteFeatureVector` gains 4 new fields plus `fastModeApplied`; existing fields are unchanged

Per-wallet timing instrumentation:

- LiteIngestionService logs `[timing] transfers ... duration_ms=...` per `getRecentTransfers` call
- TokenAnalysisService logs `[timing] wallet=... transfers_ms=... features_ms=... classify_ms=...` per holder
- log level is debug

LitePnlService is intentionally still registered in TokenModule and untouched in code; flipping FAST_MODE is a single-constant change.

Passive holder path (portfolio-only classify/score):

- applies when `swapCount < 3` but `hasPortfolioContext(features)` is true (typically top-100 holders after `LitePortfolioService.getPortfolioContext`)
- classifier uses `classifyPassiveHolder()` → Diversified Whale / Conviction Holder / Strategic Allocator; reduces unclassified % on transfer-heavy tokens (e.g. Zentry)
- scorer uses `scorePortfolioOnly()` (max 60, quantity + size multiplier) instead of score 0; multi-million-dollar passive whales can reach **Solid** (~48-53) or **Strong** (60 cap); dust wallets stay **Developing** via size multiplier
- pure all-in holders get conviction floor ~18-25 with band **Conviction**
- holders without portfolio context: classification **Dormant Wallet**, score band **Dormant Wallet** (dashboard `score: null`)
- requires `holdingsProfile` passed into `extractFeatures` **and** `trackedTokenContractAddress` (production passes token contract `address` from `TokenAnalysisService`)
- debug wallet endpoints without `trackedToken` query param will still show **Dormant Wallet** / unscored — use `?trackedToken=0x...&trackedUsd=...` to mirror production

## 9. Current limitations and known gaps

- only first two Chainbase pages are currently fetched
- wallet-level holdingTokenCount and holdingChainCount in features are placeholders unless provided by caller
- tracked token scheduling and whale alert execution logic is not implemented yet
- portfolio holdings are fetched for all top 100 analyzed holders (see `TOP_HOLDERS_PORTFOLIO_RANK_LIMIT` in `src/token/constants/token-analysis-limits.ts`)
- ERC-20 transfers truncated to FAST_MODE_TRANSFER_LIMIT (50) most recent per wallet while FAST_MODE is enabled (this is a deliberate B2B trade-off, not a defect - see section 8a)
- LitePnlService is bypassed while FAST_MODE is enabled (deliberate, not a defect; flipping `FAST_MODE = false` restores it without any other changes)
- native gas-token balance is fetched per chain only (no cross-chain aggregation); native pricing failures cause the native bag to be skipped silently
- token deep analysis requires a completed `token_analyses` row (`status=done`) for the same `(contract_address, chain)`; it does not run holder analytics itself
- dashboard `aiSummary` and deep analysis depend on third-party APIs (Gemini, Tavily, Anthropic) and degrade or error independently per feature rules above
- team detection can still vary when Etherscan **transfer** scans fail; **contract names** are now cached 24h after first successful resolve (reduces treasury/generic_contract flakiness on re-runs)
- FAST_MODE transfer cap causes rank 51–100 and same-wallet classification to vary slightly between analyze runs (different 50-transfer windows)
- `walletAgeDays` on passive holders with zero transfers may be 0 (derived from transfer timestamps only); conviction floor uses this field for the 18 vs 25 split
- persisted analyses do not auto-refresh when `known-exchange-addresses.ts` or scoring rules change — re-run `POST /token/analyze` to pick up new exchange tags or B2B score bands

## 10. How to run and verify

### Apply migrations

Run in order:

- `node scripts/run-sql-migration.js migrations/202605060001_create_token_tables.sql`
- `node scripts/run-sql-migration.js migrations/202605060003_add_token_name_symbol.sql`
- `node scripts/run-sql-migration.js migrations/202605_create_token_deep_analyses.sql`

### Verify schema

- `node scripts/verify-token-metadata-schema.js` prints `token_name` / `token_symbol` column info plus the latest 10 token_analyses rows

### Start analysis

1. POST /token/analyze with contractAddress and optional chain
2. poll GET /token/:address?chain=... until status is done or error

### Inspect dashboard + AI summary

1. Complete analysis for a contract (POST /token/analyze, poll GET /token/:address)
2. GET /token/:address/dashboard?chain=... — includes `aiSummary` when status is `done`

### Inspect deep analysis

1. POST /token/:address/deep-analysis/trigger?chain=... (after step 1)
2. Poll GET /token/:address/deep-analysis?chain=... until `done` or `error`

### Debug each stage quickly

1. GET /token/:address/holders
2. GET /token/wallet/:address/transfers
3. GET /token/wallet/:address/features
4. GET /token/wallet/:address/classify
5. GET /token/wallet/:address/score

For steps 4–5, pass portfolio context like production:

- `?trackedToken=<tokenContract>&trackedUsd=<holderUsdValue>&fastMode=true`

Without `trackedToken`, passive holders show **Dormant Wallet** / unscored even if they are large on-chain holders.

### Verify B2B pass on a real token (e.g. Zentry)

After `POST /token/analyze` completes (fresh run, not stale DB row):

1. **OKX Cold Wallet** `0x611f7bf868a6212f871e89f7e44684045ddfb09d` (often rank ~3):
   - `walletLabel`: `exchange`
   - `walletLabelDetail`: `OKX Cold Wallet`
   - `classification` / `score`: null
   - contributes to **Exchange Allocation**, not EOA avg score
2. **Large passive EOA** (rank ≤ 100, transfer-heavy):
   - `classification`: Diversified Whale or Conviction Holder
   - `score.band`: Solid / Strong / Conviction (not Developing at $1M+ unless dust multiplier applies)
3. **Rank &gt; 50** with no portfolio:
   - `classification.primaryType`: Dormant Wallet
   - dashboard `score`: null
4. **Staked derivative holder** (e.g. rank 29 with stZENT + ZENT):
   - `portfolio.trackedTokenWeight` ≈ 99% (ecosystem, not raw ZENT slice only)
   - `classification`: Conviction Holder (not Strategic Allocator from understated weight)
5. **qualityMetrics.breakdown invariant** (fresh run):
   - `breakdown.counts.*` sum = `totalAnalyzedEOAs` (e.g. 78)
   - `breakdown.convictionHolders + diamondHands + activeTraders + riskDegen + bots + dormant` = **100** (percentages)
   - `pnlAggregation.portfolioSmartMoneyCount` &gt; 0 under FAST_MODE when large whales present
6. **Dashboard** `GET /token/:address/dashboard`:
   - `holderQuality.smartMoneyPct` &gt; 0 when `portfolioSmartMoneyCount` populated
   - `holderQualityBreakdown.convictionHolders` and `.dormant` replace legacy `unclassified`
   - holder rows include `percentSupplyBasis`; `token.circulatingSupply` set when metadata has it

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

### TokenChartService

File: src/token/services/token-chart.service.ts

Responsibilities:

- expose `GET /token/:address/chart` for token contract chart data and choose the best available third-party source
- return `TokenChartResponse` with `contractAddress`, `chain`, `currency`, `timeframe`, `dataSource`, `dataPoints`, and `fetchedAt`
- support `dataSource` values: `coingecko`, `geckoterminal`, or `unavailable`

Current flow:

- try CoinGecko contract chart first via `/coins/{platform}/contract/{address}/market_chart`
- if CoinGecko is unavailable or returns invalid data, fall back to GeckoTerminal

GeckoTerminal design update:

- GeckoTerminal OHLCV data is pool-based, not token-based
- the service now performs a two-step lookup:
  1. resolve the token contract to a pool address via `/networks/{network}/tokens/{contractAddress}/pools?page=1`
  2. request OHLCV for that pool via `/networks/{network}/pools/{poolAddress}/ohlcv/{resolution}?aggregate={aggregate}&limit={limit}&currency=usd`
- this is necessary because GeckoTerminal requires a pool address for OHLCV lookup and will reject direct token contract OHLCV requests
- if the pool lookup fails or returns no pool, the chart service logs a warning and returns `unavailable`

Timeframe mapping:

- `24h`: `hour`, aggregate 1, limit 24
- `7d`: `hour`, aggregate 4, limit 42
- `30d`: `hour`, aggregate 12, limit 60
- `90d`: `day`, aggregate 1, limit 90
- `1y`: `day`, aggregate 1, limit 365
- `all`: `day`, aggregate 1, limit 1000

Notes:

- CoinGecko contract lookup is still unreliable for tokens not fully indexed by contract address; GeckoTerminal with pool lookup is the more robust source for this release
- returned chart points are normalized to `{ timestamp, price, volume }` and sorted ascending by timestamp
- the chart service uses a 10s `AbortController` timeout for all external HTTP calls

### LitePortfolioService

File: src/token/services/lite-portfolio.service.ts

- fetches full ERC-20 balances via Alchemy `getTokenBalances`
- prices holdings via `LitePricingService.getBatchPrices` (DefiLlama-primary, CoinGecko-fallback)
- produces a formalized HoldingsProfile with categoryAllocations (bluechip/defi/meme/ai/gaming/infrastructure/stablecoin/rwa/other), portfolioRiskSignal, and per-holding category labels
- computes: totalPortfolioUsd, `trackedTokenUsd`, `trackedTokenWeight`, diversificationScore
- **tracked token ecosystem weight:** sums USD for (a) the analyzed token contract, (b) derivative symbols vs `tokenMetadata.symbol` — `st{SYM}`, `w{SYM}`, `{SYM}.e`, `{SYM}x` (case-insensitive), (c) optional staking-related contract addresses detected from top holders (`generic_contract` + knownLabel contains symbol / stake / silo / vault). Example: ZENT + stZENT → ~99% weight, not ZENT slice alone
- `getPortfolioContext(..., stakingRelatedContracts?, trackedTokenSymbol?)` — production passes symbol + staking set from `TokenAnalysisService`
- uses centralized src/token/constants/token-categories.ts for classification
- HoldingsProfile is fetched BEFORE feature extraction for all top 100 analyzed holders so portfolio signals feed into classification and scoring
- capped at `TOP_HOLDERS_PORTFOLIO_RANK_LIMIT` (100) in `token-analysis-limits.ts`
- native gas-token balances (ETH on ethereum/base, BNB on bsc, POL on polygon) are resolved via `LiteIngestionService.getNativeBalance` and priced via `LitePricingService.getTokenPrice` using known native-token proxy addresses (`0xeee...eee` for ETH, `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` for BNB, `0x0000000000000000000000000000000000001010` for POL). The native bag is pushed into `holdings` BEFORE the ERC-20 loop so it automatically participates in totalPortfolioUsd, trackedTokenWeight, categoryAllocations (bluechip), topHoldings, diversificationScore, and portfolioRiskSignal
- native pricing failures degrade silently (holding is skipped, the rest of the profile still builds); the legacy empty-balances early-return now also requires `!nativeHolding` so ETH-only wallets are no longer reported as empty portfolios
- emits `[portfolio] native holding added wallet=... symbol=... usdValue=...` debug log when a native bag clears the $1 minimum

### LiteFeatureService

File: src/token/services/lite-feature.service.ts

- feature vector includes optional holdings-based fields: `totalPortfolioUsd`, `trackedTokenWeight`, `portfolioDiversificationScore`, `holdingCategoryMix`, `portfolioRiskSignal`, `trackedTokenCategory` (populated when HoldingsProfile is available, i.e. top 100 analyzed holders)
- feature vector also includes FAST_MODE-derived fields: `walletAgeDays`, `daysSinceLastActivity`, `activityConsistencyScore`, `portfolioConcentrationScore`, `fastModeApplied`
- `hasPortfolioContext(features)` gates passive classify/score paths in classifier and scorer
- `withHoldingsProfile()` centralizes portfolio merge; production passes `trackedTokenContractAddress` as the analyzed token contract
- see section 2 LiteFeatureService for the full public API + hold-time strategy details

### LitePnlService

File: src/token/services/lite-pnl.service.ts

- FIFO position lot reconstruction from detected swaps
- swap valuation priority: stablecoin-side first, DefiLlama historical second, CoinGecko historical third, current price last resort
- outputs: realized PnL, win rate, profit factor, ROI, largest win/loss
- feeds into classifier Smart Money/Paper Hand boosts (opportunistic) and the scorer profitability dimension (additive 0-30 points) when active
- matches wallet module's DefiLlama-first historical pricing strategy
- currently bypassed at runtime because `FAST_MODE = true` in TokenAnalysisService; the service stays wired in TokenModule so flipping FAST_MODE re-engages it without code changes

### Known exchange registry

See **section 2 → Known exchange registry** for the canonical file and production wiring.

### WalletFilterService

File: src/token/services/wallet-filter.service.ts

- labels wallets before analysis: exchange, contract, lp_pool, bridge, burn, dust, eoa
- exchange lookups delegate to `known-exchange-addresses.ts` (not used by production analyze path; intelligence service owns triage)
- static lookup maps for ~10 known routers/contracts and burn addresses
- eth_getCode check via Alchemy for unknown addresses
- only eoa wallets proceed through full analysis pipeline
- reduces API calls and eliminates Dormant Wallet / unprofiled-holder spam on exchange-heavy tokens

### TokenIntelligenceService

File: src/token/services/token-intelligence.service.ts

See **section 2 → TokenIntelligenceService** for classify/triage flow. Additional implementation notes:

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
  - eth_getCode contract detection cache (in-memory, per process)
  - Etherscan contract-name cache: successful names only; memory L1 + Nest `CacheModule` L2 (`token:contract-name:{chainId}:{address}`, 24h). Failed lookups are **not** written to cache
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

## 12. Retail Token Trust Report Layer

### Why this layer exists

The legacy token dashboard emphasized B2B holder-intelligence framing (community health and holder quality).
Retail users need a different interpretation layer: "what can hurt me, and why?".

The Token Trust Report is an additive deterministic layer that reinterprets existing on-chain outputs into:

- Token Trust Score (0-100)
- risk level (`low | moderate | high | severe | unknown`)
- red flags and positive signals
- "who can dump?" exit-pressure summary
- evidence/limitations for confidence context

It does **not** change core holder fetching, classification, scoring, or aggregation.
It does **not** add off-chain crawling, contract-audit logic, or chat behavior.

### Implementation

- Service: `src/token/services/token-trust-report.service.ts`
- Consumer: `DashboardSummaryService.buildDashboardSummary()`
- DTO field: `DashboardSummaryResponse.tokenTrust`
- Returned by:
  - `GET /token/:address/dashboard`
  - `GET /token/share/:shareId` (same dashboard payload path)

### TokenTrust output shape

`tokenTrust` includes:

- `trustScore` (compatibility field), `scoreType`, `scoreLabel`, `scoreStatus`, `scoreCoverage`, `missingScoreInputs`
- `riskLevel`, `verdict`, `confidence`, `reportMode`, `summary`
- `concentrationContext` (retail-scoped vs total-supply impact)
- `redFlags[]` (severity + title + description + optional evidence)
- `positiveSignals[]` (strength + title + description + optional evidence)
- `whoCanDump`:
  - largest retail wallet `%`, USD, address
  - top-10 retail concentration
  - retail whale count (wallets >= 1% supply)
  - team/exchange/contract/lp percentages
  - risk level + summary
- `trustBreakdown` sub-scores:
  - holder concentration
  - whale exit risk
  - team/insider risk
  - exchange liquidity context
  - holder strength
  - data confidence
- `limitations[]`

### Trust score formula (deterministic, recalibrated)

**Baseline:** start at `70` (not 100). Contract safety and off-chain credibility are not yet in scope, so scores are capped at **82** until those layers ship.

**Derived concentration metrics:**

- `top10RetailPctOfRetail` = `distribution.supplyConcentration.top10Pct` (retail-scoped)
- `top10RetailPctOfTotal` = `retailSupplyPct * top10RetailPctOfRetail / 100`
- Same pattern for top50/top100 when available
- `largestRetailWalletPctOfTotal` from retail EOA holder balances / supply

Severity is driven primarily by **total-supply impact**, not retail-scoped % alone.

**Adjustments (added to baseline 70):**

1. Holder concentration — primarily `top10RetailPctOfTotal`; secondary modifier from `top10RetailPctOfRetail`
2. Largest retail wallet — `largestRetailWalletPctOfTotal`
3. Team/treasury — team % with treasury/vesting cap (`-8` max) unless deployer/owner/team_connected EOAs or high team risk
4. Holder strength — `qualityMetrics.avgScore` (can add points for strong bases)
5. Decentralization — `distribution.decentralizationScore`
6. Exchange custody — neutral/slightly positive for 20–60%; penalty only if >70% or <2%
7. Data confidence — `classifiableRetailCount`

**Risk mapping:**

- 80-100: low
- 65-79: moderate
- 45-64: high
- 0-44: severe
- insufficient sample: unknown

**Hard severe triggers** (override score band):

- largest retail wallet ≥ 10% of total supply
- `top10RetailPctOfTotal` ≥ 35%
- deployer/owner/team_connected EOA exposure ≥ 20%
- very weak data + high concentration

The verdict deliberately avoids "Healthy" language by default.

### Red flags and positives

Red flags are deterministic from concentration/team/sample/strength conditions, including:

- High Retail Concentration
- Large Wallet Can Move Price
- Team-Linked Supply Detected
- Limited Retail Sample
- Weak Holder Strength

Positive signals are also deterministic and non-overriding:

- Low Detected Team Allocation
- Broad Exchange Access (liquidity context only)
- Well Distributed Retail Supply
- Stronger Holder Base

A severe concentration signal is never neutralized by a positive exchange-liquidity signal.

### Who can dump calculation

Holder groups are derived from existing labels:

- Retail: `walletLabel === 'eoa' && !isTeamLinked`
- Team: `isTeamLinked` or team/deployer/owner/treasury/vesting labels
- Exchange: `exchange` / `cex_deposit`
- Contract: `generic_contract` / `dex_router` / `bridge` / `staking`
- LP: `dex_pool`
- Burn: `burn`

`whoCanDump` combines top retail concentration, largest wallet share, and team-linked exposure into a separate exit-pressure risk label and summary text.

### Retail-facing holder labels

Internal classifier outputs are preserved for backward compatibility.
Dashboard holder rows add retail interpretation fields:

- `retailType`
- `retailRiskLabel`
- `retailExplanation`

Examples:

- `Conviction Holder` -> `Concentrated Holder`
- `Strategic Allocator` -> `Partial Allocator`
- `Dormant Wallet` -> `Low-Activity Wallet`
- legacy score bands map to retail strength labels (`Institutional -> Very Strong`, etc.)

### Limitations (always surfaced)

The Token Trust Report includes explicit limitations such as:

- contract safety analysis not included yet
- off-chain credibility analysis not included yet
- holder classifications depend on available on-chain data
- exchange custody is liquidity context, not direct sell pressure
- FAST_MODE warning when recent-history analysis is used (no long-horizon PnL)

### Migration guidance

The legacy holder score and holder-quality blocks remain in the API for compatibility.
Retail UI should prefer `tokenTrust` + retail holder labels as the primary interpretation path.
