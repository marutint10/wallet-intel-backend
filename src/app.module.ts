import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { getDatabaseSslOption } from './database/database-options';
import { TokenModule } from './token/token.module';
import { WalletModule } from './wallet/wallet.module';

const databaseLogger = new Logger('DatabaseConfig');

const isSupabaseDirectHost = (hostname: string): boolean => {
  return hostname.startsWith('db.') && hostname.endsWith('.supabase.co');
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
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
          migrations: [join(__dirname, 'database', 'migrations', '*.{ts,js}')],
          migrationsRun: false,
          logging: false,
          ssl: getDatabaseSslOption(databaseUrl, configuredSsl),
          extra: {
            connectionTimeoutMillis: connectionTimeoutMs,
          },
        };
      },
    }),
    AuthModule,
    TokenModule,
    WalletModule,
  ],
})
export class AppModule {}
