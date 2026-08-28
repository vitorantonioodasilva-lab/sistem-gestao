import { NextResponse } from 'next/server';
import { trocarCodePorToken, salvarConta } from '@/lib/ml';

export const runtime = 'nodejs';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const esperado = req.cookies.get('ml_state')?.value;

  if (!code) {
    return NextResponse.redirect(new URL('/config?erro=sem_code', url.origin));
  }
  // O Mercado Livre não valida o state — a conferência é nossa.
  if (esperado && state !== esperado) {
    return NextResponse.redirect(new URL('/config?erro=state_invalido', url.origin));
  }

  try {
    const token = await trocarCodePorToken(code);
    await salvarConta(token);
    return NextResponse.redirect(new URL('/config?conectado=1', url.origin));
  } catch (e) {
    return NextResponse.redirect(
      new URL(`/config?erro=${encodeURIComponent(e.message)}`, url.origin)
    );
  }
}
