import { ConfigService } from '@nestjs/config';

export interface OffchainRuntimeConfig {
  credibilityEnabled: boolean;
  crawlEnabled: boolean;
  braveEnabled: boolean;
  playwrightFallbackEnabled: boolean;
  externalEvidenceEnabled: boolean;
  externalEvidenceMaxQueries: number;
  externalEvidenceMaxResultsPerQuery: number;
  externalEvidenceFetchTopPages: boolean;
  aiUnderstandingEnabled: boolean;
  aiClassifierEnabled: boolean;
  aiClassifierProvider: 'anthropic' | 'gemini';
  aiClassifierModel: string;
  aiClassifierTimeoutMs: number;
  aiClassifierMaxInputChars: number;
  maxPages: number;
  fetchTimeoutMs: number;
  braveTimeoutMs: number;
}

const DEFAULTS: OffchainRuntimeConfig = {
  credibilityEnabled: true,
  crawlEnabled: true,
  braveEnabled: true,
  playwrightFallbackEnabled: true,
  externalEvidenceEnabled: true,
  externalEvidenceMaxQueries: 6,
  externalEvidenceMaxResultsPerQuery: 5,
  externalEvidenceFetchTopPages: false,
  aiUnderstandingEnabled: false,
  aiClassifierEnabled: false,
  aiClassifierProvider: 'anthropic',
  aiClassifierModel: 'claude-sonnet-4-6',
  aiClassifierTimeoutMs: 20_000,
  aiClassifierMaxInputChars: 30_000,
  maxPages: 5,
  fetchTimeoutMs: 10_000,
  braveTimeoutMs: 8_000,
};

export function resolveOffchainConfig(config?: ConfigService | null): OffchainRuntimeConfig {
  if (!config) {
    return { ...DEFAULTS };
  }

  const braveApiKey =
    config.get<string>('BRAVE_SEARCH_API_KEY') ??
    config.get<string>('brave.searchApiKey') ??
    '';
  const anthropicApiKey =
    config.get<string>('ANTHROPIC_API_KEY') ??
    config.get<string>('anthropic.apiKey') ??
    '';
  const aiClassifierProvider = readProvider(config, 'OFFCHAIN_AI_CLASSIFIER_PROVIDER', DEFAULTS.aiClassifierProvider);
  const defaultAiClassifierModel =
    aiClassifierProvider === 'gemini' ? 'gemini-2.5-flash-lite' : DEFAULTS.aiClassifierModel;

  return {
    credibilityEnabled: readBoolean(config, 'OFFCHAIN_CREDIBILITY_ENABLED', true),
    crawlEnabled: readBoolean(config, 'OFFCHAIN_CRAWL_ENABLED', true),
    braveEnabled: readBoolean(config, 'OFFCHAIN_BRAVE_ENABLED', true),
    playwrightFallbackEnabled: readBoolean(
      config,
      'OFFCHAIN_PLAYWRIGHT_FALLBACK_ENABLED',
      true,
    ),
    externalEvidenceEnabled: readBoolean(
      config,
      'OFFCHAIN_EXTERNAL_EVIDENCE_ENABLED',
      braveApiKey.trim().length > 0,
    ),
    externalEvidenceMaxQueries: readNumber(
      config,
      'OFFCHAIN_EXTERNAL_EVIDENCE_MAX_QUERIES',
      DEFAULTS.externalEvidenceMaxQueries,
      1,
      12,
    ),
    externalEvidenceMaxResultsPerQuery: readNumber(
      config,
      'OFFCHAIN_EXTERNAL_EVIDENCE_MAX_RESULTS_PER_QUERY',
      DEFAULTS.externalEvidenceMaxResultsPerQuery,
      1,
      10,
    ),
    externalEvidenceFetchTopPages: readBoolean(
      config,
      'OFFCHAIN_EXTERNAL_EVIDENCE_FETCH_TOP_PAGES',
      DEFAULTS.externalEvidenceFetchTopPages,
    ),
    aiUnderstandingEnabled: readBoolean(
      config,
      'OFFCHAIN_AI_UNDERSTANDING_ENABLED',
      anthropicApiKey.trim().length > 0,
    ),
    aiClassifierEnabled: readBoolean(
      config,
      'OFFCHAIN_AI_CLASSIFIER_ENABLED',
      DEFAULTS.aiClassifierEnabled,
    ),
    aiClassifierProvider,
    aiClassifierModel: readString(config, 'OFFCHAIN_AI_CLASSIFIER_MODEL', defaultAiClassifierModel, [
      'offchain.aiClassifierModel',
    ]),
    aiClassifierTimeoutMs: readNumber(
      config,
      'OFFCHAIN_AI_CLASSIFIER_TIMEOUT_MS',
      DEFAULTS.aiClassifierTimeoutMs,
      1_000,
      60_000,
    ),
    aiClassifierMaxInputChars: readNumber(
      config,
      'OFFCHAIN_AI_CLASSIFIER_MAX_INPUT_CHARS',
      DEFAULTS.aiClassifierMaxInputChars,
      5_000,
      60_000,
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

function readString(
  config: ConfigService,
  key: string,
  fallback: string,
  aliases: string[] = [],
): string {
  const raw =
    config.get<string>(key) ??
    config.get<string>(key.toLowerCase()) ??
    aliases.map((alias) => config.get<string>(alias)).find((value) => value !== undefined);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
}

function readProvider(
  config: ConfigService,
  key: string,
  fallback: 'anthropic' | 'gemini',
): 'anthropic' | 'gemini' {
  const raw = config.get<string>(key) ?? config.get<string>(key.toLowerCase());
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized === 'gemini' || normalized === 'anthropic' ? normalized : fallback;
}
