import { SiweMessage } from 'siwe';
import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { getSessionOptions, type SessionData } from '../../../../lib/auth/session';

export async function POST(request: Request): Promise<Response> {
  try {
    const cookieStore = await cookies();
    const storedNonce = cookieStore.get('wi_nonce')?.value;
    if (!storedNonce) {
      return Response.json({ error: 'Missing nonce' }, { status: 400 });
    }

    const body = (await request.json()) as { message?: string; signature?: string };
    const { message, signature } = body;
    if (!message || !signature) {
      return Response.json({ error: 'Verification failed' }, { status: 422 });
    }

    const siweMessage = new SiweMessage(message);
    const result = await siweMessage.verify({ signature, nonce: storedNonce });
    if (!result.success) {
      return Response.json({ error: 'Verification failed' }, { status: 422 });
    }

    const session = await getIronSession<SessionData>(cookieStore, getSessionOptions());
    session.address = siweMessage.address;
    session.authenticated = true;
    await session.save();

    cookieStore.delete('wi_nonce');

    return Response.json({ ok: true }, { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
