import { NextResponse } from "next/server";
import { query, getConfigs } from "@/lib/db";
import {
  getContaValida,
  sincronizarPedidos,
  sincronizarProdutos,
  configurada,
} from "@/lib/shopee";
import { COOKIE, sessaoValida } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function autorizado(req) {
  const cron = req.headers.get("authorization");
  if (process.env.CRON_SECRET && cron === `Bearer ${process.env.CRON_SECRET}`)
    return true;
  if (req.headers.get("user-agent")?.includes("vercel-cron")) return true;
  return sessaoValida(req.cookies.get(COOKIE)?.value);
}

export async function GET(req) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ erro: "Não autorizado" }, { status: 401 });
  }
  if (!configurada()) {
    return NextResponse.json(
      { erro: "Shopee não configurada nas variáveis de ambiente." },
      { status: 400 },
    );
  }

  try {
    const cfg = await getConfigs();
    const dias = Number(
      new URL(req.url).searchParams.get("dias") || cfg.dias_historico || 90,
    );

    const conta = await getContaValida();
    const anuncios = await sincronizarProdutos(conta);
    const pedidos = await sincronizarPedidos(conta, dias);

    await query(
      `INSERT INTO log_sync (origem, pedidos, anuncios) VALUES ('shopee',$1,$2)`,
      [pedidos, anuncios],
    );
    return NextResponse.json({ ok: true, pedidos, anuncios });
  } catch (e) {
    await query(`INSERT INTO log_sync (origem, erro) VALUES ('shopee', $1)`, [
      e.message,
    ]).catch(() => {});
    const status =
      e.message === "SEM_CONTA" ||
      e.message === "RECONECTAR" ||
      e.message === "SEM_CREDENCIAL"
        ? 409
        : 500;
    return NextResponse.json({ erro: e.message, codigo: e.codigo }, { status });
  }
}

export const POST = GET;
