import { resolveOffchainConfig } from './offchain-config';

describe('resolveOffchainConfig', () => {
  it('uses safe defaults when env is missing', () => {
    const config = resolveOffchainConfig(null);
    expect(config.credibilityEnabled).toBe(true);
    expect(config.crawlEnabled).toBe(true);
    expect(config.braveEnabled).toBe(true);
    expect(config.maxPages).toBe(5);
  });

  it('respects disabled flags', () => {
    const config = resolveOffchainConfig({
      get: (key: string) => {
        if (key === 'OFFCHAIN_CREDIBILITY_ENABLED') return 'false';
        if (key === 'OFFCHAIN_CRAWL_ENABLED') return 'false';
        if (key === 'OFFCHAIN_BRAVE_ENABLED') return 'false';
        return '';
      },
    } as never);

    expect(config.credibilityEnabled).toBe(false);
    expect(config.crawlEnabled).toBe(false);
    expect(config.braveEnabled).toBe(false);
  });
});
