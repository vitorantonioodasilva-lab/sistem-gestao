import { NextResponse } from "next/server";
import { analisar, converter, documentos } from "@/lib/etiquetas";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_ARQUIVOS = 12;
const MAX_BYTES = 25 * 1024 * 1024;

/** Tira acento e caractere estranho do nome, que vai virar cabeçalho HTTP. */
function nomeSeguro(texto) {
  return (
    texto
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "etiquetas"
  );
}

async function lerArquivos(form) {
  const enviados = form.getAll("arquivos").filter((a) => typeof a?.arrayBuffer === "function");

  if (!enviados.length) throw new Error("Nenhum arquivo enviado.");
  if (enviados.length > MAX_ARQUIVOS)
    throw new Error(`No máximo ${MAX_ARQUIVOS} arquivos por vez.`);

  const total = enviados.reduce((s, a) => s + (a.size || 0), 0);
  if (total > MAX_BYTES)
    throw new Error("Os arquivos somam mais de 25 MB. Envie em partes menores.");

  return Promise.all(
    enviados.map(async (a) => ({
      nome: a.name || "etiqueta.pdf",
      bytes: new Uint8Array(await a.arrayBuffer()),
    })),
  );
}

export async function POST(req) {
  let form;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ erro: "Envio inválido." }, { status: 400 });
  }

  let arquivos;
  try {
    arquivos = await lerArquivos(form);
  } catch (e) {
    return NextResponse.json({ erro: e.message }, { status: 400 });
  }

  const acao = String(form.get("acao") || "converter");

  if (acao === "analisar") {
    try {
      return NextResponse.json({ arquivos: await analisar(arquivos) });
    } catch (e) {
      return NextResponse.json({ erro: e.message }, { status: 500 });
    }
  }

  if (acao === "documentos") {
    try {
      const pdf = await documentos(arquivos);
      return new NextResponse(Buffer.from(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="documentos-a4.pdf"',
        },
      });
    } catch (e) {
      return NextResponse.json({ erro: e.message }, { status: 422 });
    }
  }

  let opcoes = {};
  try {
    opcoes = JSON.parse(form.get("opcoes") || "{}");
  } catch {
    /* sem opções: o conversor usa os padrões */
  }

  try {
    const { pdf, resumo } = await converter(arquivos, opcoes);
    const base =
      arquivos.length === 1
        ? nomeSeguro(arquivos[0].nome.replace(/\.pdf$/i, ""))
        : `etiquetas-${arquivos.length}-arquivos`;

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${base}-termica.pdf"`,
        "X-Resumo": encodeURIComponent(JSON.stringify(resumo)),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { erro: e.message, resumo: e.resumo || [] },
      { status: 422 },
    );
  }
}
