import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getTokenValido } from "@/lib/ml";
import { emitirLote, atualizarStatusNotas } from "@/lib/nf";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const corpo = await req.json().catch(() => ({}));
    const ids = (corpo.shipment_ids || []).map(String);
    if (!ids.length) {
      return NextResponse.json(
        { erro: "Nenhum envio selecionado." },
        { status: 400 },
      );
    }

    const { token, sellerId } = await getTokenValido();

    // Carrinho gera nota única: agrupa os pedidos pelo pack.
    const r = await query(
      `SELECT shipment_id, order_id, pack_id FROM envios
        WHERE shipment_id = ANY($1::bigint[])`,
      [ids],
    );

    const porPack = new Map();
    for (const e of r.rows) {
      const chave = e.pack_id || `solo:${e.order_id}`;
      const atual = porPack.get(chave) || {
        order_id: e.order_id,
        order_ids: [],
      };
      atual.order_ids.push(e.order_id);
      porPack.set(chave, atual);
    }

    if (corpo.acao === "status") {
      const n = await atualizarStatusNotas(
        token,
        sellerId,
        r.rows.map((x) => x.order_id),
      );
      return NextResponse.json({ ok: true, autorizadas: n });
    }

    const res = await emitirLote(token, sellerId, [...porPack.values()]);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const status =
      e.message === "SEM_CONTA" || e.message === "RECONECTAR" ? 409 : 500;
    return NextResponse.json({ erro: e.message }, { status });
  }
}
