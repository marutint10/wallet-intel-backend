import type { HolderLabel } from './token-intelligence.service';

export type HolderBucket = 'retail' | 'exchange' | 'contract' | 'team' | 'burn' | 'lp';

export interface HolderForBucket {
  walletLabel: HolderLabel;
  isTeamLinked?: boolean;
}

export type HolderWithBucket<T extends HolderForBucket> = T & { bucket: HolderBucket };

const EMPTY_SUPPLY_BREAKDOWN: Record<
  HolderBucket,
  { count: number; pctOfSupply: number }
> = {
  retail: { count: 0, pctOfSupply: 0 },
  exchange: { count: 0, pctOfSupply: 0 },
  contract: { count: 0, pctOfSupply: 0 },
  team: { count: 0, pctOfSupply: 0 },
  burn: { count: 0, pctOfSupply: 0 },
  lp: { count: 0, pctOfSupply: 0 },
};

export function emptySupplyBreakdown(): typeof EMPTY_SUPPLY_BREAKDOWN {
  return {
    retail: { count: 0, pctOfSupply: 0 },
    exchange: { count: 0, pctOfSupply: 0 },
    contract: { count: 0, pctOfSupply: 0 },
    team: { count: 0, pctOfSupply: 0 },
    burn: { count: 0, pctOfSupply: 0 },
    lp: { count: 0, pctOfSupply: 0 },
  };
}

export function bucketHolder(holder: {
  walletLabel: HolderLabel;
  isTeamLinked?: boolean;
}): HolderBucket {
  if (holder.isTeamLinked) {
    return 'team';
  }

  const label = holder.walletLabel;

  if (label === 'burn') {
    return 'burn';
  }

  if (label === 'exchange' || label === 'cex_deposit') {
    return 'exchange';
  }

  if (label === 'dex_pool') {
    return 'lp';
  }

  if (
    label === 'treasury' ||
    label === 'vesting' ||
    label === 'deployer' ||
    label === 'owner' ||
    label === 'team_connected'
  ) {
    return 'team';
  }

  if (
    label === 'generic_contract' ||
    label === 'dex_router' ||
    label === 'bridge' ||
    label === 'staking' ||
    label === 'dust'
  ) {
    return 'contract';
  }

  if (label === 'eoa') {
    return 'retail';
  }

  return 'contract';
}

export function attachBucket<T extends HolderForBucket>(holder: T): HolderWithBucket<T> {
  return {
    ...holder,
    bucket: bucketHolder(holder),
  };
}

export function isRetailHolder(holder: HolderForBucket): boolean {
  return bucketHolder(holder) === 'retail';
}
