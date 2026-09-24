import { NextResponse } from "next/server";
import { getConfigs } from "@/lib/db";
import { getTokenValido } from "@/lib/ml";
import { listarExpedicao, sincronizarEnvios, marcar } from "@/lib/expedicao";
import {
  getContaValida as contaShopee,
  sincronizarPedidos as pedidosShopee,
  configurada as shopeeConfigurada,
} from "@/lib/shopee";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const cfg = await getConfigs();
    const url = new URL(req.url);
    const dias = Number(url.searchParams.get("dias") || cfg.expedicao_dias || 15);
    // canal=ml ou canal=shopee filtra; sem parâmetro vem tudo junto.
    const canal = url.searchParams.get("canal") || null;
    const envios = await listarExpedicao(dias, canal);

    const resumo = {
      nf: 0,
      imprimir: 0,
      impresso: 0,
      futuras: 0,
      transporte: 0,
      entregue: 0,
    };
    const canais = { ml: 0, shopee: 0 };
    for (const e of envios) {
      if (resumo[e.etapa] !== undefined) resumo[e.etapa]++;
      if (canais[e.canal] !== undefined) canais[e.canal]++;
    }
    return NextResponse.json({ envios, resumo, canais, dias, canal });
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
    const dias = Number(cfg.expedicao_dias) || 15;

    // Cada canal se vira sozinho: loja não conectada não pode derrubar a
    // atualização da outra.
    const falhas = [];
    let ml = null;
    let shopee = null;

    try {
      const { token } = await getTokenValido();
      ml = await sincronizarEnvios(token, dias);
    } catch (e) {
      falhas.push({ canal: "ml", erro: e.message });
    }

    if (shopeeConfigurada()) {
      try {
        shopee = { pedidos: await pedidosShopee(await contaShopee(), dias) };
      } catch (e) {
        falhas.push({ canal: "shopee", erro: e.message });
      }
    }

    if (!ml && !shopee) {
      const e = new Error(falhas[0]?.erro || "Nenhum canal conectado.");
      e.status = falhas[0]?.erro === "SEM_CONTA" ? 409 : 500;
      throw e;
    }

    return NextResponse.json({ ok: true, ...(ml || {}), shopee, falhas });
  } catch (e) {
    const status =
      e.status ||
      (e.message === "SEM_CONTA" || e.message === "RECONECTAR" ? 409 : 500);
    return NextResponse.json({ erro: e.message }, { status });
  }
}
