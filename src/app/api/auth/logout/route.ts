import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { getSessionOptions, type SessionData } from '../../../../lib/auth/session';

export async function POST(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
    session.destroy();
    return Response.json({ ok: true }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
