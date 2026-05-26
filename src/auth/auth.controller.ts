import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { Repository } from 'typeorm';
import { generateNonce, SiweMessage } from 'siwe';
import { NONCE_COOKIE_NAME, clearNonceCookie, setNonceCookie } from '../lib/auth/nonce-cookie';
import { getSession } from '../lib/auth/session';
import { WhitelistedWalletEntity } from './entities/whitelisted-wallet.entity';

interface VerifyBody {
  message?: string;
  signature?: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(
    @InjectRepository(WhitelistedWalletEntity)
    private readonly whitelistRepo: Repository<WhitelistedWalletEntity>,
  ) {}
  @Get('nonce')
  async getNonce(@Res() res: Response): Promise<void> {
    try {
      const nonce = generateNonce();
      setNonceCookie(res, nonce);
      res.status(HttpStatus.OK).type('text/plain').send(nonce);
    } catch {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
    }
  }

  @Post('verify')
  async verify(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: VerifyBody,
  ): Promise<void> {
    try {
      const storedNonce = req.cookies?.[NONCE_COOKIE_NAME] as string | undefined;
      if (!storedNonce) {
        res.status(HttpStatus.BAD_REQUEST).json({ error: 'Missing nonce' });
        return;
      }

      const { message, signature } = body;
      if (!message || !signature) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({ error: 'Verification failed' });
        return;
      }

      const siweMessage = new SiweMessage(message);

      if (siweMessage.nonce !== storedNonce) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: 'Nonce mismatch — sign again (do not refresh during wallet prompt).',
        });
        return;
      }

      const forwardedHost = req.headers['x-forwarded-host'];
      const expectedDomain =
      process.env.SIWE_DOMAIN ||
      (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0]?.trim() : null) ||
      (typeof req.headers.host === 'string' ? req.headers.host.split(',')[0]?.trim() : null);

      const result = await siweMessage.verify(
        {
          signature,
          nonce: storedNonce,
          ...(expectedDomain ? { domain: expectedDomain } : {}),
        },
        { suppressExceptions: true },
      );

      if (!result.success) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
          error: result.error?.type ?? 'Verification failed',
        });
        return;
      }

      const session = await getSession(req, res);
      session.address = siweMessage.address;
      session.authenticated = true;
      await session.save();

      clearNonceCookie(res);
      res.status(HttpStatus.OK).json({ ok: true });
    } catch {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
    }
  }

  @Get('session')
  async getSessionStatus(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const session = await getSession(req, res);

      if (session.authenticated && session.address) {
        res.status(HttpStatus.OK).json({
          authenticated: true,
          address: session.address,
        });
        return;
      }

      res.status(HttpStatus.OK).json({ authenticated: false });
    } catch {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
    }
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const session = await getSession(req, res);
      session.destroy();
      res.status(HttpStatus.OK).json({ ok: true });
    } catch {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
    }
  }

  @Get('access-check')
  async accessCheck(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const session = await getSession(req, res);

      if (!session.authenticated || !session.address) {
        res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Not authenticated' });
        return;
      }

      const wallet = await this.whitelistRepo.findOne({
        where: { address: session.address.toLowerCase() },
      });

      if (wallet) {
        res.status(HttpStatus.OK).json({ whitelisted: true, plan: wallet.plan });
      } else {
        res.status(HttpStatus.OK).json({ whitelisted: false });
      }
    } catch {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
    }
  }
}
