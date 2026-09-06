import { NextResponse } from 'next/server';
import { COOKIE, sessaoValida } from './lib/session';

const LIVRES = [
  '/login',
  '/api/login',
  '/api/ml/webhook',
  '/api/ml/sync',
  '/api/ml/callback',
  '/api/shopee/callback',
  '/api/shopee/sync',
];

export async function middleware(req) {
  const { pathname } = req.nextUrl;
  if (LIVRES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const ok = await sessaoValida(req.cookies.get(COOKIE)?.value);
  if (ok) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ erro: 'Não autenticado' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
