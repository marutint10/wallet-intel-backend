import { getIronSession, IronSession, SessionOptions } from 'iron-session';
import type { Request, Response } from 'express';

export interface SessionData {
  address?: string;
  authenticated: boolean;
}

export function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters');
  }

  return {
    password,
    cookieName: 'wi_session',
    cookieOptions: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
    },
  };
}

/** Express / NestJS route handlers */
export async function getSession(
  req: Request,
  res: Response,
): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(req, res, getSessionOptions());
}
