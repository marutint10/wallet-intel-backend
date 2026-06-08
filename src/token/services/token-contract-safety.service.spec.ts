import {
  buildContractSafetyReport,
  ContractSafetyCollectedData,
} from './token-contract-safety.service';

const STANDARD_ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', stateMutability: 'view' },
];

function makeCollected(
  overrides: Partial<ContractSafetyCollectedData> = {},
): ContractSafetyCollectedData {
  return {
    contractAddress: '0xtoken',
    chain: 'ethereum',
    bytecode: '0x608060405234801561001057600080fd5b50',
    bytecodeError: null,
    sourceFetchError: null,
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
    ownerAddress: '0x000000000000000000000000000000000000dead',
    ownerType: 'eoa',
    adminAddresses: [],
    scanText: 'StandardToken transfer approve balanceOf totalSupply',
    abiFunctionNames: ['transfer', 'approve', 'balanceOf', 'totalSupply'],
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
  });

  it('unverified source: high risk flag and low confidence', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        verifiedSource: false,
        abi: null,
        sourceText: null,
        scanText: '',
        abiFunctionNames: [],
        sourceFetchError: 'Source not verified',
      }),
    );

    expect(report.flags.some((flag) => flag.title === 'Unverified Source Code')).toBe(true);
    expect(['high', 'unknown', 'severe']).toContain(report.riskLevel);
    expect(['low', 'medium']).toContain(report.confidence);
  });

  it('mint + blacklist + active owner: severe/high with permission flags', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        ownerAddress: '0xowner000000000000000000000000000000000001',
        ownerType: 'eoa',
        abiFunctionNames: ['mint', 'blacklist', 'transfer'],
        scanText: 'function mint(address to, uint256 amount) public onlyOwner function blacklist(address account) public',
        abi: [
          { type: 'function', name: 'mint' },
          { type: 'function', name: 'blacklist' },
          { type: 'function', name: 'transfer' },
        ],
      }),
    );

    expect(['severe', 'high']).toContain(report.riskLevel);
    expect(report.flags.some((flag) => flag.title === 'Mint Function Detected')).toBe(true);
    expect(report.flags.some((flag) => flag.title === 'Blacklist Controls Detected')).toBe(true);
    expect(report.flags.some((flag) => flag.title === 'Owner Privileges Active')).toBe(true);
  });

  it('upgradeable proxy with known implementation: moderate, not automatically severe', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        isProxy: true,
        proxyType: 'uups',
        contractName: 'ERC1967Proxy',
        implementationAddress: '0ximpl000000000000000000000000000000000001',
        scanText: 'ERC1967Proxy upgradeTo implementation',
        abiFunctionNames: ['upgradeTo', 'transfer'],
      }),
    );

    expect(report.riskLevel).not.toBe('severe');
    expect(['moderate', 'high', 'low']).toContain(report.riskLevel);
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
        scanText: 'Proxy',
        abiFunctionNames: [],
      }),
    );

    expect(
      report.flags.some((flag) => flag.title === 'Unknown Implementation Contract'),
    ).toBe(true);
    expect(['high', 'severe']).toContain(report.riskLevel);
  });

  it('returns error status when bytecode is missing', () => {
    const report = buildContractSafetyReport(
      makeCollected({
        bytecode: null,
        bytecodeError: 'No contract bytecode found.',
      }),
    );

    expect(report.status).toBe('error');
    expect(report.score).toBeNull();
    expect(report.riskLevel).toBe('unknown');
  });
});
