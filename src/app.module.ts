import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { TokenModule } from './token/token.module';
import { WalletModule } from './wallet/wallet.module';

const databaseLogger = new Logger('DatabaseConfig');

const isSupabaseDirectHost = (hostname: string): boolean => {
  return hostname.startsWith('db.') && hostname.endsWith('.supabase.co');
};

const shouldUseSsl = (
  databaseUrl: URL,
  configuredSsl: boolean | undefined,
): boolean => {
  if (configuredSsl !== undefined) {
    return configuredSsl;
  }

  if (databaseUrl.searchParams.get('sslmode') === 'disable') {
    return false;
  }

  if (databaseUrl.searchParams.get('sslmode') === 'require') {
    return true;
  }

  return databaseUrl.hostname !== 'localhost' && databaseUrl.hostname !== '127.0.0.1';
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      expandVariables: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('database.url');

        if (!databaseUrl) {
          throw new Error('DATABASE_URL is not configured');
        }

        const parsedDatabaseUrl = new URL(databaseUrl);
        const configuredSsl = configService.get<boolean | undefined>('database.ssl');
        const connectionTimeoutMs =
          configService.get<number>('database.connectionTimeoutMs') ?? 10000;
        const useSsl = shouldUseSsl(parsedDatabaseUrl, configuredSsl);

        if (isSupabaseDirectHost(parsedDatabaseUrl.hostname)) {
          databaseLogger.warn(
            'DATABASE_URL is using a Supabase direct host. That endpoint is IPv6-only; if your machine or network does not support IPv6, switch to the Supabase pooler host instead.',
          );
        }

        return {
          type: 'postgres' as const,
          url: databaseUrl,
          autoLoadEntities: true,
          synchronize: false,
          logging: false,
          ssl: useSsl ? { rejectUnauthorized: false } : false,
          extra: {
            connectionTimeoutMillis: connectionTimeoutMs,
          },
        };
      },
    }),
    TokenModule,
    WalletModule,
  ],
})
export class AppModule {}
