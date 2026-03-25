import { BlockchainNetwork, BlockchainProvider, NormalizedTransaction } from '../interfaces/transaction.interface';

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
}

export function normalizeTransaction(
  provider: BlockchainProvider,
  network: BlockchainNetwork,
  payload: UnknownRecord,
): NormalizedTransaction {
  const txHash =
    asString(payload.hash) ??
    asString(payload.signature) ??
    asString(payload.transactionHash) ??
    'unknown';

  const fromAddress =
    asString(payload.from) ??
    asString(payload.sender) ??
    asString(payload.source) ??
    'unknown';

  const toAddress =
    asString(payload.to) ??
    asString(payload.recipient) ??
    asString(payload.destination) ??
    'unknown';

  return {
    provider,
    network,
    txHash,
    blockNumber: asString(payload.blockNumber) ?? asString(payload.slot),
    timestamp: asDate(payload.blockTimestamp) ?? asDate(payload.timestamp),
    fromAddress,
    toAddress,
    assetSymbol: asString(payload.asset) ?? asString(payload.symbol),
    amount: asString(payload.value) ?? asString(payload.amount),
    raw: payload,
  };
}
