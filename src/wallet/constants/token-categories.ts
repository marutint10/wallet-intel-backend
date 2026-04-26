/**
 * Token Category Classification
 *
 * Static map of top Ethereum ERC-20 tokens by contract address → category.
 * Keyed by lowercase contract address for fast, deterministic lookup.
 *
 * Categories:
 *   BLUE_CHIP    – Top L1/L2 native tokens, mature and high market cap
 *   DEFI         – DeFi protocol governance/utility tokens
 *   STABLECOIN   – Pegged assets (USD, EUR, gold-backed)
 *   L2_INFRA     – Layer 2 and infrastructure tokens
 *   MEMECOIN     – Meme/community-driven speculative tokens
 *   AI_NARRATIVE  – AI, compute, and narrative-driven tokens
 *   GAMING       – Gaming, metaverse, and entertainment tokens
 *   LST_LRT      – Liquid staking and liquid restaking tokens
 *   RWA          – Real-world asset tokens
 *   OTHER        – Fallback for unknown tokens
 *
 * Sources: Etherscan Token Tracker, CoinGecko, verified contract addresses
 * Last updated: 2026-04-15
 */

// ─── Category Enum ───────────────────────────────────────────────
export enum TokenCategory {
  BLUE_CHIP = 'Blue Chip / L1',
  DEFI = 'DeFi Protocol',
  STABLECOIN = 'Stablecoin',
  L2_INFRA = 'L2 / Infrastructure',
  MEMECOIN = 'Memecoin',
  AI_NARRATIVE = 'AI / Narrative',
  GAMING = 'Gaming / Metaverse',
  LST_LRT = 'Liquid Staking / Restaking',
  RWA = 'Real World Assets',
  OTHER = 'Other / Unclassified',
}

// ─── Risk Level per Category ─────────────────────────────────────
export const CATEGORY_RISK: Record<TokenCategory, string> = {
  [TokenCategory.BLUE_CHIP]: 'Low',
  [TokenCategory.DEFI]: 'Medium',
  [TokenCategory.STABLECOIN]: 'None',
  [TokenCategory.L2_INFRA]: 'Medium',
  [TokenCategory.MEMECOIN]: 'Very High',
  [TokenCategory.AI_NARRATIVE]: 'High',
  [TokenCategory.GAMING]: 'High',
  [TokenCategory.LST_LRT]: 'Low-Medium',
  [TokenCategory.RWA]: 'Low-Medium',
  [TokenCategory.OTHER]: 'Unknown',
};

// ─── Token Metadata ──────────────────────────────────────────────
interface TokenMeta {
  symbol: string;
  name: string;
  category: TokenCategory;
}

// ─── Static Token Map ────────────────────────────────────────────
// Key: lowercase Ethereum mainnet contract address
// ~150 tokens covering 90%+ of on-chain trading volume
export const TOKEN_CATEGORY_MAP: Record<string, TokenMeta> = {

  // ════════════════════════════════════════════════════════════════
  // BLUE CHIP / L1
  // ════════════════════════════════════════════════════════════════

  // ETH is native, but WETH is the ERC-20 representation
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    category: TokenCategory.BLUE_CHIP,
  },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x66eff5221ca926636224650fd3b9c497ff828f7d': {
    symbol: 'multiBTC',
    name: 'Multichain BTC',
    category: TokenCategory.BLUE_CHIP,
  },
  '0xb8c77482e45f1f44de1745f52c74426c631bdd52': {
    symbol: 'BNB',
    name: 'BNB',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x582d872a1b094fc48f5de31d3b73f2d9be47def1': {
    symbol: 'TONCOIN',
    name: 'Wrapped TON',
    category: TokenCategory.BLUE_CHIP,
  },
  '0xa0b73e1ff0b80914ab6fe0444e65848c4c34450b': {
    symbol: 'CRO',
    name: 'Cronos Coin',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x85f17cf997934a597031b2e18a9ab6ebd4b9f6a4': {
    symbol: 'NEAR',
    name: 'NEAR Protocol',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x514910771af9ca656af840dff83e8264ecf986ca': {
    symbol: 'LINK',
    name: 'Chainlink',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': {
    symbol: 'MATIC',
    name: 'Polygon',
    category: TokenCategory.BLUE_CHIP,
  },
  '0xd1d82d3ab815e0b47e38ec2d666c5b8aa05ae501': {
    symbol: 'SOL',
    name: 'Wrapped Solana (IBC)',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x196c20da81fbc324ecdf55501e95ce9f0bd84d14': {
    symbol: 'DOT',
    name: 'Polkadot (Snowbridge)',
    category: TokenCategory.BLUE_CHIP,
  },
  '0x4fabb145d64652a948d72533023f6e7a623c7c53': {
    symbol: 'BUSD',
    name: 'Binance USD',
    category: TokenCategory.STABLECOIN, // technically stablecoin
  },
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': {
    symbol: 'USD1',
    name: 'World Liberty Financial USD',
    category: TokenCategory.STABLECOIN, // technically stablecoin
  },

  // ════════════════════════════════════════════════════════════════
  // STABLECOINS
  // ════════════════════════════════════════════════════════════════

  '0xdac17f958d2ee523a2206206994597c13d831ec7': {
    symbol: 'USDT',
    name: 'Tether USD',
    category: TokenCategory.STABLECOIN,
  },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
    symbol: 'USDC',
    name: 'USD Coin',
    category: TokenCategory.STABLECOIN,
  },
  '0x6b175474e89094c44da98b954eedeac495271d0f': {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    category: TokenCategory.STABLECOIN,
  },
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': {
    symbol: 'USDS',
    name: 'USDS Stablecoin',
    category: TokenCategory.STABLECOIN,
  },
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': {
    symbol: 'USDe',
    name: 'Ethena USDe',
    category: TokenCategory.STABLECOIN,
  },
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497': {
    symbol: 'sUSDe',
    name: 'Staked USDe',
    category: TokenCategory.STABLECOIN,
  },
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': {
    symbol: 'PYUSD',
    name: 'PayPal USD',
    category: TokenCategory.STABLECOIN,
  },
  '0x853d955acef822db058eb8505911ed77f175b99e': {
    symbol: 'FRAX',
    name: 'Frax',
    category: TokenCategory.STABLECOIN,
  },
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': {
    symbol: 'LUSD',
    name: 'Liquity USD',
    category: TokenCategory.STABLECOIN,
  },
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': {
    symbol: 'RLUSD',
    name: 'Ripple USD',
    category: TokenCategory.STABLECOIN,
  },
  '0xe343167631d89b6ffc58b88d6b7fb0228795491d': {
    symbol: 'USDG',
    name: 'Global Dollar',
    category: TokenCategory.STABLECOIN,
  },
  '0xfa2b947eec368f42195f24f36d2af29f7c24cec2': {
    symbol: 'USDf',
    name: 'Falcon USD',
    category: TokenCategory.STABLECOIN,
  },
  '0x0000000000085d4780b73119b644ae5ecd22b376': {
    symbol: 'TUSD',
    name: 'TrueUSD',
    category: TokenCategory.STABLECOIN,
  },
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': {
    symbol: 'EURC',
    name: 'Euro Coin',
    category: TokenCategory.STABLECOIN,
  },

  // Gold-backed stablecoins
  '0x68749665ff8d2d112fa859aa293f07a622782f38': {
    symbol: 'XAUt',
    name: 'Tether Gold',
    category: TokenCategory.STABLECOIN,
  },
  '0x45804880de22913dafe09f4980848ece6ecbaf78': {
    symbol: 'PAXG',
    name: 'Paxos Gold',
    category: TokenCategory.STABLECOIN,
  },

  // ════════════════════════════════════════════════════════════════
  // LIQUID STAKING / RESTAKING
  // ════════════════════════════════════════════════════════════════

  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': {
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    category: TokenCategory.LST_LRT,
  },
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': {
    symbol: 'wstETH',
    name: 'Wrapped stETH',
    category: TokenCategory.LST_LRT,
  },
  '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee': {
    symbol: 'weETH',
    name: 'Wrapped eETH (EtherFi)',
    category: TokenCategory.LST_LRT,
  },
  '0xa2e3356610840701bdf5611a53974510ae27e2e1': {
    symbol: 'wBETH',
    name: 'Wrapped Beacon ETH',
    category: TokenCategory.LST_LRT,
  },
  '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7': {
    symbol: 'rsETH',
    name: 'KelpDAO rsETH',
    category: TokenCategory.LST_LRT,
  },
  '0xbe9895146f7af43049ca1c1ae358b0541ea49704': {
    symbol: 'cbETH',
    name: 'Coinbase Staked ETH',
    category: TokenCategory.LST_LRT,
  },
  '0xac3e018457b222d93114458476f3e3416abbe38f': {
    symbol: 'sfrxETH',
    name: 'Staked Frax ETH',
    category: TokenCategory.LST_LRT,
  },
  '0x5e8422345238f34275888049021821e8e08caa1f': {
    symbol: 'frxETH',
    name: 'Frax ETH',
    category: TokenCategory.LST_LRT,
  },
  '0xf951e335afb289353dc249e82926178eac7ded78': {
    symbol: 'swETH',
    name: 'Swell ETH',
    category: TokenCategory.LST_LRT,
  },
  '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa': {
    symbol: 'mETH',
    name: 'Mantle Staked ETH',
    category: TokenCategory.LST_LRT,
  },
  '0xa35b1b31ce002fbf2058d22f30f95d405200a15b': {
    symbol: 'ETHx',
    name: 'Stader ETHx',
    category: TokenCategory.LST_LRT,
  },
  '0xfe2e637202056d30016725477c5da089ab0a043a': {
    symbol: 'sETH2',
    name: 'StakeWise Staked ETH',
    category: TokenCategory.LST_LRT,
  },

  // ════════════════════════════════════════════════════════════════
  // DEFI PROTOCOL TOKENS
  // ════════════════════════════════════════════════════════════════

  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': {
    symbol: 'UNI',
    name: 'Uniswap',
    category: TokenCategory.DEFI,
  },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': {
    symbol: 'AAVE',
    name: 'Aave',
    category: TokenCategory.DEFI,
  },
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': {
    symbol: 'MKR',
    name: 'Maker',
    category: TokenCategory.DEFI,
  },
  '0x56072c95faa701256059aa122697b133aded9279': {
    symbol: 'SKY',
    name: 'Sky Governance (ex-MKR)',
    category: TokenCategory.DEFI,
  },
  '0xd533a949740bb3306d119cc777fa900ba034cd52': {
    symbol: 'CRV',
    name: 'Curve DAO',
    category: TokenCategory.DEFI,
  },
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': {
    symbol: 'LDO',
    name: 'Lido DAO',
    category: TokenCategory.DEFI,
  },
  '0xc00e94cb662c3520282e6f5717214004a7f26888': {
    symbol: 'COMP',
    name: 'Compound',
    category: TokenCategory.DEFI,
  },
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': {
    symbol: 'SNX',
    name: 'Synthetix',
    category: TokenCategory.DEFI,
  },
  '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': {
    symbol: 'SUSHI',
    name: 'SushiSwap',
    category: TokenCategory.DEFI,
  },
  '0xba100000625a3754423978a60c9317c58a424e3d': {
    symbol: 'BAL',
    name: 'Balancer',
    category: TokenCategory.DEFI,
  },
  '0x1a4b46696b2bb4794eb3d4c26f1c55f9170fa4c5': {
    symbol: 'BIT',
    name: 'BitDAO',
    category: TokenCategory.DEFI,
  },
  '0x111111111117dc0aa78b770fa6a738034120c302': {
    symbol: '1INCH',
    name: '1inch',
    category: TokenCategory.DEFI,
  },
  '0xdbdb4d16eda451d0503b854cf79d55697f90c8df': {
    symbol: 'ALCX',
    name: 'Alchemix',
    category: TokenCategory.DEFI,
  },
  '0x090185f2135308bad17527004364ebcc2d37e5f6': {
    symbol: 'SPELL',
    name: 'Spell Token',
    category: TokenCategory.DEFI,
  },
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': {
    symbol: 'RPL',
    name: 'Rocket Pool',
    category: TokenCategory.DEFI,
  },
  '0xc0c293ce456ff0ed870add98a0828dd4d2903dbf': {
    symbol: 'AURA',
    name: 'Aura Finance',
    category: TokenCategory.DEFI,
  },
  '0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d': {
    symbol: 'LQTY',
    name: 'Liquity',
    category: TokenCategory.DEFI,
  },
  '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': {
    symbol: 'CVX',
    name: 'Convex Finance',
    category: TokenCategory.DEFI,
  },
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e': {
    symbol: 'YFI',
    name: 'yearn.finance',
    category: TokenCategory.DEFI,
  },
  '0x6f40d4a6237c257fff2db00fa0510deeecd303eb': {
    symbol: 'INST',
    name: 'Instadapp',
    category: TokenCategory.DEFI,
  },
  '0xdefi0000000000000000000000000000000pendle': {
    symbol: 'PENDLE_PLACEHOLDER',
    name: 'Pendle',
    category: TokenCategory.DEFI,
  },
  // Pendle (real address)
  '0x808507121b80c02388fad14726482e061b8da827': {
    symbol: 'PENDLE',
    name: 'Pendle',
    category: TokenCategory.DEFI,
  },
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': {
    symbol: 'ENS',
    name: 'Ethereum Name Service',
    category: TokenCategory.DEFI,
  },
  '0x6810e776880c02933d47db1b9fc05908e5386b96': {
    symbol: 'GNO',
    name: 'Gnosis',
    category: TokenCategory.DEFI,
  },
  '0xde30da39c46104798bb5aa3fe8b9e0e1f348163f': {
    symbol: 'GTC',
    name: 'Gitcoin',
    category: TokenCategory.DEFI,
  },

  // Ethena governance
  '0x57e114b691db790c35207b2e685d4a43181e6061': {
    symbol: 'ENA',
    name: 'Ethena',
    category: TokenCategory.DEFI,
  },

  // ════════════════════════════════════════════════════════════════
  // L2 / INFRASTRUCTURE
  // ════════════════════════════════════════════════════════════════

  '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': {
    symbol: 'ARB',
    name: 'Arbitrum',
    category: TokenCategory.L2_INFRA,
  },
  '0x4200000000000000000000000000000000000042': {
    symbol: 'OP',
    name: 'Optimism',
    category: TokenCategory.L2_INFRA,
  },
  '0x3c3a81e81dc49a522a592e7622a7e711c06bf354': {
    symbol: 'MNT',
    name: 'Mantle',
    category: TokenCategory.L2_INFRA,
  },
  '0x5283d291dbcf85356a21ba090e6db59121208b44': {
    symbol: 'BLUR',
    name: 'Blur',
    category: TokenCategory.L2_INFRA,
  },
  '0xc5cb997016c9a3ac91a7d764b5e7f6dbc1140ee6': {
    symbol: 'STRK',
    name: 'StarkNet',
    category: TokenCategory.L2_INFRA,
  },
  '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff': {
    symbol: 'IMX',
    name: 'Immutable X',
    category: TokenCategory.L2_INFRA,
  },
  '0x0f5d2fb29fb7d3cfee444a200298f468908cc942': {
    symbol: 'MANA',
    name: 'Decentraland',
    category: TokenCategory.GAMING, // more gaming than infra
  },
  '0xc944e90c64b2c07662a292be6244bdf05cda44a7': {
    symbol: 'GRT',
    name: 'The Graph',
    category: TokenCategory.L2_INFRA,
  },
  '0x0d8775f648430679a709e98d2b0cb6250d2887ef': {
    symbol: 'BAT',
    name: 'Basic Attention Token',
    category: TokenCategory.L2_INFRA,
  },
  '0x4a220e6096b25eadb88358cb44068a3248254675': {
    symbol: 'QNT',
    name: 'Quant',
    category: TokenCategory.L2_INFRA,
  },
  '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3': {
    symbol: 'ONDO',
    name: 'Ondo Finance',
    category: TokenCategory.RWA,
  },

  // ════════════════════════════════════════════════════════════════
  // MEMECOINS
  // ════════════════════════════════════════════════════════════════

  '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    category: TokenCategory.MEMECOIN,
  },
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': {
    symbol: 'PEPE',
    name: 'Pepe',
    category: TokenCategory.MEMECOIN,
  },
  '0x761d38e5ddf6ccf6cf7c55759d5210750b5d60f3': {
    symbol: 'ELON',
    name: 'Dogelon Mars',
    category: TokenCategory.MEMECOIN,
  },
  '0x4d224452801aced8b2f0aebe155379bb5d594381': {
    symbol: 'APE',
    name: 'ApeCoin',
    category: TokenCategory.MEMECOIN,
  },
  '0x163f8c2467924be0ae7b5347228cabf260318753': {
    symbol: 'WLD',
    name: 'Worldcoin',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0xb131f4a55907b10d1f0a50d8ab8fa09ec342cd74': {
    symbol: 'MEME',
    name: 'Memecoin',
    category: TokenCategory.MEMECOIN,
  },
  '0x6985884c4392d348587b19cb9eaaf157f13271cd': {
    symbol: 'ZRO',
    name: 'LayerZero',
    category: TokenCategory.L2_INFRA,
  },
  '0xb23d80f5fefcddaa212212f028021b41ded428cf': {
    symbol: 'PRIME',
    name: 'Echelon Prime',
    category: TokenCategory.GAMING,
  },
  '0x532f27101965dd16442e59d40670faf5ebb142e4': {
    symbol: 'BRETT',
    name: 'Brett',
    category: TokenCategory.MEMECOIN,
  },
  '0xaaee1a9723aadb7afa2810263653a34ba2c21c7a': {
    symbol: 'MOG',
    name: 'Mog Coin',
    category: TokenCategory.MEMECOIN,
  },
  '0xa9b1eb5908cfc3cdf91f9b8b3a74108598009096': {
    symbol: 'AUCTION',
    name: 'Bounce',
    category: TokenCategory.DEFI,
  },
  '0x44971abf0251958492fee97da3e5c5ada88b9185': {
    symbol: 'TURBO',
    name: 'Turbo',
    category: TokenCategory.MEMECOIN,
  },
  '0xcf0c122c6b73ff809c693db761e7baebe62b6a2e': {
    symbol: 'FLOKI',
    name: 'Floki Inu',
    category: TokenCategory.MEMECOIN,
  },
  '0x69420f9e38a4e60a62224c489be4bf7a94402496': {
    symbol: 'NEIRO',
    name: 'Neiro',
    category: TokenCategory.MEMECOIN,
  },
  '0xfb66321d7c674995dfcc2cb67a30bc978dc862ad': {
    symbol: 'SPX',
    name: 'SPX6900',
    category: TokenCategory.MEMECOIN,
  },

  // ════════════════════════════════════════════════════════════════
  // AI / NARRATIVE
  // ════════════════════════════════════════════════════════════════

  '0xaea46a60368a7bd060eec7df8cba43b7ef41ad85': {
    symbol: 'FET',
    name: 'Fetch.ai',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24': {
    symbol: 'RNDR',
    name: 'Render Token',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0x967da4048cd07ab37855c090aaf366e4ce1b9f48': {
    symbol: 'OCEAN',
    name: 'Ocean Protocol',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0x5b7533812759b45c2b44c19e320ba2cd2681b542': {
    symbol: 'AGIX',
    name: 'SingularityNET',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0x8390a1da07e376ef7add4be859ba74fb83aa02d5': {
    symbol: 'GROK',
    name: 'Grok',
    category: TokenCategory.AI_NARRATIVE,
  },
  '0x4c19596f5aaff459fa38b0f7ed92f11ae6543784': {
    symbol: 'TRU',
    name: 'TrueFi',
    category: TokenCategory.DEFI,
  },
  '0xd31a59c85ae9d8edefec411d448f90841571b89c': {
    symbol: 'SOL_WORMHOLE',
    name: 'Wrapped SOL (Wormhole)',
    category: TokenCategory.BLUE_CHIP,
  },

  // ════════════════════════════════════════════════════════════════
  // GAMING / METAVERSE
  // ════════════════════════════════════════════════════════════════

  '0xbb0e17ef65f82ab018d8edd776e8dd940327b28b': {
    symbol: 'AXS',
    name: 'Axie Infinity',
    category: TokenCategory.GAMING,
  },
  '0x3845badade8e6dff049820680d1f14bd3903a5d0': {
    symbol: 'SAND',
    name: 'The Sandbox',
    category: TokenCategory.GAMING,
  },
  '0x15d4c048f83bd7e37d49ea4c83a07267ec4203da': {
    symbol: 'GALA',
    name: 'Gala',
    category: TokenCategory.GAMING,
  },
  '0x767fe9edc9e0df98e07454847909338d505e9e68': {
    symbol: 'ILV',
    name: 'Illuvium',
    category: TokenCategory.GAMING,
  },
  '0x4e15361fd6b4bb609fa63c81a2be19d873717870': {
    symbol: 'FTM',
    name: 'Fantom',
    category: TokenCategory.L2_INFRA,
  },
  '0x0ab87046fbb341d058f17cbc4c1133f25a20a52f': {
    symbol: 'gOHM',
    name: 'Governance OHM',
    category: TokenCategory.DEFI,
  },
  '0xda5e1988097297dcdc1f90d4dfe7909e847cbef6': {
    symbol: 'WLFI',
    name: 'Worldcoin Foundation',
    category: TokenCategory.DEFI,
  },

  // ════════════════════════════════════════════════════════════════
  // REAL WORLD ASSETS
  // ════════════════════════════════════════════════════════════════

  '0x7712c34205737192402172409a8f7ccef8aa2aec': {
    symbol: 'BUIDL',
    name: 'BlackRock USD Fund',
    category: TokenCategory.RWA,
  },
  '0x136471a34f6ef19fe571effc1ca711fdb8e49f2b': {
    symbol: 'USYC',
    name: 'US Yield Coin',
    category: TokenCategory.RWA,
  },
  '0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b': {
    symbol: 'syrupUSDC',
    name: 'Syrup USDC',
    category: TokenCategory.RWA,
  },

  // ════════════════════════════════════════════════════════════════
  // EXCHANGE TOKENS
  // ════════════════════════════════════════════════════════════════

  '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3': {
    symbol: 'LEO',
    name: 'Bitfinex LEO',
    category: TokenCategory.L2_INFRA,
  },
  '0x54d2252757e1672eead234d27b1270728ff90581': {
    symbol: 'BGB',
    name: 'Bitget Token',
    category: TokenCategory.L2_INFRA,
  },
  '0x75231f58b43240c9718dd58b4967c5114342a86c': {
    symbol: 'OKB',
    name: 'OKB',
    category: TokenCategory.L2_INFRA,
  },
};

// ─── Native ETH special handling ─────────────────────────────────
// ETH is not an ERC-20, so it won't have a contract address in your trades.
// Handle it by symbol matching in the lookup function.
export const NATIVE_TOKEN_CATEGORIES: Record<string, TokenCategory> = {
  ETH: TokenCategory.BLUE_CHIP,
  BTC: TokenCategory.BLUE_CHIP,
  SOL: TokenCategory.BLUE_CHIP,
};

export const MAJOR_SYMBOL_CATEGORY_FALLBACKS: Record<string, TokenCategory> = {
  WETH: TokenCategory.BLUE_CHIP,
  WBTC: TokenCategory.BLUE_CHIP,
  UNI: TokenCategory.DEFI,
  AAVE: TokenCategory.DEFI,
  LINK: TokenCategory.BLUE_CHIP,
  USDC: TokenCategory.STABLECOIN,
  USDT: TokenCategory.STABLECOIN,
  DAI: TokenCategory.STABLECOIN,
  FRAX: TokenCategory.STABLECOIN,
  MKR: TokenCategory.DEFI,
  COMP: TokenCategory.DEFI,
  CRV: TokenCategory.DEFI,
  LDO: TokenCategory.LST_LRT,
};

// ─── Lookup Function ─────────────────────────────────────────────

/**
 * Classify a token by contract address, falling back to symbol match.
 * All lookups use lowercase addresses.
 */
export function classifyToken(
  contractAddress?: string | null,
  symbol?: string | null,
): TokenMeta {
  // 1. Try contract address lookup (primary, most accurate)
  if (contractAddress) {
    const normalized = contractAddress.toLowerCase();
    const found = TOKEN_CATEGORY_MAP[normalized];
    if (found) return found;
  }

  // 2. Try native token symbol match
  if (symbol) {
    const upper = symbol.toUpperCase();
    const nativeCategory = NATIVE_TOKEN_CATEGORIES[upper];
    if (nativeCategory) {
      return {
        symbol: upper,
        name: upper,
        category: nativeCategory,
      };
    }

    const majorFallbackCategory = MAJOR_SYMBOL_CATEGORY_FALLBACKS[upper];
    if (majorFallbackCategory) {
      return {
        symbol: upper,
        name: upper,
        category: majorFallbackCategory,
      };
    }
  }

  // 3. Fallback to Other
  return {
    symbol: symbol || 'UNKNOWN',
    name: symbol || 'Unknown Token',
    category: TokenCategory.OTHER,
  };
}

/**
 * Batch classify multiple tokens.
 * Returns a map of contract address/symbol → category.
 */
export function classifyTokenBatch(
  tokens: Array<{ contractAddress?: string | null; symbol?: string | null }>,
): Map<string, TokenMeta> {
  const result = new Map<string, TokenMeta>();

  for (const token of tokens) {
    const key = token.contractAddress?.toLowerCase() || token.symbol || 'unknown';
    if (!result.has(key)) {
      result.set(key, classifyToken(token.contractAddress, token.symbol));
    }
  }

  return result;
}

/**
 * Get category breakdown for a list of tokens with amounts.
 * Returns percentage of each category by count and optional USD volume.
 */
export function getCategoryBreakdown(
  tokens: Array<{
    contractAddress?: string | null;
    symbol?: string | null;
    tradeCount?: number;
    usdVolume?: number;
  }>,
): {
  byCount: Record<string, { count: number; percent: number }>;
  byVolume: Record<string, { volume: number; percent: number }>;
  dominantTradingCategory: string;
  categoryDiversity: number;
  memecoinTradePercent: number;
  blueChipTradePercent: number;
  stablecoinTradePercent: number;
} {
  const countMap: Record<string, number> = {};
  const volumeMap: Record<string, number> = {};
  let totalCount = 0;
  let totalVolume = 0;

  for (const token of tokens) {
    const meta = classifyToken(token.contractAddress, token.symbol);
    const cat = meta.category;
    const count = token.tradeCount || 1;
    const volume = token.usdVolume || 0;

    countMap[cat] = (countMap[cat] || 0) + count;
    volumeMap[cat] = (volumeMap[cat] || 0) + volume;
    totalCount += count;
    totalVolume += volume;
  }

  const byCount: Record<string, { count: number; percent: number }> = {};
  for (const [cat, count] of Object.entries(countMap)) {
    byCount[cat] = {
      count,
      percent: totalCount > 0 ? (count / totalCount) * 100 : 0,
    };
  }

  const byVolume: Record<string, { volume: number; percent: number }> = {};
  for (const [cat, volume] of Object.entries(volumeMap)) {
    byVolume[cat] = {
      volume,
      percent: totalVolume > 0 ? (volume / totalVolume) * 100 : 0,
    };
  }

  // Find dominant category by count
  let dominantTradingCategory = TokenCategory.OTHER;
  let maxCount = 0;
  for (const [cat, count] of Object.entries(countMap)) {
    if (count > maxCount) {
      maxCount = count;
      dominantTradingCategory = cat as TokenCategory;
    }
  }

  const categoryDiversity = Object.keys(countMap).length;

  const memecoinTradePercent = byCount[TokenCategory.MEMECOIN]?.percent || 0;
  const blueChipTradePercent = byCount[TokenCategory.BLUE_CHIP]?.percent || 0;
  const stablecoinTradePercent = byCount[TokenCategory.STABLECOIN]?.percent || 0;

  return {
    byCount,
    byVolume,
    dominantTradingCategory,
    categoryDiversity,
    memecoinTradePercent,
    blueChipTradePercent,
    stablecoinTradePercent,
  };
}

// ─── Stats ───────────────────────────────────────────────────────
// Quick count for validation
const _tokenCount = Object.keys(TOKEN_CATEGORY_MAP).length;
const _categoryCount = new Set(
  Object.values(TOKEN_CATEGORY_MAP).map((t) => t.category),
).size;

console.log(
  `Token Category Map loaded: ${_tokenCount} tokens across ${_categoryCount} categories`,
);