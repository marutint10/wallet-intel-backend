import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { SessionGuard } from './guards/session.guard';
import { WhitelistedWalletEntity } from './entities/whitelisted-wallet.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WhitelistedWalletEntity])],
  controllers: [AuthController],
  providers: [SessionGuard],
  exports: [SessionGuard],
})
export class AuthModule {}
