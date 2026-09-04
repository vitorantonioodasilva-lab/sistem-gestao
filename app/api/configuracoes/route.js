import { NextResponse } from "next/server";
import { query, getConfigs, setConfig } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = await getConfigs();
    const fixos = await query(
      "SELECT * FROM custos_fixos ORDER BY valor_mensal DESC",
    );
    const conta = await query(
      "SELECT seller_id, nickname, conectado_em, expira_em FROM conta_ml WHERE id = 1",
    );
    const shopee = await query(
      "SELECT shop_id, shop_name, conectado_em, expira_em FROM conta_shopee WHERE id = 1",
    ).catch(() => ({ rows: [] }));
    const log = await query("SELECT * FROM log_sync ORDER BY id DESC LIMIT 5");
    return NextResponse.json({
      config: cfg,
      custos_fixos: fixos.rows,
      conta: conta.rows[0] || null,
      conta_shopee: shopee.rows[0] || null,
      log: log.rows,
      ambiente: {
        client_id: Boolean(process.env.ML_CLIENT_ID),
        client_secret: Boolean(process.env.ML_CLIENT_SECRET),
        redirect_uri: process.env.ML_REDIRECT_URI || null,
        senha_painel: Boolean(process.env.APP_PASSWORD),
        shopee_partner_id: Boolean(process.env.SHOPEE_PARTNER_ID),
        shopee_partner_key: Boolean(process.env.SHOPEE_PARTNER_KEY),
        shopee_redirect_uri: process.env.SHOPEE_REDIRECT_URI || null,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, codigo: e.code || null },
      { status: 500 },
    );
  }
}

export async function PUT(req) {
  try {
    const corpo = await req.json();
    for (const [k, v] of Object.entries(corpo.config || {}))
      await setConfig(k, v);

    if (corpo.custo_fixo_novo?.descricao) {
      await query(
        "INSERT INTO custos_fixos (descricao, valor_mensal) VALUES ($1,$2)",
        [
          corpo.custo_fixo_novo.descricao,
          Number(corpo.custo_fixo_novo.valor_mensal) || 0,
        ],
      );
    }
    if (corpo.remover_custo_fixo) {
      await query("DELETE FROM custos_fixos WHERE id = $1", [
        corpo.remover_custo_fixo,
      ]);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, codigo: e.code || null },
      { status: 500 },
    );
  }
}
