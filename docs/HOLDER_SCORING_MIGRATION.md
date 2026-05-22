# Holder Scoring Architecture Migration (Token / B2B)

## Summary

Passive-holder scoring in the **token intelligence pipeline** (lite scorer, holder aggregation, dashboard) now uses a dedicated 0–100 engine independent from trader scoring. **Wallet** `GET /wallet/:address/score` holder path is unchanged.

Trader scoring (token and wallet) is unchanged.

## Token pipeline routing (unchanged orchestration)

```
swapCount >= 3  → lite trader scoring (unchanged)
swapCount < 3   → hasPortfolioContext ? scoreHolderPortfolio() : unscored
```

## Holder dimensions (100 total)

| Dimension | Weight | Notes |
|-----------|--------|--------|
| portfolioQuality | 35 | Diversification, bluechip/stable exposure, meme inverse, risk signal |
| conviction | 30 | Hold duration, profit posture; gated when meme-heavy |
| assetSelection | 20 | Bluechip, stable, DeFi, infra; meme penalties |
| capitalScale | 10 | Modest wealth boost; does not dominate |
| longevityStability | 5 | Wallet age, activity consistency |

## Removed behaviors (token passive path only)

- **60-point cap** on `scorePortfolioOnly()`
- **Always-low** passive-holder confidence on portfolio-only path

## Backward compatibility (token B2B / dashboard DTOs)

- `LiteScore` shape unchanged (`score`, `confidence`, `band`, `breakdown`)
- Passive holders can now reach **Institutional** / **Premium** bands
- `portfolioSmartMoneyCount` includes elite holder bands and refined USD thresholds

## Files changed (token only)

| File | Role |
|------|------|
| `src/scoring/holder-scoring.engine.ts` | Holder dimension formulas (used by lite scorer) |
| `src/scoring/holder-confidence.ts` | Holder-path confidence for passive B2B holders |
| `src/token/services/lite-scorer.service.ts` | Replaces capped `scorePortfolioOnly()` |
| `src/token/services/holder-aggregation.service.ts` | Smart money aggregation for elite holders |
| `src/token/token_design.md` | Architecture notes |

**Not changed:** `src/wallet/services/scoring.service.ts`, wallet types, wallet confidence.

## Suggested tests

See `src/scoring/holder-scoring.engine.spec.ts`. Additional cases:

- `swapCount < 3` + portfolio context → score can reach Institutional / Premium
- FAST_MODE passive whale → high score with diversified mix
- 100% tracked memecoin → conviction capped, band ≤ Strong
- Trader lite path (`swapCount >= 3`) unchanged

## Edge cases

- Wallets with no `holdingDays` use estimated longevity from `walletAgeDays` (FAST_MODE)
- B2B concentrated tracked-token conviction floors via `applyConvictionFloor`
