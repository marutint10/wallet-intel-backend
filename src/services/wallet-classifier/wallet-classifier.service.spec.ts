import { Test, TestingModule } from '@nestjs/testing';
import { WalletClassifierService } from './wallet-classifier.service';

describe('WalletClassifierService', () => {
  let service: WalletClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WalletClassifierService],
    }).compile();

    service = module.get<WalletClassifierService>(WalletClassifierService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
