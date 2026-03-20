import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class AlchemyService {
  private readonly apiKey = process.env.ALCHEMY_API_KEY;
  private readonly url = `https://eth-mainnet.g.alchemy.com/v2/${this.apiKey}`;

  async getTransactions(address: string) {
    const payload = {
      jsonrpc: '2.0',
      method: 'alchemy_getAssetTransfers',
      params: [
        {
          fromBlock: '0x0',
          toAddress: address,
          category: ['external', 'erc20'],
        },
      ],
      id: 1,
    };

    const response = await axios.post(this.url, payload);
    return response.data;
  }
}