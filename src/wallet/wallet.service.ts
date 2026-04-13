import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { Repository } from 'typeorm';
import {
  NormalizedTokenAmount,
  NormalizedTransaction,
  Trade,
  WalletNetFlowResponse,
  WalletPnLResponse,
  WalletPortfolioResponse,
  WalletPortfolioUSDResponse,
  StoredWalletTransactionsResponse,
  WalletSummaryResponse,
  WalletTokenFlowResponse,
  WalletTransactionsResponse,
} from './wallet.types';
import { TransactionEntity } from './transaction.entity';

interface MoralisPaginatedResponse<T> {
  cursor?: string | null;
  page?: string;
  page_size?: string;
  result: T[];
}

interface MoralisFetchOptions {
  stopAtBlock?: number;
  firstPageOnly?: boolean;
}

interface PortfolioTokenEntry {
  amount: string;
  contractAddress?: string;
}

interface CoinGeckoTokenPriceResponse {
  [contractAddress: string]: {
    usd?: number;
  };
}

interface CoinGeckoEthPriceResponse {
  ethereum?: {
    usd?: number;
  };
}

interface CoinGeckoHistoricalPriceResponse {
  market_data?: {
    current_price?: {
      usd?: number;
    };
  };
}

interface DefiLlamaPriceResponse {
  coins: {
    [key: string]: {
      price: number;
      symbol: string;
      timestamp: number;
      confidence: number;
    };
  };
}

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const DEFILLAMA_API_BASE_URL = 'https://coins.llama.fi';

type PricedTrade = Trade & { price: number };
type FifoBuyLot = { amount: number; price: number };

export interface MoralisErc20Transfer {
  token_name?: string;
  token_symbol?: string;
  token_decimals?: string;
  transaction_hash: string;
  address: string;
  block_timestamp: string;
  block_number: number | string;
  from_address: string;
  to_address: string;
  value: string | number;
  [key: string]: unknown;
}

export interface MoralisNativeTransfer {
  from_address: string;
  to_address: string;
  value: string;
  token_symbol?: string;
  direction?: string;
  [key: string]: unknown;
}

export interface MoralisWalletHistoryItem {
  hash: string;
  from_address: string;
  to_address?: string;
  value?: string;
  block_timestamp: string;
  block_number: string;
  category?: string;
  summary?: string;
  native_transfers?: MoralisNativeTransfer[];
  [key: string]: unknown;
}

function mergeTokenAmounts(entries: NormalizedTokenAmount[]) {
  const map = new Map<
    string,
    { amount: bigint; decimals?: number; contractAddress?: string }
  >();

  for (const entry of entries) {
    if (!entry.token) {
      continue;
    }

    const current = map.get(entry.token);

    if (!current) {
      map.set(entry.token, {
        amount: BigInt(entry.amount),
        decimals: entry.decimals,
        contractAddress: entry.contractAddress?.toLowerCase(),
      });

      continue;
    }

    current.amount += BigInt(entry.amount);

    if (current.decimals === undefined && entry.decimals !== undefined) {
      current.decimals = entry.decimals;
    }

    if (!current.contractAddress && entry.contractAddress) {
      current.contractAddress = entry.contractAddress.toLowerCase();
    }
  }

  return Array.from(map.entries()).map(([token, entry]) => ({
    token,
    amount: entry.amount.toString(),
    decimals: entry.decimals,
    contractAddress: entry.contractAddress,
  }));
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly moralisApiKey: string;
  private readonly coinGeckoApiKey: string;
  private readonly moralisClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TransactionEntity)
    private readonly transactionRepo: Repository<TransactionEntity>,
  ) {
    this.moralisApiKey = this.configService.get<string>('moralis.apiKey') ?? '';
    this.coinGeckoApiKey =
      this.configService.get<string>('coingecko.apiKey') ?? '';

    this.moralisClient = axios.create({
      baseURL: 'https://deep-index.moralis.io/api/v2.2',
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'X-API-Key': this.moralisApiKey,
      },
    });
  }

  async getWalletData(address: string): Promise<WalletTransactionsResponse> {
    const walletAddress = address.toLowerCase();
    const latestStoredBlock = await this.getLatestStoredBlock(walletAddress);

    if (!this.moralisApiKey) {
      throw new InternalServerErrorException('MORALIS_API_KEY is not configured');
    }

    if (latestStoredBlock !== null) {
      let latestErc20Transfers: MoralisErc20Transfer[] = [];
      let latestWalletHistory: MoralisWalletHistoryItem[] = [];

      try {
        [latestErc20Transfers, latestWalletHistory] = await Promise.all([
          this.fetchErc20Transfers(address, {
            firstPageOnly: true,
          }),
          this.fetchWalletHistory(address, {
            firstPageOnly: true,
          }),
        ]);
      } catch {
        this.logger.warn('Moralis failed, falling back to DB');
        return this.getStoredWalletData(address, walletAddress);
      }

      const latestNativeTransactions = latestWalletHistory.filter((transaction) =>
        this.isNativeTransaction(transaction),
      );

      const apiLatestBlock = this.getHighestBlockNumber(
        latestErc20Transfers,
        latestNativeTransactions,
      );

      if (apiLatestBlock <= latestStoredBlock) {
        return this.getStoredWalletData(address, walletAddress);
      }

      let newErc20Transfers: MoralisErc20Transfer[] = [];
      let newWalletHistory: MoralisWalletHistoryItem[] = [];

      try {
        [newErc20Transfers, newWalletHistory] = await Promise.all([
          this.fetchErc20Transfers(address, {
            stopAtBlock: latestStoredBlock,
          }),
          this.fetchWalletHistory(address, {
            stopAtBlock: latestStoredBlock,
          }),
        ]);
      } catch {
        this.logger.warn('Moralis failed while refreshing, falling back to DB');
        return this.getStoredWalletData(address, walletAddress);
      }

      const newNativeTransactions = this.filterNewTransactions(
        newWalletHistory.filter((transaction) => this.isNativeTransaction(transaction)),
        latestStoredBlock,
      );

      const filteredErc20Transfers = this.filterNewTransactions(
        newErc20Transfers,
        latestStoredBlock,
      );

      const normalizedTransactions = this.normalizeTransactions(
        address,
        filteredErc20Transfers,
        newNativeTransactions,
      );

      await this.saveNormalizedTransactions(address, normalizedTransactions);

      return this.getStoredWalletData(address, walletAddress);
    }

    let erc20Transfers: MoralisErc20Transfer[] = [];
    let walletHistory: MoralisWalletHistoryItem[] = [];

    try {
      [erc20Transfers, walletHistory] = await Promise.all([
        this.fetchErc20Transfers(address),
        this.fetchWalletHistory(address),
      ]);
    } catch {
      this.logger.error('Moralis failed and no cached data available');
      throw new BadGatewayException('Unable to fetch wallet data');
    }

    const nativeTransactions = walletHistory.filter((transaction) =>
      this.isNativeTransaction(transaction),
    );

    const normalizedTransactions = this.normalizeTransactions(
      address,
      erc20Transfers,
      nativeTransactions,
    );

    await this.saveNormalizedTransactions(address, normalizedTransactions);

    return this.getStoredWalletData(address, walletAddress);
  }

  async getStoredTransactions(
    address: string,
  ): Promise<StoredWalletTransactionsResponse> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        block_number: 'DESC',
      },
    });

    return {
      address: walletAddress,
      transactions: transactions.map((transaction) =>
        this.mapEntityToNormalized(transaction),
      ),
    };
  }

  async getTrades(address: string): Promise<Trade[]> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        timestamp: 'ASC',
      },
    });

    const swapTransactions = transactions
      .filter((transaction) => transaction.type === 'swap')
      .sort(
        (left, right) =>
          left.timestamp.getTime() - right.timestamp.getTime(),
      );

    const trades: Trade[] = [];

    for (const transaction of swapTransactions) {
      const timestamp = this.toUnixTimestamp(transaction.timestamp);

      trades.push(
        ...this.buildTradesFromEntries(transaction.inputs, 'SELL', timestamp),
      );
      trades.push(
        ...this.buildTradesFromEntries(transaction.outputs, 'BUY', timestamp),
      );
    }

    return trades.sort((left, right) => left.timestamp - right.timestamp);
  }

  async getPricedTrades(address: string): Promise<PricedTrade[]> {
    const trades = await this.getTrades(address);

    const priceCache = new Map<string, number>();
    const pricedTrades: PricedTrade[] = [];

    for (const trade of trades) {
      const cacheKey = `${trade.contractAddress?.toLowerCase() ?? trade.token}-${trade.timestamp}`;

      let price = priceCache.get(cacheKey);

      if (price === undefined) {
        price = await this.fetchHistoricalTradePrice(
          trade.token,
          trade.contractAddress,
          trade.timestamp,
        );
        priceCache.set(cacheKey, price);
      }

      pricedTrades.push({ ...trade, price });
    }

    return this.inferMissingSwapPrices(pricedTrades);
  }

  async getPnL(address: string): Promise<WalletPnLResponse> {
    const pricedTrades = await this.getPricedTrades(address);
    const sortedTrades = [...pricedTrades].sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    const buyQueues = new Map<string, FifoBuyLot[]>();
    const realizedPnLByToken = new Map<string, number>();
    const realizedCostBasisByToken = new Map<string, number>();

    for (const trade of sortedTrades) {
      if (!realizedPnLByToken.has(trade.token)) {
        realizedPnLByToken.set(trade.token, 0);
      }

      if (!realizedCostBasisByToken.has(trade.token)) {
        realizedCostBasisByToken.set(trade.token, 0);
      }

      const amount = this.parsePositiveNumber(trade.amount);

      if (amount === null || !this.isValidTradePrice(trade.price)) {
        continue;
      }

      const queue = buyQueues.get(trade.token) ?? [];

      if (trade.type === 'BUY') {
        queue.push({
          amount,
          price: trade.price,
        });
        buyQueues.set(trade.token, queue);
        continue;
      }

      let sellAmount = amount;

      while (sellAmount > 0 && queue.length > 0) {
        const oldestBuy = queue[0];
        const matchedAmount = Math.min(sellAmount, oldestBuy.amount);
        const currentPnL = realizedPnLByToken.get(trade.token) ?? 0;
        const currentCostBasis = realizedCostBasisByToken.get(trade.token) ?? 0;
        const matchedPnL = (trade.price - oldestBuy.price) * matchedAmount;
        const matchedCostBasis = oldestBuy.price * matchedAmount;

        realizedPnLByToken.set(
          trade.token,
          this.roundDecimal(currentPnL + matchedPnL),
        );
        realizedCostBasisByToken.set(
          trade.token,
          this.roundDecimal(currentCostBasis + matchedCostBasis),
        );

        oldestBuy.amount = this.roundDecimal(oldestBuy.amount - matchedAmount);
        sellAmount = this.roundDecimal(sellAmount - matchedAmount);

        if (oldestBuy.amount <= 0) {
          queue.shift();
        }
      }

      if (queue.length > 0) {
        buyQueues.set(trade.token, queue);
      }
    }

    return Object.fromEntries(
      Array.from(realizedPnLByToken.entries()).map(([token, realizedPnL]) => {
        const costBasis = realizedCostBasisByToken.get(token) ?? 0;
        const roundedRealizedPnL = this.roundDecimal(realizedPnL);
        const roi =
          costBasis > 0
            ? this.roundDecimal((roundedRealizedPnL / costBasis) * 100)
            : 0;

        return [
          token,
          {
            realizedPnL: roundedRealizedPnL,
            roi,
          },
        ];
      }),
    );
  }

  async getWalletSummary(address: string): Promise<WalletSummaryResponse> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
    });

    let totalSwaps = 0;
    let totalTransfers = 0;
    const tokenSet = new Set<string>();

    for (const transaction of transactions) {
      if (transaction.type === 'swap') {
        totalSwaps += 1;
      }

      if (transaction.type === 'transfer') {
        totalTransfers += 1;
      }

      for (const input of transaction.inputs) {
        tokenSet.add(input.token);
      }

      for (const output of transaction.outputs) {
        tokenSet.add(output.token);
      }
    }

    return {
      address: walletAddress,
      total_transactions: transactions.length,
      total_swaps: totalSwaps,
      total_transfers: totalTransfers,
      tokens_interacted: tokenSet.size,
    };
  }

  async getTokenFlow(address: string): Promise<WalletTokenFlowResponse> {
    const walletAddress = address.toLowerCase();
    const transactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
    });

    const flow: Record<
      string,
      {
        in: bigint;
        out: bigint;
        decimals?: number;
        contractAddress?: string;
      }
    > = {};

    for (const transaction of transactions) {
      for (const output of transaction.outputs) {
        if (!output.token) {
          continue;
        }

        if (!flow[output.token]) {
          flow[output.token] = {
            in: 0n,
            out: 0n,
            decimals: output.decimals,
            contractAddress: output.contractAddress?.toLowerCase(),
          };
        } else if (
          flow[output.token].decimals === undefined &&
          output.decimals !== undefined
        ) {
          flow[output.token].decimals = output.decimals;
        }

        if (!flow[output.token].contractAddress && output.contractAddress) {
          flow[output.token].contractAddress = output.contractAddress.toLowerCase();
        }

        flow[output.token].in += BigInt(output.amount);
      }

      for (const input of transaction.inputs) {
        if (!input.token) {
          continue;
        }

        if (!flow[input.token]) {
          flow[input.token] = {
            in: 0n,
            out: 0n,
            decimals: input.decimals,
            contractAddress: input.contractAddress?.toLowerCase(),
          };
        } else if (
          flow[input.token].decimals === undefined &&
          input.decimals !== undefined
        ) {
          flow[input.token].decimals = input.decimals;
        }

        if (!flow[input.token].contractAddress && input.contractAddress) {
          flow[input.token].contractAddress = input.contractAddress.toLowerCase();
        }

        flow[input.token].out += BigInt(input.amount);
      }
    }

    return {
      address: walletAddress,
      flow: Object.fromEntries(
        Object.entries(flow).map(([token, amounts]) => [
          token,
          {
            in: amounts.in.toString(),
            out: amounts.out.toString(),
            decimals: amounts.decimals,
            contractAddress: amounts.contractAddress,
          },
        ]),
      ),
    };
  }

  async getNetFlow(address: string): Promise<WalletNetFlowResponse> {
    const tokenFlow = await this.getTokenFlow(address);

    return Object.fromEntries(
      Object.entries(tokenFlow.flow).map(([token, amounts]) => [
        token,
        (BigInt(amounts.in) - BigInt(amounts.out)).toString(),
      ]),
    );
  }

  async getPortfolio(address: string): Promise<WalletPortfolioResponse> {
    const tokenFlow = await this.getTokenFlow(address);

    return Object.fromEntries(
      Object.entries(tokenFlow.flow).map(([token, amounts]) => [
        token,
        this.formatHumanReadableBalance(
          BigInt(amounts.in) - BigInt(amounts.out),
          amounts.decimals ?? 18,
        ),
      ]),
    );
  }

  async getPortfolioUSD(address: string): Promise<WalletPortfolioUSDResponse> {
    const portfolio = await this.getPortfolio(address);
    const tokenFlow = await this.getTokenFlow(address);
    const portfolioEntries = Object.fromEntries(
      Object.entries(portfolio).map(([token, entry]) => {
        const normalizedEntry = this.normalizePortfolioEntry(entry);

        return [
          token,
          {
            amount: normalizedEntry.amount,
            contractAddress:
              normalizedEntry.contractAddress ??
              tokenFlow.flow[token]?.contractAddress,
          },
        ];
      }),
    ) as Record<string, PortfolioTokenEntry>;

    const contractAddresses = Array.from(
      new Set(
        Object.values(portfolioEntries)
          .map((entry) => entry.contractAddress?.toLowerCase())
          .filter((address): address is string => Boolean(address)),
      ),
    );

    let priceMap: Record<string, number> = {};
    let ethPrice = 0;

    try {
      [priceMap, ethPrice] = await Promise.all([
        this.fetchCoinGeckoTokenPrices(contractAddresses),
        this.fetchEthereumUsdPrice(),
      ]);
    } catch (error) {
      this.logger.warn(
        'CoinGecko pricing failed, returning zero USD values',
        error instanceof Error ? error.stack : undefined,
      );
    }

    return Object.fromEntries(
      Object.entries(portfolioEntries).map(([token, entry]) => {
        const amount = Number(entry.amount);
        const normalizedContractAddress = entry.contractAddress?.toLowerCase();
        const price =
          token.toUpperCase() === 'ETH'
            ? ethPrice
            : normalizedContractAddress
              ? priceMap[normalizedContractAddress] ?? 0
              : 0;
        const usdValue = Number.isFinite(amount) ? amount * price : 0;

        return [
          token,
          {
            amount: entry.amount,
            usd: this.formatUsdValue(usdValue),
          },
        ];
      }),
    );
  }

  private async getStoredWalletData(
    address: string,
    walletAddress: string,
  ): Promise<WalletTransactionsResponse> {
    const cachedTransactions = await this.transactionRepo.find({
      where: {
        wallet_address: walletAddress,
      },
      order: {
        block_number: 'DESC',
      },
    });

    this.logger.log('Serving wallet data from DB');

    return {
      raw: {
        address,
        erc20_transfers: [],
        native_transactions: [],
      },
      normalized: cachedTransactions.map((transaction) =>
        this.mapEntityToNormalized(transaction),
      ),
    };
  }

  private formatHumanReadableBalance(net: bigint, decimals: number): string {
    if (net === 0n) {
      return '0';
    }

    const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
    const sign = net < 0n ? '-' : '';
    const absoluteNet = net < 0n ? -net : net;

    if (safeDecimals === 0) {
      return `${sign}${absoluteNet.toString()}`;
    }

    const divisor = 10n ** BigInt(safeDecimals);
    const wholePart = absoluteNet / divisor;
    const fractionalPart = absoluteNet % divisor;
    const fractionalString = fractionalPart
      .toString()
      .padStart(safeDecimals, '0')
      .slice(0, 8)
      .replace(/0+$/, '');

    if (!fractionalString) {
      return `${sign}${wholePart.toString()}`;
    }

    return `${sign}${wholePart.toString()}.${fractionalString}`;
  }

  private inferMissingSwapPrices(pricedTrades: PricedTrade[]): PricedTrade[] {
    const tradesByTimestamp = new Map<number, PricedTrade[]>();

    for (const trade of pricedTrades) {
      const tradesAtTimestamp = tradesByTimestamp.get(trade.timestamp) ?? [];
      tradesAtTimestamp.push(trade);
      tradesByTimestamp.set(trade.timestamp, tradesAtTimestamp);
    }

    for (const tradesAtTimestamp of tradesByTimestamp.values()) {
      if (tradesAtTimestamp.length !== 2) {
        continue;
      }

      const [firstTrade, secondTrade] = tradesAtTimestamp;

      if (firstTrade.type === secondTrade.type) {
        continue;
      }

      const missingTrades = tradesAtTimestamp.filter((trade) => trade.price === 0);

      if (missingTrades.length !== 1) {
        continue;
      }

      const knownTrade = tradesAtTimestamp.find((trade) => trade.price > 0);
      const missingTrade = missingTrades[0];

      if (!knownTrade) {
        continue;
      }

      const knownAmount = this.parsePositiveNumber(knownTrade.amount);
      const missingAmount = this.parsePositiveNumber(missingTrade.amount);

      if (knownAmount === null || missingAmount === null) {
        continue;
      }

      const knownUsdValue = knownAmount * knownTrade.price;
      const inferredPrice = knownUsdValue / missingAmount;

      if (!Number.isFinite(inferredPrice) || inferredPrice <= 0) {
        continue;
      }

      missingTrade.price = inferredPrice;
    }

    return pricedTrades;
  }

  private parsePositiveNumber(value: string): number | null {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return null;
    }

    return parsedValue;
  }

  private isValidTradePrice(price: number): boolean {
    return Number.isFinite(price) && price >= 0;
  }

  private roundDecimal(value: number, decimals = 12): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Number(value.toFixed(decimals));
  }

  private normalizePortfolioEntry(entry: unknown): PortfolioTokenEntry {
    if (typeof entry === 'string') {
      return {
        amount: entry,
      };
    }

    if (typeof entry === 'object' && entry !== null) {
      const portfolioEntry = entry as {
        amount?: unknown;
        contractAddress?: unknown;
      };

      return {
        amount:
          typeof portfolioEntry.amount === 'string' ? portfolioEntry.amount : '0',
        contractAddress:
          typeof portfolioEntry.contractAddress === 'string'
            ? portfolioEntry.contractAddress
            : undefined,
      };
    }

    return {
      amount: '0',
    };
  }

  private async fetchCoinGeckoTokenPrices(
    contractAddresses: string[],
  ): Promise<Record<string, number>> {
    if (contractAddresses.length === 0) {
      return {};
    }

    if (!this.coinGeckoApiKey) {
      this.logger.warn('COINGECKO_API_KEY is not configured');
      return {};
    }

    const response = await axios.get<CoinGeckoTokenPriceResponse>(
      `${COINGECKO_API_BASE_URL}/simple/token_price/ethereum`,
      {
        params: {
          contract_addresses: contractAddresses.join(','),
          vs_currencies: 'usd',
          x_cg_demo_api_key: this.coinGeckoApiKey,
        },
        timeout: 10000,
      },
    );

    return Object.fromEntries(
      Object.entries(response.data).map(([contractAddress, value]) => [
        contractAddress.toLowerCase(),
        typeof value.usd === 'number' ? value.usd : 0,
      ]),
    );
  }

  private async fetchEthereumUsdPrice(): Promise<number> {
    if (!this.coinGeckoApiKey) {
      this.logger.warn('COINGECKO_API_KEY is not configured');
      return 0;
    }

    const response = await axios.get<CoinGeckoEthPriceResponse>(
      `${COINGECKO_API_BASE_URL}/simple/price`,
      {
        params: {
          ids: 'ethereum',
          vs_currencies: 'usd',
          x_cg_demo_api_key: this.coinGeckoApiKey,
        },
        timeout: 10000,
      },
    );

    return typeof response.data.ethereum?.usd === 'number'
      ? response.data.ethereum.usd
      : 0;
  }

  private formatTradeDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year = date.getUTCFullYear();

    return `${day}-${month}-${year}`;
  }

  private static readonly COINGECKO_COIN_ID_MAP: Record<string, string> = {
    ETH: 'ethereum',
    BTC: 'bitcoin',
    USDT: 'tether',
  };

  private static readonly DEFILLAMA_NATIVE_TOKEN_MAP: Record<string, string> = {
    ETH: 'coingecko:ethereum',
    WETH: 'coingecko:weth',
    BTC: 'coingecko:bitcoin',
    WBTC: 'coingecko:wrapped-bitcoin',
    USDT: 'coingecko:tether',
    USDC: 'coingecko:usd-coin',
    DAI: 'coingecko:dai',
  };

  private async fetchHistoricalTradePrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    const defiLlamaPrice = await this.fetchDefiLlamaPrice(
      token,
      contractAddress,
      timestamp,
    );

    if (defiLlamaPrice > 0) {
      return defiLlamaPrice;
    }

    const coinGeckoPrice = await this.fetchCoinGeckoFallbackPrice(
      token,
      timestamp,
    );

    if (coinGeckoPrice > 0) {
      return coinGeckoPrice;
    }

    this.logger.warn(
      `No price found for ${token} at ${timestamp} from any source`,
    );

    return 0;
  }

  private async fetchDefiLlamaPrice(
    token: string,
    contractAddress: string | undefined,
    timestamp: number,
  ): Promise<number> {
    try {
      const coinKey = this.buildDefiLlamaCoinKey(token, contractAddress);

      if (!coinKey) {
        this.logger.debug(`Cannot build DeFi Llama key for ${token}`);
        return 0;
      }

      const url = `${DEFILLAMA_API_BASE_URL}/prices/historical/${timestamp}/${coinKey}`;
      this.logger.debug(`[DefiLlama] GET ${url}`);

      const response = await axios.get<DefiLlamaPriceResponse>(url, {
        timeout: 10000,
      });

      const coinData = response.data?.coins?.[coinKey];
      const price = coinData?.price;

      if (typeof price === 'number' && price > 0) {
        this.logger.debug(
          `[DefiLlama] ${token} @ ${timestamp} = $${price} (confidence: ${coinData.confidence})`,
        );
        return price;
      }

      this.logger.debug(
        `[DefiLlama] No price data for ${token} at ${timestamp}`,
      );

      return 0;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.warn(
          `[DefiLlama] HTTP ${error.response?.status ?? 'NO_RESPONSE'} for ${token} at ${timestamp}`,
        );
      } else {
        this.logger.warn(
          `[DefiLlama] Failed for ${token} at ${timestamp}`,
          error instanceof Error ? error.stack : undefined,
        );
      }

      return 0;
    }
  }

  private buildDefiLlamaCoinKey(
    token: string,
    contractAddress: string | undefined,
  ): string | null {
    const nativeKey =
      WalletService.DEFILLAMA_NATIVE_TOKEN_MAP[token.toUpperCase()];

    if (nativeKey) {
      return nativeKey;
    }

    if (contractAddress) {
      return `ethereum:${contractAddress.toLowerCase()}`;
    }

    return null;
  }

  private async fetchCoinGeckoFallbackPrice(
    token: string,
    timestamp: number,
  ): Promise<number> {
    const coinId = WalletService.COINGECKO_COIN_ID_MAP[token.toUpperCase()];

    if (!coinId || !this.coinGeckoApiKey) {
      return 0;
    }

    try {
      const date = this.formatTradeDate(timestamp);
      const response = await axios.get<CoinGeckoHistoricalPriceResponse>(
        `${COINGECKO_API_BASE_URL}/coins/${coinId}/history`,
        {
          params: {
            date,
            localization: false,
            x_cg_demo_api_key: this.coinGeckoApiKey,
          },
          timeout: 10000,
        },
      );

      return this.extractHistoricalUsdPrice(response.data);
    } catch {
      this.logger.warn(`[CoinGecko fallback] Failed for ${token}`);
      return 0;
    }
  }

  private extractHistoricalUsdPrice(
    response?: CoinGeckoHistoricalPriceResponse,
  ): number {
    return typeof response?.market_data?.current_price?.usd === 'number'
      ? response.market_data.current_price.usd
      : 0;
  }

  private formatUsdValue(value: number): string {
    if (!Number.isFinite(value)) {
      return '0';
    }

    const rounded = Math.round(value * 100) / 100;

    if (Object.is(rounded, -0) || rounded === 0) {
      return '0';
    }

    return rounded.toFixed(2).replace(/\.0+$|(?<=\.\d)0+$/, '');
  }

  private async getLatestStoredBlock(address: string): Promise<number | null> {
    const result = await this.transactionRepo
      .createQueryBuilder('transaction')
      .select('MAX(transaction.block_number)', 'latestBlock')
      .where('transaction.wallet_address = :address', { address })
      .getRawOne<{ latestBlock: string | null }>();

    if (!result?.latestBlock) {
      return null;
    }

    const latestBlock = Number(result.latestBlock);

    return Number.isFinite(latestBlock) ? latestBlock : null;
  }

  private filterNewTransactions<T extends { block_number: number | string }>(
    transactions: T[],
    latestBlock: number,
  ): T[] {
    return transactions.filter(
      (transaction) => this.toNumber(transaction.block_number) > latestBlock,
    );
  }

  private getHighestBlockNumber(
    erc20Transfers: MoralisErc20Transfer[],
    nativeTransactions: MoralisWalletHistoryItem[],
  ): number {
    let highestBlock = 0;

    for (const transfer of erc20Transfers) {
      highestBlock = Math.max(highestBlock, this.toNumber(transfer.block_number));
    }

    for (const transaction of nativeTransactions) {
      highestBlock = Math.max(
        highestBlock,
        this.toNumber(transaction.block_number),
      );
    }

    return highestBlock;
  }

  private async saveNormalizedTransactions(
    address: string,
    transactions: NormalizedTransaction[],
  ): Promise<void> {
    const transactionsToSave = transactions.filter(
      (
        transaction,
      ): transaction is NormalizedTransaction & { type: 'transfer' | 'swap' } =>
        transaction.type === 'transfer' || transaction.type === 'swap',
    );

    if (transactionsToSave.length === 0) {
      return;
    }

    try {
      await this.transactionRepo
        .createQueryBuilder()
        .insert()
        .into(TransactionEntity)
        .values(
          transactionsToSave.map((transaction) => ({
            wallet_address: address.toLowerCase(),
            transaction_hash: transaction.hash,
            block_number: transaction.block_number,
            timestamp: new Date(transaction.timestamp),
            from_address: transaction.from,
            to_address: transaction.to,
            type: transaction.type,
            inputs: transaction.inputs,
            outputs: transaction.outputs,
          })),
        )
        .orIgnore()
        .execute();
    } catch (error) {
      this.logger.error(
        `Failed to persist normalized transactions for wallet ${address}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException(
        'Failed to store normalized transactions.',
      );
    }
  }

  private mapEntityToNormalized(
    transaction: TransactionEntity,
  ): NormalizedTransaction {
    return {
      hash: transaction.transaction_hash,
      block_number: transaction.block_number,
      timestamp: transaction.timestamp.toISOString(),
      from: transaction.from_address,
      to: transaction.to_address,
      type: transaction.type,
      inputs: transaction.inputs,
      outputs: transaction.outputs,
    };
  }

  private buildTradesFromEntries(
    entries: NormalizedTokenAmount[],
    type: Trade['type'],
    timestamp: number,
  ): Trade[] {
    const trades: Trade[] = [];

    for (const entry of entries) {
      const trade = this.createTradeFromEntry(entry, type, timestamp);

      if (trade) {
        trades.push(trade);
      }
    }

    return trades;
  }

  private createTradeFromEntry(
    entry: NormalizedTokenAmount,
    type: Trade['type'],
    timestamp: number,
  ): Trade | null {
    if (!entry.token) {
      return null;
    }

    const rawAmount = this.parseBigInt(entry.amount);

    if (rawAmount === null || rawAmount === 0n) {
      return null;
    }

    return {
      token: entry.token,
      type,
      amount: this.normalizeTokenAmount(rawAmount, entry.decimals),
      decimals: entry.decimals,
      contractAddress: entry.contractAddress?.toLowerCase(),
      timestamp,
    };
  }

  private parseBigInt(value: string): bigint | null {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private normalizeTokenAmount(rawAmount: bigint, decimals?: number): string {
    const safeDecimals =
      typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0
        ? decimals
        : 18;

    const divisor = 10n ** BigInt(safeDecimals);
    const wholePart = rawAmount / divisor;
    const fractionalPart = rawAmount % divisor;

    if (fractionalPart === 0n) {
      return wholePart.toString();
    }

    const fractionalString = fractionalPart
      .toString()
      .padStart(safeDecimals, '0')
      .replace(/0+$/, '');

    return `${wholePart.toString()}.${fractionalString}`;
  }

  private toUnixTimestamp(timestamp: Date): number {
    return Math.floor(timestamp.getTime() / 1000);
  }

  private normalizeTransactions(
    address: string,
    erc20Transfers: MoralisErc20Transfer[],
    nativeTransactions: MoralisWalletHistoryItem[],
  ): NormalizedTransaction[] {
    const normalizedByHash = new Map<string, NormalizedTransaction>();
    const normalizedAddress = address.toLowerCase();

    for (const transaction of nativeTransactions) {
      const normalizedTransaction = this.getOrCreateNormalizedTransaction(
        normalizedByHash,
        transaction.hash,
        transaction.block_number,
        transaction.block_timestamp,
        transaction.from_address,
        transaction.to_address,
      );

      const nativeTransfers =
        transaction.native_transfers && transaction.native_transfers.length > 0
          ? transaction.native_transfers
          : transaction.value && this.isPositiveValue(transaction.value)
            ? [
                {
                  from_address: transaction.from_address,
                  to_address: transaction.to_address ?? '',
                  value: transaction.value,
                  token_symbol: 'ETH',
                },
              ]
            : [];

      for (const nativeTransfer of nativeTransfers) {
        const entry: NormalizedTokenAmount = {
          token: nativeTransfer.token_symbol ?? 'ETH',
          amount: String(nativeTransfer.value),
          decimals: 18,
        };

        this.addTransferEntry(
          normalizedTransaction,
          normalizedAddress,
          nativeTransfer.from_address,
          nativeTransfer.to_address,
          entry,
          nativeTransfer.direction,
        );
      }
    }

    for (const transfer of erc20Transfers) {
      const normalizedTransaction = this.getOrCreateNormalizedTransaction(
        normalizedByHash,
        transfer.transaction_hash,
        transfer.block_number,
        transfer.block_timestamp,
        transfer.from_address,
        transfer.to_address,
      );

      this.addTransferEntry(
        normalizedTransaction,
        normalizedAddress,
        transfer.from_address,
        transfer.to_address,
        {
          token: transfer.token_symbol ?? '',
          amount: String(transfer.value),
          decimals:
            transfer.token_decimals !== undefined
              ? this.toNumber(transfer.token_decimals)
              : undefined,
          contractAddress: transfer.address?.toLowerCase(),
        },
      );
    }

    return Array.from(normalizedByHash.values())
      .map((transaction) => {
        const inputs = mergeTokenAmounts(transaction.inputs);
        const outputs = mergeTokenAmounts(transaction.outputs);

        return {
          ...transaction,
          inputs,
          outputs,
          type: this.getTransactionType({
            ...transaction,
            inputs,
            outputs,
          }),
        };
      })
      .sort((left, right) => right.block_number - left.block_number);
  }

  private getOrCreateNormalizedTransaction(
    transactions: Map<string, NormalizedTransaction>,
    hash: string,
    blockNumber: number | string,
    timestamp: string,
    from: string,
    to?: string,
  ): NormalizedTransaction {
    const existingTransaction = transactions.get(hash);

    if (existingTransaction) {
      if (!existingTransaction.from && from) {
        existingTransaction.from = from;
      }

      if (!existingTransaction.to && to) {
        existingTransaction.to = to;
      }

      if (!existingTransaction.timestamp && timestamp) {
        existingTransaction.timestamp = timestamp;
      }

      if (existingTransaction.block_number === 0) {
        existingTransaction.block_number = this.toNumber(blockNumber);
      }

      return existingTransaction;
    }

    const createdTransaction: NormalizedTransaction = {
      hash,
      block_number: this.toNumber(blockNumber),
      timestamp,
      from,
      to: to ?? '',
      type: 'unknown',
      inputs: [],
      outputs: [],
    };

    transactions.set(hash, createdTransaction);
    return createdTransaction;
  }

  private addTransferEntry(
    transaction: NormalizedTransaction,
    walletAddress: string,
    fromAddress: string,
    toAddress: string,
    entry: NormalizedTokenAmount,
    direction?: string,
  ): void {
    if (!entry.token) {
      return;
    }

    const normalizedFrom = fromAddress?.toLowerCase();
    const normalizedTo = toAddress?.toLowerCase();

    if (direction === 'outgoing' || normalizedFrom === walletAddress) {
      transaction.inputs.push(entry);
      return;
    }

    if (direction === 'incoming' || normalizedTo === walletAddress) {
      transaction.outputs.push(entry);
      return;
    }

    return;
  }

  private getTransactionType(
    transaction: NormalizedTransaction,
  ): NormalizedTransaction['type'] {
    const inputTokens = new Set(transaction.inputs.map((entry) => entry.token));
    const outputTokens = new Set(
      transaction.outputs.map((entry) => entry.token),
    );

    const hasInputs = transaction.inputs.length > 0;
    const hasOutputs = transaction.outputs.length > 0;

    if (hasInputs && hasOutputs) {
      const isSameToken =
        inputTokens.size === 1 &&
        outputTokens.size === 1 &&
        [...inputTokens][0] === [...outputTokens][0];

      if (isSameToken) {
        return 'transfer';
      }

      return 'swap';
    }

    if (hasInputs || hasOutputs) {
      return 'transfer';
    }

    return 'unknown';
  }

  private isPositiveValue(value: string): boolean {
    try {
      return BigInt(value) > 0n;
    } catch {
      return false;
    }
  }

  private toNumber(value: number | string): number {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async fetchErc20Transfers(
    address: string,
    options?: MoralisFetchOptions,
  ): Promise<MoralisErc20Transfer[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisErc20Transfer>(
      `/${address}/erc20/transfers`,
      'ERC-20 transfers',
      options,
    );
  }

  private async fetchWalletHistory(
    address: string,
    options?: MoralisFetchOptions,
  ): Promise<MoralisWalletHistoryItem[]> {
    return this.fetchPaginatedMoralisEndpoint<MoralisWalletHistoryItem>(
      `/wallets/${address}/history`,
      'wallet history',
      options,
    );
  }

  private async fetchPaginatedMoralisEndpoint<
    T extends { block_number: number | string },
  >(
    path: string,
    operation: string,
    options?: MoralisFetchOptions,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    let shouldContinue = true;

    do {
      try {
        const response = await this.callMoralisWithRetry(() =>
          this.moralisClient.get<MoralisPaginatedResponse<T>>(path, {
            params: {
              chain: 'eth',
              order: 'DESC',
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
          }),
        );

        const filteredResult = this.applyStopAtBlock(
          response.data.result,
          options?.stopAtBlock,
        );

        items.push(...filteredResult.items);

        shouldContinue =
          !options?.firstPageOnly &&
          Boolean(response.data.cursor) &&
          !filteredResult.reachedStoredBlock;

        cursor = shouldContinue ? response.data.cursor ?? undefined : undefined;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = this.extractMoralisMessage(error);

          this.logger.warn(
            `Moralis failed for ${operation}, continuing with fallback (${status ?? 'NO_RESPONSE'}: ${message})`,
          );
        } else {
          this.logger.warn(
            `Moralis failed for ${operation}, continuing with fallback`,
          );
        }

        if (items.length === 0) {
          throw error;
        }

        break;
      }
    } while (cursor && shouldContinue);

    return items;
  }

  private async callMoralisWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger.warn('Moralis failed, retrying once...');

      await new Promise((resolve) => setTimeout(resolve, 500));

      return fn();
    }
  }

  private applyStopAtBlock<T extends { block_number: number | string }>(
    items: T[],
    stopAtBlock?: number,
  ): { items: T[]; reachedStoredBlock: boolean } {
    if (stopAtBlock === undefined) {
      return {
        items,
        reachedStoredBlock: false,
      };
    }

    const filteredItems: T[] = [];

    for (const item of items) {
      if (this.toNumber(item.block_number) <= stopAtBlock) {
        return {
          items: filteredItems,
          reachedStoredBlock: true,
        };
      }

      filteredItems.push(item);
    }

    return {
      items: filteredItems,
      reachedStoredBlock: false,
    };
  }

  private isNativeTransaction(transaction: MoralisWalletHistoryItem): boolean {
    if (
      Array.isArray(transaction.native_transfers) &&
      transaction.native_transfers.length > 0
    ) {
      return true;
    }

    if (transaction.value === undefined) {
      return false;
    }

    return this.isPositiveValue(transaction.value);
  }

  private extractMoralisMessage(error: AxiosError): string {
    const data = error.response?.data;

    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'object' && data !== null && 'message' in data) {
      const message = (data as { message?: unknown }).message;

      if (typeof message === 'string') {
        return message;
      }
    }

    return error.message;
  }
}