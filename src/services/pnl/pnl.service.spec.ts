import { Test, TestingModule } from '@nestjs/testing';
import { PnlService } from './pnl.service';

describe('PnlService', () => {
  let service: PnlService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PnlService],
    }).compile();

    service = module.get<PnlService>(PnlService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
