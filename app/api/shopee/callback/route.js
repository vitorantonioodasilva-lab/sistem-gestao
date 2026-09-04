import { NextResponse } from "next/server";
import { trocarCodePorToken, getContaValida, infoLoja } from "@/lib/shopee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  // Loja simples devolve shop_id; conta principal devolve main_account_id.
  const shopId = url.searchParams.get("shop_id");

  const volta = (params) =>
    NextResponse.redirect(new URL(`/config?${params}`, url.origin));

  if (!code) return volta("erro=shopee_sem_code");
  if (!shopId) return volta("erro=shopee_sem_shop_id");

  try {
    await trocarCodePorToken(code, shopId);
    // Busca o nome da loja para a tela de ajustes ter o que mostrar.
    try {
      await infoLoja(await getContaValida());
    } catch {
      /* o nome é enfeite: token gravado já basta para conectar */
    }
    return volta("shopee=1");
  } catch (e) {
    return volta(`erro=${encodeURIComponent(e.message)}`);
  }
}
