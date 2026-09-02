import { NextResponse } from "next/server";
import { getConfigs } from "@/lib/db";
import { getTokenValido } from "@/lib/ml";
import { listarExpedicao, sincronizarEnvios, marcar } from "@/lib/expedicao";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const cfg = await getConfigs();
    const dias = Number(
      new URL(req.url).searchParams.get("dias") || cfg.expedicao_dias || 15,
    );
    const envios = await listarExpedicao(dias);

    const resumo = {
      nf: 0,
      imprimir: 0,
      impresso: 0,
      futuras: 0,
      transporte: 0,
      entregue: 0,
    };
    for (const e of envios) {
      if (resumo[e.etapa] !== undefined) resumo[e.etapa]++;
    }
    return NextResponse.json({ envios, resumo, dias });
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, codigo: e.code || null },
      { status: 500 },
    );
  }
}

export async function POST(req) {
  try {
    const corpo = await req.json().catch(() => ({}));

    if (corpo.acao === "marcar") {
      await marcar(
        corpo.shipment_ids || [],
        corpo.campo,
        Boolean(corpo.desfazer),
      );
      return NextResponse.json({ ok: true });
    }

    const cfg = await getConfigs();
    const { token } = await getTokenValido();
    const r = await sincronizarEnvios(token, Number(cfg.expedicao_dias) || 15);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const status =
      e.message === "SEM_CONTA" || e.message === "RECONECTAR" ? 409 : 500;
    return NextResponse.json({ erro: e.message }, { status });
  }
}
