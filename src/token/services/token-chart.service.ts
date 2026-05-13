import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';

export interface ChartDataPoint {
  timestamp: number;
  price: number;
  volume: number;
}

export type ChartTimeframe = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

export interface TokenChartResponse {
  contractAddress: string;
  chain: string;
  currency: 'usd';
  timeframe: ChartTimeframe;
  dataSource: 'coingecko' | 'geckoterminal' | 'unavailable';
  dataPoints: ChartDataPoint[];
  fetchedAt: string;
}

interface CoinGeckoMarketChartBody {
  prices?: Array<[number, number]>;
  total_volumes?: Array<[number, number]>;
}

@Injectable()
export class TokenChartService {
  private static readonly COINGECKO_BASE = 'https://pro-api.coingecko.com/api/v3';
  private static readonly GECKO_TERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  private static readonly CACHE_TTL_24H = 5 * 60 * 1000;
  private static readonly CACHE_TTL_7D = 15 * 60 * 1000;
  private static readonly CACHE_TTL_30D = 60 * 60 * 1000;
  private static readonly CACHE_TTL_LONG = 4 * 60 * 60 * 1000;

  private readonly logger = new Logger(TokenChartService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async getChart(
    contractAddress: string,
    chain: string,
    timeframe: ChartTimeframe,
  ): Promise<TokenChartResponse> {
    const normalized = contractAddress.toLowerCase();
    const chainKey = chain.toLowerCase();
    const cacheKey = `token:chart:${chainKey}:${normalized}:${timeframe}`;

    try {
      const cached = await this.cacheManager.get<TokenChartResponse>(cacheKey);
      if (cached && typeof cached === 'object' && Array.isArray(cached.dataPoints)) {
        return cached;
      }
    } catch {
      // ignore cache read errors
    }

    const buildUnavailable = (): TokenChartResponse => ({
      contractAddress: normalized,
      chain: chainKey,
      currency: 'usd',
      timeframe,
      dataSource: 'unavailable',
      dataPoints: [],
      fetchedAt: new Date().toISOString(),
    });

    try {
      this.logger.debug(
        `[token-chart] trying_coingecko contract=${normalized} chain=${chainKey} timeframe=${timeframe}`,
      );
      const cgPoints = await this.fetchFromCoinGecko(normalized, chainKey, timeframe);
      if (cgPoints && cgPoints.length >= 2) {
        const res: TokenChartResponse = {
          contractAddress: normalized,
          chain: chainKey,
          currency: 'usd',
          timeframe,
          dataSource: 'coingecko',
          dataPoints: cgPoints,
          fetchedAt: new Date().toISOString(),
        };
        this.logger.debug(
          `[token-chart] source_selected source=coingecko points=${cgPoints.length} contract=${normalized}`,
        );
        await this.setCacheSafe(cacheKey, res, timeframe);
        return res;
      }

      this.logger.debug(
        `[token-chart] trying_geckoterminal contract=${normalized} chain=${chainKey} timeframe=${timeframe}`,
      );
      const gtPoints = await this.fetchFromGeckoTerminal(
        normalized,
        chainKey,
        timeframe,
      );
      if (gtPoints && gtPoints.length >= 2) {
        const res: TokenChartResponse = {
          contractAddress: normalized,
          chain: chainKey,
          currency: 'usd',
          timeframe,
          dataSource: 'geckoterminal',
          dataPoints: gtPoints,
          fetchedAt: new Date().toISOString(),
        };
        this.logger.debug(
          `[token-chart] source_selected source=geckoterminal points=${gtPoints.length} contract=${normalized}`,
        );
        await this.setCacheSafe(cacheKey, res, timeframe);
        return res;
      }

      const empty = buildUnavailable();
      await this.setCacheSafe(cacheKey, empty, timeframe);
      return empty;
    } catch (err: unknown) {
      this.logger.warn(
        `[token-chart] get_chart_error contract=${normalized} chain=${chainKey} timeframe=${timeframe} message=${this.getErrorMessage(err)}`,
      );
      return buildUnavailable();
    }
  }

  private getCoinGeckoPlatform(chain: string): string {
    const c = chain.toLowerCase();
    switch (c) {
      case 'ethereum':
        return 'ethereum';
      case 'base':
        return 'base';
      case 'bsc':
        return 'binance-smart-chain';
      case 'polygon':
        return 'polygon-pos';
      default:
        return 'ethereum';
    }
  }

  private getGeckoTerminalNetwork(chain: string): string {
    const c = chain.toLowerCase();
    switch (c) {
      case 'ethereum':
        return 'eth';
      case 'base':
        return 'base';
      case 'bsc':
        return 'bsc';
      case 'polygon':
        return 'polygon_pos';
      default:
        return 'eth';
    }
  }

  private timeframeToDays(timeframe: ChartTimeframe): string {
    switch (timeframe) {
      case '24h':
        return '1';
      case '7d':
        return '7';
      case '30d':
        return '30';
      case '90d':
        return '90';
      case '1y':
        return '365';
      case 'all':
        return 'max';
      default:
        return '7';
    }
  }

  private getCacheTtl(timeframe: ChartTimeframe): number {
    switch (timeframe) {
      case '24h':
        return TokenChartService.CACHE_TTL_24H;
      case '7d':
        return TokenChartService.CACHE_TTL_7D;
      case '30d':
        return TokenChartService.CACHE_TTL_30D;
      case '90d':
      case '1y':
      case 'all':
        return TokenChartService.CACHE_TTL_LONG;
      default:
        return TokenChartService.CACHE_TTL_7D;
    }
  }

  private async setCacheSafe(
    cacheKey: string,
    value: TokenChartResponse,
    timeframe: ChartTimeframe,
  ): Promise<void> {
    try {
      const ttlMs = this.getCacheTtl(timeframe);
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      await this.cacheManager.set(cacheKey, value, ttlSeconds);
    } catch (err: unknown) {
      this.logger.warn(
        `[token-chart] cache_set_failed key=${cacheKey} message=${this.getErrorMessage(err)}`,
      );
    }
  }

  private async fetchFromCoinGecko(
    contractAddress: string,
    chain: string,
    timeframe: ChartTimeframe,
  ): Promise<ChartDataPoint[] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TokenChartService.REQUEST_TIMEOUT_MS,
    );
    try {
      const apiKey =
        this.configService.get<string>('COINGECKO_API_KEY') ??
        this.configService.get<string>('coingecko.apiKey') ??
        '';

      const platform = this.getCoinGeckoPlatform(chain);
      const days = this.timeframeToDays(timeframe);
      const url =
        `${TokenChartService.COINGECKO_BASE}/coins/${platform}/contract/${contractAddress}/market_chart` +
        `?vs_currency=usd&days=${encodeURIComponent(days)}&precision=6`;

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (apiKey.trim().length > 0) {
        headers['x-cg-pro-api-key'] = apiKey.trim();
      }

      const response = await fetch(url, { headers, signal: controller.signal });

      if (!response.ok) {
        this.logger.warn(
          `[token-chart] coingecko_error contract=${contractAddress} chain=${chain} timeframe=${timeframe} status=${response.status}`,
        );
        return null;
      }

      const body = (await response.json()) as CoinGeckoMarketChartBody;
      const prices = Array.isArray(body.prices) ? body.prices : [];
      const volumes = Array.isArray(body.total_volumes) ? body.total_volumes : [];

      const points: ChartDataPoint[] = [];
      for (let i = 0; i < prices.length; i += 1) {
        const row = prices[i];
        if (!Array.isArray(row) || row.length < 2) {
          continue;
        }
        let ts = Number(row[0]);
        if (Number.isFinite(ts) && ts > 0 && ts < 1e12) {
          ts *= 1000;
        }
        const price = Number(row[1]);
        const volRow = volumes[i];
        const volume =
          Array.isArray(volRow) && volRow.length >= 2 && Number.isFinite(Number(volRow[1]))
            ? Number(volRow[1])
            : 0;
        if (Number.isFinite(ts) && Number.isFinite(price)) {
          points.push({ timestamp: ts, price, volume: Number.isFinite(volume) ? volume : 0 });
        }
      }

      if (points.length < 2) {
        return null;
      }

      return points;
    } catch (err: unknown) {
      this.logger.warn(
        `[token-chart] coingecko_error contract=${contractAddress} chain=${chain} timeframe=${timeframe} message=${this.getErrorMessage(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getGeckoTerminalParams(
    timeframe: ChartTimeframe,
  ): { ohlcv: 'hour' | 'day'; aggregate: number; limit: number } {
    switch (timeframe) {
      case '24h':
        return { ohlcv: 'hour', aggregate: 1, limit: 24 };
      case '7d':
        return { ohlcv: 'hour', aggregate: 4, limit: 42 };
      case '30d':
        return { ohlcv: 'hour', aggregate: 12, limit: 60 };
      case '90d':
        return { ohlcv: 'day', aggregate: 1, limit: 90 };
      case '1y':
        return { ohlcv: 'day', aggregate: 1, limit: 365 };
      case 'all':
        return { ohlcv: 'day', aggregate: 1, limit: 1000 };
      default:
        return { ohlcv: 'hour', aggregate: 4, limit: 42 };
    }
  }

  private async fetchFromGeckoTerminal(
    contractAddress: string,
    chain: string,
    timeframe: ChartTimeframe,
  ): Promise<ChartDataPoint[] | null> {
    const network = this.getGeckoTerminalNetwork(chain);

    // STEP 1: Find top pool for this token
    const poolUrl = `${TokenChartService.GECKO_TERMINAL_BASE}/networks/${network}/tokens/${contractAddress}/pools?page=1`;

    let poolAddress: string | null = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TokenChartService.REQUEST_TIMEOUT_MS,
      );

      const poolRes = await fetch(poolUrl, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (poolRes.ok) {
        const poolBody = await poolRes.json() as {
          data?: Array<{ attributes?: { address?: string } }>;
        };
        poolAddress = poolBody?.data?.[0]?.attributes?.address ?? null;
      }
    } catch {
      this.logger.warn(
        `[token-chart] geckoterminal_pool_lookup_failed contract=${contractAddress}`,
      );
      return null;
    }

    if (!poolAddress) {
      this.logger.warn(
        `[token-chart] geckoterminal_no_pool contract=${contractAddress} chain=${chain}`,
      );
      return null;
    }

    // STEP 2: Get OHLCV from pool
    const isDaily = ['90d', '1y', 'all'].includes(timeframe);
    const resolution = isDaily ? 'day' : 'hour';

    const aggregateMap: Record<ChartTimeframe, number> = {
      '24h': 1,
      '7d': 4,
      '30d': 12,
      '90d': 1,
      '1y': 1,
      'all': 1,
    };
    const limitMap: Record<ChartTimeframe, number> = {
      '24h': 24,
      '7d': 42,
      '30d': 60,
      '90d': 90,
      '1y': 365,
      'all': 1000,
    };

    const ohlcvUrl = `${TokenChartService.GECKO_TERMINAL_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/${resolution}?aggregate=${aggregateMap[timeframe]}&limit=${limitMap[timeframe]}&currency=usd`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TokenChartService.REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(ohlcvUrl, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(
          `[token-chart] geckoterminal_ohlcv_error contract=${contractAddress} status=${res.status}`,
        );
        return null;
      }

      const body = await res.json() as {
        data?: { attributes?: { ohlcv_list?: number[][] } };
      };

      const ohlcvList = body?.data?.attributes?.ohlcv_list ?? [];
      if (ohlcvList.length < 2) return null;

      return ohlcvList
        .map((entry) => ({
          timestamp: entry[0] * 1000,
          price: entry[4],
          volume: entry[5] ?? 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (err: unknown) {
      this.logger.warn(
        `[token-chart] geckoterminal_error contract=${contractAddress} chain=${chain} timeframe=${timeframe} error=${this.getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
