export interface WhitelistEntry {
  address: string;
  plan: 'starter' | 'pro';
  note: string;
}

export const WHITELISTED_WALLETS: WhitelistEntry[] = [
  {
    address: '0x3438B9aDb17750869D9cA4E5272Da701aB19e610',
    plan: 'pro',
    note: 'owner',
  },
  // Add paying customers below as they come in:
  // {
  //   address: '0xFounderWalletAddress',
  //   plan: 'starter',
  //   note: 'PEPE project - paid $99 - May 2026',
  // },
];
