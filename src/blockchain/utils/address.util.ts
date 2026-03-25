import { isAddress } from 'ethers';
import { BlockchainNetwork } from '../interfaces/transaction.interface';

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectBlockchainNetwork(address: string): BlockchainNetwork {
  if (isAddress(address)) {
    return 'evm';
  }

  if (SOLANA_ADDRESS_REGEX.test(address)) {
    return 'solana';
  }

  throw new Error(`Unsupported wallet address format: ${address}`);
}

export function isEvmAddress(address: string): boolean {
  return isAddress(address);
}

export function isSolanaAddress(address: string): boolean {
  return SOLANA_ADDRESS_REGEX.test(address);
}
