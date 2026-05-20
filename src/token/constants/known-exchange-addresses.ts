/**
 * Canonical lowercase exchange address registry for token holder triage.
 * Used by TokenIntelligenceService (production path) and WalletFilterService.
 */
export const KNOWN_EXCHANGE_ADDRESSES = new Map<string, string>([
  ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance Hot Wallet'],
  ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance'],
  ['0xdfd5293d8e347dfe59e90efd55b2956a1343963d', 'Binance Cold Wallet 2'],
  ['0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', 'Binance 7'],
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance (old)'],
  ['0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503', 'Binance (large)'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 'Binance 8'],
  ['0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', 'Coinbase'],
  ['0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase 2'],
  ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase 3'],
  ['0x5a52e96bacdabb82fd05763e25335261b270efcb', 'OKX'],
  ['0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', 'OKX'],
  ['0x1884c178a6542f288ebc8780d04c72514284fb84', 'OKX 2'],
  ['0x611f7bf868a6212f871e89f7e44684045ddfb09d', 'OKX Cold Wallet'],
  ['0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2', 'FTX (defunct)'],
  ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken'],
  ['0xae2d4617c862309a3d75a0ffb358c7a5009c673f', 'Kraken 2'],
  ['0x974caa59e49682cda0ad2bbe82983419a2ecc400', 'Bitfinex'],
  ['0x77134cbc06cb00b44f64f51ba68d10b0811c72f5', 'Bitfinex'],
  ['0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', 'Gate.io'],
  ['0x0d0707963952f2fba59dd06f2b425ace40b492fe', 'Gate.io 2'],
  ['0x56eddb7aa87536c09ccc2793473599fd21a8b17f', 'Bybit'],
  ['0xf89d7b9c864f589bbf53a82105107622b35eaa40', 'Bybit 2'],
  ['0x46340b20830761efd32832a74d7169b29feb9758', 'Crypto.com'],
  ['0x6262998ced04146fa42253a5c0af90ca02dfd2a3', 'Crypto.com 2'],
  ['0xab5c66752a9e8167967685f1450532fb96d5d24f', 'Huobi'],
  ['0x0548f59fee79f8832c299e01dca5c76f034f558e', 'KuCoin'],
  ['0xd6216fc19db775df9774a6e33526131da7d19a2c', 'KuCoin 2'],
]);

export function lookupKnownExchange(address: string): string | undefined {
  return KNOWN_EXCHANGE_ADDRESSES.get(address.trim().toLowerCase());
}

export function isKnownExchangeAddress(address: string): boolean {
  return lookupKnownExchange(address) !== undefined;
}
