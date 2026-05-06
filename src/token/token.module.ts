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
import { LiteClassifierService } from './services/lite-classifier.service';
import { LiteFeatureService } from './services/lite-feature.service';
import { LiteIngestionService } from './services/lite-ingestion.service';
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
  ],
})
export class TokenModule {}
