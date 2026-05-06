import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import {
  TokenAnalysisEntity,
  TrackedTokenEntity,
  WhaleSnapshotEntity,
  WhaleAlertEntity,
} from './entities';
import { ChainbaseService } from './services/chainbase.service';
import { HolderAggregationService } from './services/holder-aggregation.service';
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
import { LitePnlService } from './services/lite-pnl.service';
import { LitePortfolioService } from './services/lite-portfolio.service';
import { LitePricingService } from './services/lite-pricing.service';
import { LiteScorerService } from './services/lite-scorer.service';
import { TokenAnalysisService } from './services/token-analysis.service';
import { TokenController } from './token.controller';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      TokenAnalysisEntity,
      TrackedTokenEntity,
      WhaleSnapshotEntity,
      WhaleAlertEntity,
    ]),
  ],
  controllers: [TokenController],
  providers: [
    ChainbaseService,
    LiteIngestionService,
    LiteFeatureService,
    LiteClassifierService,
    LiteScorerService,
    LitePricingService,
    LitePortfolioService,
    LitePnlService,
    HolderAggregationService,
    TokenAnalysisService,
  ],
})
export class TokenModule {}
