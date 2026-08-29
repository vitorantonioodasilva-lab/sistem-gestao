import { NextResponse } from "next/server";
import { query, getConfigs } from "@/lib/db";
import {
  getTokenValido,
  sincronizarPedidos,
  sincronizarAnuncios,
} from "@/lib/ml";
import { sincronizarAds } from "@/lib/ads";
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

async function executar(dias, cfg) {
  const { token, sellerId } = await getTokenValido();
  const desde = new Date(Date.now() - dias * 86400000);
  const anuncios = await sincronizarAnuncios(token, sellerId);
  const pedidos = await sincronizarPedidos(token, sellerId, desde);

  // Publicidade é opcional: se a conta não tiver Product Ads, o resto
  // da sincronização não pode quebrar por causa disso.
  let ads = { ativo: false, motivo: "desligado nos ajustes" };
  if (cfg.ads_ativo !== "false") {
    try {
      ads = await sincronizarAds(
        token,
        sellerId,
        Number(cfg.ads_dias_sync) || 30,
      );
    } catch (e) {
      ads = { ativo: false, motivo: e.message };
    }
  }

  await query(
    `INSERT INTO log_sync (origem, pedidos, anuncios) VALUES ($1,$2,$3)`,
    ["manual", pedidos, anuncios],
  );
  return { pedidos, anuncios, ads };
}

export async function GET(req) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ erro: "Não autorizado" }, { status: 401 });
  }
  try {
    const cfg = await getConfigs();
    const dias = Number(
      new URL(req.url).searchParams.get("dias") || cfg.dias_historico || 90,
    );
    const r = await executar(dias, cfg);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    await query(`INSERT INTO log_sync (origem, erro) VALUES ('cron', $1)`, [
      e.message,
    ]).catch(() => {});
    const status =
      e.message === "SEM_CONTA" || e.message === "RECONECTAR" ? 409 : 500;
    return NextResponse.json({ erro: e.message }, { status });
  }
}

export const POST = GET;
