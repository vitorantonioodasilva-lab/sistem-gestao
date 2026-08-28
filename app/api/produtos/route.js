import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await query("SELECT * FROM produtos ORDER BY titulo");
    return NextResponse.json(r.rows);
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, codigo: e.code || null },
      { status: 500 },
    );
  }
}

/** Salva os custos digitados pelo usuário. Aceita um item ou uma lista. */
export async function PUT(req) {
  try {
    const corpo = await req.json();
    const lista = Array.isArray(corpo) ? corpo : [corpo];
    for (const p of lista) {
      await query(
        `UPDATE produtos SET
         custo_unitario = $2,
         custo_embalagem = $3,
         estoque_minimo = $4,
         lead_time_dias = $5,
         sku = COALESCE(NULLIF($6,''), sku),
         atualizado_em = now()
       WHERE id = $1`,
        [
          p.id,
          Number(p.custo_unitario) || 0,
          Number(p.custo_embalagem) || 0,
          Number(p.estoque_minimo) || 0,
          Number(p.lead_time_dias) || 15,
          p.sku ?? "",
        ],
      );
    }
    return NextResponse.json({ ok: true, atualizados: lista.length });
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, codigo: e.code || null },
      { status: 500 },
    );
  }
}
