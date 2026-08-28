import { NextResponse } from 'next/server';
import { montarPainel } from '@/lib/margem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const dias = Number(new URL(req.url).searchParams.get('dias') || 30);
    const dados = await montarPainel(dias);
    return NextResponse.json(dados);
  } catch (e) {
    return NextResponse.json({ erro: e.message }, { status: 500 });
  }
}
