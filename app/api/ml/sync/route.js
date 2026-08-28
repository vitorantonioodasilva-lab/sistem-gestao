import { NextResponse } from 'next/server';
import { query, getConfigs } from '@/lib/db';
import { getTokenValido, sincronizarPedidos, sincronizarAnuncios } from '@/lib/ml';
import { COOKIE, sessaoValida } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function autorizado(req) {
  const cron = req.headers.get('authorization');
  if (process.env.CRON_SECRET && cron === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (req.headers.get('user-agent')?.includes('vercel-cron')) return true;
  return sessaoValida(req.cookies.get(COOKIE)?.value);
}

async function executar(dias) {
  const { token, sellerId } = await getTokenValido();
  const desde = new Date(Date.now() - dias * 86400000);
  const anuncios = await sincronizarAnuncios(token, sellerId);
  const pedidos = await sincronizarPedidos(token, sellerId, desde);
  await query(
    `INSERT INTO log_sync (origem, pedidos, anuncios) VALUES ($1,$2,$3)`,
    ['manual', pedidos, anuncios]
  );
  return { pedidos, anuncios };
}

export async function GET(req) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ erro: 'Não autorizado' }, { status: 401 });
  }
  try {
    const cfg = await getConfigs();
    const dias = Number(new URL(req.url).searchParams.get('dias') || cfg.dias_historico || 90);
    const r = await executar(dias);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    await query(`INSERT INTO log_sync (origem, erro) VALUES ('cron', $1)`, [e.message]).catch(() => {});
    const status = e.message === 'SEM_CONTA' || e.message === 'RECONECTAR' ? 409 : 500;
    return NextResponse.json({ erro: e.message }, { status });
  }
}

export const POST = GET;
