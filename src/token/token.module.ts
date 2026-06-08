import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import {
  TokenAnalysisEntity,
  TrackedTokenEntity,
  WhaleSnapshotEntity,
  WhaleAlertEntity,
} from './entities';
import { TokenDeepAnalysisEntity } from './entities/token-deep-analysis.entity';
import { ChainbaseService } from './services/chainbase.service';
import { DashboardSummaryService } from './services/dashboard-summary.service';
import { HolderAggregationService } from './services/holder-aggregation.service';
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
import { LitePnlService } from './services/lite-pnl.service';
import { LitePortfolioService } from './services/lite-portfolio.service';
import { LitePricingService } from './services/lite-pricing.service';
import { LiteScorerService } from './services/lite-scorer.service';
import { TokenAiSummaryService } from './services/token-ai-summary.service';
import { TokenChartService } from './services/token-chart.service';
import { TokenAnalysisService } from './services/token-analysis.service';
import { TokenDeepAnalysisService } from './services/token-deep-analysis.service';
import { TokenIntelligenceService } from './services/token-intelligence.service';
import { TokenTrustReportService } from './services/token-trust-report.service';
import { WalletFilterService } from './services/wallet-filter.service';
import { ExportPdfController } from './export-pdf.controller';
import { TokenController } from './token.controller';
import { TokenPdfExportService } from './services/token-pdf-export.service';
import { TokenTargetValidatorService } from './services/token-target-validator.service';
import { TokenContractSafetyService } from './services/token-contract-safety.service';

@Module({
  imports: [
    ConfigModule,
    CacheModule.register(),
    TypeOrmModule.forFeature([
      TokenAnalysisEntity,
      TokenDeepAnalysisEntity,
      TrackedTokenEntity,
      WhaleSnapshotEntity,
      WhaleAlertEntity,
    ]),
  ],
  controllers: [TokenController, ExportPdfController],
  providers: [
    ChainbaseService,
    LiteIngestionService,
    LiteFeatureService,
    LiteClassifierService,
    LiteScorerService,
    LitePricingService,
    LitePortfolioService,
    LitePnlService,
    WalletFilterService,
    HolderAggregationService,
    TokenAnalysisService,
    TokenIntelligenceService,
    TokenTrustReportService,
    DashboardSummaryService,
    TokenAiSummaryService,
    TokenChartService,
    TokenDeepAnalysisService,
    TokenPdfExportService,
    TokenTargetValidatorService,
    TokenContractSafetyService,
  ],
})
export class TokenModule {}
