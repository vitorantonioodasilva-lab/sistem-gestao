import { NextResponse } from "next/server";
import { analisar } from "@/lib/diagnostico";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req) {
  const dias = Number(new URL(req.url).searchParams.get("dias") || 30);
  try {
    const r = await analisar(dias);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, configuracao: Boolean(e.configuracao) },
      { status: e.configuracao ? 400 : 500 },
    );
  }
}
