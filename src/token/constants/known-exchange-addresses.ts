/**
 * Canonical lowercase exchange address registry for token holder triage.
 * Used by TokenIntelligenceService (production path) and WalletFilterService.
 *
 * Last updated: May 2026
 * Sources: internal curation + observed top-holder lists across major ERC-20 tokens.
 *
 * KNOWN CONFLICTS (flagged for manual review):
 *  - 0x5a52e96bacdabb82fd05763e25335261b270efcb:
 *      new holder list labels this "Binance" but existing registry had it as "OKX".
 *      Kept as OKX — verify on-chain before changing.
 *  - 0x9b0c45d46d386cedd98873168c36efd0dcba8d46:
 *      appears in holder list as both "Revolt" and "Bitget" for the same address.
 *      Labelled "Revolut" here — treat as unconfirmed.
 *  - 0xd048b2711fe36fba1092fc661e0bf03f219d3e51:
 *      appears in holder list as both "MaskEx" and "Binance".
 *      Labelled "MaskEx" here — treat as unconfirmed.
 */
export const KNOWN_EXCHANGE_ADDRESSES = new Map<string, string>([

  // ── Binance ──────────────────────────────────────────────────────────────
  ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance'],
  ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance 2'],
  ['0xdfd5293d8e347dfe59e90efd55b2956a1343963d', 'Binance Cold Wallet'],
  ['0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', 'Binance 4'],
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance 5'],
  ['0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503', 'Binance 6'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 'Binance 7'],
  ['0x43684d03d81d3a4c70da68febdd61029d426f042', 'Binance 8'],
  ['0x835678a611b28684005a5e2233695fb6cbbb0007', 'Binance 9'],
  ['0x98adef6f2ac8572ec48965509d69a8dd5e8bba9d', 'Binance 10'],
  ['0x4fdfe365436b5273a42f135c6a6244a20404271e', 'Binance 11'],
  ['0xf60c2ea62edbfe808163751dd0d8693dcb30019c', 'Binance 12'],

  // ── Coinbase ─────────────────────────────────────────────────────────────
  ['0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', 'Coinbase'],
  ['0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase 2'],
  ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase 3'],
  ['0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', 'Coinbase 4'],
  ['0x3cd751e6b0078be393132286c442345e5dc49699', 'Coinbase 5'],
  ['0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', 'Coinbase 6'],  // cold wallet
  ['0xeb2629a2734e272bcc07bda959863f316f4bd4cf', 'Coinbase 7'],

  // ── OKX ──────────────────────────────────────────────────────────────────
  ['0x5a52e96bacdabb82fd05763e25335261b270efcb', 'OKX'],           // ⚠ conflict: see header
  ['0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', 'OKX 2'],
  ['0x1884c178a6542f288ebc8780d04c72514284fb84', 'OKX 3'],
  ['0x611f7bf868a6212f871e89f7e44684045ddfb09d', 'OKX Cold Wallet'],
  ['0x91d40e4818f4d4c57b4578d9eca6afc92ac8debe', 'OKX 5'],
  ['0xb0a27099582833c0cb8c7a0565759ff145113d64', 'OKX 6'],
  ['0x85dcd76d4fbd3aa0c85c27b9441222c19a14134b', 'OKX 7'],
  ['0x4a4aaa0155237881fbd5c34bfae16e985a7b068d', 'OKX 8'],

  // ── Kraken ───────────────────────────────────────────────────────────────
  ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken'],
  ['0xae2d4617c862309a3d75a0ffb358c7a5009c673f', 'Kraken 2'],
  ['0xd2dd7b597fd2435b6db61ddf48544fd931e6869f', 'Kraken 3'],
  ['0x7dafba1d69f6c01ae7567ffd7b046ca03b706f83', 'Kraken 4'],
  ['0xcc282e2004428939ee5149a9e7872f0b4d5d5ec7', 'Kraken 5'],
  ['0x2910543af39aba0cd09dbb2d50200b3e800a63d2', 'Kraken 6'],
  ['0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13', 'Kraken 7'],

  // ── Bybit ────────────────────────────────────────────────────────────────
  ['0x56eddb7aa87536c09ccc2793473599fd21a8b17f', 'Bybit'],
  ['0xf89d7b9c864f589bbf53a82105107622b35eaa40', 'Bybit 2'],
  ['0xc93e48d89f2d6dbc1672908aa68ce7c24d0413b4', 'Bybit 3'],

  // ── Crypto.com ───────────────────────────────────────────────────────────
  ['0x46340b20830761efd32832a74d7169b29feb9758', 'Crypto.com'],
  ['0x6262998ced04146fa42253a5c0af90ca02dfd2a3', 'Crypto.com 2'],
  ['0xa023f08c70a23abc7edfc5b6b5e171d78dfc947e', 'Crypto.com 3'],
  ['0xcffad3200574698b78f32232aa9d63eabd290703', 'Crypto.com 4'],
  ['0x5b71d5fd6bb118665582dd87922bf3b9de6c75f9', 'Crypto.com 5'],
  ['0x24eb3a39856723138796c5068a17ba4fb15cd25e', 'Crypto.com 6'],

  // ── KuCoin ───────────────────────────────────────────────────────────────
  ['0x0548f59fee79f8832c299e01dca5c76f034f558e', 'KuCoin'],
  ['0xd6216fc19db775df9774a6e33526131da7d19a2c', 'KuCoin 2'],
  ['0x6d6cc65e2060d0a280fcd47b6c22ec5636797fec', 'KuCoin 3'],
  ['0x8dac80ce96f69f9762bc450faa4d7fbd5891ae18', 'KuCoin 4'],
  ['0x446b86a33e2a438f569b15855189e3da28d027ba', 'KuCoin 5'],
  ['0xdd276dc5223d0120f9bf1776f38957cc8da23cb0', 'KuCoin 6'],

  // ── Gate.io ──────────────────────────────────────────────────────────────
  ['0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', 'Gate.io'],
  ['0x0d0707963952f2fba59dd06f2b425ace40b492fe', 'Gate.io 2'],
  ['0xc882b111a75c0c657fc507c04fbfcd2cc984f071', 'Gate.io 3'],

  // ── Bitget ───────────────────────────────────────────────────────────────
  ['0x5bdf85216ec1e38d6458c870992a69e38e03f7ef', 'Bitget'],
  ['0xffa8db7b38579e6a2d14f9b347a9ace4d044cd54', 'Bitget 2'],

  // ── Bitstamp ─────────────────────────────────────────────────────────────
  ['0x4a2d57d669f2194fa7b5df619cba9f33ccea26bd', 'Bitstamp'],
  ['0xb66410ae75317faf13dba869b6df7b30892d1e46', 'Bitstamp 2'],
  ['0x7f604d597c15b2e2f60dc645844f68b1d781b752', 'Bitstamp 3'],

  // ── Bitfinex ─────────────────────────────────────────────────────────────
  ['0x974caa59e49682cda0ad2bbe82983419a2ecc400', 'Bitfinex'],
  ['0x77134cbc06cb00b44f64f51ba68d10b0811c72f5', 'Bitfinex 2'],
  ['0x742d35cc6634c0532925a3b844bc454e4438f44e', 'Bitfinex 3'],  // listed as "bitfenix" — likely typo
  ['0x1151314c646ce4e0efd76d1af4760ae66a9fe30f', 'Bitfinex 4'],  // cold wallet
  ['0x876eabf441b2ee5b5b0554fd502a8e0600950cfa', 'Bitfinex 5'],

  // ── Huobi / HTX ──────────────────────────────────────────────────────────
  ['0xab5c66752a9e8167967685f1450532fb96d5d24f', 'HTX (Huobi)'],
  ['0x18709e89bd403f470088abdacebe86cc60dda12e', 'HTX (Huobi) 2'],
  ['0x4fb312915b779b1339388e14b6d079741ca83128', 'HTX 3'],
  ['0xeee28d484628d41a82d01e21d12e2e78d69920da', 'HTX 4'],           // formerly Huobi 10
  ['0xfa4b5be3f2f84f56703c42eb22142744e95a2c58', 'HTX 5'],           // formerly Huobi 13
  ['0x6f48110d4ade4f4b5bcd58a9a31a5e85bb6cccbe', 'HTX 6'],

  // ── MEXC ─────────────────────────────────────────────────────────────────
  ['0x3cc936b795a188f0e246cbb2d74c5bd190aecf18', 'MEXC'],
  ['0x9642b23ed1e01df1092b92641051881a322f5d4e', 'MEXC 2'],
  ['0x576b81F0c21EDBc920ad63FeEEB2b0736b018A58', 'MEXC 3'],
  ['0x51E3D44172868Acc60D68ca99591Ce4230bc75E0', 'MEXC 4'],

  // ── Bithumb ──────────────────────────────────────────────────────────────
  ['0xc671b05671a7cd3080c6ceae79d284bdde0ef271', 'Bithumb'],
  ['0x96b1392f2e9e6849b8598d51f0861ade4fda2885', 'Bithumb 2'],

  // ── Bitso ────────────────────────────────────────────────────────────────
  ['0xe3ecd65cf2ad2eba2aa2be1d0894753b2172abd1', 'Bitso'],
  ['0xa01aa2196724a39290f465b3925e5dcafe7f2256', 'Bitso 2'],

  // ── Bitpanda ─────────────────────────────────────────────────────────────
  ['0xf197c6f2ac14d25ee2789a73e4847732c7f16bc9', 'Bitpanda'],
  ['0x0529ea5885702715e83923c59746ae8734c553b7', 'Bitpanda 2'],

  // ── CoinSpot ─────────────────────────────────────────────────────────────
  ['0xf35a6bd6e0459a4b53a27862c51a2a7292b383d1', 'CoinSpot'],
  ['0x916ed5586bb328e0ec1a428af060dc3d10919d84', 'CoinSpot 2'],
  ['0x19184ab45c40c2920b0e0e31413b9434abd243ed', 'CoinSpot 3'],

  // ── Coinhako ─────────────────────────────────────────────────────────────
  ['0xf4e6deea1b4da85c2d68db8d771d37ec1148b853', 'Coinhako'],
  ['0xe66baa0b612003af308d78f066bbdb9a5e00ff6c', 'Coinhako 2'],

  // ── Robinhood ────────────────────────────────────────────────────────────
  ['0x40b38765696e3d5d8d9d834d8aad4bb6e418e489', 'Robinhood'],
  ['0x841ed663f2636863d40be4ee76243377dff13a34', 'Robinhood 2'],
  ['0x1887fa9edadeab7562b01cc3f4fa246ace2c3cdd', 'Robinhood 3'],
  ['0x1d48963DD8FAdA6aB5C2C7b92Eba81ECC5030270', 'Robinhood 4'],

  // ── eToro ────────────────────────────────────────────────────────────────
  ['0x77fb357f55bef5a70d30663955f8c9f35794df0e', 'eToro'],         // listed as "eterro" — likely typo
  ['0x434587332cc35d33db75b93f4f27cc496c67a4db', 'eToro 2'],

  // ── Gemini ───────────────────────────────────────────────────────────────
  ['0xafcd96e580138cfa2332c632e66308eacd45c5da', 'Gemini'],
  ['0xd24400ae8bfebb18ca49be86258a3c749cf46853', 'Gemini'],  // main hot wallet (documented)
  ['0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8', 'Gemini 2'],
  ['0x61edcdf5bb737adffe5043706e7c5bb1f1a56eea', 'Gemini 3'],

  // ── Poloniex ─────────────────────────────────────────────────────────────
  ['0x32be343b94f860124dc4fee278fdcbd38c102d88', 'Poloniex'],
  ['0x209c4784ab1e8183cf58ca33cb740efbf3fc18ef', 'Poloniex 2'],

  // ── Bittrex ──────────────────────────────────────────────────────────────
  ['0xfbb1b73c4f0bda4f67dca266ce6ef42f520fbb98', 'Bittrex'],

  // ── Nexo ─────────────────────────────────────────────────────────────────
  ['0x8b3d70d628ebd30d4a2ea82db95ba2e906c71633', 'Nexo'],

  // ── OKCoin ───────────────────────────────────────────────────────────────
  ['0xf1954d0291e2b91fb7d3da54d73b65fae5e0bb0a', 'OKCoin'],

  // ── Coincheck ──────────────────────────────────────────────────────────
  ['0x26f1457f067bf26881f311833391b52ca871a4b5', 'Coincheck'],

  // ── Upbit ────────────────────────────────────────────────────────────────
  ['0x377b8ce04761754e8ac153b47805a9cf6b190873', 'Upbit'],

  // ── BingX ────────────────────────────────────────────────────────────────
  ['0x0b07f64abc342b68aec57c0936e4b6fd4452967e', 'BingX'],

  // ── LBank ────────────────────────────────────────────────────────────────
  ['0x120051a72966950b8ce12eb5496b5d1eeec1541b', 'LBank'],

  // ── CoinOne ──────────────────────────────────────────────────────────────
  ['0x167a9333bf582556f35bd4d16a7e80e191aa6476', 'CoinOne'],

  // ── Korbit ───────────────────────────────────────────────────────────────
  ['0xf0bc8fddb1f358cef470d63f96ae65b1d7914953', 'Korbit'],

  // ── CoinEx ───────────────────────────────────────────────────────────────
  ['0x548054687ef6c56c6d82e8269e5fd93d8b88fcb2', 'CoinEx'],

  // ── BitFlyer ─────────────────────────────────────────────────────────────
  ['0x111cff45948819988857bbf1966a0399e0d1141e', 'BitFlyer'],

  // ── Paribu ───────────────────────────────────────────────────────────────
  ['0xc3681709ee476308b45812eabe0eb22f3b816880', 'Paribu'],

  // ── BtcTurk ──────────────────────────────────────────────────────────────
  ['0x76ec5a0d3632b2133d9f1980903305b62678fbd3', 'BtcTurk'],

  // ── Mercado Bitcoin ──────────────────────────────────────────────────────
  ['0xb8ba36e591facee901ffd3d5d82df491551ad7ef', 'Mercado Bitcoin'],

  // ── Paxos ────────────────────────────────────────────────────────────────
  ['0x2fb074fa59c9294c71246825c1c9a0c7782d41a4', 'Paxos'],

  // ── CoinDCX ──────────────────────────────────────────────────────────────
  ['0x8c7efd5b04331efc618e8006f19019a3dc88973e', 'CoinDCX'],

  // ── Revolut ──────────────────────────────────────────────────────────────
  ['0x9b0c45d46d386cedd98873168c36efd0dcba8d46', 'Revolut'],      // ⚠ conflict: see header
  ['0xb23360ccdd9ed1b15d45e5d3824bb409c8d7c460', 'Revolut 2'],

  // ── MaskEx ───────────────────────────────────────────────────────────────
  ['0xd048b2711fe36fba1092fc661e0bf03f219d3e51', 'MaskEx'],       // ⚠ conflict: see header

  // ── SEBA Custody ─────────────────────────────────────────────────────────
  ['0xd3a22590f8243f8e83ac230d1842c9af0404c4a1', 'SEBA Custody'], // listed as "sefu custody" — likely typo

  // ── FTX (defunct) ────────────────────────────────────────────────────────
  ['0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2', 'FTX (defunct)'],
]);

// ─── Lookup Helpers ──────────────────────────────────────────────────────────

export function lookupKnownExchange(address: string): string | undefined {
  return KNOWN_EXCHANGE_ADDRESSES.get(address.trim().toLowerCase());
}

export function isKnownExchangeAddress(address: string): boolean {
  return lookupKnownExchange(address) !== undefined;
}

/**
 * Returns the exchange name and a normalized group label for UI grouping.
 * e.g. "Binance 7" → { name: "Binance 7", group: "Binance" }
 */
export function resolveExchangeLabel(address: string): {
  name: string;
  group: string;
} | undefined {
  const name = lookupKnownExchange(address);
  if (!name) return undefined;
  // Strip trailing numeric suffix to get the group name
  const group = name.replace(/\s+\d+$/, '').replace(' (defunct)', '').replace(' Cold Wallet', '').trim();
  return { name, group };
}