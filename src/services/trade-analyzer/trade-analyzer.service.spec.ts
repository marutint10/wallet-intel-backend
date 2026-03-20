import { Test, TestingModule } from '@nestjs/testing';
import { TradeAnalyzerService } from './trade-analyzer.service';

describe('TradeAnalyzerService', () => {
  let service: TradeAnalyzerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TradeAnalyzerService],
    }).compile();

    service = module.get<TradeAnalyzerService>(TradeAnalyzerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
