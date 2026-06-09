import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  directorySourceFromUrl,
  emptyDiscoveryTrace,
  resolveDiscoveryMode,
  toMetadataSource,
  type DiscoveredLinks,
  type DiscoveryMode,
  type OffchainDiscoveryTrace,
  type OffchainLinkCandidate,
  type OffchainLinkKind,
} from './offchain-discovery-types';

export type { DiscoveredLinks } from './offchain-discovery-types';
import {
  buildDiscoveryCacheKey,
  OffchainMemoryCache,
} from './offchain-memory-cache';
import { resolveOffchainConfig } from './offchain-config';
import {
  coinGeckoMetadataMatchesToken,
  extractCoinGeckoCategories,
  extractCoinGeckoDirectoryUrl,
  extractOutboundLinksFromDirectoryHtml,
  isTrustedDirectoryUrl,
  mergeDirectoryExtractions,
} from './offchain-directory-extraction';
import {
  firstNonAggregatorUrl,
  firstNonAggregatorUrlMatching,
  hasCrossProjectMismatch,
  isAggregatorUrl,
  isBlockedOfficialLink,
  isPlatformDirectorySocialUrl,
  isTrustedMetadataSource,
  sanitizeDiscoveredLinks,
  type LinkProvenanceMap,
  type MetadataSource,
} from './offchain-link-validation';
import {
  TokenWebCrawlerService,
  type TokenWebsiteCrawlResult,
} from './token-web-crawler.service';

export interface OffchainDiscoveryResult {
  status: 'done' | 'partial' | 'error' | 'unknown';
  discoveryMode: DiscoveryMode;
  discoveredLinks: DiscoveredLinks;
  linkSources: LinkProvenanceMap;
  officialLinkConfidence: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  sourceUrls: string[];
  errors: string[];
  hasTrustedOfficialWebsite: boolean;
  braveOnlyWebsite: boolean;
  aggregatorWebsiteRejected: boolean;
  metadataCategories: string[];
  trustedDirectoryUrls: string[];
  debugTrace?: OffchainDiscoveryTrace;
}

export interface BraveSearchHit {
  title: string;
  url: string;
  description: string;
}

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_BRAVE_QUERIES = 4;
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BRAVE_RESULTS = 5;

export interface BraveSearchResponse {
  hits: BraveSearchHit[];
  error: string | null;
  rateLimited: boolean;
  timedOut: boolean;
}

@Injectable()
export class TokenOffchainDiscoveryService {
  private readonly logger = new Logger(TokenOffchainDiscoveryService.name);
  private readonly discoveryCache = new OffchainMemoryCache<OffchainDiscoveryResult>(
    200,
    DISCOVERY_CACHE_TTL_MS,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly webCrawler: TokenWebCrawlerService,
  ) {}

  clearDiscoveryCache(): void {
    this.discoveryCache.clear();
  }

  async discoverOfficialLinks(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
    chain?: string | null;
    seedLinks?: Partial<DiscoveredLinks>;
    dexScreenerProfile?: unknown;
    coinGeckoMetadata?: unknown;
    explorerMetadata?: unknown;
    existingMetadata?: unknown;
    bypassCache?: boolean;
    forceRefresh?: boolean;
    debug?: boolean;
  }): Promise<OffchainDiscoveryResult> {
    const runtime = resolveOffchainConfig(this.config);
    const forceRefresh = Boolean(input.forceRefresh || input.bypassCache);
    const cacheKey = buildDiscoveryCacheKey(input);
    const trace = emptyDiscoveryTrace({
      tokenName: safeString(input.tokenName),
      tokenSymbol: safeString(input.tokenSymbol),
      contractAddress: safeString(input.contractAddress)?.toLowerCase() ?? null,
      chain: input.chain ?? null,
      forceRecompute: forceRefresh,
    });
    trace.brave.enabled = runtime.braveEnabled;

    if (!forceRefresh) {
      const cached = this.discoveryCache.get(cacheKey);
      if (cached) {
        trace.cache.discoveryCacheHit = true;
        if (input.debug) {
          return { ...cached, debugTrace: trace };
        }
        return cached;
      }
    }

    const errors: string[] = [];
    const sourceUrls: string[] = [];
    const provenance: LinkProvenanceMap = {};
    const trustedDirectoryUrls = new Set<string>();

    const discoveredLinks = emptyDiscoveredLinks();
    const tokenName = safeString(input.tokenName);
    const tokenSymbol = safeString(input.tokenSymbol);
    const contractAddress = safeString(input.contractAddress)?.toLowerCase() ?? null;

    populateStructuredMetadataTrace(trace, input);

    // Lane A — structured official identity sources (priority order)
    recordStructuredCandidates(
      trace,
      discoveredLinks,
      provenance,
      sourceUrls,
      {
        seed: extractSeedLinks(input.seedLinks),
        dexscreener: extractDexScreenerLinks(input.dexScreenerProfile),
        coingecko: shouldTrustCoinGeckoMetadata(input.coinGeckoMetadata, contractAddress)
          ? extractCoinGeckoLinks(input.coinGeckoMetadata)
          : emptyDiscoveredLinks(),
        explorer: extractExplorerLinks(input.explorerMetadata),
        existing: extractExistingMetadataLinks(input.existingMetadata),
      },
      { tokenName, tokenSymbol, contractAddress },
    );

    if (input.coinGeckoMetadata && !shouldTrustCoinGeckoMetadata(input.coinGeckoMetadata, contractAddress)) {
      errors.push('CoinGecko metadata did not match token contract identity');
    }

    const metadataCategories = [...extractCoinGeckoCategories(input.coinGeckoMetadata)];
    const directoryCandidates = new Set<string>();

    if (shouldTrustCoinGeckoMetadata(input.coinGeckoMetadata, contractAddress)) {
      const directoryUrl = extractCoinGeckoDirectoryUrl(input.coinGeckoMetadata);
      if (directoryUrl) {
        queueDirectoryCandidate(directoryCandidates, trace, directoryUrl, 'coingecko_directory');
        trustedDirectoryUrls.add(directoryUrl);
      }
    }

    const dexDirectoryUrl = extractDexScreenerDirectoryUrl(input.dexScreenerProfile, contractAddress);
    if (dexDirectoryUrl) {
      queueDirectoryCandidate(directoryCandidates, trace, dexDirectoryUrl, 'dexscreener_directory');
      trustedDirectoryUrls.add(dexDirectoryUrl);
    }

    // Directory outbound extraction before Brave fallback
    if (directoryCandidates.size > 0 && runtime.crawlEnabled) {
      for (const directoryUrl of directoryCandidates) {
        sourceUrls.push(directoryUrl);
      }
      const directoryExtraction = await this.extractOutboundFromDirectories(
        [...directoryCandidates],
        {
          tokenName,
          tokenSymbol,
          contractAddress,
          chain: input.chain ?? null,
        },
        trace,
      );
      mergeDirectoryOutboundLinks(
        discoveredLinks,
        provenance,
        sourceUrls,
        directoryExtraction.links,
        directoryExtraction.directorySources,
      );
      metadataCategories.push(...directoryExtraction.categories);
      errors.push(...directoryExtraction.errors);
    }

    const braveApiKey = this.getBraveApiKey();
    const needsBrave = shouldUseBraveFallback(discoveredLinks);
    let braveUsed = false;

    if (needsBrave) {
      if (!runtime.braveEnabled) {
        errors.push('Brave search fallback disabled');
        trace.brave.errors.push('Brave search fallback disabled');
      } else if (!braveApiKey) {
        errors.push('Brave search API key missing; Brave fallback skipped');
        trace.brave.errors.push('Brave search API key missing');
      } else if (tokenName || tokenSymbol || contractAddress) {
        braveUsed = true;
        trace.brave.called = true;
        const braveLinks = await this.discoverWithBrave(
          braveApiKey,
          tokenName,
          tokenSymbol,
          contractAddress,
          discoveredLinks,
          runtime.braveTimeoutMs,
          trace,
        );
        mergeBraveEvidence(discoveredLinks, provenance, sourceUrls, braveLinks.links, trace, {
          tokenName,
          tokenSymbol,
          contractAddress,
        });
        for (const directoryUrl of braveLinks.directoryCandidates ?? []) {
          queueDirectoryCandidate(
            directoryCandidates,
            trace,
            directoryUrl,
            directorySourceFromUrl(directoryUrl),
          );
          trustedDirectoryUrls.add(directoryUrl);
          sourceUrls.push(directoryUrl);
        }
        errors.push(...braveLinks.errors);
        trace.brave.errors.push(...braveLinks.errors);

        if (!discoveredLinks.website && braveLinks.directoryCandidates.length > 0 && runtime.crawlEnabled) {
          const braveDirectoryExtraction = await this.extractOutboundFromDirectories(
            braveLinks.directoryCandidates,
            {
              tokenName,
              tokenSymbol,
              contractAddress,
              chain: input.chain ?? null,
            },
            trace,
          );
          mergeDirectoryOutboundLinks(
            discoveredLinks,
            provenance,
            sourceUrls,
            braveDirectoryExtraction.links,
            braveDirectoryExtraction.directorySources,
          );
          metadataCategories.push(...braveDirectoryExtraction.categories);
          errors.push(...braveDirectoryExtraction.errors);
        }
      }
    }

    let crawlResult: TokenWebsiteCrawlResult | null = null;
    if (discoveredLinks.website && runtime.crawlEnabled) {
      try {
        trace.cache.crawlCacheHit =
          !forceRefresh && this.webCrawler.hasCachedCrawl(discoveredLinks.website);
        crawlResult = await this.webCrawler.crawlOfficialWebsite({
          websiteUrl: discoveredLinks.website,
          tokenName,
          tokenSymbol,
          contractAddress,
          maxPages: 1,
          bypassCache: forceRefresh,
        });
        mergeDiscoveredLinks(
          discoveredLinks,
          provenance,
          mapCrawlLinksToDiscovered(crawlResult.links),
          'crawl',
          sourceUrls,
        );
        if (crawlResult.errors.length > 0) {
          errors.push(...crawlResult.errors);
        }
        if (crawlResult.brokenWebsite) {
          errors.push('Official website could not be validated from homepage crawl');
        }
      } catch (err: unknown) {
        errors.push(`Website validation crawl failed: ${getErrorMessage(err)}`);
      }
    } else if (discoveredLinks.website && !runtime.crawlEnabled) {
      errors.push('Website crawling disabled; homepage validation skipped');
    }

    const sanitized = sanitizeDiscoveredLinks({
      links: discoveredLinks,
      provenance,
      sourceUrls,
      context: {
        tokenName,
        tokenSymbol,
        contractAddress,
        provenance,
        verifiedOfficialWebsite: null,
        crawlMentionsContract: crawlResult?.mentions.contractAddress ?? false,
      },
    });

    const finalLinks = sanitized.links;
    const finalProvenance = sanitized.provenance;
    if (sanitized.aggregatorWebsiteRejected) {
      errors.push('Aggregator listing page rejected as official website');
    }
    if (sanitized.rejectedUrls.length > 0) {
      errors.push(`${sanitized.rejectedUrls.length} unverified project link(s) rejected`);
    }

    const discoveryMode = resolveDiscoveryMode({
      website: finalLinks.website,
      websiteSource: finalProvenance.website,
      hasTrustedDirectoryPresence: trustedDirectoryUrls.size > 0,
      hasSearchEvidence: braveUsed,
    });

    let hasTrustedOfficialWebsite = sanitized.hasTrustedOfficialWebsite;
    let braveOnlyWebsite = sanitized.braveOnlyWebsite;
    if (discoveryMode === 'search_only') {
      finalLinks.website = null;
      delete finalProvenance.website;
      hasTrustedOfficialWebsite = false;
      braveOnlyWebsite = false;
    }

    const officialLinkConfidence = resolveOfficialLinkConfidence({
      discoveredLinks: finalLinks,
      provenance: finalProvenance,
      crawlResult: discoveryMode === 'search_only' ? null : crawlResult,
      braveUsed,
      tokenName,
      tokenSymbol,
      contractAddress,
    });

    trace.finalSelection = {
      discoveryMode,
      website: finalLinks.website,
      websiteSource: finalProvenance.website ?? null,
      docs: finalLinks.docs,
      github: finalLinks.github,
      twitter: finalLinks.twitter,
      telegram: finalLinks.telegram,
      discord: finalLinks.discord,
    };

    let status: OffchainDiscoveryResult['status'] = 'done';
    if (!finalLinks.website && Object.values(finalLinks).every((value) => !value)) {
      status = braveApiKey || trustedDirectoryUrls.size > 0 ? 'partial' : 'unknown';
    } else if (errors.length > 0 || officialLinkConfidence.level === 'low') {
      status = 'partial';
    }

    const result: OffchainDiscoveryResult = {
      status,
      discoveryMode,
      discoveredLinks: finalLinks,
      linkSources: finalProvenance,
      officialLinkConfidence,
      sourceUrls: sanitized.sourceUrls,
      errors,
      hasTrustedOfficialWebsite,
      braveOnlyWebsite,
      aggregatorWebsiteRejected:
        sanitized.aggregatorWebsiteRejected ||
        [...directoryCandidates].some((url) => isAggregatorUrl(url)),
      metadataCategories: [...new Set(metadataCategories)],
      trustedDirectoryUrls: [...trustedDirectoryUrls],
      debugTrace: input.debug ? trace : undefined,
    };

    if ((result.status === 'done' || result.status === 'partial') && !input.debug) {
      this.discoveryCache.set(cacheKey, result);
    }

    return result;
  }

  private getBraveApiKey(): string {
    return (
      this.config.get<string>('BRAVE_SEARCH_API_KEY') ??
      this.config.get<string>('brave.searchApiKey') ??
      ''
    ).trim();
  }

  private async extractOutboundFromDirectories(
    directoryUrls: string[],
    context: {
      tokenName: string | null;
      tokenSymbol: string | null;
      contractAddress: string | null;
      chain: string | null;
    },
    trace: OffchainDiscoveryTrace,
  ): Promise<{
    links: DiscoveredLinks;
    categories: string[];
    errors: string[];
    directorySources: Partial<Record<keyof DiscoveredLinks, MetadataSource>>;
  }> {
    const errors: string[] = [];
    const extractions = [];
    const directorySources: Partial<Record<keyof DiscoveredLinks, MetadataSource>> = {};

    for (const directoryUrl of directoryUrls.slice(0, 3)) {
      const traceEntry = {
        directoryUrl,
        identityVerified: false,
        outboundLinksFound: [] as string[],
        acceptedOutboundLinks: [] as string[],
        rejectedOutboundLinks: [] as Array<{ url: string; reason: string }>,
      };

      try {
        const page = await this.webCrawler.fetchPageContent(directoryUrl);
        if (!page) {
          errors.push(`Directory page could not be fetched: ${directoryUrl}`);
          trace.directoryExtraction.push(traceEntry);
          continue;
        }
        const extraction = extractOutboundLinksFromDirectoryHtml(page.html, page.finalUrl, context);
        traceEntry.identityVerified = extraction.identityVerified;
        traceEntry.outboundLinksFound = collectLinkUrls(extraction.links);

        if (!extraction.identityVerified) {
          errors.push('Directory page did not match token identity');
          trace.directoryExtraction.push(traceEntry);
          continue;
        }

        const dirSource = toMetadataSource(directorySourceFromUrl(directoryUrl));
        for (const key of Object.keys(extraction.links) as Array<keyof DiscoveredLinks>) {
          const url = extraction.links[key];
          if (!url) {
            continue;
          }
          const rejectReason = rejectCandidateReason(url, key, context, true);
          if (rejectReason) {
            traceEntry.rejectedOutboundLinks.push({ url, reason: rejectReason });
            trace.candidates.push({
              url,
              kind: key,
              source: dirSource,
              confidenceHint: 'medium',
              action: 'rejected',
              reason: rejectReason,
            });
            continue;
          }
          traceEntry.acceptedOutboundLinks.push(url);
          directorySources[key] ??= dirSource;
          trace.candidates.push({
            url,
            kind: key,
            source: dirSource,
            confidenceHint: 'medium',
            action: 'accepted',
            reason: 'directory_outbound_identity_verified',
          });
        }

        extractions.push(extraction);
        trace.directoryExtraction.push(traceEntry);
      } catch (err: unknown) {
        errors.push(`Directory extraction failed: ${getErrorMessage(err)}`);
        trace.directoryExtraction.push(traceEntry);
      }
    }

    const merged = mergeDirectoryExtractions(extractions);
    return {
      links: merged.links,
      categories: merged.categories,
      errors,
      directorySources,
    };
  }

  private async discoverWithBrave(
    apiKey: string,
    tokenName: string | null,
    tokenSymbol: string | null,
    contractAddress: string | null,
    current: DiscoveredLinks,
    timeoutMs: number,
    trace: OffchainDiscoveryTrace,
  ): Promise<{ links: DiscoveredLinks; errors: string[]; directoryCandidates: string[] }> {
    const errors: string[] = [];
    const links = emptyDiscoveredLinks();
    const directoryCandidates = new Set<string>();
    const label = [tokenName, tokenSymbol].filter(Boolean).join(' ').trim();

    const queries: string[] = [];
    if (!current.website && label) {
      queries.push(`${label} official website crypto`);
    }
    if (!current.website && label && contractAddress) {
      queries.push(`${label} ${contractAddress}`);
    }
    if (!current.website && tokenSymbol && contractAddress) {
      queries.push(`${tokenSymbol} token ${contractAddress}`);
    }
    if (!current.website && label) {
      queries.push(`${label} CoinGecko CoinMarketCap DexScreener`);
    }

    const limitedQueries = [...new Set(queries)].slice(0, MAX_BRAVE_QUERIES);
    trace.brave.queries = limitedQueries;

    for (const query of limitedQueries) {
      const response = await searchBraveWeb(apiKey, query, timeoutMs);
      if (response.rateLimited) {
        errors.push('Brave Search rate limit reached');
        break;
      }
      if (response.timedOut) {
        errors.push(`Brave search timed out for: ${query}`);
        continue;
      }
      if (response.error) {
        errors.push(response.error);
      }
      if (response.hits.length === 0) {
        errors.push(`Brave search returned no results for: ${query}`);
        continue;
      }

      for (const hit of response.hits.slice(0, MAX_BRAVE_RESULTS)) {
        trace.brave.resultUrls.push(hit.url);
        if (isTrustedDirectoryUrl(hit.url)) {
          directoryCandidates.add(hit.url);
          trace.candidates.push({
            url: hit.url,
            kind: 'directory',
            source: directorySourceFromUrl(hit.url),
            confidenceHint: 'medium',
            action: 'queued_directory_extraction',
            reason: 'aggregator_directory_page',
          });
          continue;
        }
        assignBraveHit(links, hit, current, trace, {
          tokenName,
          tokenSymbol,
          contractAddress,
        });
      }
    }

    return { links, errors, directoryCandidates: [...directoryCandidates] };
  }
}

export function shouldUseBraveFallback(links: DiscoveredLinks): boolean {
  if (!links.website) {
    return true;
  }

  const hasSocialOrDocs = Boolean(
    links.docs ||
      links.github ||
      links.twitter ||
      links.telegram ||
      links.discord,
  );

  return !hasSocialOrDocs;
}

export async function searchBraveWeb(
  apiKey: string,
  query: string,
  timeoutMs = 8_000,
): Promise<BraveSearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(BRAVE_API_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(MAX_BRAVE_RESULTS));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      return {
        hits: [],
        error: 'Brave Search rate limit reached',
        rateLimited: true,
        timedOut: false,
      };
    }

    if (!response.ok) {
      return {
        hits: [],
        error: `Brave search HTTP ${response.status}`,
        rateLimited: false,
        timedOut: false,
      };
    }

    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    const hits = (body.web?.results ?? [])
      .map((result) => ({
        title: safeString(result.title) ?? '',
        url: safeString(result.url) ?? '',
        description: safeString(result.description) ?? '',
      }))
      .filter((result) => result.url.length > 0);

    return { hits, error: null, rateLimited: false, timedOut: false };
  } catch (err: unknown) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      hits: [],
      error: timedOut ? 'Brave search timed out' : 'Brave search failed',
      rateLimited: false,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractSeedLinks(seed?: Partial<DiscoveredLinks>): DiscoveredLinks {
  return normalizeDiscoveredLinks(seed ?? {});
}

export function extractCoinGeckoLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const links = asRecord(record.links);
  const repos = asRecord(links.repos_url);
  const githubRepos = Array.isArray(repos.github) ? repos.github : [];

  const homepage = firstNonAggregatorUrl(links.homepage);
  const twitterHandle = safeString(links.twitter_screen_name);
  const telegram = safeString(links.telegram_channel_identifier);
  const telegramUrl = telegram ? `https://t.me/${telegram}` : firstUrl(links.chat_url);

  return normalizeDiscoveredLinks({
    website: homepage,
    docs: firstNonAggregatorUrlMatching(
      links.homepage,
      /(^|[/.-])(docs?|documentation|developers?|developer-docs|dev)([/.-]|$)/i,
    ),
    whitepaper: firstNonAggregatorUrlMatching(links.homepage, /whitepaper|white-paper/i),
    github: firstNonAggregatorUrl(githubRepos),
    twitter: twitterHandle ? `https://twitter.com/${twitterHandle}` : null,
    telegram: telegramUrl && !isPlatformDirectorySocialUrl(telegramUrl) ? telegramUrl : null,
    discord: firstUrlMatching(links.chat_url, /discord/i),
    blog: firstUrlMatching(links.homepage, /blog/i),
  });
}

export function extractDexScreenerLinks(profile: unknown): DiscoveredLinks {
  const record = asRecord(profile);
  const info = asRecord(record.info ?? record);
  const websites = Array.isArray(info.websites) ? info.websites : [];
  const socials = Array.isArray(info.socials) ? info.socials : [];

  const links = emptyDiscoveredLinks();
  links.website = firstNonAggregatorUrl(websites);

  for (const social of socials) {
    const item = asRecord(social);
    const type = safeString(item.type)?.toLowerCase() ?? '';
    const url = safeString(item.url);
    if (!url) {
      continue;
    }
    if (isPlatformDirectorySocialUrl(url)) {
      continue;
    }
    if (type.includes('twitter') || type === 'x') {
      links.twitter ??= url;
    } else if (type.includes('telegram')) {
      links.telegram ??= url;
    } else if (type.includes('discord')) {
      links.discord ??= url;
    } else if (type.includes('github')) {
      links.github ??= url;
    }
  }

  return normalizeDiscoveredLinks(links);
}

export function extractExplorerLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const rawResult = record.result;
  const firstResult =
    Array.isArray(rawResult) && rawResult.length > 0 ? asRecord(rawResult[0]) : asRecord(rawResult);
  const result = Object.keys(firstResult).length > 0 ? firstResult : record;
  const tokenInfo = asRecord(result.tokenInfo ?? result);

  return normalizeDiscoveredLinks({
    website: safeString(tokenInfo.website) ?? safeString(result.website),
    twitter: safeString(tokenInfo.twitter) ?? safeString(result.twitter),
    github: safeString(tokenInfo.github) ?? safeString(result.github),
    telegram: rejectPlatformSocial(safeString(tokenInfo.telegram) ?? safeString(result.telegram)),
    discord: safeString(tokenInfo.discord) ?? safeString(result.discord),
  });
}

export function extractExistingMetadataLinks(metadata: unknown): DiscoveredLinks {
  const record = asRecord(metadata);
  const social = asRecord(record.social ?? record.socials ?? record.links);

  return normalizeDiscoveredLinks({
    website:
      safeString(record.website) ??
      safeString(record.homepage) ??
      safeString(social.website),
    docs: safeString(record.docs) ?? safeString(social.docs),
    whitepaper: safeString(record.whitepaper) ?? safeString(social.whitepaper),
    github: safeString(record.github) ?? safeString(social.github),
    twitter: safeString(record.twitter) ?? safeString(social.twitter),
    telegram: rejectPlatformSocial(safeString(record.telegram) ?? safeString(social.telegram)),
    discord: safeString(record.discord) ?? safeString(social.discord),
    blog: safeString(record.blog) ?? safeString(social.blog),
  });
}

export function resolveOfficialLinkConfidence(input: {
  discoveredLinks: DiscoveredLinks;
  provenance: LinkProvenanceMap;
  crawlResult: TokenWebsiteCrawlResult | null;
  braveUsed: boolean;
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
}): OffchainDiscoveryResult['officialLinkConfidence'] {
  const reasons: string[] = [];
  const { discoveredLinks, provenance, crawlResult, braveUsed, tokenName, tokenSymbol, contractAddress } =
    input;

  if (!discoveredLinks.website) {
    return {
      level: 'low',
      reasons: ['No official website discovered'],
    };
  }

  const websiteSource = provenance.website;
  const trustedWebsite = isTrustedMetadataSource(websiteSource);
  const mentions = crawlResult?.mentions;
  const verifiedOnSite =
    Boolean(mentions?.tokenName || mentions?.tokenSymbol || mentions?.contractAddress);
  const socialAgreement = countSocialAgreement(discoveredLinks, crawlResult);

  if (trustedWebsite && verifiedOnSite) {
    reasons.push('Website found in trusted metadata and homepage mentions token identifiers');
    if (socialAgreement > 0) {
      reasons.push('Homepage crawl links align with known social metadata');
    }
    return { level: 'high', reasons };
  }

  if (trustedWebsite && (socialAgreement > 0 || crawlResult?.signals.hasClearUseCase)) {
    reasons.push('Trusted metadata provides website with consistent supporting links or use-case signals');
    return { level: 'high', reasons };
  }

  if (trustedWebsite) {
    reasons.push('Website found in trusted metadata');
    if (!verifiedOnSite && (tokenName || tokenSymbol || contractAddress)) {
      reasons.push('Official website could not be fully verified from homepage text');
      if (socialAgreement > 0) {
        reasons.push('Supporting social or docs links appear consistent with trusted metadata');
        return { level: 'medium', reasons };
      }
      return { level: 'medium', reasons };
    }
    return { level: 'medium', reasons };
  }

  if (braveUsed && !trustedWebsite) {
    reasons.push('Website discovered primarily from Brave search without trusted metadata confirmation');
    if (!verifiedOnSite) {
      reasons.push('Homepage content did not verify token name, symbol, or contract');
      return { level: 'low', reasons };
    }
    if (socialAgreement > 0) {
      reasons.push('Brave discovery with homepage verification and social consistency');
      return { level: 'medium', reasons };
    }
    reasons.push('Brave discovery lacked consistent social metadata agreement');
    return { level: 'low', reasons };
  }

  if (
    crawlResult &&
    !verifiedOnSite &&
    (tokenName || tokenSymbol || contractAddress) &&
    !trustedWebsite
  ) {
    reasons.push('Website could not be verified against token identifiers');
    return { level: 'low', reasons };
  }

  reasons.push('Limited metadata agreement for official links');
  return { level: 'medium', reasons };
}

function countSocialAgreement(
  discovered: DiscoveredLinks,
  crawlResult: TokenWebsiteCrawlResult | null,
): number {
  if (!crawlResult) {
    return 0;
  }
  let matches = 0;
  if (discovered.github && crawlResult.links.github && sameUrlHost(discovered.github, crawlResult.links.github)) {
    matches += 1;
  }
  if (discovered.twitter && crawlResult.links.twitter && sameUrlHost(discovered.twitter, crawlResult.links.twitter)) {
    matches += 1;
  }
  if (discovered.telegram && crawlResult.links.telegram && sameUrlHost(discovered.telegram, crawlResult.links.telegram)) {
    matches += 1;
  }
  if (discovered.docs && crawlResult.links.docs && sameUrlHost(discovered.docs, crawlResult.links.docs)) {
    matches += 1;
  }
  return matches;
}

function assignBraveHit(
  target: DiscoveredLinks,
  hit: BraveSearchHit,
  current: DiscoveredLinks,
  trace: OffchainDiscoveryTrace,
  context: {
    tokenName: string | null;
    tokenSymbol: string | null;
    contractAddress: string | null;
  },
): void {
  const rejectReason = rejectCandidateReason(hit.url, 'website', context, false);
  if (rejectReason || isBlockedOfficialLink(hit.url)) {
    trace.candidates.push({
      url: hit.url,
      kind: 'evidence',
      source: 'brave',
      confidenceHint: 'low',
      action: 'rejected',
      reason: rejectReason ?? 'blocked_official_link',
    });
    return;
  }

  const lowerUrl = hit.url.toLowerCase();
  const combined = `${hit.title} ${hit.description} ${hit.url}`.toLowerCase();

  if (!current.website && !target.website && looksLikeWebsiteHit(combined, lowerUrl)) {
    target.website = hit.url;
    trace.candidates.push({
      url: hit.url,
      kind: 'website',
      source: 'brave',
      confidenceHint: 'low',
      action: 'evidence_only',
      reason: 'brave_unverified_website_candidate',
    });
    return;
  }
  if (!current.docs && !target.docs && combined.includes('doc') && !isAggregatorUrl(hit.url)) {
    target.docs = hit.url;
    trace.candidates.push({
      url: hit.url,
      kind: 'docs',
      source: 'brave',
      confidenceHint: 'low',
      action: 'evidence_only',
      reason: 'brave_docs_candidate',
    });
    return;
  }
  if (
    !current.whitepaper &&
    !target.whitepaper &&
    combined.includes('whitepaper') &&
    !isAggregatorUrl(hit.url)
  ) {
    target.whitepaper = hit.url;
    trace.candidates.push({
      url: hit.url,
      kind: 'whitepaper',
      source: 'brave',
      confidenceHint: 'low',
      action: 'evidence_only',
      reason: 'brave_whitepaper_candidate',
    });
    return;
  }
  if (!current.github && !target.github && lowerUrl.includes('github.com')) {
    target.github = hit.url;
    trace.candidates.push({
      url: hit.url,
      kind: 'github',
      source: 'brave',
      confidenceHint: 'low',
      action: 'evidence_only',
      reason: 'brave_github_candidate',
    });
  }
}

function looksLikeWebsiteHit(combined: string, lowerUrl: string): boolean {
  const candidateUrl = lowerUrl.startsWith('http') ? lowerUrl : `https://${lowerUrl}`;
  if (isAggregatorUrl(candidateUrl)) {
    return false;
  }
  if (
    lowerUrl.includes('twitter.com') ||
    lowerUrl.includes('x.com') ||
    lowerUrl.includes('github.com') ||
    lowerUrl.includes('t.me/') ||
    lowerUrl.includes('discord.')
  ) {
    return false;
  }
  return combined.includes('official') || true;
}

function mapCrawlLinksToDiscovered(links: TokenWebsiteCrawlResult['links']): DiscoveredLinks {
  return normalizeDiscoveredLinks({
    docs: links.docs,
    whitepaper: links.whitepaper,
    github: links.github,
    twitter: links.twitter,
    telegram: links.telegram,
    discord: links.discord,
    blog: links.blog,
  });
}

function mergeDiscoveredLinks(
  target: DiscoveredLinks,
  provenance: LinkProvenanceMap,
  incoming: DiscoveredLinks,
  source: MetadataSource,
  sourceUrls: string[],
): void {
  for (const key of Object.keys(target) as Array<keyof DiscoveredLinks>) {
    const value = incoming[key];
    if (!value) {
      continue;
    }
    if (!target[key]) {
      target[key] = value;
      provenance[key] = source;
      sourceUrls.push(value);
    }
  }
}

function emptyDiscoveredLinks(): DiscoveredLinks {
  return {
    website: null,
    docs: null,
    whitepaper: null,
    github: null,
    twitter: null,
    telegram: null,
    discord: null,
    blog: null,
  };
}

function normalizeDiscoveredLinks(links: Partial<DiscoveredLinks>): DiscoveredLinks {
  const normalized = emptyDiscoveredLinks();
  for (const key of Object.keys(normalized) as Array<keyof DiscoveredLinks>) {
    const value = safeString(links[key]);
    normalized[key] = value ? normalizeHttpUrl(value) : null;
  }
  return normalized;
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const parsed = new URL(withProtocol);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return safeString(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrl(item);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function firstUrlMatching(value: unknown, pattern: RegExp): string | null {
  if (typeof value === 'string' && pattern.test(value)) {
    return safeString(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrlMatching(item, pattern);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function sameUrlHost(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname.replace(/^www\./i, '') === b.hostname.replace(/^www\./i, '');
  } catch {
    return left === right;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function rejectPlatformSocial(url: string | null): string | null {
  return url && !isPlatformDirectorySocialUrl(url) ? url : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function populateStructuredMetadataTrace(
  trace: OffchainDiscoveryTrace,
  input: {
    dexScreenerProfile?: unknown;
    coinGeckoMetadata?: unknown;
    explorerMetadata?: unknown;
    contractAddress?: string | null;
  },
): void {
  const dexRecord = asRecord(input.dexScreenerProfile);
  const dexInfo = asRecord(dexRecord.info ?? dexRecord);
  const dexWebsites = Array.isArray(dexInfo.websites) ? dexInfo.websites : [];
  const dexSocials = Array.isArray(dexInfo.socials) ? dexInfo.socials : [];
  const dexPairs = Array.isArray(dexRecord.pairs) ? dexRecord.pairs : null;

  trace.structuredMetadata.dexScreenerWebsitesFound = dexWebsites
    .map((item) => safeString(item))
    .filter((item): item is string => Boolean(item));
  trace.structuredMetadata.dexScreenerSocialsFound = dexSocials
    .map((item) => safeString(asRecord(item).url))
    .filter((item): item is string => Boolean(item));
  trace.structuredMetadata.dexScreenerPairCount = dexPairs ? dexPairs.length : null;

  const cgRecord = asRecord(input.coinGeckoMetadata);
  const cgLinks = asRecord(cgRecord.links);
  const cgRepos = asRecord(cgLinks.repos_url);
  const homepage = Array.isArray(cgLinks.homepage) ? cgLinks.homepage : [];
  trace.structuredMetadata.coinGeckoHomepageFound = homepage
    .map((item) => safeString(item))
    .filter((item): item is string => Boolean(item));
  trace.structuredMetadata.coinGeckoTwitterFound = safeString(cgLinks.twitter_screen_name);
  trace.structuredMetadata.coinGeckoGithubFound = (Array.isArray(cgRepos.github) ? cgRepos.github : [])
    .map((item) => safeString(item))
    .filter((item): item is string => Boolean(item));
  trace.structuredMetadata.coinGeckoCategories = extractCoinGeckoCategories(input.coinGeckoMetadata);

  const platforms = asRecord(cgRecord.platforms);
  const platformMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(platforms)) {
    if (typeof value === 'string') {
      platformMap[key] = value;
    }
  }
  trace.structuredMetadata.coinGeckoPlatforms = platformMap;
  trace.structuredMetadata.coinGeckoContractMatched =
    input.coinGeckoMetadata && input.contractAddress
      ? coinGeckoMetadataMatchesToken(input.coinGeckoMetadata, input.contractAddress)
      : input.coinGeckoMetadata
        ? true
        : null;

  const explorerLinks = extractExplorerLinks(input.explorerMetadata);
  trace.structuredMetadata.explorerWebsiteFound = explorerLinks.website;
}

function recordStructuredCandidates(
  trace: OffchainDiscoveryTrace,
  discoveredLinks: DiscoveredLinks,
  provenance: LinkProvenanceMap,
  sourceUrls: string[],
  sources: Record<'seed' | 'dexscreener' | 'coingecko' | 'explorer' | 'existing', DiscoveredLinks>,
  context: {
    tokenName: string | null;
    tokenSymbol: string | null;
    contractAddress: string | null;
  },
): void {
  const confidenceBySource: Record<keyof typeof sources, 'high' | 'medium' | 'low'> = {
    seed: 'high',
    dexscreener: 'high',
    coingecko: 'high',
    explorer: 'high',
    existing: 'medium',
  };

  for (const [source, links] of Object.entries(sources) as Array<
    [keyof typeof sources, DiscoveredLinks]
  >) {
    mergeDiscoveredLinks(discoveredLinks, provenance, links, source, sourceUrls);
    for (const key of Object.keys(links) as Array<keyof DiscoveredLinks>) {
      const url = links[key];
      if (!url) {
        continue;
      }
      const rejectReason = rejectCandidateReason(url, key, context, true);
      trace.candidates.push({
        url,
        kind: key,
        source,
        confidenceHint: confidenceBySource[source],
        action: rejectReason ? 'rejected' : 'accepted',
        reason: rejectReason ?? `structured_metadata_${source}`,
      });
    }
  }
}

function queueDirectoryCandidate(
  directoryCandidates: Set<string>,
  trace: OffchainDiscoveryTrace,
  directoryUrl: string,
  source: OffchainLinkCandidate['source'],
): void {
  if (!directoryUrl || !isTrustedDirectoryUrl(directoryUrl)) {
    return;
  }
  directoryCandidates.add(directoryUrl);
  trace.candidates.push({
    url: directoryUrl,
    kind: 'directory',
    source,
    confidenceHint: 'medium',
    action: 'queued_directory_extraction',
    reason: 'trusted_directory_page',
  });
}

function mergeDirectoryOutboundLinks(
  discoveredLinks: DiscoveredLinks,
  provenance: LinkProvenanceMap,
  sourceUrls: string[],
  links: DiscoveredLinks,
  directorySources: Partial<Record<keyof DiscoveredLinks, MetadataSource>>,
): void {
  for (const key of Object.keys(links) as Array<keyof DiscoveredLinks>) {
    const value = links[key];
    const source = directorySources[key];
    if (!value || !source || discoveredLinks[key]) {
      continue;
    }
    discoveredLinks[key] = value;
    provenance[key] = source;
    sourceUrls.push(value);
  }
}

function mergeBraveEvidence(
  discoveredLinks: DiscoveredLinks,
  provenance: LinkProvenanceMap,
  sourceUrls: string[],
  braveLinks: DiscoveredLinks,
  trace: OffchainDiscoveryTrace,
  context: {
    tokenName: string | null;
    tokenSymbol: string | null;
    contractAddress: string | null;
  },
): void {
  for (const key of Object.keys(braveLinks) as Array<keyof DiscoveredLinks>) {
    const value = braveLinks[key];
    if (!value || discoveredLinks[key]) {
      continue;
    }
    if (key === 'website') {
      const rejectReason = rejectCandidateReason(value, 'website', context, false);
      trace.candidates.push({
        url: value,
        kind: 'website',
        source: 'brave',
        confidenceHint: 'low',
        action: 'rejected',
        reason: rejectReason ?? 'brave_unverified_website_candidate',
      });
      continue;
    }
    discoveredLinks[key] = value;
    provenance[key] = 'search_evidence';
    sourceUrls.push(value);
  }
}

export function extractDexScreenerDirectoryUrl(
  profile: unknown,
  contractAddress: string | null,
): string | null {
  const record = asRecord(profile);
  const pairs = Array.isArray(record.pairs) ? record.pairs : [];
  if (pairs.length === 0) {
    return null;
  }
  const chainId = safeString(asRecord(pairs[0]).chainId);
  const address = contractAddress?.toLowerCase();
  if (!chainId || !address) {
    return null;
  }
  return `https://dexscreener.com/${chainId}/${address}`;
}

function rejectCandidateReason(
  url: string,
  kind: OffchainLinkKind | keyof DiscoveredLinks,
  context: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
  },
  trustedMetadataConfirmed: boolean,
): string | null {
  if (isAggregatorUrl(url) && kind === 'website') {
    return 'aggregator_not_official_website';
  }
  if (isBlockedOfficialLink(url) && kind === 'website') {
    return 'blocked_official_link';
  }
  if (
    hasCrossProjectMismatch(
      url,
      context.tokenName ?? null,
      context.tokenSymbol ?? null,
      trustedMetadataConfirmed,
    )
  ) {
    return 'cross_project_or_clone';
  }
  return null;
}

function collectLinkUrls(links: DiscoveredLinks): string[] {
  return Object.values(links).filter((value): value is string => Boolean(value));
}

function shouldTrustCoinGeckoMetadata(
  metadata: unknown,
  contractAddress: string | null,
): boolean {
  if (!metadata) {
    return false;
  }
  if (!contractAddress) {
    return true;
  }
  const platforms = asRecord(asRecord(metadata).platforms);
  if (Object.keys(platforms).length === 0) {
    return true;
  }
  return coinGeckoMetadataMatchesToken(metadata, contractAddress);
}
