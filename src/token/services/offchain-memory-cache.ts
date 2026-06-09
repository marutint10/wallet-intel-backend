interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class OffchainMemoryCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  get(key: string, now = Date.now()): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export function normalizeCacheUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url.trim().toLowerCase();
  }
}

const DISCOVERY_CACHE_VERSION = 'v4';

export function buildDiscoveryCacheKey(input: {
  chain?: string | null;
  contractAddress?: string | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
}): string {
  const chain = (input.chain ?? 'unknown').toLowerCase();
  const address = (input.contractAddress ?? '').toLowerCase();
  if (address) {
    return `offchain:discovery:${DISCOVERY_CACHE_VERSION}:${chain}:${address}`;
  }
  const label = [input.tokenName, input.tokenSymbol]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(':')
    .toLowerCase();
  return `offchain:discovery:${DISCOVERY_CACHE_VERSION}:${chain}:${label || 'unknown'}`;
}

export function buildCrawlCacheKey(url: string): string {
  return `offchain:crawl:${DISCOVERY_CACHE_VERSION}:${normalizeCacheUrl(url)}`;
}
