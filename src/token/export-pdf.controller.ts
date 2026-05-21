import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { TokenPdfExportService } from './services/token-pdf-export.service';

/**
 * PDF export via headless Chrome (Puppeteer).
 * Frontend must expose GET /report-print/:tokenId?chain=&secret= with class `.pdf-ready` when render is complete.
 */
@Controller('api')
export class ExportPdfController {
  private readonly logger = new Logger(ExportPdfController.name);

  constructor(private readonly pdfExport: TokenPdfExportService) {}

  @Get('export-pdf/:tokenId')
  async exportPdf(
    @Param('tokenId') tokenId: string,
    @Query('chain') chain: string = 'ethereum',
  ): Promise<StreamableFile> {
    try {
      const { buffer, filename } = await this.pdfExport.generatePdf({
        contractAddress: tokenId,
        chain,
      });

      return new StreamableFile(buffer, {
        type: 'application/pdf',
        disposition: `attachment; filename="${filename}"`,
      });
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`export-pdf failed tokenId=${tokenId}: ${message}`);
      throw new HttpException(
        { error: 'Failed to generate PDF report' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
