import { NextResponse } from 'next/server';
import { query, getConfigs, setConfig } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = await getConfigs();
  const fixos = await query('SELECT * FROM custos_fixos ORDER BY valor_mensal DESC');
  const conta = await query(
    'SELECT seller_id, nickname, conectado_em, expira_em FROM conta_ml WHERE id = 1'
  );
  const log = await query('SELECT * FROM log_sync ORDER BY id DESC LIMIT 5');
  return NextResponse.json({
    config: cfg,
    custos_fixos: fixos.rows,
    conta: conta.rows[0] || null,
    log: log.rows,
    ambiente: {
      client_id: Boolean(process.env.ML_CLIENT_ID),
      client_secret: Boolean(process.env.ML_CLIENT_SECRET),
      redirect_uri: process.env.ML_REDIRECT_URI || null,
      senha_painel: Boolean(process.env.APP_PASSWORD),
    },
  });
}

export async function PUT(req) {
  const corpo = await req.json();
  for (const [k, v] of Object.entries(corpo.config || {})) await setConfig(k, v);

  if (corpo.custo_fixo_novo?.descricao) {
    await query('INSERT INTO custos_fixos (descricao, valor_mensal) VALUES ($1,$2)', [
      corpo.custo_fixo_novo.descricao,
      Number(corpo.custo_fixo_novo.valor_mensal) || 0,
    ]);
  }
  if (corpo.remover_custo_fixo) {
    await query('DELETE FROM custos_fixos WHERE id = $1', [corpo.remover_custo_fixo]);
  }
  return NextResponse.json({ ok: true });
}
