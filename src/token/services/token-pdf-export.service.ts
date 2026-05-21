import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { type Browser } from 'puppeteer';
import { TokenAnalysisService } from './token-analysis.service';

export interface TokenPdfExportOptions {
  contractAddress: string;
  chain: string;
  waitForPdfReady?: boolean;
}

export interface TokenPdfExportResult {
  buffer: Buffer;
  filename: string;
}

@Injectable()
export class TokenPdfExportService {
  private readonly logger = new Logger(TokenPdfExportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tokenAnalysis: TokenAnalysisService,
  ) {}

  async generatePdf(options: TokenPdfExportOptions): Promise<TokenPdfExportResult> {
    const contractAddress = options.contractAddress.trim().toLowerCase();
    const chain = (options.chain || 'ethereum').trim().toLowerCase();

    if (!this.isEvmContractAddress(contractAddress)) {
      throw new BadRequestException('Invalid token contract address');
    }

    const analysis = await this.tokenAnalysis.getResult(contractAddress, chain);
    if (!analysis) {
      throw new BadRequestException(
        'No analysis found for this token. Run POST /token/analyze first.',
      );
    }

    if (analysis.status !== 'done') {
      throw new BadRequestException(
        `Analysis is not ready (status=${analysis.status}). Poll GET /token/:address until status=done.`,
      );
    }

    const frontendUrl = this.config.get<string>('pdfExport.frontendUrl')?.trim();
    const printSecret = this.config
      .get<string>('pdfExport.internalPrintSecret')
      ?.trim();

    if (!frontendUrl) {
      throw new ServiceUnavailableException(
        'FRONTEND_URL is not configured. Set it in the environment to enable PDF export.',
      );
    }

    if (!printSecret) {
      throw new ServiceUnavailableException(
        'INTERNAL_PRINT_SECRET is not configured. Set it in the environment to enable PDF export.',
      );
    }

    const reportUrl = this.buildReportUrl(
      frontendUrl,
      contractAddress,
      chain,
      printSecret,
    );

    let browser: Browser | null = null;

    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();
      await page.setViewport({
        width: 1440,
        height: 900,
        deviceScaleFactor: 2,
      });

      this.logger.log(
        `PDF export navigating contract=${contractAddress} chain=${chain}`,
      );

      await page.goto(reportUrl, {
        waitUntil: 'networkidle0',
        timeout: 30_000,
      });

      if (options.waitForPdfReady !== false) {
        try {
          await page.waitForSelector('.pdf-ready', { timeout: 5_000 });
        } catch {
          this.logger.warn(
            `PDF export: .pdf-ready not found within 5s for ${contractAddress}; generating PDF anyway`,
          );
        }
      }

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20mm',
          right: '15mm',
          bottom: '20mm',
          left: '15mm',
        },
        displayHeaderFooter: false,
      });

      return {
        buffer: Buffer.from(pdfBuffer),
        filename: this.buildDownloadFilename(
          contractAddress,
          analysis.tokenSymbol,
        ),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`PDF generation failed for ${contractAddress}: ${message}`);
      throw new ServiceUnavailableException('Failed to generate PDF report');
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  buildDownloadFilename(
    contractAddress: string,
    tokenSymbol?: string | null,
  ): string {
    const symbol =
      typeof tokenSymbol === 'string' && tokenSymbol.trim().length > 0
        ? tokenSymbol.trim().replace(/[^a-zA-Z0-9_-]/g, '')
        : contractAddress.slice(2, 10);
    return `WalletIntel_${symbol}_Report.pdf`;
  }

  private buildReportUrl(
    frontendUrl: string,
    contractAddress: string,
    chain: string,
    printSecret: string,
  ): string {
    const base = frontendUrl.replace(/\/$/, '');
    const url = new URL(`${base}/report-print/${contractAddress}`);
    url.searchParams.set('chain', chain);
    url.searchParams.set('secret', printSecret);
    return url.toString();
  }

  private isEvmContractAddress(address: string): boolean {
    return /^0x[a-f0-9]{40}$/.test(address);
  }
}
