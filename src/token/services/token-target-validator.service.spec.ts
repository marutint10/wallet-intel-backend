import { ConfigService } from '@nestjs/config';
import { TokenTargetValidatorService } from './token-target-validator.service';

describe('TokenTargetValidatorService', () => {
  const configGet = jest.fn((key: string) =>
    key === 'ALCHEMY_API_KEY' ? 'test-alchemy-key' : undefined,
  );
  const config = { get: configGet } as unknown as ConfigService;

  let service: TokenTargetValidatorService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configGet.mockImplementation((key: string) =>
      key === 'ALCHEMY_API_KEY' ? 'test-alchemy-key' : undefined,
    );
    service = new TokenTargetValidatorService(config);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function mockRpcHandlers(handlers: {
    code?: string;
    ethCall?: Record<string, string>;
  }) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('dexscreener.com')) {
        return {
          ok: true,
          json: async () => ({ pairs: [] }),
        };
      }

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const method = body.method as string;

      if (method === 'eth_getCode') {
        return {
          ok: true,
          json: async () => ({ result: handlers.code ?? '0x' }),
        };
      }

      if (method === 'eth_call') {
        const data = body.params?.[0]?.data as string | undefined;
        const result = (data && handlers.ethCall?.[data]) ?? '0x';
        return { ok: true, json: async () => ({ result }) };
      }

      return { ok: false, json: async () => ({}) };
    });
  }

  it('rejects invalid address format', async () => {
    const result = await service.validate('not-an-address', 'ethereum');
    expect(result.kind).toBe('invalid_address');
    expect(result.canAnalyze).toBe(false);
  });

  it('rejects EOA wallets (no bytecode)', async () => {
    mockRpcHandlers({ code: '0x' });

    const result = await service.validate(
      '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
      'ethereum',
    );

    expect(result.kind).toBe('eoa_wallet');
    expect(result.addressType).toBe('eoa');
    expect(result.canAnalyze).toBe(false);
    expect(result.title).toContain('EOA');
  });

  it('accepts ERC-20 contracts with multiple on-chain signals', async () => {
    mockRpcHandlers({
      code: '0x608060405234801561001057600080fd5b',
      ethCall: {
        '0x18160ddd':
          '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
        '0x313ce567':
          '0x0000000000000000000000000000000000000000000000000000000000000012',
        '0x95d89b41':
          '0x0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '544553540000000000000000000000000000000000000000',
      },
    });

    const result = await service.validate(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      'ethereum',
    );

    expect(result.kind).toBe('erc20_token');
    expect(result.canAnalyze).toBe(true);
  });

  it('rejects non-token contracts (LP-style token0 response)', async () => {
    mockRpcHandlers({
      code: '0x608060405234801561001057600080fd5b',
      ethCall: {
        '0x0dfe1681':
          '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
    });

    const result = await service.validate(
      '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
      'ethereum',
    );

    expect(result.kind).toBe('non_token_contract');
    expect(result.canAnalyze).toBe(false);
  });
});
