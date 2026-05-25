import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  const configService = app.get(ConfigService);
  const frontendUrl = configService.get<string>('pdfExport.frontendUrl');
  app.enableCors({
    origin: frontendUrl || true,
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = configService.get<number>('port') ?? 3000;

  const httpServer = await app.listen(port);

  // Release the port immediately on SIGTERM/SIGINT so nest --watch reloads
  // don't hit EADDRINUSE while NestJS lifecycle hooks are still running.
  const releasePort = (): void => void httpServer.close();
  process.once('SIGTERM', releasePort);
  process.once('SIGINT', releasePort);

  Logger.log(`Server listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();