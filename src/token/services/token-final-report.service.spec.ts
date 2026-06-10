import { TokenAnalysisEntity } from '../entities/token-analysis.entity';
import type { DashboardSummaryResponse } from './dashboard-summary.service';
import type { ContractSafetyReport } from './token-contract-safety.service';
import type { MarketContextReport } from './token-market-context.service';
import type { OffChainCredibilityReport } from './token-offchain-credibility.service';
import { TokenFinalReportService } from './token-final-report.service';
import type { TokenTrustReport } from './token-trust-report.service';

function makeAnalysis(overrides: Partial<TokenAnalysisEntity> = {}): TokenAnalysisEntity {
  return {
    id: 'analysis-1',
    contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
    chain: 'ethereum',
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    shareId: 'share-pepe',
    totalHolders: 1000,
    holdersData: [],
    qualityMetrics: {},
    distribution: {},
    riskCallouts: [],
    status: 'done',
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as TokenAnalysisEntity;
}

function makeTokenTrust(overrides: Partial<TokenTrustReport> = {}): TokenTrustReport {
  return {
    trustScore: 45,
    scoreType: 'visible_onchain_score',
    scoreLabel: 'Visible On-chain Score',
    scoreStatus: 'partial',
    scoreCoverage: ['holders'],
    missingScoreInputs: [],
    riskLevel: 'high',
    verdict: 'Elevated holder concentration and whale exit risk.',
    confidence: 'high',
    reportMode: 'standard',
    summary: 'On-chain trust is limited by concentration.',
    redFlags: [
      {
        severity: 'high',
        title: 'High Retail Concentration',
        description: 'Top holders control a large share of retail supply.',
      },
    ],
    positiveSignals: [],
    concentrationContext: {
      retailSupplyPct: 55,
      top10RetailPctOfRetail: 42,
      top10RetailPctOfTotal: 23,
      top50RetailPctOfTotal: 35,
      top100RetailPctOfTotal: 40,
      largestRetailWalletPctOfTotal: 12,
      explanation: 'Concentration is elevated.',
    },
    whoCanDump: {
      largestRetailWalletPct: 12,
      largestRetailWalletUsd: 45_000_000,
      largestRetailWalletAddress: '0xabc',
      top10RetailPct: 38,
      retailWhaleCount: 4,
      teamLinkedPct: 8,
      exchangePct: 18,
      contractPct: 5,
      lpPct: 12,
      summary: 'A few large wallets could move meaningful supply.',
      riskLevel: 'high',
    },
    trustBreakdown: {
      holderConcentration: { score: 35, risk: 'high' },
      whaleExitRisk: { score: 40, risk: 'high' },
      teamOrInsiderRisk: { score: 55, risk: 'moderate' },
      exchangeLiquidityContext: { score: 60, risk: 'moderate' },
      holderStrength: { score: 30, risk: 'high' },
      dataConfidence: { score: 80, risk: 'low' },
    },
    limitations: ['Visible on-chain score excludes full contract audit coverage.'],
    ...overrides,
  };
}

function makeOffChain(overrides: Partial<OffChainCredibilityReport> = {}): OffChainCredibilityReport {
  return {
    status: 'done',
    score: 69,
    riskLevel: 'moderate',
    credibilityTier: 'credible',
    verdict: 'Meme token with verified official links but limited utility evidence.',
    confidence: 'high',
    discoveryMode: 'official_verified',
    websiteSource: 'discovery',
    discoveredLinks: {
      website: 'https://pepe.vip',
      docs: null,
      whitepaper: null,
      github: null,
      twitter: 'https://twitter.com/pepecoineth',
      telegram: null,
      discord: null,
      blog: null,
    },
    officialLinkConfidence: { level: 'high', reasons: ['Official website matched'] },
    projectProfile: {
      category: 'meme',
      claimedUseCase: 'Community meme token',
      hasClearUseCase: false,
      hasDocs: false,
      hasWhitepaper: false,
      hasGithub: false,
      hasAuditsMentioned: false,
      hasTeamInfo: false,
    },
    credibilitySignals: [
      {
        strength: 'medium',
        title: 'Official Website Found',
        description: 'An official website was discovered and matched token metadata.',
      },
    ],
    riskFlags: [
      {
        severity: 'medium',
        title: 'Limited Functional Utility Evidence',
        description: 'Project materials emphasize meme/community positioning over product utility.',
      },
    ],
    claimChecks: [],
    unknowns: [],
    limitations: ['Off-chain review does not prove token safety.'],
    checkedAt: '2026-06-01T00:00:00.000Z',
    projectUnderstanding: {
      source: 'ai',
      category: 'meme',
      claimedUseCase: 'Community meme token',
      hasClearUseCase: false,
      identityStatus: 'verified',
      evidenceQuality: 'moderate',
      externalValidation: 'moderate',
      communitySignal: 'strong',
      negativeRiskEvidence: 'low',
      evidenceRefs: ['https://pepe.vip'],
    },
    externalEvidence: {
      summary: {
        officialSourceCount: 2,
        trustedDirectoryCount: 1,
        unrelatedCount: 3,
        scamWarningCount: 0,
        riskWarningCount: 0,
      },
    } as OffChainCredibilityReport['externalEvidence'],
    ...overrides,
  };
}

function makeContractSafety(overrides: Partial<ContractSafetyReport> = {}): ContractSafetyReport {
  return {
    status: 'done',
    score: 78,
    riskLevel: 'moderate',
    verdict: 'No severe contract controls detected.',
    confidence: 'high',
    verifiedSource: true,
    sourceProvider: 'etherscan',
    contractType: 'erc20',
    isProxy: false,
    proxyType: 'none',
    implementationAddress: null,
    proxyAdminAddress: null,
    owner: {
      ownerAddress: null,
      isRenounced: true,
      ownerType: 'none',
      adminAddresses: [],
    },
    permissions: {
      mint: { detected: false, risk: 'none', reason: 'No mint function detected.', evidence: [] },
      burn: { detected: false, risk: 'none', reason: 'No burn function detected.', evidence: [] },
      pause: { detected: false, risk: 'none', reason: 'No pause function detected.', evidence: [] },
      blacklist: { detected: false, risk: 'none', reason: 'No blacklist function detected.', evidence: [] },
      whitelist: { detected: false, risk: 'none', reason: 'No whitelist function detected.', evidence: [] },
      tradingGate: { detected: false, risk: 'none', reason: 'No trading gate detected.', evidence: [] },
      taxChange: { detected: false, risk: 'none', reason: 'No tax change function detected.', evidence: [] },
      maxTxOrMaxWallet: { detected: false, risk: 'none', reason: 'No max tx function detected.', evidence: [] },
      upgradeability: { detected: false, risk: 'none', reason: 'No upgradeability detected.', evidence: [] },
      rescueOrWithdraw: { detected: false, risk: 'none', reason: 'No rescue function detected.', evidence: [] },
    },
    taxes: { status: 'not_detected', buyTaxPct: null, sellTaxPct: null, transferTaxPct: null, evidence: [] },
    honeypot: { status: 'not_checked', reason: null, evidence: [] },
    flags: [],
    positiveSignals: [],
    unknowns: [],
    limitations: [],
    checkedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  } as ContractSafetyReport;
}

function makeMarketContext(overrides: Partial<MarketContextReport> = {}): MarketContextReport {
  return {
    status: 'done',
    score: 88,
    riskLevel: 'low',
    maturityTier: 'established',
    verdict: 'Strong market depth and liquidity.',
    confidence: 'high',
    marketCapUsd: 4_500_000_000,
    fdvUsd: 4_500_000_000,
    liquidityUsd: 45_000_000,
    volume24hUsd: 250_000_000,
    priceChange24hPct: -2,
    tokenAgeDays: 700,
    firstSeenAt: '2024-01-01T00:00:00.000Z',
    exchangeContext: {
      cexSignals: {
        exchangeSupplyPct: 18,
        exchangeWalletCount: 12,
        interpretation: 'Listed on major centralized exchanges.',
      },
      dexSignals: {
        pairCount: 20,
        topPairLiquidityUsd: 20_000_000,
        totalDexLiquidityUsd: 45_000_000,
        mainDex: 'uniswap',
      },
    },
    liquidityRisk: { level: 'low', reason: 'Deep liquidity across CEX and DEX venues.' },
    maturitySignals: [
      {
        strength: 'high',
        title: 'Established Market',
        description: 'Token has multi-year trading history and deep liquidity.',
      },
    ],
    riskFlags: [],
    unknowns: [],
    limitations: [],
    checkedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<DashboardSummaryResponse> = {}): DashboardSummaryResponse {
  return {
    token: {
      contractAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      chain: 'ethereum',
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      tokenPriceUsd: 0.00001,
      circulatingSupply: '420000000000000',
    },
    aiSummary: null,
    summaryCards: [],
    holderQuality: {
      avgScore: 32,
      qualityLabel: 'Weak',
      smartMoneyPct: 4,
      convictionPct: 8,
      activeTraderPct: 20,
      degenPct: 45,
      botPct: 10,
      scoringBase: 'retail',
      classifiableRetailCount: 200,
      totalHoldersExamined: 500,
      classificationBreakdown: {},
    },
    holderQualityBreakdown: {
      diamondHands: 10,
      accumulators: 15,
      swingTraders: 25,
      dayTraders: 40,
      degens: 90,
      bots: 20,
      convictionHolders: 16,
      dormant: 30,
    },
    distribution: {
      scope: 'retail',
      retailHolderCount: 500,
      decentralizationScore: 28,
      giniCoefficient: 0.82,
      top10Pct: 38,
      top50Pct: 55,
      top100Pct: 62,
      supplyBreakdown: {
        retail: { count: 500, pctOfSupply: 55 },
        exchange: { count: 12, pctOfSupply: 18 },
        contract: { count: 2, pctOfSupply: 5 },
        team: { count: 3, pctOfSupply: 8 },
        burn: { count: 1, pctOfSupply: 2 },
        lp: { count: 4, pctOfSupply: 12 },
      },
      retailSizeBuckets: { micro: 200, small: 180, medium: 90, whale: 30 },
      raw: { giniCoefficient: 0.82, top10PctOfTotal: 23, top50PctOfTotal: 35 },
    },
    tokenTrust: makeTokenTrust(),
    contractSafety: makeContractSafety(),
    marketContext: makeMarketContext(),
    offChainCredibility: makeOffChain(),
    holderTable: { total: 0, rows: [] },
    riskCallouts: [],
    ...overrides,
  };
}

describe('TokenFinalReportService', () => {
  const service = new TokenFinalReportService();

  it('builds PEPE-like meme report with elevated on-chain risk despite verified identity', () => {
    const dashboard = makeDashboard();
    const report = service.buildFinalReport({
      analysis: makeAnalysis(),
      dashboard,
    });

    expect(report.overall.reportType).toBe('risk_first_token_intelligence');
    expect(['high', 'moderate']).toContain(report.overall.riskLevel);
    expect(report.overall.verdict).toMatch(/meme\/community token/i);
    expect(report.overall.verdict).toMatch(/holder concentration/i);

    const riskTitles = report.keyFindings.risks.map((item) => item.title);
    expect(riskTitles.some((title) => /concentration/i.test(title))).toBe(true);
    expect(riskTitles.some((title) => /utility/i.test(title))).toBe(true);

    expect(report.monitoringPlan.watchItems.some((item) => /top-holder|largest retail wallet/i.test(item))).toBe(true);
    expect(report.monitoringPlan.watchItems.some((item) => /exchange/i.test(item))).toBe(true);
    expect(report.monitoringPlan.alertCTA).toContain('Telegram alerts');

    expect(report.deepAnalysis.onchainVsOffchainAlignment).toMatch(/identity appears credible/i);
    expect(report.deepAnalysis.onchainVsOffchainAlignment).toMatch(/holder concentration|limited functional utility/i);
    expect(report.offchainCredibility.category).toBe('meme');
  });

  it('builds ONDO-like RWA report capped by severe on-chain and contract risks', () => {
    const dashboard = makeDashboard({
      token: {
        contractAddress: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
        chain: 'ethereum',
        tokenName: 'Ondo',
        tokenSymbol: 'ONDO',
      },
      tokenTrust: makeTokenTrust({
        trustScore: 28,
        riskLevel: 'severe',
        confidence: 'high',
        whoCanDump: {
          ...makeTokenTrust().whoCanDump,
          teamLinkedPct: 42,
          largestRetailWalletPct: 15,
          top10RetailPct: 48,
          riskLevel: 'severe',
        },
      }),
      contractSafety: makeContractSafety({
        score: 42,
        riskLevel: 'high',
        confidence: 'high',
        verdict: 'Mint permission detected on token contract.',
        owner: {
          ownerAddress: '0xowner',
          isRenounced: false,
          ownerType: 'contract',
          adminAddresses: [],
        },
        permissions: {
          ...makeContractSafety().permissions,
          mint: { detected: true, risk: 'high', reason: 'Mint function detected.', evidence: ['mint()'] },
        },
        flags: [
          {
            severity: 'high',
            title: 'Mint Permission Detected',
            description: 'Contract exposes a mint function that can increase supply.',
          },
        ],
      }),
      offChainCredibility: makeOffChain({
        score: 92,
        riskLevel: 'low',
        verdict: 'Strong RWA project credibility with official docs and GitHub.',
        projectProfile: {
          category: 'rwa',
          claimedUseCase: 'Tokenized real-world assets and institutional on-chain finance.',
          hasClearUseCase: true,
          hasDocs: true,
          hasWhitepaper: true,
          hasGithub: true,
          hasAuditsMentioned: true,
          hasTeamInfo: true,
        },
        discoveredLinks: {
          website: 'https://ondo.finance',
          docs: 'https://docs.ondo.finance',
          whitepaper: null,
          github: 'https://github.com/ondoprotocol',
          twitter: 'https://twitter.com/ondoprotocol',
          telegram: null,
          discord: null,
          blog: null,
        },
        projectUnderstanding: {
          source: 'ai',
          category: 'rwa',
          claimedUseCase: 'Tokenized real-world assets and institutional on-chain finance.',
          hasClearUseCase: true,
          identityStatus: 'verified',
          evidenceQuality: 'strong',
          externalValidation: 'strong',
          communitySignal: 'moderate',
          negativeRiskEvidence: 'none_found',
          evidenceRefs: ['https://ondo.finance', 'https://docs.ondo.finance'],
        },
        credibilitySignals: [
          {
            strength: 'high',
            title: 'Official Documentation Found',
            description: 'Project documentation was discovered on the official domain.',
          },
          {
            strength: 'high',
            title: 'GitHub Repository Found',
            description: 'An official GitHub repository was linked from project materials.',
          },
        ],
      }),
      marketContext: makeMarketContext({ score: 75, riskLevel: 'moderate' }),
    });

    const report = service.buildFinalReport({
      analysis: makeAnalysis({ tokenName: 'Ondo', tokenSymbol: 'ONDO' }),
      dashboard,
    });

    expect(report.overall.score).toBeLessThanOrEqual(65);
    expect(['high', 'severe']).toContain(report.overall.riskLevel);
    expect(report.overall.verdict).toMatch(/credibility appears strong/i);
    expect(report.overall.verdict).toMatch(/on-chain|contract/i);

    const positiveTitles = report.keyFindings.positives.map((item) => item.title);
    expect(positiveTitles.some((title) => /documentation|github/i.test(title))).toBe(true);

    const riskTitles = report.keyFindings.risks.map((item) => item.title);
    expect(riskTitles.some((title) => /mint/i.test(title))).toBe(true);
    expect(report.whoCanDump.teamLinkedPct).toBeGreaterThanOrEqual(30);
  });

  it('builds Chainlink-like infrastructure report with moderate overall risk', () => {
    const dashboard = makeDashboard({
      token: {
        contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
        chain: 'ethereum',
        tokenName: 'Chainlink',
        tokenSymbol: 'LINK',
      },
      tokenTrust: makeTokenTrust({
        trustScore: 68,
        riskLevel: 'moderate',
        confidence: 'high',
        whoCanDump: {
          ...makeTokenTrust().whoCanDump,
          teamLinkedPct: 12,
          largestRetailWalletPct: 4,
          top10RetailPct: 22,
          riskLevel: 'moderate',
        },
        redFlags: [],
      }),
      contractSafety: makeContractSafety({
        score: 92,
        riskLevel: 'low',
        confidence: 'high',
        verdict: 'Contract controls appear limited with renounced ownership.',
      }),
      marketContext: makeMarketContext({
        score: 94,
        riskLevel: 'low',
        maturityTier: 'established',
      }),
      offChainCredibility: makeOffChain({
        score: 96,
        riskLevel: 'low',
        verdict: 'Established infrastructure project with strong official presence.',
        projectProfile: {
          category: 'infrastructure',
          claimedUseCase: 'Decentralized oracle network and data infrastructure.',
          hasClearUseCase: true,
          hasDocs: true,
          hasWhitepaper: true,
          hasGithub: true,
          hasAuditsMentioned: true,
          hasTeamInfo: true,
        },
        projectUnderstanding: {
          source: 'ai',
          category: 'infrastructure',
          claimedUseCase: 'Decentralized oracle network and data infrastructure.',
          hasClearUseCase: true,
          identityStatus: 'verified',
          evidenceQuality: 'strong',
          externalValidation: 'strong',
          communitySignal: 'strong',
          negativeRiskEvidence: 'none_found',
          evidenceRefs: ['https://chain.link'],
        },
      }),
      holderQuality: {
        ...makeDashboard().holderQuality,
        avgScore: 72,
        qualityLabel: 'Strong',
        smartMoneyPct: 18,
      },
    });

    const report = service.buildFinalReport({
      analysis: makeAnalysis({ tokenName: 'Chainlink', tokenSymbol: 'LINK' }),
      dashboard,
    });

    expect(['low', 'moderate']).toContain(report.overall.riskLevel);
    expect(report.overall.riskLevel).not.toBe('severe');
    expect(report.overall.verdict).toMatch(/strong off-chain credibility|contract safety|market maturity/i);
    expect(report.overall.verdict).toMatch(/monitor/i);
    expect(report.moduleScores.contractSafety.riskLevel).toBe('low');
  });

  it('builds unknown token report with identity caution and monitoring', () => {
    const dashboard = makeDashboard({
      tokenTrust: makeTokenTrust({
        trustScore: 38,
        riskLevel: 'high',
        confidence: 'low',
      }),
      marketContext: makeMarketContext({
        score: 35,
        riskLevel: 'high',
        confidence: 'low',
        liquidityRisk: { level: 'high', reason: 'Thin liquidity and limited market history.' },
      }),
      offChainCredibility: makeOffChain({
        score: 22,
        riskLevel: 'severe',
        confidence: 'low',
        verdict: 'Official identity could not be verified.',
        discoveredLinks: {
          website: null,
          docs: null,
          whitepaper: null,
          github: null,
          twitter: null,
          telegram: null,
          discord: null,
          blog: null,
        },
        officialLinkConfidence: { level: 'low', reasons: ['No official website found'] },
        projectProfile: {
          category: 'unknown',
          claimedUseCase: null,
          hasClearUseCase: false,
          hasDocs: false,
          hasWhitepaper: false,
          hasGithub: false,
          hasAuditsMentioned: false,
          hasTeamInfo: false,
        },
        projectUnderstanding: {
          source: 'deterministic',
          category: 'unknown',
          claimedUseCase: null,
          hasClearUseCase: false,
          identityStatus: 'unverified',
          evidenceQuality: 'limited',
          externalValidation: 'weak',
          communitySignal: 'unknown',
          negativeRiskEvidence: 'medium',
          evidenceRefs: [],
        },
        unknowns: ['Official website not found', 'Documentation not found'],
      }),
      contractSafety: null,
    });

    const report = service.buildFinalReport({
      analysis: makeAnalysis({ tokenName: 'Unknown', tokenSymbol: 'UNK' }),
      dashboard,
    });

    expect(report.overall.score).toBeLessThanOrEqual(55);
    expect(report.overall.verdict).toMatch(/official identity could not be verified/i);
    expect(report.monitoringPlan.watchItems.some((item) => /off-chain identity|official website/i.test(item))).toBe(true);
    expect(report.keyFindings.unknowns.some((item) => /website|documentation/i.test(item))).toBe(true);
    expect(report.evidence.officialLinks).toHaveLength(0);
  });

  it('exposes expected top-level sections', () => {
    const report = service.buildFinalReport({
      analysis: makeAnalysis(),
      dashboard: makeDashboard(),
    });

    expect(report).toEqual(
      expect.objectContaining({
        overall: expect.objectContaining({
          score: expect.any(Number),
          riskLevel: expect.any(String),
          confidence: expect.any(String),
          verdict: expect.any(String),
          summary: expect.any(String),
        }),
        keyFindings: expect.objectContaining({
          positives: expect.any(Array),
          risks: expect.any(Array),
          unknowns: expect.any(Array),
        }),
        moduleScores: expect.any(Object),
        whoCanDump: expect.any(Object),
        contractSafety: expect.any(Object),
        marketAndLiquidity: expect.any(Object),
        offchainCredibility: expect.any(Object),
        deepAnalysis: expect.any(Object),
        evidence: expect.any(Object),
        monitoringPlan: expect.any(Object),
        limitations: expect.any(Array),
      }),
    );
  });
});
