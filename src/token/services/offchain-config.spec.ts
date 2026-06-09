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

  it('reads AI classifier config with true boolean and Claude model default', () => {
    const config = resolveOffchainConfig({
      get: (key: string) => {
        if (key === 'OFFCHAIN_AI_CLASSIFIER_ENABLED') return 'true';
        if (key === 'ANTHROPIC_API_KEY') return 'test-key';
        return '';
      },
    } as never);

    expect(config.aiClassifierEnabled).toBe(true);
    expect(config.aiClassifierProvider).toBe('anthropic');
    expect(config.aiClassifierModel).toBe('claude-sonnet-4-6');
  });

  it('uses Gemini lite as the default model when provider is gemini', () => {
    const config = resolveOffchainConfig({
      get: (key: string) => {
        if (key === 'OFFCHAIN_AI_CLASSIFIER_ENABLED') return 'true';
        if (key === 'OFFCHAIN_AI_CLASSIFIER_PROVIDER') return 'gemini';
        if (key === 'GEMINI_API_KEY') return 'test-key';
        return '';
      },
    } as never);

    expect(config.aiClassifierEnabled).toBe(true);
    expect(config.aiClassifierProvider).toBe('gemini');
    expect(config.aiClassifierModel).toBe('gemini-2.5-flash-lite');
  });
});
