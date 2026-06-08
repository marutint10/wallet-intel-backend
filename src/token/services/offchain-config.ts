import { ConfigService } from '@nestjs/config';

export interface OffchainRuntimeConfig {
  credibilityEnabled: boolean;
  crawlEnabled: boolean;
  braveEnabled: boolean;
  playwrightFallbackEnabled: boolean;
  maxPages: number;
  fetchTimeoutMs: number;
  braveTimeoutMs: number;
}

const DEFAULTS: OffchainRuntimeConfig = {
  credibilityEnabled: true,
  crawlEnabled: true,
  braveEnabled: true,
  playwrightFallbackEnabled: true,
  maxPages: 5,
  fetchTimeoutMs: 10_000,
  braveTimeoutMs: 8_000,
};

export function resolveOffchainConfig(config?: ConfigService | null): OffchainRuntimeConfig {
  if (!config) {
    return { ...DEFAULTS };
  }

  return {
    credibilityEnabled: readBoolean(config, 'OFFCHAIN_CREDIBILITY_ENABLED', true),
    crawlEnabled: readBoolean(config, 'OFFCHAIN_CRAWL_ENABLED', true),
    braveEnabled: readBoolean(config, 'OFFCHAIN_BRAVE_ENABLED', true),
    playwrightFallbackEnabled: readBoolean(
      config,
      'OFFCHAIN_PLAYWRIGHT_FALLBACK_ENABLED',
      true,
    ),
    maxPages: readNumber(config, 'OFFCHAIN_MAX_PAGES', DEFAULTS.maxPages, 1, 5),
    fetchTimeoutMs: readNumber(
      config,
      'OFFCHAIN_FETCH_TIMEOUT_MS',
      DEFAULTS.fetchTimeoutMs,
      1_000,
      30_000,
    ),
    braveTimeoutMs: readNumber(
      config,
      'OFFCHAIN_BRAVE_TIMEOUT_MS',
      DEFAULTS.braveTimeoutMs,
      1_000,
      30_000,
    ),
  };
}

function readBoolean(config: ConfigService, key: string, fallback: boolean): boolean {
  const raw =
    config.get<string>(key) ??
    config.get<string>(key.toLowerCase()) ??
    '';
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  return fallback;
}

function readNumber(
  config: ConfigService,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = config.get<string>(key) ?? config.get<string>(key.toLowerCase());
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
