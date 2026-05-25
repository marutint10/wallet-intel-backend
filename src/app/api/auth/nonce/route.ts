import { generateNonce } from 'siwe';
import { cookies } from 'next/headers';

export async function GET(): Promise<Response> {
  try {
    const nonce = generateNonce();
    const cookieStore = await cookies();
    cookieStore.set('wi_nonce', nonce, {
      httpOnly: true,
      maxAge: 10 * 60,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    return new Response(nonce);
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
