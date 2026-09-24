import { NextResponse } from "next/server";
import { authUrl, configurada } from "@/lib/shopee";

export const runtime = "nodejs";

export async function GET() {
  if (!configurada() || !process.env.SHOPEE_REDIRECT_URI) {
    return NextResponse.json(
      {
        erro:
          "Configure SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY e SHOPEE_REDIRECT_URI nas variáveis de ambiente.",
      },
      { status: 400 },
    );
  }
  // A Shopee não repassa state: a conferência da volta é pelo shop_id.
  return NextResponse.redirect(authUrl());
}
