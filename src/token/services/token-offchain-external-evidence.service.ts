import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveOffchainConfig } from './offchain-config';
import { isTrustedDirectoryUrl } from './offchain-directory-extraction';
import type { DiscoveredLinks } from './offchain-discovery-types';
import {
  extractHostname,
  isAggregatorUrl,
  isExplorerUrl,
  isSameOfficialDomain,
} from './offchain-link-validation';
import { searchBraveWeb, type BraveSearchHit } from './token-offchain-discovery.service';

export type OffchainEvidenceSourceType =
  | 'official_website'
  | 'official_docs'
  | 'official_github'
  | 'official_whitepaper'
  | 'official_security'
  | 'trusted_directory'
  | 'explorer_identity'
  | 'brave_search'
  | 'news'
  | 'security_report'
  | 'audit_report'
  | 'developer_resource'
  | 'community_social'
  | 'risk_warning'
  | 'scam_warning'
  | 'spam_or_seo'
  | 'unrelated'
  | 'clone_or_wrong_token';

export type OffchainEvidenceTrustLevel = 'high' | 'medium' | 'low';
export type OffchainEvidenceRelevance = 'high' | 'medium' | 'low';

export interface OffchainEvidenceItem {
  id: string;
  sourceType: OffchainEvidenceSourceType;
  trustLevel: OffchainEvidenceTrustLevel;
  relevance: OffchainEvidenceRelevance;
  url?: string;
  title?: string;
  snippet?: string;
  query?: string;
  matchedContractAddress?: boolean;
  matchedTokenName?: boolean;
  matchedTokenSymbol?: boolean;
  matchedOfficialDomain?: boolean;
  sourceName?: string;
  reason: string;
}

export interface OffchainExternalEvidenceResult {
  status: 'done' | 'partial' | 'skipped' | 'failed';
  evidenceItems: OffchainEvidenceItem[];
  summary: {
    trustedDirectoryCount: number;
    officialSourceCount: number;
    externalValidationCount: number;
    riskWarningCount: number;
    scamWarningCount: number;
    unrelatedCount: number;
  };
  errors?: string[];
}

@Injectable()
export class TokenOffchainExternalEvidenceService {
  constructor(private readonly config: ConfigService) {}

  async collectEvidence(input: {
    tokenName?: string | null;
    tokenSymbol?: string | null;
    contractAddress?: string | null;
    chain?: string | null;
    discoveredLinks?: DiscoveredLinks;
    forceRefresh?: boolean;
  }): Promise<OffchainExternalEvidenceResult> {
    const runtime = resolveOffchainConfig(this.config);
    const apiKey = this.getBraveApiKey();

    if (!runtime.externalEvidenceEnabled || !runtime.braveEnabled) {
      return emptyEvidence('skipped', ['External evidence collection disabled']);
    }
    if (!apiKey) {
      return emptyEvidence('skipped', ['Brave search API key missing']);
    }

    const queries = buildExternalEvidenceQueries({
      tokenName: input.tokenName ?? null,
      tokenSymbol: input.tokenSymbol ?? null,
      contractAddress: input.contractAddress ?? null,
      chain: input.chain ?? null,
    }).slice(0, runtime.externalEvidenceMaxQueries);

    if (queries.length === 0) {
      return emptyEvidence('skipped', ['Insufficient token identity for external evidence queries']);
    }

    const evidenceItems: OffchainEvidenceItem[] = [];
    const seenUrls = new Set<string>();
    const errors: string[] = [];

    for (const query of queries) {
      const response = await searchBraveWeb(apiKey, query, runtime.braveTimeoutMs);
      if (response.error) {
        errors.push(response.error);
      }
      if (response.rateLimited) {
        break;
      }

      for (const hit of response.hits.slice(0, runtime.externalEvidenceMaxResultsPerQuery)) {
        const normalizedUrl = normalizeEvidenceUrl(hit.url);
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
          continue;
        }
        seenUrls.add(normalizedUrl);
        evidenceItems.push(
          classifyBraveHit(hit, query, {
            tokenName: input.tokenName ?? null,
            tokenSymbol: input.tokenSymbol ?? null,
            contractAddress: input.contractAddress?.toLowerCase() ?? null,
            officialWebsite: input.discoveredLinks?.website ?? null,
            officialDocs: input.discoveredLinks?.docs ?? null,
            officialGithub: input.discoveredLinks?.github ?? null,
            officialWhitepaper: input.discoveredLinks?.whitepaper ?? null,
          }),
        );
      }
    }

    const status =
      evidenceItems.length > 0 ? (errors.length > 0 ? 'partial' : 'done') : errors.length > 0 ? 'failed' : 'done';

    return {
      status,
      evidenceItems: evidenceItems.slice(0, 40),
      summary: summarizeEvidence(evidenceItems),
      errors: errors.length > 0 ? [...new Set(errors)].slice(0, 5) : undefined,
    };
  }

  private getBraveApiKey(): string {
    return (
      this.config.get<string>('BRAVE_SEARCH_API_KEY') ??
      this.config.get<string>('brave.searchApiKey') ??
      ''
    ).trim();
  }
}

export function buildExternalEvidenceQueries(input: {
  tokenName: string | null;
  tokenSymbol: string | null;
  contractAddress: string | null;
  chain: string | null;
}): string[] {
  const label = [input.tokenName, input.tokenSymbol].filter(Boolean).join(' ').trim();
  const queries: string[] = [];

  if (input.contractAddress) {
    queries.push(input.contractAddress);
    queries.push(`${input.contractAddress} ${input.chain ?? ''}`.trim());
  }
  if (label) {
    queries.push(`${label} crypto`);
    queries.push(`${label} official website`);
    queries.push(`${label} token`);
    queries.push(`${label} coingecko dexscreener`);
    queries.push(`${label} docs github`);
    queries.push(`${label} whitepaper`);
    queries.push(`${label} audit security`);
    queries.push(`${label} scam exploit hack`);
    queries.push(`${label} integration partnership`);
  }
  if (input.tokenSymbol && input.contractAddress) {
    queries.push(`${input.tokenSymbol} token ${input.contractAddress}`);
  }

  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function classifyBraveHit(
  hit: BraveSearchHit,
  query: string,
  context: {
    tokenName: string | null;
    tokenSymbol: string | null;
    contractAddress: string | null;
    officialWebsite: string | null;
    officialDocs: string | null;
    officialGithub: string | null;
    officialWhitepaper: string | null;
  },
): OffchainEvidenceItem {
  const text = `${hit.title} ${hit.description} ${hit.url}`.toLowerCase();
  const lowerUrl = hit.url.toLowerCase();
  const matchedContractAddress = Boolean(
    context.contractAddress && text.includes(context.contractAddress.toLowerCase()),
  );
  const matchedTokenName = Boolean(
    context.tokenName && text.includes(context.tokenName.toLowerCase()),
  );
  const matchedTokenSymbol = Boolean(
    context.tokenSymbol && new RegExp(`\\b${escapeRegExp(context.tokenSymbol)}\\b`, 'i').test(text),
  );
  const matchedOfficialDomain = Boolean(
    context.officialWebsite && isSameOfficialDomain(hit.url, context.officialWebsite),
  );

  let sourceType: OffchainEvidenceSourceType = 'brave_search';
  let trustLevel: OffchainEvidenceTrustLevel = 'low';
  let reason = 'Open-web search result matched the token query.';

  if (isLikelyCloneOrWrongToken(hit.url, text, context)) {
    sourceType = 'clone_or_wrong_token';
    reason = 'Search result appears to reference a clone, variant, or wrong-token project.';
  } else if (isSpamOrSeo(text, hit.url)) {
    sourceType = 'spam_or_seo';
    reason = 'Search result looks promotional, low-quality, or SEO-oriented.';
  } else if (!matchedContractAddress && !matchedTokenName && !matchedTokenSymbol && !matchedOfficialDomain) {
    sourceType = 'unrelated';
    reason = 'Search result does not match contract, token name, symbol, or official domain.';
  } else if (/scam|honeypot|phishing|rug pull|rugpull/i.test(text)) {
    sourceType = 'scam_warning';
    trustLevel = matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result contains scam/rug-pull warning language.';
  } else if (/exploit|hack|incident|vulnerabilit|security warning/i.test(text)) {
    sourceType = 'risk_warning';
    trustLevel = matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result contains risk, exploit, hack, or incident language.';
  } else if (matchedOfficialDomain && context.officialDocs && isSameOfficialDomain(hit.url, context.officialDocs)) {
    sourceType = 'official_docs';
    trustLevel = 'high';
    reason = 'Search result matches the verified official documentation domain.';
  } else if (matchedOfficialDomain && /whitepaper|white-paper|\.pdf/i.test(lowerUrl)) {
    sourceType = 'official_whitepaper';
    trustLevel = 'high';
    reason = 'Search result matches a verified official whitepaper resource.';
  } else if (matchedOfficialDomain && /security|audit/i.test(text)) {
    sourceType = 'official_security';
    trustLevel = 'high';
    reason = 'Search result matches verified official security or audit material.';
  } else if (matchedOfficialDomain) {
    sourceType = 'official_website';
    trustLevel = 'high';
    reason = 'Search result matches the verified official website domain.';
  } else if (/github\.com/i.test(lowerUrl)) {
    sourceType = 'developer_resource';
    trustLevel = matchedTokenName || matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result points to a developer resource.';
  } else if (isTrustedDirectoryUrl(hit.url)) {
    sourceType = 'trusted_directory';
    trustLevel = matchedContractAddress || matchedTokenName ? 'medium' : 'low';
    reason = 'Search result is from a trusted token directory.';
  } else if (isExplorerUrl(hit.url)) {
    sourceType = 'explorer_identity';
    trustLevel = matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result is an explorer page that can support identity, not documentation.';
  } else if (/audit|security report|certik|trail of bits|openzeppelin/i.test(text)) {
    sourceType = 'audit_report';
    trustLevel = matchedTokenName || matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result references audit or security-report material.';
  } else if (/docs?|documentation|developer|whitepaper|research/i.test(text)) {
    sourceType = /whitepaper|research/i.test(text) ? 'official_whitepaper' : 'developer_resource';
    trustLevel = matchedTokenName || matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result references project documentation, research, or developer resources.';
  } else if (/twitter\.com|x\.com|t\.me|discord\.|reddit\.com|medium\.com/i.test(lowerUrl)) {
    sourceType = 'community_social';
    trustLevel = 'low';
    reason = 'Search result points to a community or social channel.';
  } else if (/coindesk|cointelegraph|the block|decrypt|beincrypto|news/i.test(text)) {
    sourceType = 'news';
    trustLevel = matchedTokenName || matchedContractAddress ? 'medium' : 'low';
    reason = 'Search result is news or media coverage.';
  }

  const relevance = resolveRelevance({
    matchedContractAddress,
    matchedOfficialDomain,
    matchedTokenName,
    matchedTokenSymbol,
    sourceType,
  });

  if (relevance === 'low' && sourceType !== 'unrelated' && sourceType !== 'spam_or_seo') {
    reason = `${reason} Relevance is limited because matching is weak.`;
  }

  return {
    id: `ev_${hashEvidenceId(hit.url || `${query}:${hit.title}`)}`,
    sourceType,
    trustLevel,
    relevance,
    url: hit.url,
    title: truncate(hit.title, 160),
    snippet: truncate(hit.description, 280),
    query,
    matchedContractAddress,
    matchedTokenName,
    matchedTokenSymbol,
    matchedOfficialDomain,
    sourceName: extractHostname(hit.url) ?? undefined,
    reason,
  };
}

function resolveRelevance(input: {
  matchedContractAddress: boolean;
  matchedOfficialDomain: boolean;
  matchedTokenName: boolean;
  matchedTokenSymbol: boolean;
  sourceType: OffchainEvidenceSourceType;
}): OffchainEvidenceRelevance {
  if (input.sourceType === 'unrelated' || input.sourceType === 'spam_or_seo') {
    return 'low';
  }
  if (input.matchedContractAddress || input.matchedOfficialDomain) {
    return 'high';
  }
  if (input.matchedTokenName && input.matchedTokenSymbol) {
    return 'medium';
  }
  return input.matchedTokenName ? 'medium' : 'low';
}

function summarizeEvidence(items: OffchainEvidenceItem[]): OffchainExternalEvidenceResult['summary'] {
  return {
    trustedDirectoryCount: count(items, 'trusted_directory'),
    officialSourceCount: items.filter((item) => item.sourceType.startsWith('official_')).length,
    externalValidationCount: items.filter((item) =>
      ['news', 'security_report', 'audit_report', 'developer_resource', 'trusted_directory'].includes(
        item.sourceType,
      ) && item.relevance !== 'low',
    ).length,
    riskWarningCount: count(items, 'risk_warning'),
    scamWarningCount: count(items, 'scam_warning'),
    unrelatedCount: items.filter((item) =>
      ['unrelated', 'clone_or_wrong_token', 'spam_or_seo'].includes(item.sourceType),
    ).length,
  };
}

function emptyEvidence(
  status: OffchainExternalEvidenceResult['status'],
  errors?: string[],
): OffchainExternalEvidenceResult {
  return {
    status,
    evidenceItems: [],
    summary: {
      trustedDirectoryCount: 0,
      officialSourceCount: 0,
      externalValidationCount: 0,
      riskWarningCount: 0,
      scamWarningCount: 0,
      unrelatedCount: 0,
    },
    errors,
  };
}

function count(items: OffchainEvidenceItem[], sourceType: OffchainEvidenceSourceType): number {
  return items.filter((item) => item.sourceType === sourceType).length;
}

function isLikelyCloneOrWrongToken(
  url: string,
  text: string,
  context: { tokenName: string | null; tokenSymbol: string | null; contractAddress: string | null },
): boolean {
  if (
    (context.tokenSymbol?.toUpperCase() === 'PEPE' || context.tokenName?.toLowerCase() === 'pepe') &&
    /pepe[-\s]?unchained|pepe[-\s]?2\.?0|pepe[-\s]?sol|pepe[-\s]?base/i.test(`${url} ${text}`)
  ) {
    return true;
  }
  return false;
}

function isSpamOrSeo(text: string, url: string): boolean {
  return (
    /price prediction|buy now|presale|1000x|best wallet|airdrop claim/i.test(text) ||
    /\/tag\/|\/category\/|utm_/i.test(url)
  );
}

function normalizeEvidenceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hashEvidenceId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
