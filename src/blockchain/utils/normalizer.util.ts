import { BlockchainNetwork, BlockchainProvider, NormalizedTokenTransfer, NormalizedTransaction } from '../interfaces/transaction.interface';

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

function asRecord(value: unknown): UnknownRecord | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as UnknownRecord;
  }

  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeTransferRecord(payload: UnknownRecord): NormalizedTokenTransfer {
  return {
    fromAddress:
      asString(payload.fromUserAccount) ??
      asString(payload.from) ??
      asString(payload.sender) ??
      'unknown',
    toAddress:
      asString(payload.toUserAccount) ??
      asString(payload.to) ??
      asString(payload.recipient) ??
      'unknown',
    assetSymbol:
      asString(payload.asset) ??
      asString(payload.symbol) ??
      asString(payload.mint),
    amount:
      asString(payload.tokenAmount) ??
      asString(payload.amount) ??
      asString(payload.value),
    raw: payload,
  };
}

function extractTokenTransfers(payload: UnknownRecord): NormalizedTokenTransfer[] {
  const tokenTransfers = asArray(payload.tokenTransfers)
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((item) => normalizeTransferRecord(item));

  if (tokenTransfers.length > 0) {
    return tokenTransfers;
  }

  const nativeTransfers = asArray(payload.nativeTransfers)
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((item) => normalizeTransferRecord(item));

  if (nativeTransfers.length > 0) {
    return nativeTransfers;
  }

  const fallbackTransfer = normalizeTransferRecord(payload);
  const hasTransferData =
    fallbackTransfer.fromAddress !== 'unknown' ||
    fallbackTransfer.toAddress !== 'unknown' ||
    fallbackTransfer.amount !== undefined ||
    fallbackTransfer.assetSymbol !== undefined;

  return hasTransferData ? [fallbackTransfer] : [];
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
    tokenTransfers: extractTokenTransfers(payload),
    raw: payload,
  };
}
