import {
  buildContractSafetyReport,
  ContractSafetyCollectedData,
  parseAbiFunctions,
} from './token-contract-safety.service';

const STANDARD_ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [] },
];

function makeCollected(
  overrides: Partial<ContractSafetyCollectedData> = {},
): ContractSafetyCollectedData {
  const parsedAbiFunctions = parseAbiFunctions(STANDARD_ERC20_ABI);
  return {
    contractAddress: '0xtoken',
    chain: 'ethereum',
    bytecode: '0x608060405234801561001057600080fd5b50',
    bytecodeFetchStatus: 'success',
    bytecodeError: null,
    chainId: '0x1',
    rpcProvider: 'alchemy',
    rpcBytecodeConflict: false,
    sourceFetchError: null,
    sourceLookupStatus: 'success',
    verifiedSource: true,
    sourceProvider: 'etherscan',
    contractName: 'StandardToken',
    abi: STANDARD_ERC20_ABI,
    sourceText: 'contract StandardToken { function transfer(address to, uint256 amount) public {} }',
    etherscanProxyFlag: false,
    etherscanImplementation: null,
    implementationAddress: null,
    proxyAdminAddress: null,
    proxyType: null,
    isProxy: false,
    implementationScanned: false,
    ownerAddress: '0x000000000000000000000000000000000000dead',
    ownerType: 'eoa',
    adminAddresses: [],
    parsedAbiFunctions,
    abiFunctionNames: parsedAbiFunctions.map((fn) => fn.name),
    ...overrides,
  };
}

describe('TokenContractSafetyService scoring', () => {
  it('verified simple ERC20: low/moderate risk with verified positive', () => {
    const report = buildContractSafetyReport(makeCollected());

    expect(report.verifiedSource).toBe(true);
    expect(['low', 'moderate']).toContain(report.riskLevel);
    expect(report.positiveSignals.some((signal) => signal.title === 'Verified Source Code')).toBe(
      true,
    );
    expect(report.flags.some((flag) => flag.severity === 'severe')).toBe(false);
    expect(report.permissions.mint.detected).toBe(false);
    expect(
      report.positiveSignals.some((signal) => signal.title === 'No external mint function detected'),
    ).toBe(true);
  });

  it('RPC error is not treated as no bytecode', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        bytecode: null,
        bytecodeFetchStatus: 'rpc_error',
        bytecodeError: 'Bytecode fetch failed due to RPC/provider error',
        verifiedSource: false,
        abi: null,
        sourceText: null,
        parsedAbiFunctions: [],
        abiFunctionNames: [],
        sourceLookupStatus: 'not_verified',
      }),
    );

    expect(report.status).toBe('partial');
    expect(report.unknowns.some((item) => item.includes('RPC/provider error'))).toBe(true);
    expect(report.limitations.some((item) => item.includes('RPC/provider error'))).toBe(true);
    expect(report.unknowns.some((item) => item.includes('No contract bytecode found'))).toBe(false);
    expect(report.score).toBeNull();
  });

  it('chain mismatch returns clear limitation', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        bytecode: null,
        bytecodeFetchStatus: 'chain_mismatch',
        bytecodeError: 'RPC chain mismatch: expected ethereum mainnet.',
        chainId: '0x89',
      }),
    );

    expect(report.status).toBe('error');
    expect(report.limitations.some((item) => item.includes('chain mismatch'))).toBe(true);
    expect(report.verdict).toBe('Contract safety could not be verified');
  });

  it('internal _mint only does not create mint flag', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        sourceText:
          'contract Token { function _mint(address to, uint256 amount) internal {} function transfer(address to, uint256 amount) public {} }',
      }),
    );

    expect(report.flags.some((flag) => flag.title === 'Mint Function Detected')).toBe(false);
    expect(report.permissions.mint.detected).toBe(false);
    expect(report.permissions.mint.evidence.some((line) => line.includes('internal _mint'))).toBe(
      true,
    );
  });

  it('comment-only blacklist text does not create high blacklist flag', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        sourceText:
          'contract Token { // blacklist feature removed function transfer(address to, uint256 amount) public {} }',
        parsedAbiFunctions: parseAbiFunctions(STANDARD_ERC20_ABI),
        abiFunctionNames: ['transfer', 'approve', 'balanceOf', 'totalSupply'],
      }),
    );

    expect(report.flags.some((flag) => flag.title === 'Blacklist Controls Detected')).toBe(false);
    expect(['none', 'low', 'unknown']).toContain(report.permissions.blacklist.risk);
  });

  it('external onlyOwner mint function creates mint flag with ABI evidence', () => {
    const mintAbi = [
      ...STANDARD_ERC20_ABI,
      {
        type: 'function',
        name: 'mint',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
      },
    ];
    const report = buildContractSafetyReport(
      makeCollected({
        ownerAddress: '0xowner000000000000000000000000000000000001',
        ownerType: 'eoa',
        parsedAbiFunctions: parseAbiFunctions(mintAbi),
        abiFunctionNames: ['transfer', 'approve', 'balanceOf', 'totalSupply', 'mint'],
        abi: mintAbi,
        sourceText:
          'function mint(address to, uint256 amount) public onlyOwner { _mint(to, amount); }',
      }),
    );

    expect(report.flags.some((flag) => flag.title === 'Mint Function Detected')).toBe(true);
    expect(report.permissions.mint.evidence.some((line) => line.includes('ABI'))).toBe(true);
    expect(report.permissions.mint.evidence.some((line) => line.includes('mint('))).toBe(true);
  });

  it('external blacklist setter creates blacklist flag with ABI evidence', () => {
    const blacklistAbi = [
      ...STANDARD_ERC20_ABI,
      {
        type: 'function',
        name: 'setBlacklist',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'address' }, { type: 'bool' }],
      },
    ];
    const report = buildContractSafetyReport(
      makeCollected({
        ownerAddress: '0xowner000000000000000000000000000000000001',
        ownerType: 'eoa',
        parsedAbiFunctions: parseAbiFunctions(blacklistAbi),
        abiFunctionNames: [...STANDARD_ERC20_ABI.map((entry) => entry.name), 'setBlacklist'],
        abi: blacklistAbi,
        sourceText:
          'function setBlacklist(address account, bool value) public onlyOwner { isBlacklisted[account] = value; }',
      }),
    );

    expect(report.flags.some((flag) => flag.title === 'Blacklist Controls Detected')).toBe(true);
    expect(report.verdict).toBe('Owner-controlled permissions require review');
    expect(report.permissions.blacklist.evidence.some((line) => line.includes('setBlacklist'))).toBe(
      true,
    );
  });

  it('PEPE-like renounced owner + blacklist onlyOwner uses softer interpretation', () => {
    const blacklistAbi = [
      ...STANDARD_ERC20_ABI,
      {
        type: 'function',
        name: 'blacklist',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'address' }, { type: 'bool' }],
      },
    ];
    const report = buildContractSafetyReport(
      makeCollected({
        ownerAddress: '0x0000000000000000000000000000000000000000',
        ownerType: 'eoa',
        parsedAbiFunctions: parseAbiFunctions(blacklistAbi),
        abiFunctionNames: [...STANDARD_ERC20_ABI.map((entry) => entry.name), 'blacklist'],
        abi: blacklistAbi,
        sourceText:
          'function blacklist(address account, bool value) public onlyOwner { isBlacklisted[account] = value; }',
      }),
    );

    expect(report.owner.isRenounced).toBe(true);
    expect(['low', 'moderate']).toContain(report.riskLevel);
    expect(report.flags.some((flag) => flag.title === 'Blacklist Function Exists')).toBe(true);
    expect(report.flags.some((flag) => flag.title === 'Blacklist Controls Detected')).toBe(false);

    const blacklistFlag = report.flags.find((flag) => flag.title === 'Blacklist Function Exists');
    expect(['low', 'medium']).toContain(blacklistFlag?.severity);
    expect(
      report.permissions.blacklist.evidence.some((line) => line.includes('blacklist(address,bool)')),
    ).toBe(true);
    expect(report.verdict).toBe(
      'Blacklist function exists, but ownership appears renounced; review recommended',
    );
    expect(report.verdict).not.toContain('No major contract permission risks detected');
  });

  it('mint + blacklist + active owner: severe/high with permission flags', () => {
    const riskyAbi = [
      ...STANDARD_ERC20_ABI,
      { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [] },
      { type: 'function', name: 'blacklist', stateMutability: 'nonpayable', inputs: [{ type: 'address' }] },
    ];
    const report = buildContractSafetyReport(
      makeCollected({
        ownerAddress: '0xowner000000000000000000000000000000000001',
        ownerType: 'eoa',
        parsedAbiFunctions: parseAbiFunctions(riskyAbi),
        abiFunctionNames: ['transfer', 'approve', 'balanceOf', 'totalSupply', 'mint', 'blacklist'],
        abi: riskyAbi,
      }),
    );

    expect(['severe', 'high']).toContain(report.riskLevel);
    expect(report.flags.some((flag) => flag.title === 'Mint Function Detected')).toBe(true);
    expect(report.flags.some((flag) => flag.title === 'Blacklist Controls Detected')).toBe(true);
  });

  it('upgradeable proxy with known implementation: moderate, not automatically severe', () => {
    const proxyAbi = [
      ...STANDARD_ERC20_ABI,
      { type: 'function', name: 'upgradeTo', stateMutability: 'nonpayable', inputs: [{ type: 'address' }] },
    ];
    const report = buildContractSafetyReport(
      makeCollected({
        isProxy: true,
        proxyType: 'uups',
        contractName: 'ERC1967Proxy',
        implementationAddress: '0ximpl000000000000000000000000000000000001',
        implementationScanned: true,
        parsedAbiFunctions: parseAbiFunctions(proxyAbi),
        abiFunctionNames: ['transfer', 'upgradeTo'],
        abi: proxyAbi,
      }),
    );

    expect(report.riskLevel).not.toBe('severe');
    expect(
      report.flags.some((flag) => flag.title === 'Upgradeable Contract Requires Review'),
    ).toBe(true);
  });

  it('proxy with unknown implementation: high risk unknown implementation flag', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        isProxy: true,
        proxyType: 'unknown',
        implementationAddress: null,
        verifiedSource: false,
        abi: null,
        sourceText: null,
        parsedAbiFunctions: [],
        abiFunctionNames: [],
        sourceLookupStatus: 'not_verified',
      }),
    );

    expect(
      report.flags.some((flag) => flag.title === 'Unknown Implementation Contract'),
    ).toBe(true);
    expect(['high', 'severe']).toContain(report.riskLevel);
  });

  it('verified source but empty RPC bytecode creates partial conflict', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        bytecode: null,
        bytecodeFetchStatus: 'empty',
        bytecodeError: 'No contract bytecode found at 0xtoken on ethereum.',
        rpcBytecodeConflict: true,
        verifiedSource: true,
      }),
    );

    expect(report.status).toBe('partial');
    expect(report.unknowns.some((item) => item.includes('conflicts with verified source'))).toBe(
      true,
    );
    expect(report.flags.some((flag) => flag.title === 'RPC Bytecode Conflict')).toBe(true);
    expect(report.score).not.toBeNull();
  });

  it('returns error status when bytecode is truly empty and source unverified', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        bytecode: null,
        bytecodeFetchStatus: 'empty',
        bytecodeError: 'No contract bytecode found at 0xtoken on ethereum.',
        verifiedSource: false,
        abi: null,
        sourceText: null,
        parsedAbiFunctions: [],
        abiFunctionNames: [],
        sourceLookupStatus: 'not_verified',
      }),
    );

    expect(report.status).toBe('error');
    expect(report.score).toBeNull();
    expect(report.riskLevel).toBe('unknown');
  });
});
