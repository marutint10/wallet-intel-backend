import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ContractSafetyStatus = 'done' | 'partial' | 'error' | 'unknown';
export type ContractSafetyRiskLevel =
  | 'low'
  | 'moderate'
  | 'high'
  | 'severe'
  | 'unknown';
export type ContractSafetyConfidence = 'low' | 'medium' | 'high';
export type SourceProvider =
  | 'etherscan'
  | 'blockscout'
  | 'sourcify'
  | 'none'
  | 'unknown';
export type ContractType = 'erc20' | 'proxy' | 'unknown';
export type ProxyType =
  | 'transparent'
  | 'uups'
  | 'beacon'
  | 'minimal_proxy'
  | 'unknown'
  | null;
export type OwnerType = 'eoa' | 'multisig' | 'contract' | 'unknown' | null;
export type PermissionRisk =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'severe'
  | 'unknown';

export interface PermissionSignal {
  detected: boolean | null;
  risk: PermissionRisk;
  reason: string;
  evidence: string[];
}

export interface ContractSafetyFlag {
  severity: 'low' | 'medium' | 'high' | 'severe';
  title: string;
  description: string;
  evidence?: string;
}

export interface ContractSafetyPositiveSignal {
  strength: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  evidence?: string;
}

export interface ContractSafetyReport {
  status: ContractSafetyStatus;
  score: number | null;
  riskLevel: ContractSafetyRiskLevel;
  verdict: string;
  confidence: ContractSafetyConfidence;

  verifiedSource: boolean | null;
  sourceProvider: SourceProvider;

  contractType: ContractType;
  isProxy: boolean;
  proxyType: ProxyType;
  implementationAddress: string | null;
  proxyAdminAddress: string | null;

  owner: {
    ownerAddress: string | null;
    isRenounced: boolean | null;
    ownerType: OwnerType;
    adminAddresses: string[];
  };

  permissions: {
    mint: PermissionSignal;
    burn: PermissionSignal;
    pause: PermissionSignal;
    blacklist: PermissionSignal;
    whitelist: PermissionSignal;
    tradingGate: PermissionSignal;
    taxChange: PermissionSignal;
    maxTxOrMaxWallet: PermissionSignal;
    upgradeability: PermissionSignal;
    rescueOrWithdraw: PermissionSignal;
  };

  taxes: {
    status: 'detected' | 'not_detected' | 'unknown';
    buyTaxPct: number | null;
    sellTaxPct: number | null;
    transferTaxPct: number | null;
    evidence: string[];
  };

  honeypot: {
    status: 'not_checked' | 'pass' | 'warning' | 'fail' | 'unknown';
    reason: string | null;
    evidence: string[];
  };

  flags: ContractSafetyFlag[];
  positiveSignals: ContractSafetyPositiveSignal[];
  unknowns: string[];
  limitations: string[];
  checkedAt: string;
}

export interface ContractSafetyCollectedData {
  contractAddress: string;
  chain: string;
  bytecode: string | null;
  bytecodeError: string | null;
  sourceFetchError: string | null;
  verifiedSource: boolean;
  sourceProvider: SourceProvider;
  contractName: string | null;
  abi: unknown[] | null;
  sourceText: string | null;
  etherscanProxyFlag: boolean;
  etherscanImplementation: string | null;
  implementationAddress: string | null;
  proxyAdminAddress: string | null;
  proxyType: ProxyType;
  isProxy: boolean;
  ownerAddress: string | null;
  ownerType: OwnerType;
  adminAddresses: string[];
  scanText: string;
  abiFunctionNames: string[];
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae63b9e1ff41bd6484f148bf7af0b5a18a14dbaeb54413';
const EIP1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

const OWNER_SELECTORS = [
  '0x8da5cb5b', // owner()
  '0x893d20e8', // getOwner()
  '0xf851a440', // admin()
];

interface AbiEntry {
  type?: string;
  name?: string;
  stateMutability?: string;
}

interface EtherscanSourceResult {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  Proxy?: string;
  Implementation?: string;
}

interface PatternGroup {
  clear: RegExp[];
  unclear: RegExp[];
}

const PERMISSION_PATTERNS: Record<string, PatternGroup> = {
  mint: {
    clear: [/\bmint\b/i, /\bownerMint\b/i, /\bincreaseSupply\b/i, /\bissue\b/i],
    unclear: [/\b_mint\b/i],
  },
  burn: {
    clear: [/\bburn\b/i, /\bburnFrom\b/i],
    unclear: [],
  },
  pause: {
    clear: [/\bpause\b/i, /\bunpause\b/i, /\bpaused\b/i],
    unclear: [],
  },
  blacklist: {
    clear: [
      /\bblacklist\b/i,
      /\bisBlacklisted\b/i,
      /\bsetBlacklist\b/i,
      /\bbotList\b/i,
      /\bantibot\b/i,
    ],
    unclear: [],
  },
  whitelist: {
    clear: [/\bwhitelist\b/i, /\bsetWhitelist\b/i, /\bexcludeFromMaxTransaction\b/i],
    unclear: [],
  },
  tradingGate: {
    clear: [
      /\benableTrading\b/i,
      /\btradingEnabled\b/i,
      /\bopenTrading\b/i,
      /\bsetTradingEnabled\b/i,
    ],
    unclear: [],
  },
  taxChange: {
    clear: [
      /\bsetTax\b/i,
      /\bsetFees\b/i,
      /\bsetBuyFee\b/i,
      /\bsetSellFee\b/i,
      /\bsetTransferFee\b/i,
      /\bupdateFees\b/i,
      /\btaxWallet\b/i,
      /\bfeeReceiver\b/i,
    ],
    unclear: [],
  },
  maxTxOrMaxWallet: {
    clear: [
      /\bsetMaxTx\b/i,
      /\bsetMaxWallet\b/i,
      /\bmaxTransactionAmount\b/i,
      /\bmaxWallet\b/i,
    ],
    unclear: [],
  },
  upgradeability: {
    clear: [
      /\bupgradeTo\b/i,
      /\bupgradeToAndCall\b/i,
      /\bimplementation\b/i,
      /\bproxyAdmin\b/i,
    ],
    unclear: [],
  },
  rescueOrWithdraw: {
    clear: [
      /\brescueTokens\b/i,
      /\bwithdrawToken\b/i,
      /\brecoverERC20\b/i,
      /\bsweep\b/i,
      /\brescueETH\b/i,
    ],
    unclear: [],
  },
};

function emptyPermission(reason: string): PermissionSignal {
  return { detected: null, risk: 'unknown', reason, evidence: [] };
}

function createDefaultPermissions(): ContractSafetyReport['permissions'] {
  return {
    mint: emptyPermission('Not scanned'),
    burn: emptyPermission('Not scanned'),
    pause: emptyPermission('Not scanned'),
    blacklist: emptyPermission('Not scanned'),
    whitelist: emptyPermission('Not scanned'),
    tradingGate: emptyPermission('Not scanned'),
    taxChange: emptyPermission('Not scanned'),
    maxTxOrMaxWallet: emptyPermission('Not scanned'),
    upgradeability: emptyPermission('Not scanned'),
    rescueOrWithdraw: emptyPermission('Not scanned'),
  };
}

@Injectable()
export class TokenContractSafetyService {
  private readonly logger = new Logger(TokenContractSafetyService.name);

  constructor(private readonly config: ConfigService) {}

  async analyzeContract(
    contractAddress: string,
    chain: string,
    metadata?: { owner?: string | null; name?: string | null; symbol?: string | null },
  ): Promise<ContractSafetyReport> {
    const address = contractAddress.trim().toLowerCase();
    const collected = await this.collectData(address, chain, metadata);
    return buildContractSafetyReport(collected);
  }

  private async collectData(
    address: string,
    chain: string,
    metadata?: { owner?: string | null; name?: string | null; symbol?: string | null },
  ): Promise<ContractSafetyCollectedData> {
    const rpcUrl = this.getRpcUrl(chain);
    let bytecode: string | null = null;
    let bytecodeError: string | null = null;

    if (!rpcUrl) {
      bytecodeError = 'RPC unavailable';
    } else {
      bytecode = await this.getCode(rpcUrl, address);
      if (!bytecode) {
        bytecodeError = 'No contract bytecode found.';
      }
    }

    const sourceResult = await this.fetchEtherscanSource(address, chain);
    const abi = sourceResult.abi;
    const sourceText = sourceResult.sourceText;
    const verifiedSource = sourceResult.verifiedSource;
    const abiFunctionNames = extractAbiFunctionNames(abi);

    let implementationAddress = sourceResult.implementationAddress;
    let proxyAdminAddress: string | null = null;
    let proxyType: ProxyType = null;
    let isProxy = sourceResult.etherscanProxyFlag;

    if (rpcUrl && bytecode) {
      const slotImpl = await this.getStorageAddress(rpcUrl, address, EIP1967_IMPLEMENTATION_SLOT);
      const slotAdmin = await this.getStorageAddress(rpcUrl, address, EIP1967_ADMIN_SLOT);
      const slotBeacon = await this.getStorageAddress(rpcUrl, address, EIP1967_BEACON_SLOT);

      if (slotImpl) {
        implementationAddress = slotImpl;
        isProxy = true;
        proxyType = inferProxyTypeFromName(sourceResult.contractName, sourceText);
      }
      if (slotAdmin) {
        proxyAdminAddress = slotAdmin;
        isProxy = true;
      }
      if (slotBeacon) {
        isProxy = true;
        proxyType = 'beacon';
      }

      const minimalImpl = detectMinimalProxyImplementation(bytecode);
      if (minimalImpl) {
        implementationAddress = minimalImpl;
        isProxy = true;
        proxyType = 'minimal_proxy';
      }
    }

    if (isProxy && !implementationAddress && sourceResult.implementationAddress) {
      implementationAddress = sourceResult.implementationAddress;
    }

    const proxyKeywords = detectProxyFromKeywords(sourceResult.contractName, sourceText);
    if (proxyKeywords) {
      isProxy = true;
      if (!proxyType) {
        proxyType = inferProxyTypeFromName(sourceResult.contractName, sourceText);
      }
    }

    let implementationAbi = abi;
    let implementationSource = sourceText;
    if (isProxy && implementationAddress && implementationAddress !== address) {
      const implSource = await this.fetchEtherscanSource(implementationAddress, chain);
      if (implSource.abi) {
        implementationAbi = implSource.abi;
        implementationSource = implSource.sourceText ?? implementationSource;
      }
    }

    const scanAbi = implementationAbi ?? abi;
    const scanSource = implementationSource ?? sourceText ?? '';
    const scanAbiNames = extractAbiFunctionNames(scanAbi);
    const scanText = [scanSource, ...scanAbiNames, sourceResult.contractName ?? ''].join('\n');

    let ownerAddress = normalizeAddress(metadata?.owner ?? null);
    if (!ownerAddress && rpcUrl) {
      ownerAddress = await this.resolveOwner(rpcUrl, address);
      if (isProxy && implementationAddress && !ownerAddress) {
        ownerAddress = await this.resolveOwner(rpcUrl, implementationAddress);
      }
    }

    let ownerType: OwnerType = null;
    if (ownerAddress && rpcUrl) {
      ownerType = await this.resolveOwnerType(rpcUrl, ownerAddress, scanSource);
    }

    const adminAddresses = proxyAdminAddress ? [proxyAdminAddress] : [];

    return {
      contractAddress: address,
      chain,
      bytecode,
      bytecodeError,
      sourceFetchError: sourceResult.fetchError,
      verifiedSource,
      sourceProvider: sourceResult.sourceProvider,
      contractName: sourceResult.contractName,
      abi: scanAbi,
      sourceText: scanSource,
      etherscanProxyFlag: sourceResult.etherscanProxyFlag,
      etherscanImplementation: sourceResult.implementationAddress,
      implementationAddress,
      proxyAdminAddress,
      proxyType,
      isProxy,
      ownerAddress,
      ownerType,
      adminAddresses,
      scanText,
      abiFunctionNames: scanAbiNames,
    };
  }

  private getRpcUrl(chain: string): string | null {
    const apiKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    if (apiKey.trim().length === 0) {
      return null;
    }

    const networkMap: Record<string, string> = {
      ethereum: 'eth-mainnet',
      polygon: 'polygon-mainnet',
      bsc: 'bnb-mainnet',
      base: 'base-mainnet',
    };
    const network = networkMap[chain.toLowerCase()];
    return network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : null;
  }

  private getEtherscanChainId(chain: string): string | null {
    const map: Record<string, string> = {
      ethereum: '1',
      polygon: '137',
      base: '8453',
      bsc: '56',
    };
    return map[chain.toLowerCase()] ?? null;
  }

  private shouldSkipEtherscan(chainId: string): boolean {
    return chainId === '8453' || chainId === '56';
  }

  private async getCode(rpcUrl: string, address: string): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getCode',
          params: [address, 'latest'],
          id: 1,
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { result?: string };
      if (!payload.result || payload.result === '0x' || payload.result === '0x0') {
        return null;
      }
      return payload.result;
    } catch (err: unknown) {
      this.logger.warn(`eth_getCode failed: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async ethCall(
    rpcUrl: string,
    to: string,
    data: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
          id: 1,
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { result?: string };
      return typeof payload.result === 'string' && payload.result !== '0x'
        ? payload.result
        : null;
    } catch {
      return null;
    }
  }

  private async getStorageAddress(
    rpcUrl: string,
    address: string,
    slot: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getStorageAt',
          params: [address, slot, 'latest'],
          id: 1,
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { result?: string };
      return parseAddressFromStorage(payload.result);
    } catch {
      return null;
    }
  }

  private async resolveOwner(rpcUrl: string, address: string): Promise<string | null> {
    for (const selector of OWNER_SELECTORS) {
      const result = await this.ethCall(rpcUrl, address, selector);
      const parsed = parseAddressResult(result);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  private async resolveOwnerType(
    rpcUrl: string,
    ownerAddress: string,
    sourceText: string,
  ): Promise<OwnerType> {
    const code = await this.getCode(rpcUrl, ownerAddress);
    if (!code) {
      return 'eoa';
    }
    const lowerSource = sourceText.toLowerCase();
    if (
      /gnosissafe|gnosis safe|safeproxy|multisig/i.test(lowerSource) ||
      /gnosissafe|safeproxy/i.test(ownerAddress)
    ) {
      return 'multisig';
    }
    return 'contract';
  }

  private async fetchEtherscanSource(
    address: string,
    chain: string,
  ): Promise<{
    verifiedSource: boolean;
    sourceProvider: SourceProvider;
    contractName: string | null;
    abi: unknown[] | null;
    sourceText: string | null;
    etherscanProxyFlag: boolean;
    implementationAddress: string | null;
    fetchError: string | null;
  }> {
    const apiKey = this.config.get<string>('ETHERSCAN_API_KEY') ?? '';
    const chainId = this.getEtherscanChainId(chain);

    if (!chainId || this.shouldSkipEtherscan(chainId)) {
      return {
        verifiedSource: false,
        sourceProvider: 'none',
        contractName: null,
        abi: null,
        sourceText: null,
        etherscanProxyFlag: false,
        implementationAddress: null,
        fetchError: 'Etherscan not available for chain',
      };
    }

    if (apiKey.trim().length === 0) {
      return {
        verifiedSource: false,
        sourceProvider: 'none',
        contractName: null,
        abi: null,
        sourceText: null,
        etherscanProxyFlag: false,
        implementationAddress: null,
        fetchError: 'ETHERSCAN_API_KEY missing',
      };
    }

    try {
      const url = new URL('https://api.etherscan.io/v2/api');
      url.searchParams.set('chainid', chainId);
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', 'getsourcecode');
      url.searchParams.set('address', address);
      url.searchParams.set('apikey', apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        return {
          verifiedSource: false,
          sourceProvider: 'etherscan',
          contractName: null,
          abi: null,
          sourceText: null,
          etherscanProxyFlag: false,
          implementationAddress: null,
          fetchError: `HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as {
        status?: string;
        result?: EtherscanSourceResult[];
      };
      const row = payload.result?.[0];
      if (!row) {
        return {
          verifiedSource: false,
          sourceProvider: 'etherscan',
          contractName: null,
          abi: null,
          sourceText: null,
          etherscanProxyFlag: false,
          implementationAddress: null,
          fetchError: 'Empty Etherscan response',
        };
      }

      const contractName = row.ContractName?.trim() || null;
      const abi = parseAbiJson(row.ABI);
      const sourceText = normalizeSourceCode(row.SourceCode);
      const verifiedSource =
        Boolean(contractName) &&
        abi !== null &&
        sourceText !== null &&
        sourceText.length > 0 &&
        row.ABI !== 'Contract source code not verified';

      return {
        verifiedSource,
        sourceProvider: 'etherscan',
        contractName,
        abi,
        sourceText,
        etherscanProxyFlag: row.Proxy === '1',
        implementationAddress: normalizeAddress(row.Implementation ?? null),
        fetchError: null,
      };
    } catch (err: unknown) {
      return {
        verifiedSource: false,
        sourceProvider: 'etherscan',
        contractName: null,
        abi: null,
        sourceText: null,
        etherscanProxyFlag: false,
        implementationAddress: null,
        fetchError: getErrorMessage(err),
      };
    }
  }
}

export function buildContractSafetyReport(
  data: ContractSafetyCollectedData,
): ContractSafetyReport {
  const checkedAt = new Date().toISOString();
  const limitations: string[] = [];
  const unknowns: string[] = [];
  const flags: ContractSafetyFlag[] = [];
  const positiveSignals: ContractSafetyPositiveSignal[] = [];

  if (data.bytecodeError === 'No contract bytecode found.') {
    return {
      status: 'error',
      score: null,
      riskLevel: 'unknown',
      verdict: 'Contract safety could not be verified',
      confidence: 'low',
      verifiedSource: false,
      sourceProvider: data.sourceProvider,
      contractType: 'unknown',
      isProxy: false,
      proxyType: null,
      implementationAddress: null,
      proxyAdminAddress: null,
      owner: {
        ownerAddress: null,
        isRenounced: null,
        ownerType: null,
        adminAddresses: [],
      },
      permissions: createDefaultPermissions(),
      taxes: { status: 'unknown', buyTaxPct: null, sellTaxPct: null, transferTaxPct: null, evidence: [] },
      honeypot: { status: 'not_checked', reason: null, evidence: [] },
      flags: [],
      positiveSignals: [],
      unknowns: ['No contract bytecode found at address'],
      limitations: ['No contract bytecode found.'],
      checkedAt,
    };
  }

  const hasAbi = data.abi !== null && data.abiFunctionNames.length > 0;
  const hasSource = Boolean(data.sourceText && data.sourceText.length > 0);
  const canScanPermissions = hasAbi || hasSource;

  const permissions = scanPermissions(data.scanText, data.abiFunctionNames, canScanPermissions);
  const ownerAddress = data.ownerAddress;
  const isRenounced =
    ownerAddress === null
      ? null
      : ownerAddress === ZERO_ADDRESS || ownerAddress === DEAD_ADDRESS;

  const taxes = scanTaxes(data.scanText, canScanPermissions);
  const honeypot = {
    status: 'not_checked' as const,
    reason: null,
    evidence: [] as string[],
  };
  limitations.push('Honeypot / sell-restriction simulation was not run in this scan.');

  if (!data.verifiedSource) {
    flags.push({
      severity: 'high',
      title: 'Unverified Source Code',
      description:
        'Contract source is not verified on the explorer. Permission risks cannot be fully assessed.',
      evidence: data.sourceFetchError ?? 'Source not verified',
    });
  } else {
    positiveSignals.push({
      strength: 'high',
      title: 'Verified Source Code',
      description: 'Contract source is verified on the block explorer.',
    });
  }

  if (data.isProxy) {
    flags.push({
      severity: 'medium',
      title: 'Upgradeable Contract Requires Review',
      description:
        'This contract appears to be a proxy. Review the implementation contract and admin controls.',
      evidence: data.implementationAddress ?? undefined,
    });
    if (data.implementationAddress && data.verifiedSource) {
      positiveSignals.push({
        strength: 'medium',
        title: 'Known Proxy Implementation Verified',
        description: 'Proxy implementation address is known and source was reviewed.',
        evidence: data.implementationAddress,
      });
    }
    if (!data.implementationAddress) {
      flags.push({
        severity: 'high',
        title: 'Unknown Implementation Contract',
        description: 'Proxy detected but implementation address could not be resolved.',
      });
      unknowns.push('Proxy implementation address unknown');
    }
  }

  if (ownerAddress && isRenounced === false) {
    flags.push({
      severity: 'medium',
      title: 'Owner Privileges Active',
      description: 'Contract ownership has not been renounced. Admin functions may still be callable.',
      evidence: ownerAddress,
    });
  } else if (isRenounced === true) {
    positiveSignals.push({
      strength: 'medium',
      title: 'Ownership Renounced',
      description: 'Owner address is renounced or dead; direct owner privileges appear inactive.',
    });
  }

  applyPermissionFlags(permissions, flags, positiveSignals);

  if (data.ownerType === 'multisig' || data.ownerType === 'contract') {
    positiveSignals.push({
      strength: 'low',
      title: 'Multisig / Contract Admin instead of EOA',
      description: 'Admin appears to be a contract or multisig rather than a single EOA.',
      evidence: ownerAddress ?? undefined,
    });
  }

  const scoreResult = scoreContractSafety({
    verifiedSource: data.verifiedSource,
    hasAbi,
    sourceFetchError: data.sourceFetchError,
    ownerAddress,
    isRenounced,
    ownerType: data.ownerType,
    isProxy: data.isProxy,
    implementationAddress: data.implementationAddress,
    implementationVerified: data.isProxy && Boolean(data.implementationAddress) && data.verifiedSource,
    proxyAdminAddress: data.proxyAdminAddress,
    proxyAdminType: null,
    permissions,
    honeypot,
    sellRestrictionDetected: detectSellRestriction(data.scanText),
  });

  if (scoreResult.hardSevere) {
    flags.push({
      severity: 'severe',
      title: 'Honeypot / Sell Restriction Risk',
      description: 'Sell restriction or severe permission combination detected from available contract data.',
    });
  }

  const riskLevel = scoreResult.score === null ? 'unknown' : scoreResult.riskLevel;
  const verdict = resolveVerdict(riskLevel, flags, data.verifiedSource, data.isProxy);

  let confidence: ContractSafetyConfidence = 'low';
  if (data.verifiedSource && hasAbi) {
    confidence = 'high';
  } else if (hasAbi || hasSource || data.bytecode) {
    confidence = 'medium';
  }

  if (!canScanPermissions) {
    unknowns.push('ABI/source unavailable; permission scan incomplete');
    limitations.push('Permission scan limited without verified ABI/source.');
  }
  if (data.bytecodeError) {
    limitations.push('RPC bytecode fetch was incomplete.');
  }
  if (data.sourceFetchError) {
    limitations.push(`Source lookup issue: ${data.sourceFetchError}`);
  }
  limitations.push(
    'Contract safety is deterministic and based on available bytecode, ABI, and source only.',
  );

  const contractType: ContractType = data.isProxy ? 'proxy' : data.bytecode ? 'erc20' : 'unknown';

  let status: ContractSafetyStatus = 'done';
  if (data.bytecodeError || !canScanPermissions) {
    status = 'partial';
  }
  if (data.bytecodeError === 'RPC unavailable') {
    status = 'partial';
  }

  return {
    status,
    score: scoreResult.score,
    riskLevel,
    verdict,
    confidence,
    verifiedSource: data.verifiedSource,
    sourceProvider: data.sourceProvider,
    contractType,
    isProxy: data.isProxy,
    proxyType: data.proxyType,
    implementationAddress: data.implementationAddress,
    proxyAdminAddress: data.proxyAdminAddress,
    owner: {
      ownerAddress,
      isRenounced,
      ownerType: data.ownerType,
      adminAddresses: data.adminAddresses,
    },
    permissions,
    taxes,
    honeypot,
    flags,
    positiveSignals,
    unknowns,
    limitations,
    checkedAt,
  };
}

function scanPermissions(
  scanText: string,
  abiFunctionNames: string[],
  canScan: boolean,
): ContractSafetyReport['permissions'] {
  const combined = `${scanText}\n${abiFunctionNames.join('\n')}`;
  const permissions = createDefaultPermissions();

  if (!canScan) {
    const reason = 'ABI/source unavailable';
    for (const key of Object.keys(permissions) as Array<keyof typeof permissions>) {
      permissions[key] = emptyPermission(reason);
    }
    return permissions;
  }

  const entries: Array<keyof typeof permissions> = [
    'mint',
    'burn',
    'pause',
    'blacklist',
    'whitelist',
    'tradingGate',
    'taxChange',
    'maxTxOrMaxWallet',
    'upgradeability',
    'rescueOrWithdraw',
  ];

  for (const key of entries) {
    permissions[key] = detectPermission(key, combined, abiFunctionNames);
  }

  return permissions;
}

function detectPermission(
  key: keyof typeof PERMISSION_PATTERNS,
  text: string,
  abiNames: string[],
): PermissionSignal {
  const patterns = PERMISSION_PATTERNS[key];
  const evidence: string[] = [];

  for (const name of abiNames) {
    for (const pattern of [...patterns.clear, ...patterns.unclear]) {
      if (pattern.test(name)) {
        evidence.push(`ABI function: ${name}`);
      }
    }
  }

  const clearMatch = patterns.clear.some((pattern) => pattern.test(text));
  const unclearMatch = patterns.unclear.some((pattern) => pattern.test(text));

  if (clearMatch || evidence.length > 0) {
    const severeKeys = new Set(['mint', 'blacklist', 'tradingGate', 'taxChange']);
    const mediumKeys = new Set(['pause', 'maxTxOrMaxWallet', 'upgradeability', 'rescueOrWithdraw']);
    let risk: PermissionRisk = 'medium';
    if (severeKeys.has(key)) {
      risk = 'high';
    } else if (mediumKeys.has(key)) {
      risk = 'medium';
    } else if (key === 'burn' || key === 'whitelist') {
      risk = 'low';
    } else {
      risk = 'medium';
    }
    return {
      detected: true,
      risk,
      reason: `${key} capability pattern detected`,
      evidence: evidence.length > 0 ? evidence : [`Pattern match in source/ABI for ${key}`],
    };
  }

  if (unclearMatch) {
    return {
      detected: true,
      risk: 'medium',
      reason: `${key} pattern detected with unclear externality`,
      evidence: [`Unclear ${key} pattern in source`],
    };
  }

  return {
    detected: false,
    risk: 'none',
    reason: `No ${key} pattern detected`,
    evidence: [],
  };
}

function applyPermissionFlags(
  permissions: ContractSafetyReport['permissions'],
  flags: ContractSafetyFlag[],
  positives: ContractSafetyPositiveSignal[],
): void {
  if (permissions.mint.detected) {
    flags.push({
      severity: permissions.mint.risk === 'high' ? 'high' : 'medium',
      title: 'Mint Function Detected',
      description: 'Contract appears to expose mint or supply-increase capability.',
      evidence: permissions.mint.evidence.join('; ') || undefined,
    });
  } else if (permissions.mint.detected === false) {
    positives.push({
      strength: 'medium',
      title: 'No Mint Function Detected',
      description: 'No mint or supply-increase function was detected in available ABI/source.',
    });
  }

  if (permissions.blacklist.detected) {
    flags.push({
      severity: 'high',
      title: 'Blacklist Controls Detected',
      description: 'Blacklist or antibot controls appear present in the contract.',
      evidence: permissions.blacklist.evidence.join('; ') || undefined,
    });
  } else if (permissions.blacklist.detected === false) {
    positives.push({
      strength: 'medium',
      title: 'No Blacklist Function Detected',
      description: 'No blacklist control pattern was detected in available ABI/source.',
    });
  }

  if (permissions.pause.detected || permissions.tradingGate.detected) {
    flags.push({
      severity: 'medium',
      title: 'Trading Pause / Gate Controls Detected',
      description: 'Pause or trading gate controls appear present.',
    });
  }

  if (permissions.taxChange.detected) {
    flags.push({
      severity: 'high',
      title: 'Tax or Fee Controls Detected',
      description: 'Tax or fee change functions appear present in the contract.',
    });
  } else if (permissions.taxChange.detected === false) {
    positives.push({
      strength: 'low',
      title: 'No Tax Controls Detected',
      description: 'No tax/fee change function pattern was detected in available ABI/source.',
    });
  }

  if (permissions.maxTxOrMaxWallet.detected) {
    flags.push({
      severity: 'low',
      title: 'Max Wallet / Max Transaction Controls',
      description: 'Max transaction or max wallet controls appear present.',
    });
  }
}

function scanTaxes(
  text: string,
  canScan: boolean,
): ContractSafetyReport['taxes'] {
  if (!canScan) {
    return {
      status: 'unknown',
      buyTaxPct: null,
      sellTaxPct: null,
      transferTaxPct: null,
      evidence: [],
    };
  }

  const hasTaxPattern = PERMISSION_PATTERNS.taxChange.clear.some((pattern) => pattern.test(text));
  return {
    status: hasTaxPattern ? 'detected' : 'not_detected',
    buyTaxPct: null,
    sellTaxPct: null,
    transferTaxPct: null,
    evidence: hasTaxPattern ? ['Tax/fee function names present; live rates not simulated'] : [],
  };
}

function detectSellRestriction(text: string): boolean {
  return /\bcannot\s+sell\b|\bsell\s+disabled\b|\bantiSell\b|\bblocks?\s+sell/i.test(text);
}

interface ScoreInput {
  verifiedSource: boolean;
  hasAbi: boolean;
  sourceFetchError: string | null;
  ownerAddress: string | null;
  isRenounced: boolean | null;
  ownerType: OwnerType;
  isProxy: boolean;
  implementationAddress: string | null;
  implementationVerified: boolean;
  proxyAdminAddress: string | null;
  proxyAdminType: OwnerType;
  permissions: ContractSafetyReport['permissions'];
  honeypot: ContractSafetyReport['honeypot'];
  sellRestrictionDetected: boolean;
}

function scoreContractSafety(input: ScoreInput): {
  score: number | null;
  riskLevel: ContractSafetyRiskLevel;
  hardSevere: boolean;
} {
  if (input.honeypot.status === 'fail') {
    return { score: clamp(100 - 35, 0, 100), riskLevel: 'severe', hardSevere: true };
  }

  let score = 100;
  let hardSevere = false;

  if (!input.verifiedSource) {
    score -= 25;
  }
  if (!input.hasAbi) {
    score -= 15;
  }
  if (input.sourceFetchError) {
    score -= 8;
  }

  if (input.isRenounced === true) {
    score += 3;
  } else if (input.ownerAddress) {
    if (input.ownerType === 'eoa') {
      score -= 8;
    } else if (input.ownerType === 'contract' || input.ownerType === 'multisig') {
      score -= 4;
    }
  } else if (input.ownerAddress === null && input.isRenounced === null) {
    score -= 6;
  }

  if (input.isProxy) {
    if (input.implementationAddress && input.implementationVerified) {
      score -= 5;
    } else if (!input.implementationAddress) {
      score -= 15;
    } else {
      score -= 8;
    }
    if (input.proxyAdminAddress) {
      score -= 8;
    }
  }

  if (input.permissions.mint.detected === true) {
    score -= input.permissions.mint.risk === 'high' ? 25 : 12;
  } else if (input.permissions.mint.detected === null) {
    score -= 0;
  }

  if (input.permissions.blacklist.detected === true) {
    score -= input.permissions.blacklist.risk === 'high' ? 20 : 10;
  }

  if (input.permissions.pause.detected === true) {
    score -= 10;
  }
  if (input.permissions.tradingGate.detected === true) {
    score -= 15;
  }

  if (input.permissions.taxChange.detected === true) {
    score -= 18;
  } else if (input.permissions.taxChange.detected === null) {
    score -= 0;
  } else if (input.permissions.taxChange.risk === 'medium') {
    score -= 8;
  }

  if (input.permissions.maxTxOrMaxWallet.detected === true) {
    score -= 8;
  }

  if (input.permissions.rescueOrWithdraw.detected === true) {
    score -= 5;
  }

  if (input.honeypot.status === 'warning') {
    score -= 15;
  }

  score = clamp(Math.round(score), 0, 100);

  const ownerActive = input.isRenounced === false && Boolean(input.ownerAddress);
  const highRiskControls =
    input.permissions.blacklist.detected === true ||
    input.permissions.taxChange.detected === true ||
    input.permissions.tradingGate.detected === true;

  if (
    input.sellRestrictionDetected ||
    (!input.verifiedSource && highRiskControls) ||
    (ownerActive &&
      input.permissions.mint.detected === true &&
      input.permissions.blacklist.detected === true) ||
    (!input.implementationAddress &&
      input.isProxy &&
      (input.permissions.mint.detected === true ||
        input.permissions.blacklist.detected === true ||
        input.permissions.tradingGate.detected === true))
  ) {
    hardSevere = true;
    score = Math.min(score, 44);
  }

  const riskLevel = resolveRiskLevel(score, hardSevere);
  return { score, riskLevel, hardSevere };
}

function resolveRiskLevel(
  score: number,
  hardSevere: boolean,
): ContractSafetyRiskLevel {
  if (hardSevere) {
    return 'severe';
  }
  if (score >= 85) {
    return 'low';
  }
  if (score >= 70) {
    return 'moderate';
  }
  if (score >= 45) {
    return 'high';
  }
  return 'severe';
}

function resolveVerdict(
  riskLevel: ContractSafetyRiskLevel,
  flags: ContractSafetyFlag[],
  verifiedSource: boolean,
  isProxy: boolean,
): string {
  if (riskLevel === 'unknown') {
    return 'Contract safety could not be verified';
  }
  if (riskLevel === 'severe') {
    return 'Severe contract risk — trading or supply controls detected';
  }
  if (riskLevel === 'high') {
    return 'High-risk token controls detected';
  }
  if (flags.some((flag) => flag.title === 'Owner Privileges Active')) {
    return 'Owner-controlled permissions require review';
  }
  if (isProxy && verifiedSource) {
    return 'Verified contract with upgradeability review required';
  }
  if (riskLevel === 'low' || riskLevel === 'moderate') {
    return 'No major contract permission risks detected from available contract data';
  }
  return 'Contract safety requires review';
}

function extractAbiFunctionNames(abi: unknown[] | null): string[] {
  if (!abi) {
    return [];
  }
  return abi
    .filter((entry): entry is AbiEntry => typeof entry === 'object' && entry !== null)
    .filter((entry) => entry.type === 'function' && typeof entry.name === 'string')
    .map((entry) => entry.name as string);
}

function parseAbiJson(raw: string | undefined): unknown[] | null {
  if (!raw || raw === 'Contract source code not verified') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSourceCode(raw: string | undefined): string | null {
  if (!raw || raw === 'Contract source code not verified') {
    return null;
  }
  if (raw.startsWith('{{')) {
    try {
      const parsed = JSON.parse(raw.slice(1, -1)) as { sources?: Record<string, { content?: string }> };
      const parts = Object.values(parsed.sources ?? {})
        .map((source) => source.content ?? '')
        .filter((content) => content.length > 0);
      return parts.join('\n');
    } catch {
      return raw;
    }
  }
  return raw;
}

function parseAddressResult(hex: string | null | undefined): string | null {
  if (!hex || hex.length < 42) {
    return null;
  }
  const cleaned = hex.toLowerCase();
  const suffix = cleaned.slice(-40);
  if (!/^[0-9a-f]{40}$/.test(suffix)) {
    return null;
  }
  const address = `0x${suffix}`;
  if (address === ZERO_ADDRESS) {
    return ZERO_ADDRESS;
  }
  return address;
}

function parseAddressFromStorage(hex: string | null | undefined): string | null {
  const address = parseAddressResult(hex);
  if (!address || address === ZERO_ADDRESS) {
    return null;
  }
  return address;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function detectMinimalProxyImplementation(bytecode: string): string | null {
  const normalized = bytecode.toLowerCase();
  if (!normalized.startsWith('0x363d3d373d3d3d363d73')) {
    return null;
  }
  const implHex = normalized.slice(22, 62);
  if (implHex.length !== 40 || !/^[0-9a-f]{40}$/.test(implHex)) {
    return null;
  }
  return `0x${implHex}`;
}

function detectProxyFromKeywords(contractName: string | null, sourceText: string | null): boolean {
  const haystack = `${contractName ?? ''}\n${sourceText ?? ''}`;
  return /TransparentUpgradeableProxy|ERC1967Proxy|\bUUPS\b|BeaconProxy|Initializable|\bProxy\b/i.test(
    haystack,
  );
}

function inferProxyTypeFromName(
  contractName: string | null,
  sourceText: string | null,
): ProxyType {
  const haystack = `${contractName ?? ''}\n${sourceText ?? ''}`;
  if (/TransparentUpgradeableProxy/i.test(haystack)) {
    return 'transparent';
  }
  if (/\bUUPS\b/i.test(haystack)) {
    return 'uups';
  }
  if (/BeaconProxy/i.test(haystack)) {
    return 'beacon';
  }
  if (/ERC1967Proxy/i.test(haystack)) {
    return 'uups';
  }
  return 'unknown';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
