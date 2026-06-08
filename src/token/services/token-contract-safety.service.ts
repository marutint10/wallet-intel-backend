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
export type BytecodeFetchStatus =
  | 'success'
  | 'empty'
  | 'rpc_error'
  | 'chain_mismatch'
  | 'no_provider';
export type SourceLookupStatus =
  | 'success'
  | 'not_verified'
  | 'error'
  | 'not_checked';

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

export interface ContractSafetyDebugMeta {
  chainId: string | null;
  bytecodeLength: number | null;
  sourceLookupStatus: SourceLookupStatus;
  scannedAddress: string;
  implementationScanned: boolean;
  rpcProvider: string | null;
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
  debugMeta?: ContractSafetyDebugMeta;
}

export interface ParsedAbiFunction {
  name: string;
  stateMutability: string;
  isStateChanging: boolean;
  signature: string;
}

export interface ContractSafetyCollectedData {
  contractAddress: string;
  chain: string;
  bytecode: string | null;
  bytecodeFetchStatus: BytecodeFetchStatus;
  bytecodeError: string | null;
  chainId: string | null;
  rpcProvider: string | null;
  rpcBytecodeConflict: boolean;
  sourceFetchError: string | null;
  sourceLookupStatus: SourceLookupStatus;
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
  implementationScanned: boolean;
  ownerAddress: string | null;
  ownerType: OwnerType;
  adminAddresses: string[];
  parsedAbiFunctions: ParsedAbiFunction[];
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

const OWNER_SELECTORS = ['0x8da5cb5b', '0x893d20e8', '0xf851a440'];

const EXPECTED_CHAIN_IDS: Record<string, string> = {
  ethereum: '0x1',
  polygon: '0x89',
  base: '0x2105',
  bsc: '0x38',
};

const BYTECODE_RETRY_ATTEMPTS = 3;
const BYTECODE_RETRY_BACKOFF_MS = 250;

interface AbiEntry {
  type?: string;
  name?: string;
  stateMutability?: string;
  inputs?: Array<{ type?: string; name?: string }>;
}

interface EtherscanSourceResult {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  Proxy?: string;
  Implementation?: string;
}

interface RpcProvider {
  name: string;
  url: string;
}

interface BytecodeFetchResult {
  bytecode: string | null;
  status: BytecodeFetchStatus;
  error: string | null;
  provider: string | null;
  chainId: string | null;
}

type PermissionKey =
  | 'mint'
  | 'burn'
  | 'pause'
  | 'blacklist'
  | 'whitelist'
  | 'tradingGate'
  | 'taxChange'
  | 'maxTxOrMaxWallet'
  | 'upgradeability'
  | 'rescueOrWithdraw';

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
    const bytecodeResult = await this.fetchBytecode(address, chain);
    const sourceResult = await this.fetchEtherscanSource(address, chain);

    const sourceLookupStatus: SourceLookupStatus = sourceResult.fetchError
      ? 'error'
      : sourceResult.verifiedSource
        ? 'success'
        : sourceResult.sourceProvider === 'none'
          ? 'not_checked'
          : 'not_verified';

    const abi = sourceResult.abi;
    const sourceText = sourceResult.sourceText;
    const verifiedSource = sourceResult.verifiedSource;
    const rpcUrl = bytecodeResult.provider
      ? this.getProviderUrlByName(bytecodeResult.provider, chain)
      : null;

    let implementationAddress = sourceResult.implementationAddress;
    let proxyAdminAddress: string | null = null;
    let proxyType: ProxyType = null;
    let isProxy = sourceResult.etherscanProxyFlag;
    const bytecode = bytecodeResult.bytecode;

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

    if (detectProxyFromKeywords(sourceResult.contractName, sourceText)) {
      isProxy = true;
      if (!proxyType) {
        proxyType = inferProxyTypeFromName(sourceResult.contractName, sourceText);
      }
    }

    let implementationAbi = abi;
    let implementationSource = sourceText;
    let implementationScanned = false;
    if (isProxy && implementationAddress && implementationAddress !== address) {
      const implSource = await this.fetchEtherscanSource(implementationAddress, chain);
      if (implSource.abi) {
        implementationAbi = implSource.abi;
        implementationSource = implSource.sourceText ?? implementationSource;
        implementationScanned = true;
      }
    }

    const scanAbi = implementationAbi ?? abi;
    const scanSource = implementationSource ?? sourceText ?? '';
    const parsedAbiFunctions = parseAbiFunctions(scanAbi);
    const abiFunctionNames = parsedAbiFunctions.map((fn) => fn.name);

    const rpcBytecodeConflict =
      bytecodeResult.status === 'empty' &&
      verifiedSource &&
      Boolean(bytecodeResult.provider);

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

    return {
      contractAddress: address,
      chain,
      bytecode,
      bytecodeFetchStatus: bytecodeResult.status,
      bytecodeError: bytecodeResult.error,
      chainId: bytecodeResult.chainId,
      rpcProvider: bytecodeResult.provider,
      rpcBytecodeConflict,
      sourceFetchError: sourceResult.fetchError,
      sourceLookupStatus,
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
      implementationScanned,
      ownerAddress,
      ownerType,
      adminAddresses: proxyAdminAddress ? [proxyAdminAddress] : [],
      parsedAbiFunctions,
      abiFunctionNames,
    };
  }

  private getRpcProviders(chain: string): RpcProvider[] {
    const providers: RpcProvider[] = [];
    const apiKey = this.config.get<string>('ALCHEMY_API_KEY') ?? '';
    const networkMap: Record<string, string> = {
      ethereum: 'eth-mainnet',
      polygon: 'polygon-mainnet',
      bsc: 'bnb-mainnet',
      base: 'base-mainnet',
    };
    const network = networkMap[chain.toLowerCase()];
    if (apiKey.trim().length > 0 && network) {
      providers.push({
        name: 'alchemy',
        url: `https://${network}.g.alchemy.com/v2/${apiKey}`,
      });
    }

    const rpcUrls = this.config.get<Record<string, string>>('rpc.urls') ?? {};
    const fallbackUrl = rpcUrls[chain.toLowerCase()];
    if (fallbackUrl && !providers.some((provider) => provider.url === fallbackUrl)) {
      providers.push({ name: 'fallback_rpc', url: fallbackUrl });
    }

    return providers;
  }

  private getProviderUrlByName(name: string, chain: string): string | null {
    return this.getRpcProviders(chain).find((provider) => provider.name === name)?.url ?? null;
  }

  private async fetchBytecode(address: string, chain: string): Promise<BytecodeFetchResult> {
    const providers = this.getRpcProviders(chain);
    const expectedChainId = EXPECTED_CHAIN_IDS[chain.toLowerCase()];

    if (providers.length === 0) {
      return {
        bytecode: null,
        status: 'no_provider',
        error: 'No RPC provider configured',
        provider: null,
        chainId: null,
      };
    }

    let lastRpcError: string | null = null;

    for (const provider of providers) {
      const chainId = await this.getChainId(provider.url);
      if (expectedChainId && chainId && chainId !== expectedChainId) {
        this.logger.warn(
          `[contract-safety] chain mismatch provider=${provider.name} chain=${chain} expected=${expectedChainId} got=${chainId}`,
        );
        return {
          bytecode: null,
          status: 'chain_mismatch',
          error: `RPC chain mismatch: expected ${chain} mainnet.`,
          provider: provider.name,
          chainId,
        };
      }

      for (let attempt = 1; attempt <= BYTECODE_RETRY_ATTEMPTS; attempt += 1) {
        const codeResult = await this.getCodeOnce(provider.url, address);
        if (codeResult.kind === 'success') {
          this.logger.debug(
            `[contract-safety] bytecode ok provider=${provider.name} chain=${chain} len=${codeResult.bytecode.length}`,
          );
          return {
            bytecode: codeResult.bytecode,
            status: 'success',
            error: null,
            provider: provider.name,
            chainId,
          };
        }
        if (codeResult.kind === 'empty') {
          return {
            bytecode: null,
            status: 'empty',
            error: `No contract bytecode found at ${address} on ${chain}.`,
            provider: provider.name,
            chainId,
          };
        }

        lastRpcError = codeResult.error;
        if (attempt < BYTECODE_RETRY_ATTEMPTS) {
          await sleep(BYTECODE_RETRY_BACKOFF_MS * attempt);
        }
      }
    }

    return {
      bytecode: null,
      status: 'rpc_error',
      error: lastRpcError ?? 'Bytecode fetch failed due to RPC/provider error',
      provider: providers[providers.length - 1]?.name ?? null,
      chainId: null,
    };
  }

  private async getChainId(rpcUrl: string): Promise<string | null> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { result?: string; error?: { message?: string } };
      if (payload.error?.message) {
        return null;
      }
      return typeof payload.result === 'string' ? payload.result.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  private async getCodeOnce(
    rpcUrl: string,
    address: string,
  ): Promise<
    | { kind: 'success'; bytecode: string }
    | { kind: 'empty' }
    | { kind: 'rpc_error'; error: string }
  > {
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
        return { kind: 'rpc_error', error: `RPC HTTP ${response.status}` };
      }

      const payload = (await response.json()) as {
        result?: string;
        error?: { message?: string };
      };

      if (payload.error?.message) {
        return { kind: 'rpc_error', error: payload.error.message };
      }

      if (typeof payload.result !== 'string') {
        return { kind: 'rpc_error', error: 'Malformed eth_getCode response' };
      }

      if (payload.result === '0x' || payload.result === '0x0') {
        return { kind: 'empty' };
      }

      return { kind: 'success', bytecode: payload.result };
    } catch (err: unknown) {
      return { kind: 'rpc_error', error: getErrorMessage(err) };
    }
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

  private async ethCall(rpcUrl: string, to: string, data: string): Promise<string | null> {
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
    const codeResult = await this.getCodeOnce(rpcUrl, ownerAddress);
    if (codeResult.kind !== 'success') {
      return 'eoa';
    }
    const lowerSource = sourceText.toLowerCase();
    if (/gnosissafe|gnosis safe|safeproxy|multisig/i.test(lowerSource)) {
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

  const debugMeta: ContractSafetyDebugMeta = {
    chainId: data.chainId,
    bytecodeLength: data.bytecode ? Math.max(0, (data.bytecode.length - 2) / 2) : null,
    sourceLookupStatus: data.sourceLookupStatus,
    scannedAddress: data.contractAddress,
    implementationScanned: data.implementationScanned,
    rpcProvider: data.rpcProvider,
  };

  if (data.bytecodeFetchStatus === 'chain_mismatch') {
    return buildBlockedReport(data, checkedAt, debugMeta, {
      status: 'error',
      limitations: [
        data.bytecodeError ?? 'RPC chain mismatch: expected ethereum mainnet.',
      ],
      unknowns: ['RPC chain mismatch prevented bytecode verification'],
    });
  }

  if (data.bytecodeFetchStatus === 'rpc_error' || data.bytecodeFetchStatus === 'no_provider') {
    limitations.push(data.bytecodeError ?? 'Bytecode fetch failed due to RPC/provider error');
    unknowns.push('Bytecode fetch failed due to RPC/provider error');
  }

  if (data.bytecodeFetchStatus === 'empty' && !data.verifiedSource) {
    return buildBlockedReport(data, checkedAt, debugMeta, {
      status: 'error',
      limitations: [
        data.bytecodeError ??
          `No contract bytecode found at ${data.contractAddress} on ${data.chain}.`,
      ],
      unknowns: [
        `No contract bytecode found at ${data.contractAddress} on ${data.chain} (checkedAt ${checkedAt})`,
      ],
    });
  }

  if (data.rpcBytecodeConflict) {
    unknowns.push('RPC bytecode result conflicts with verified source lookup');
    limitations.push(
      'RPC returned empty bytecode but explorer source is verified; treating scan as partial.',
    );
    flags.push({
      severity: 'medium',
      title: 'RPC Bytecode Conflict',
      description:
        'Explorer shows verified source but RPC returned empty bytecode. Permission scan uses source/ABI only.',
    });
  }

  const hasAbi = data.parsedAbiFunctions.length > 0;
  const hasSource = Boolean(data.sourceText && data.sourceText.length > 0);
  const canScanPermissions = hasAbi || hasSource;

  const permissions = scanPermissions(
    data.parsedAbiFunctions,
    data.sourceText,
    canScanPermissions,
    data.verifiedSource,
  );

  const ownerAddress = data.ownerAddress;
  const isRenounced =
    ownerAddress === null
      ? null
      : ownerAddress === ZERO_ADDRESS || ownerAddress === DEAD_ADDRESS;

  const taxes = scanTaxes(permissions.taxChange, data.verifiedSource);
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
        severity: data.bytecodeFetchStatus === 'rpc_error' ? 'medium' : 'high',
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

  const effectivePermissions = applyEffectivePermissionRisk(
    permissions,
    isRenounced,
    data.verifiedSource,
  );

  applyPermissionFlags(
    effectivePermissions,
    flags,
    positiveSignals,
    isRenounced,
    data.verifiedSource,
  );

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
    permissions: effectivePermissions,
    honeypot,
    sellRestrictionDetected: detectSellRestriction(data.sourceText),
    bytecodeFetchStatus: data.bytecodeFetchStatus,
  });

  if (scoreResult.hardSevere) {
    flags.push({
      severity: 'severe',
      title: 'Honeypot / Sell Restriction Risk',
      description: 'Sell restriction or severe permission combination detected from available contract data.',
    });
  }

  const riskLevel =
    scoreResult.score === null ||
    data.bytecodeFetchStatus === 'rpc_error' ||
    data.bytecodeFetchStatus === 'no_provider'
      ? 'unknown'
      : scoreResult.riskLevel;
  const verdict = resolveVerdict(
    riskLevel,
    flags,
    effectivePermissions,
    data.verifiedSource,
    data.isProxy,
    isRenounced,
  );

  let confidence: ContractSafetyConfidence = 'low';
  if (data.verifiedSource && hasAbi) {
    confidence = 'high';
  } else if (hasAbi || (hasSource && data.verifiedSource)) {
    confidence = 'medium';
  }

  if (!canScanPermissions) {
    unknowns.push('ABI/source unavailable; permission scan incomplete');
    limitations.push('Permission scan limited without verified ABI/source.');
  }
  if (data.sourceFetchError) {
    limitations.push(`Source lookup issue: ${data.sourceFetchError}`);
  }
  limitations.push(
    'Contract safety is deterministic and based on available bytecode, ABI, and source only.',
  );

  const contractType: ContractType = data.isProxy
    ? 'proxy'
    : data.bytecode || data.verifiedSource
      ? 'erc20'
      : 'unknown';

  let status: ContractSafetyStatus = 'done';
  if (
    data.bytecodeFetchStatus === 'rpc_error' ||
    data.bytecodeFetchStatus === 'no_provider' ||
    data.rpcBytecodeConflict ||
    !canScanPermissions
  ) {
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
    permissions: effectivePermissions,
    taxes,
    honeypot,
    flags,
    positiveSignals,
    unknowns,
    limitations,
    checkedAt,
    debugMeta,
  };
}

function buildBlockedReport(
  data: ContractSafetyCollectedData,
  checkedAt: string,
  debugMeta: ContractSafetyDebugMeta,
  options: { status: ContractSafetyStatus; limitations: string[]; unknowns: string[] },
): ContractSafetyReport {
  return {
    status: options.status,
    score: null,
    riskLevel: 'unknown',
    verdict: 'Contract safety could not be verified',
    confidence: 'low',
    verifiedSource: data.verifiedSource,
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
    taxes: {
      status: 'unknown',
      buyTaxPct: null,
      sellTaxPct: null,
      transferTaxPct: null,
      evidence: [],
    },
    honeypot: { status: 'not_checked', reason: null, evidence: [] },
    flags: [],
    positiveSignals: [],
    unknowns: options.unknowns,
    limitations: options.limitations,
    checkedAt,
    debugMeta,
  };
}

function scanPermissions(
  abiFunctions: ParsedAbiFunction[],
  sourceText: string | null,
  canScan: boolean,
  verifiedSource: boolean,
): ContractSafetyReport['permissions'] {
  const permissions = createDefaultPermissions();
  if (!canScan) {
    const reason = 'ABI/source unavailable';
    for (const key of Object.keys(permissions) as PermissionKey[]) {
      permissions[key] = emptyPermission(reason);
    }
    return permissions;
  }

  const sourceWithoutComments = sourceText ? stripSolidityComments(sourceText) : '';
  const sourceHints = extractExternalSourceFunctions(sourceWithoutComments);

  const rules: Array<{ key: PermissionKey; matcher: (fn: ParsedAbiFunction) => boolean }> = [
    { key: 'mint', matcher: isExternalMintFunction },
    { key: 'burn', matcher: isExternalBurnFunction },
    { key: 'pause', matcher: isExternalPauseFunction },
    { key: 'blacklist', matcher: isExternalBlacklistFunction },
    { key: 'whitelist', matcher: isExternalWhitelistFunction },
    { key: 'tradingGate', matcher: isExternalTradingGateFunction },
    { key: 'taxChange', matcher: isExternalTaxFunction },
    { key: 'maxTxOrMaxWallet', matcher: isExternalMaxLimitFunction },
    { key: 'upgradeability', matcher: isExternalUpgradeFunction },
    { key: 'rescueOrWithdraw', matcher: isExternalRescueFunction },
  ];

  for (const rule of rules) {
    permissions[rule.key] = detectPermissionFromEvidence(
      rule.key,
      abiFunctions.filter(rule.matcher),
      sourceWithoutComments,
      sourceHints,
      verifiedSource,
    );
  }

  return permissions;
}

function detectPermissionFromEvidence(
  key: PermissionKey,
  abiMatches: ParsedAbiFunction[],
  sourceWithoutComments: string,
  sourceHints: SourceFunctionHint[],
  verifiedSource: boolean,
): PermissionSignal {
  if (abiMatches.length > 0) {
    const evidence = abiMatches.map((fn) =>
      formatAbiEvidence(fn, key, inferAccessHint(sourceWithoutComments, fn.name)),
    );
    const risk = resolvePermissionRisk(key, 'abi', abiMatches);
    return {
      detected: true,
      risk,
      reason: `External/public ${key} capability found in ABI`,
      evidence,
    };
  }

  if (key === 'mint') {
    const internalMintOnly =
      /\bfunction\s+_mint\b/i.test(sourceWithoutComments) && abiMatches.length === 0;
    if (internalMintOnly) {
      return {
        detected: false,
        risk: 'none',
        reason: 'Only internal _mint found; not treated as external mint permission',
        evidence: ['Source contains internal _mint only; not treated as external mint permission'],
      };
    }
  }

  const weakSourceHints = sourceHints.filter((hint) => matchesPermissionKey(key, hint.name));
  if (weakSourceHints.length > 0 && !verifiedSource) {
    return {
      detected: null,
      risk: 'unknown',
      reason: `${key} term found in source without verified ABI/external evidence`,
      evidence: weakSourceHints.map(
        (hint) =>
          `Source text match for ${hint.name}; visibility ${hint.visibility}; not treated as confirmed external permission`,
      ),
    };
  }

  if (hasWeakSourceTextOnly(key, sourceWithoutComments) && verifiedSource) {
    return {
      detected: null,
      risk: 'low',
      reason: `${key}-like term in source only; no external ABI evidence`,
      evidence: [
        `Source contains ${key}-like terms without external/public ABI function; not treated as active admin risk`,
      ],
    };
  }

  const negativeTitle =
    key === 'mint' ? 'No external mint function detected' : `No ${key} pattern detected`;
  return {
    detected: false,
    risk: 'none',
    reason: negativeTitle,
    evidence: [],
  };
}

function formatAbiEvidence(
  fn: ParsedAbiFunction,
  key: PermissionKey,
  accessHint: string,
): string {
  const visibility = fn.isStateChanging ? 'external/public state-changing' : 'external/public view';
  return `ABI ${visibility} function ${fn.signature} matched ${key} control pattern; access ${accessHint}`;
}

function resolvePermissionRisk(
  key: PermissionKey,
  source: 'abi' | 'source_text',
  abiMatches: ParsedAbiFunction[],
): PermissionRisk {
  if (source !== 'abi') {
    return 'unknown';
  }
  const stateChanging = abiMatches.some((fn) => fn.isStateChanging);
  if (!stateChanging) {
    return 'low';
  }

  const highKeys = new Set<PermissionKey>(['mint', 'blacklist', 'tradingGate', 'taxChange']);
  const mediumKeys = new Set<PermissionKey>([
    'pause',
    'maxTxOrMaxWallet',
    'upgradeability',
    'rescueOrWithdraw',
  ]);

  if (highKeys.has(key)) {
    return 'high';
  }
  if (mediumKeys.has(key)) {
    return 'medium';
  }
  return 'low';
}

function isExternalMintFunction(fn: ParsedAbiFunction): boolean {
  if (!fn.isStateChanging) {
    return false;
  }
  return /^(owner)?mint$|increasesupply$|^issue$/i.test(fn.name) && !fn.name.startsWith('_');
}

function isExternalBurnFunction(fn: ParsedAbiFunction): boolean {
  return fn.isStateChanging && /^(burn|burnfrom)$/i.test(fn.name);
}

function isExternalPauseFunction(fn: ParsedAbiFunction): boolean {
  return fn.isStateChanging && /^(pause|unpause)$/i.test(fn.name);
}

function isExternalBlacklistFunction(fn: ParsedAbiFunction): boolean {
  if (!fn.isStateChanging) {
    return false;
  }
  return /^(set)?blacklist$|setbotlist$|antibot$|addblacklist$/i.test(fn.name);
}

function isExternalWhitelistFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(set)?whitelist$|excludefrommaxtransaction$/i.test(fn.name)
  );
}

function isExternalTradingGateFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(enabletrading|opentrading|settradingenabled)$/i.test(fn.name)
  );
}

function isExternalTaxFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(settax|setfees|setbuyfee|setsellfee|settransferfee|updatefees)$/i.test(fn.name)
  );
}

function isExternalMaxLimitFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(setmaxtx|setmaxwallet|setmaxtransactionamount)$/i.test(fn.name)
  );
}

function isExternalUpgradeFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(upgradeto|upgradetoandcall)$/i.test(fn.name)
  );
}

function isExternalRescueFunction(fn: ParsedAbiFunction): boolean {
  return (
    fn.isStateChanging &&
    /^(rescuetokens|withdrawtoken|recovererc20|sweep|rescueeth)$/i.test(fn.name)
  );
}

function hasWeakSourceTextOnly(key: PermissionKey, source: string): boolean {
  const patterns: Record<PermissionKey, RegExp> = {
    mint: /(?<!_)\bmint\b/i,
    burn: /\bburn\b/i,
    pause: /\bpaused\b/i,
    blacklist: /\bblacklist\b|\bbotlist\b|\bantibot\b/i,
    whitelist: /\bwhitelist\b/i,
    tradingGate: /\btradingenabled\b|\benabletrading\b/i,
    taxChange: /\btaxwallet\b|\bfee\b/i,
    maxTxOrMaxWallet: /\bmaxwallet\b|\bmaxtransactionamount\b/i,
    upgradeability: /\bproxyadmin\b|\bimplementation\b/i,
    rescueOrWithdraw: /\brescue\b|\bsweep\b/i,
  };
  return patterns[key].test(source);
}

function matchesPermissionKey(key: PermissionKey, name: string): boolean {
  const lowered = name.toLowerCase();
  const map: Record<PermissionKey, RegExp> = {
    mint: /mint|increasesupply|issue/,
    burn: /burn/,
    pause: /pause/,
    blacklist: /blacklist|botlist|antibot/,
    whitelist: /whitelist/,
    tradingGate: /trading|enabletrading/,
    taxChange: /tax|fee/,
    maxTxOrMaxWallet: /maxwallet|maxtx/,
    upgradeability: /upgrade|implementation|proxyadmin/,
    rescueOrWithdraw: /rescue|sweep|recover/,
  };
  return map[key].test(lowered);
}

interface SourceFunctionHint {
  name: string;
  visibility: string;
}

function extractExternalSourceFunctions(source: string): SourceFunctionHint[] {
  const hints: SourceFunctionHint[] = [];
  const regex =
    /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(public|external)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    hints.push({ name: match[1], visibility: match[2] });
  }
  return hints;
}

function inferAccessHint(source: string, functionName: string): string {
  const pattern = new RegExp(
    `function\\s+${functionName}\\s*\\([^)]*\\)[^{;]*?(onlyOwner|onlyRole|onlyAdmin|requiresRole)`,
    'i',
  );
  const match = source.match(pattern);
  if (match?.[1]) {
    return match[1].toLowerCase();
  }
  return 'unknown';
}

function hasOnlyOwnerAccess(signal: PermissionSignal): boolean {
  return signal.evidence.some((line) => /access\s+onlyowner/i.test(line));
}

function isRenouncedOnlyOwnerPermission(
  signal: PermissionSignal,
  isRenounced: boolean | null,
): boolean {
  return signal.detected === true && isRenounced === true && hasOnlyOwnerAccess(signal);
}

function applyEffectivePermissionRisk(
  permissions: ContractSafetyReport['permissions'],
  isRenounced: boolean | null,
  verifiedSource: boolean,
): ContractSafetyReport['permissions'] {
  if (isRenounced !== true) {
    return permissions;
  }

  const adminKeys: PermissionKey[] = [
    'mint',
    'blacklist',
    'pause',
    'tradingGate',
    'taxChange',
  ];
  const updated = { ...permissions };

  for (const key of adminKeys) {
    const signal = permissions[key];
    if (!isRenouncedOnlyOwnerPermission(signal, isRenounced)) {
      continue;
    }
    updated[key] = {
      ...signal,
      risk: 'medium',
      reason: `${key} capability exists with onlyOwner access, but ownership appears renounced; effective admin risk may be reduced`,
    };
  }

  return updated;
}

function applyPermissionFlags(
  permissions: ContractSafetyReport['permissions'],
  flags: ContractSafetyFlag[],
  positives: ContractSafetyPositiveSignal[],
  isRenounced: boolean | null,
  verifiedSource: boolean,
): void {
  if (permissions.mint.detected === true && permissions.mint.risk !== 'low') {
    if (isRenouncedOnlyOwnerPermission(permissions.mint, isRenounced)) {
      flags.push({
        severity: verifiedSource ? 'low' : 'medium',
        title: 'Mint Function Exists',
        description:
          'A mint function exists in the contract ABI, but ownership appears renounced, which may reduce active admin-control risk. Review source and ownership state before relying on this.',
        evidence: permissions.mint.evidence.join('; ') || undefined,
      });
    } else {
      flags.push({
        severity: permissions.mint.risk === 'high' ? 'high' : 'medium',
        title: 'Mint Function Detected',
        description: 'Contract exposes an external/public mint or supply-increase capability.',
        evidence: permissions.mint.evidence.join('; ') || undefined,
      });
    }
  } else if (permissions.mint.detected === false) {
    positives.push({
      strength: 'medium',
      title: 'No external mint function detected',
      description: 'No external/public mint function was detected in the verified ABI.',
      evidence: permissions.mint.evidence.join('; ') || undefined,
    });
  }

  if (permissions.blacklist.detected === true) {
    if (isRenouncedOnlyOwnerPermission(permissions.blacklist, isRenounced)) {
      flags.push({
        severity: verifiedSource ? 'low' : 'medium',
        title: 'Blacklist Function Exists',
        description:
          'A blacklist function exists in the contract ABI, but ownership appears renounced, which may reduce active admin-control risk. Review source and ownership state before relying on this.',
        evidence: permissions.blacklist.evidence.join('; ') || undefined,
      });
    } else if (permissions.blacklist.risk !== 'low') {
      flags.push({
        severity: permissions.blacklist.risk === 'high' ? 'high' : 'medium',
        title: 'Blacklist Controls Detected',
        description: 'External/public blacklist or antibot controls appear present.',
        evidence: permissions.blacklist.evidence.join('; ') || undefined,
      });
    }
  } else if (permissions.blacklist.detected === false) {
    positives.push({
      strength: 'medium',
      title: 'No Blacklist Function Detected',
      description: 'No external/public blacklist control was detected in the verified ABI.',
    });
  }

  const pauseRenounced = isRenouncedOnlyOwnerPermission(permissions.pause, isRenounced);
  const gateRenounced = isRenouncedOnlyOwnerPermission(permissions.tradingGate, isRenounced);
  if (
    (permissions.pause.detected === true && permissions.pause.risk !== 'low') ||
    (permissions.tradingGate.detected === true && permissions.tradingGate.risk !== 'low')
  ) {
    const renouncedInactive = pauseRenounced || gateRenounced;
    flags.push({
      severity: renouncedInactive ? (verifiedSource ? 'low' : 'medium') : 'medium',
      title: renouncedInactive
        ? 'Trading Pause / Gate Function Exists'
        : 'Trading Pause / Gate Controls Detected',
      description: renouncedInactive
        ? 'Pause or trading gate functions exist in the ABI, but ownership appears renounced, which may reduce active admin-control risk. Review source and ownership state before relying on this.'
        : 'External/public pause or trading gate controls appear present.',
      evidence: [
        ...permissions.pause.evidence,
        ...permissions.tradingGate.evidence,
      ].join('; ') || undefined,
    });
  }

  if (permissions.taxChange.detected === true && permissions.taxChange.risk !== 'low') {
    if (isRenouncedOnlyOwnerPermission(permissions.taxChange, isRenounced)) {
      flags.push({
        severity: verifiedSource ? 'low' : 'medium',
        title: 'Tax or Fee Function Exists',
        description:
          'Tax or fee setter functions exist in the ABI, but ownership appears renounced, which may reduce active admin-control risk. Review source and ownership state before relying on this.',
        evidence: permissions.taxChange.evidence.join('; ') || undefined,
      });
    } else {
      flags.push({
        severity: permissions.taxChange.risk === 'high' ? 'high' : 'medium',
        title: 'Tax or Fee Controls Detected',
        description: 'External/public tax or fee setter functions appear present.',
        evidence: permissions.taxChange.evidence.join('; ') || undefined,
      });
    }
  } else if (permissions.taxChange.detected === false) {
    positives.push({
      strength: 'low',
      title: 'No Tax Controls Detected',
      description: 'No external/public tax/fee setter was detected in the verified ABI.',
    });
  }

  if (permissions.maxTxOrMaxWallet.detected === true) {
    flags.push({
      severity: 'low',
      title: 'Max Wallet / Max Transaction Controls',
      description: 'External/public max wallet or max transaction controls appear present.',
      evidence: permissions.maxTxOrMaxWallet.evidence.join('; ') || undefined,
    });
  }

  if (permissions.rescueOrWithdraw.detected === true) {
    flags.push({
      severity: permissions.rescueOrWithdraw.risk === 'high' ? 'medium' : 'low',
      title: 'Rescue / Withdraw Functions Present',
      description:
        'Contract includes rescue/withdraw style functions; review whether they can affect user funds or LP balances.',
      evidence: permissions.rescueOrWithdraw.evidence.join('; ') || undefined,
    });
  }
}

function scanTaxes(
  taxPermission: PermissionSignal,
  verifiedSource: boolean,
): ContractSafetyReport['taxes'] {
  if (!verifiedSource) {
    return {
      status: 'unknown',
      buyTaxPct: null,
      sellTaxPct: null,
      transferTaxPct: null,
      evidence: [],
    };
  }
  if (taxPermission.detected === true && taxPermission.risk !== 'low') {
    return {
      status: 'detected',
      buyTaxPct: null,
      sellTaxPct: null,
      transferTaxPct: null,
      evidence: taxPermission.evidence,
    };
  }
  return {
    status: 'not_detected',
    buyTaxPct: null,
    sellTaxPct: null,
    transferTaxPct: null,
    evidence: [],
  };
}

function detectSellRestriction(sourceText: string | null): boolean {
  if (!sourceText) {
    return false;
  }
  const stripped = stripSolidityComments(sourceText);
  return /\bcannot\s+sell\b|\bsell\s+disabled\b|\bantisell\b|\bblocks?\s+sell/i.test(stripped);
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
  permissions: ContractSafetyReport['permissions'];
  honeypot: ContractSafetyReport['honeypot'];
  sellRestrictionDetected: boolean;
  bytecodeFetchStatus: BytecodeFetchStatus;
}

function scoreContractSafety(input: ScoreInput): {
  score: number | null;
  riskLevel: ContractSafetyRiskLevel;
  hardSevere: boolean;
} {
  if (
    input.bytecodeFetchStatus === 'rpc_error' ||
    input.bytecodeFetchStatus === 'no_provider'
  ) {
    return { score: null, riskLevel: 'unknown', hardSevere: false };
  }

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

  score -= permissionPenalty(input.permissions.mint, 25, 12, 0);
  score -= permissionPenalty(input.permissions.blacklist, 20, 10, 0);
  score -= permissionPenalty(input.permissions.pause, 10, 5, 0);
  score -= permissionPenalty(input.permissions.tradingGate, 15, 8, 0);
  score -= permissionPenalty(input.permissions.taxChange, 18, 8, 0);
  score -= permissionPenalty(input.permissions.maxTxOrMaxWallet, 8, 4, 0);
  score -= permissionPenalty(input.permissions.rescueOrWithdraw, 5, 3, 0);

  if (input.honeypot.status === 'warning') {
    score -= 15;
  }

  score = clamp(Math.round(score), 0, 100);

  const ownerActive = input.isRenounced === false && Boolean(input.ownerAddress);
  const confirmedHighRisk =
    isConfirmedPermission(input.permissions.blacklist) ||
    isConfirmedPermission(input.permissions.taxChange) ||
    isConfirmedPermission(input.permissions.tradingGate);

  if (
    input.sellRestrictionDetected ||
    (!input.verifiedSource && confirmedHighRisk) ||
    (ownerActive &&
      isConfirmedPermission(input.permissions.mint) &&
      isConfirmedPermission(input.permissions.blacklist)) ||
    (!input.implementationAddress &&
      input.isProxy &&
      (isConfirmedPermission(input.permissions.mint) ||
        isConfirmedPermission(input.permissions.blacklist) ||
        isConfirmedPermission(input.permissions.tradingGate)))
  ) {
    hardSevere = true;
    score = Math.min(score, 44);
  }

  const riskLevel = resolveRiskLevel(score, hardSevere);
  return { score, riskLevel, hardSevere };
}

function permissionPenalty(
  signal: PermissionSignal,
  highPenalty: number,
  mediumPenalty: number,
  lowPenalty: number,
): number {
  if (signal.detected !== true) {
    return 0;
  }
  if (signal.risk === 'high' || signal.risk === 'severe') {
    return highPenalty;
  }
  if (signal.risk === 'medium') {
    return mediumPenalty;
  }
  if (signal.risk === 'low') {
    return lowPenalty;
  }
  return 0;
}

function isConfirmedPermission(signal: PermissionSignal): boolean {
  return signal.detected === true && (signal.risk === 'high' || signal.risk === 'severe');
}

function resolveRiskLevel(score: number, hardSevere: boolean): ContractSafetyRiskLevel {
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

function hasPermissionControlFlags(flags: ContractSafetyFlag[]): boolean {
  return flags.some((flag) =>
    /Blacklist|Mint Function|Trading Pause|Gate|Tax or Fee/i.test(flag.title),
  );
}

function hasActiveAdminControlFlags(flags: ContractSafetyFlag[]): boolean {
  return flags.some((flag) =>
    [
      'Blacklist Controls Detected',
      'Mint Function Detected',
      'Tax or Fee Controls Detected',
      'Trading Pause / Gate Controls Detected',
    ].includes(flag.title),
  );
}

function resolveVerdict(
  riskLevel: ContractSafetyRiskLevel,
  flags: ContractSafetyFlag[],
  permissions: ContractSafetyReport['permissions'],
  verifiedSource: boolean,
  isProxy: boolean,
  isRenounced: boolean | null,
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

  if (
    isRenounced === true &&
    permissions.blacklist.detected === true &&
    flags.some((flag) => flag.title === 'Blacklist Function Exists')
  ) {
    return 'Blacklist function exists, but ownership appears renounced; review recommended';
  }

  if (
    flags.some((flag) => flag.title === 'Owner Privileges Active') ||
    hasActiveAdminControlFlags(flags)
  ) {
    return 'Owner-controlled permissions require review';
  }

  if (isProxy && verifiedSource) {
    return 'Verified contract with upgradeability review required';
  }

  if (hasPermissionControlFlags(flags)) {
    return 'Contract permission signals require review';
  }

  if (riskLevel === 'low' || riskLevel === 'moderate') {
    return 'No major contract permission risks detected from available contract data';
  }
  return 'Contract safety requires review';
}

export function parseAbiFunctions(abi: unknown[] | null): ParsedAbiFunction[] {
  if (!abi) {
    return [];
  }

  return abi
    .filter((entry): entry is AbiEntry => typeof entry === 'object' && entry !== null)
    .filter((entry) => entry.type === 'function' && typeof entry.name === 'string')
    .map((entry) => {
      const stateMutability = (entry.stateMutability ?? 'nonpayable').toLowerCase();
      const isStateChanging = stateMutability === 'nonpayable' || stateMutability === 'payable';
      const inputs = (entry.inputs ?? [])
        .map((input) => input.type ?? 'unknown')
        .join(',');
      return {
        name: entry.name as string,
        stateMutability,
        isStateChanging,
        signature: `${entry.name}(${inputs})`,
      };
    });
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
      const parsed = JSON.parse(raw.slice(1, -1)) as {
        sources?: Record<string, { content?: string }>;
      };
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

function stripSolidityComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
