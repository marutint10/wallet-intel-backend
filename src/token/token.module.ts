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
  providers: [ChainbaseService, LiteIngestionService],
})
export class TokenModule {}
