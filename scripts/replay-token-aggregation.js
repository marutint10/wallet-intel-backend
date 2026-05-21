/**
 * Recompute quality_metrics, distribution, and risk_callouts from stored holders_data
 * without re-fetching on-chain data. Safe to run after retail-scoped distribution changes.
 *
 * Usage:
 *   node scripts/replay-token-aggregation.js
 *   node scripts/replay-token-aggregation.js 0xContractAddress ethereum
 */
require('dotenv').config();
require('reflect-metadata');

const { NestFactory } = require('@nestjs/core');
const { getRepositoryToken } = require('@nestjs/typeorm');
const { AppModule } = require('../dist/app.module');
const { TokenAnalysisEntity } = require('../dist/token/entities/token-analysis.entity');
const { HolderAggregationService } = require('../dist/token/services/holder-aggregation.service');

const QUALITY_PRESERVE_KEYS = [
  'tokenPriceUsd',
  'priceSource',
  'priceFetchedAt',
  'priceConfidence',
  'totalSupply',
  'circulatingSupply',
  'liquidityUsd',
  'liquidityPairs',
  'deployer',
  'owner',
  'metadataSource',
  'teamDetection',
];

function pickQualityExtras(existing) {
  const extras = {};
  if (!existing || typeof existing !== 'object') {
    return extras;
  }
  for (const key of QUALITY_PRESERVE_KEYS) {
    if (existing[key] !== undefined) {
      extras[key] = existing[key];
    }
  }
  return extras;
}

function parseTotalSupplyFormatted(quality) {
  const raw = quality?.totalSupply;
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = Number.parseFloat(String(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function main() {
  const filterAddress = process.argv[2]?.toLowerCase();
  const filterChain = process.argv[3] ?? 'ethereum';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const aggregation = app.get(HolderAggregationService);
    const repo = app.get(getRepositoryToken(TokenAnalysisEntity));

    const where = { status: 'done' };
    if (filterAddress) {
      where.contractAddress = filterAddress;
      where.chain = filterChain;
    }

    const rows = await repo.find({ where });
    console.log(`Replaying aggregation for ${rows.length} completed analysis row(s)...`);

    let updated = 0;
    for (const row of rows) {
      const holders = Array.isArray(row.holdersData) ? row.holdersData : [];
      if (holders.length === 0) {
        console.warn(`Skip ${row.contractAddress} (${row.chain}): empty holders_data`);
        continue;
      }

      const existingQuality = row.qualityMetrics ?? {};
      const totalSupply = String(existingQuality.totalSupply ?? '0');
      const totalSupplyFormatted = parseTotalSupplyFormatted(existingQuality);
      const teamDetection = existingQuality.teamDetection ?? null;
      const extras = pickQualityExtras(existingQuality);

      const { quality, distribution, riskCallouts } =
        aggregation.reprocessFromStoredHolders(
          holders,
          totalSupply,
          totalSupplyFormatted,
          teamDetection,
          extras,
        );

      await repo.update(
        { id: row.id },
        {
          qualityMetrics: quality,
          distribution,
          riskCallouts,
          updatedAt: new Date(),
        },
      );

      updated += 1;
      console.log(
        `Updated ${row.contractAddress} (${row.chain}) — retail ${distribution.retailHolderCount}/${distribution.totalHolders}, top10 retail ${distribution.supplyConcentration.top10Pct}%`,
      );
    }

    console.log(`Done. Updated ${updated} row(s).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
