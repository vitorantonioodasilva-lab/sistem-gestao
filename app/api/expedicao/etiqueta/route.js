import { NextResponse } from "next/server";
import { getTokenValido } from "@/lib/ml";
import {
  montarEtiquetas,
  etiquetasZpl,
  recorteConfigurado,
  marcar,
} from "@/lib/expedicao";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    return NextResponse.json(
      { erro: "Nenhum envio selecionado." },
      { status: 400 },
    );
  }
  if (ids.length > 50) {
    return NextResponse.json(
      { erro: "O Mercado Livre aceita no máximo 50 etiquetas por vez." },
      { status: 400 },
    );
  }

  const formato = url.searchParams.get("formato") || "pdf";
  const inteira = url.searchParams.get("inteira") === "1";

  try {
    const { token } = await getTokenValido();

    if (formato === "zpl") {
      const zip = await etiquetasZpl(token, ids);
      await marcar(ids, "impresso");
      return new NextResponse(Buffer.from(zip), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="etiquetas-${ids.length}.zip"`,
        },
      });
    }

    const cfg = await recorteConfigurado();
    const { pdf, falhas } = await montarEtiquetas(token, ids, {
      apenasPrimeira: !inteira,
      recortar: inteira ? false : cfg.recortar,
      recorte: cfg.recorte,
    });

    await marcar(
      ids.filter(
        (id) => !falhas.some((f) => String(f.shipment_id) === String(id)),
      ),
      "impresso",
    );

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="etiquetas-${ids.length}.pdf"`,
        "X-Falhas": String(falhas.length),
      },
    });
  } catch (e) {
    const status =
      e.message === "SEM_CONTA" || e.message === "RECONECTAR" ? 409 : 500;
    return NextResponse.json(
      { erro: e.message, falhas: e.falhas || [] },
      { status },
    );
  }
}
