import { NextResponse } from 'next/server';
import { COOKIE, tokenEsperado } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req) {
  const { senha } = await req.json().catch(() => ({}));
  const esperado = await tokenEsperado();

  if (!esperado) {
    return NextResponse.json({ ok: true, aviso: 'Nenhuma senha configurada.' });
  }
  const dados = new TextEncoder().encode(`${senha ?? ''}::ml-financeiro`);
  const hash = await crypto.subtle.digest('SHA-256', dados);
  const recebido = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (recebido !== esperado) {
    return NextResponse.json({ erro: 'Senha incorreta.' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, esperado, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
