import type { Response } from 'express';

export const NONCE_COOKIE_NAME = 'wi_nonce';
const NONCE_TTL_MS = 10 * 60 * 1000;

const secureCookie = (): boolean => process.env.NODE_ENV === 'production';

export function setNonceCookie(res: Response, nonce: string): void {
  res.cookie(NONCE_COOKIE_NAME, nonce, {
    httpOnly: true,
    maxAge: NONCE_TTL_MS,
    sameSite: 'lax',
    secure: secureCookie(),
    path: '/',
  });
}

export function clearNonceCookie(res: Response): void {
  res.clearCookie(NONCE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: '/',
  });
}
