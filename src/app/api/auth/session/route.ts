import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { getSessionOptions, type SessionData } from '../../../../lib/auth/session';

export async function GET(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());

    if (session.authenticated && session.address) {
      return Response.json({
        authenticated: true,
        address: session.address,
      });
    }

    return Response.json({ authenticated: false });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
