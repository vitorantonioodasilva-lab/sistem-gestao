import { NextResponse } from 'next/server';
import { authUrl } from '@/lib/ml';

export const runtime = 'nodejs';

export async function GET() {
  if (!process.env.ML_CLIENT_ID || !process.env.ML_REDIRECT_URI) {
    return NextResponse.json(
      { erro: 'Configure ML_CLIENT_ID e ML_REDIRECT_URI nas variáveis de ambiente.' },
      { status: 400 }
    );
  }
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set('ml_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });
  return res;
}
