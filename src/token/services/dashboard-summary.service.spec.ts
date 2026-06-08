import { DashboardSummaryService, buildSummaryCards, mapHolderTypeForRetail, mapQualityLabelForRetail } from './dashboard-summary.service';
import { TokenTrustReportService, concentrationRedFlagTitle } from './token-trust-report.service';
import { TokenAnalysisEntity } from '../entities/token-analysis.entity';

function pepeAnalysis(): TokenAnalysisEntity {
  return {
    id: '1',
    contractAddress: '0xpepe',
    chain: 'ethereum',
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    shareId: null,
    totalHolders: 100,
    holdersData: [
      { walletAddress: '0x1', walletLabel: 'eoa', balance: '6700000', usdValue: 2_500_000 },
      { walletAddress: '0x2', walletLabel: 'exchange', balance: '45000000' },
      { walletAddress: '0x3', walletLabel: 'treasury', balance: '1200000' },
      { walletAddress: '0x4', walletLabel: 'dex_pool', balance: '800000' },
      { walletAddress: '0x5', walletLabel: 'generic_contract', balance: '500000' },
    ],
    qualityMetrics: {
      avgScore: 35,
      qualityLabel: 'Developing Community',
      classifiableRetailCount: 78,
      totalAnalyzedEOAs: 78,
      totalSupply: '100000000',
      pnlAggregation: { holdersWithPnlData: 0, portfolioSmartMoneyCount: 12 },
      teamDetection: { teamTotalPctOfSupply: 1.2, riskLevel: 'low' },
    },
    distribution: {
      decentralizationScore: 41,
      retailHolderCount: 78,
      supplyConcentration: { top10Pct: 66 },
      supplyBreakdown: {
        retail: { pctOfSupply: 28.5 },
        exchange: { pctOfSupply: 45 },
        team: { pctOfSupply: 1.2 },
      },
    },
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function linkAnalysis(): TokenAnalysisEntity {
  return {
    id: '2',
    contractAddress: '0xlink',
    chain: 'ethereum',
    tokenName: 'Chainlink',
    tokenSymbol: 'LINK',
    shareId: null,
    totalHolders: 100,
    holdersData: [
      { walletAddress: '0xr', walletLabel: 'eoa', balance: '500000', usdValue: 1_200_000 },
      { walletAddress: '0xt', walletLabel: 'treasury', balance: '18700000' },
      { walletAddress: '0xe', walletLabel: 'exchange', balance: '30000000' },
      { walletAddress: '0xp', walletLabel: 'dex_pool', balance: '2000000' },
    ],
    qualityMetrics: {
      avgScore: 65,
      qualityLabel: 'Strong Community',
      classifiableRetailCount: 70,
      totalAnalyzedEOAs: 70,
      totalSupply: '100000000',
      pnlAggregation: { holdersWithPnlData: 0 },
      teamDetection: { teamTotalPctOfSupply: 18.7, riskLevel: 'medium' },
    },
    distribution: {
      decentralizationScore: 76,
      retailHolderCount: 70,
      supplyConcentration: { top10Pct: 36 },
      supplyBreakdown: {
        retail: { pctOfSupply: 16.75 },
        exchange: { pctOfSupply: 30 },
        team: { pctOfSupply: 18.7 },
      },
    },
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('dashboard wording cleanup', () => {
  const trust = new TokenTrustReportService();
  const dashboard = new DashboardSummaryService(trust);

  it('maps community quality labels for retail', () => {
    expect(mapQualityLabelForRetail('Strong Community')).toBe('Strong Holder Strength');
    expect(mapQualityLabelForRetail('Weak Community')).toBe('Weak Holder Base');
  });

  it('uses Strong Wallet Signals in FAST_MODE summary cards', () => {
    const tokenTrust = trust.buildReport(pepeAnalysis());
    const cards = buildSummaryCards({
      avgScore: 35,
      smartMoneyPct: 12,
      top10Pct: 66,
      decentralizationScore: 41,
      teamPctOfSupply: 1.2,
      exchangePctOfSupply: 45,
      botPct: 0,
      tokenTrust,
      hasRealizedPnl: false,
    });

    const walletCard = cards.find((card) => card.title.includes('Wallet'));
    expect(walletCard?.title).toBe('Strong Wallet Signals');
    expect(walletCard?.subtitle).toContain('not realized PnL');
    expect(JSON.stringify(cards)).not.toContain('profitable traders');

    const top10Card = cards.find((card) => card.title === 'Top 10 Retail Control');
    expect(top10Card?.value).toBe('66%');
    expect(top10Card?.subtitle).toContain('18.8% of total supply');

    const scoreCard = cards.find((card) => card.title === 'Visible On-chain Score');
    expect(scoreCard).toBeDefined();
  });

  it('PEPE dashboard has no community or profitable-trader wording', () => {
    const summary = dashboard.buildDashboardSummary(pepeAnalysis());
    expect(summary.holderQuality.qualityLabel).not.toContain('Community');
    expect(JSON.stringify(summary.summaryCards)).not.toContain('profitable traders');
    expect(summary.tokenTrust.scoreLabel).toBe('Visible On-chain Score');
    expect(summary.holderTable.rows.every((row) => row.retailType !== 'Unknown')).toBe(
      true,
    );
  });

  it('LINK dashboard uses moderate concentration wording', () => {
    const summary = dashboard.buildDashboardSummary(linkAnalysis());
    expect(summary.holderQuality.qualityLabel).toBe('Strong Holder Strength');
    expect(summary.tokenTrust.riskLevel).toBe('moderate');

    const top10Card = summary.summaryCards.find(
      (card) => card.title === 'Top 10 Retail Control',
    );
    expect(top10Card?.subtitle).toContain('6% of total supply');

    const concentrationFlag = summary.tokenTrust.redFlags.find((flag) =>
      flag.title.includes('Concentration'),
    );
    expect(concentrationFlag?.title).toBe('Retail Holder Concentration');

    const treasuryRow = summary.holderTable.rows.find(
      (row) => row.walletLabel === 'treasury',
    );
    expect(treasuryRow?.retailType).toBe('Team / Treasury Wallet');
    expect(treasuryRow?.retailRiskLabel).toBe('Team / Treasury Exposure');

    const poolRow = summary.holderTable.rows.find((row) => row.walletLabel === 'dex_pool');
    expect(poolRow?.retailType).toBe('Liquidity Pool');
  });
});

describe('concentrationRedFlagTitle', () => {
  it('uses softer titles for low/medium severity', () => {
    expect(concentrationRedFlagTitle('low')).toBe('Retail Holder Concentration');
    expect(concentrationRedFlagTitle('medium')).toBe('Retail Concentration Requires Review');
    expect(concentrationRedFlagTitle('high')).toBe('High Retail Concentration');
  });
});

describe('mapHolderTypeForRetail structural wallets', () => {
  it('maps all structural wallet labels', () => {
    expect(
      mapHolderTypeForRetail(null, { walletLabel: 'dex_pool', percentSupply: 1, trackedTokenWeight: null })
        .retailType,
    ).toBe('Liquidity Pool');
    expect(
      mapHolderTypeForRetail(null, { walletLabel: 'generic_contract', percentSupply: 3, trackedTokenWeight: null })
        .retailRiskLabel,
    ).toBe('Contract Supply Risk');
    expect(
      mapHolderTypeForRetail(null, { walletLabel: null, percentSupply: 0, trackedTokenWeight: null })
        .retailType,
    ).toBe('Unclassified Wallet');
  });
});
