import { SupportedChain } from '../../shared/constants/chains';

export const DEX_ROUTERS: Record<SupportedChain, Record<string, string>> = {
  ethereum: {
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
    '0x99a58482bd75cbab83b27ec03ca68ff489b5788f': 'Curve Router',
    '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer Vault',
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'Kyber Network',
    '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'Paraswap V5',
  },
  base: {
    '0x2626664c2603336edef7bceaac4cca244c6c9288': 'Uniswap V3',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'SushiSwap',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  },
  bsc: {
    '0x10ed43c718714eb63d5aa57b78b54704e256024e': 'PancakeSwap V2',
    '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeSwap V3',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
    '0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8': 'BiSwap',
  },
  polygon: {
    '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff': 'QuickSwap',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': 'SushiSwap',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch V5',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
    '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer Vault',
  },
};

export const UNKNOWN_DEX_LABEL = 'Unknown';