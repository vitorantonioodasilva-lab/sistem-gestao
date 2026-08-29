import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnóstico. Diz o que está faltando sem expor segredo nenhum.
 * Acesse /api/diag já logado no painel.
 */
export async function GET() {
  const out = {
    variaveis: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      ML_CLIENT_ID: Boolean(process.env.ML_CLIENT_ID),
      ML_CLIENT_SECRET: Boolean(process.env.ML_CLIENT_SECRET),
      ML_REDIRECT_URI: process.env.ML_REDIRECT_URI || null,
      APP_PASSWORD: Boolean(process.env.APP_PASSWORD),
    },
    banco: { ok: false },
  };

  const url = process.env.DATABASE_URL;
  if (!url) {
    out.banco.erro =
      "DATABASE_URL não existe neste deploy. Cadastre na Vercel e faça redeploy.";
    return NextResponse.json(out, { status: 200 });
  }

  // Formato da string, sem revelar a senha.
  try {
    const u = new URL(url);
    out.banco.protocolo = u.protocol.replace(":", "");
    out.banco.host = u.hostname;
    out.banco.porta = u.port || "5432";
    out.banco.database = u.pathname.replace("/", "") || null;
    out.banco.tem_usuario = Boolean(u.username);
    out.banco.tem_senha = Boolean(u.password);
    if (!["postgres", "postgresql"].includes(out.banco.protocolo)) {
      out.banco.aviso =
        "A string não é postgres://. Use a connection string direta do Postgres, não uma URL de API/pooler proprietário.";
    }
  } catch {
    out.banco.erro =
      "DATABASE_URL não é uma URL válida. Confira se não colou com aspas ou espaço.";
    return NextResponse.json(out, { status: 200 });
  }

  // Conexão de verdade.
  try {
    const { query } = await import("@/lib/db");
    const r = await query("SELECT current_database() AS db, version() AS v");
    out.banco.ok = true;
    out.banco.conectado_em = r.rows[0].db;
    out.banco.versao = String(r.rows[0].v).split(" ").slice(0, 2).join(" ");

    const t = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    out.banco.tabelas = t.rows.map((x) => x.table_name);
  } catch (e) {
    out.banco.erro = e.message;
    out.banco.codigo = e.code || null;
    out.banco.dica = dica(e);
  }

  // Publicidade: mostra qual caminho da API de Ads respondeu.
  try {
    const { getTokenValido } = await import("@/lib/ml");
    const { diagnosticoAds } = await import("@/lib/ads");
    const { token, sellerId } = await getTokenValido();
    out.ads = await diagnosticoAds(token, sellerId);
  } catch (e) {
    out.ads = { erro: e.message };
  }

  return NextResponse.json(out, { status: 200 });
}

function dica(e) {
  const m = (e.message || "").toLowerCase();
  if (e.code === "28P01" || m.includes("password authentication"))
    return "Usuário ou senha errados. Copie a connection string de novo, inteira.";
  if (e.code === "3D000")
    return "O banco citado na URL não existe nesse servidor.";
  if (e.code === "42501")
    return "Usuário sem permissão para criar tabelas no schema public.";
  if (m.includes("enotfound") || m.includes("getaddrinfo"))
    return "Host não encontrado. Confira se o endereço do servidor está correto.";
  if (m.includes("timeout") || m.includes("etimedout"))
    return "Sem resposta do servidor. Provável bloqueio de IP: libere acesso externo no painel do banco.";
  if (m.includes("ssl") || m.includes("self signed"))
    return "Problema de SSL. Acrescente ?sslmode=require no fim da DATABASE_URL.";
  if (m.includes("too many") || m.includes("connection slots"))
    return "Limite de conexões atingido. Use a string do pooler do seu provedor.";
  return "Copie esta mensagem e me mande.";
}
