import { montarPainel } from "./margem";
import { getConfigs } from "./db";

const HOST = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Nomes de modelo do Gemini mudam com frequência. Tenta o configurado
 * primeiro e cai para os seguintes se der 404.
 */
const FALLBACK = [
  "gemini-3.7-flash",
  "gemini-3-pro-preview",
  "gemini-flash-latest",
  "gemini-2.0-flash",
];

const brl = (v) =>
  (Number(v) || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
const pct = (v) =>
  v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}%`;

/**
 * Monta o dossiê enviado ao modelo. Só números agregados do próprio negócio:
 * nada de dado de comprador, endereço ou documento.
 */
export function montarDossie(painel) {
  const d = painel.dre;
  const ads = painel.ads || {};

  const produtos = (painel.produtos || [])
    .filter((p) => p.unidades_vendidas > 0 || p.ads_custo > 0)
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 25)
    .map((p) => ({
      produto: p.titulo?.slice(0, 60),
      sku: p.sku || null,
      preco: p.preco_anuncio,
      custo_compra: p.custo_unitario,
      unidades: p.unidades_vendidas,
      receita: p.receita,
      lucro: p.lucro,
      margem_pct: p.margem === null ? null : Number(p.margem.toFixed(1)),
      ads_gasto: p.ads_custo,
      ads_acos_pct: p.ads_acos === null ? null : Number(p.ads_acos.toFixed(1)),
      ads_cliques: p.ads_clicks,
      lucro_antes_do_ads: p.lucro_sem_ads,
      estoque: p.estoque_atual,
      cobertura_dias:
        p.cobertura_dias === null ? null : Math.round(p.cobertura_dias),
      curva: p.curva,
      sem_custo_cadastrado: !p.custo_unitario,
    }));

  return {
    periodo_dias: painel.dias,
    resultado: {
      receita_bruta: d.receita,
      tarifa_mercado_livre: d.tarifa,
      frete_pago_pelo_vendedor: d.frete,
      custo_dos_produtos: d.cmv,
      imposto: d.imposto,
      publicidade_rateada: d.ads,
      publicidade_sem_venda: d.ads_sem_venda,
      custo_fixo: d.custo_fixo,
      margem_contribuicao: d.margem_contribuicao,
      lucro_operacional: d.lucro_operacional,
      margem_pct: Number(d.margem_pct?.toFixed(1)),
      pedidos: d.pedidos,
      cancelados: d.cancelados,
      ticket_medio: d.ticket_medio,
    },
    publicidade: {
      investido: ads.investido,
      receita_atribuida: ads.receita_atribuida,
      acos_pct: ads.acos === null ? null : Number(ads.acos?.toFixed(1)),
      roas: ads.roas === null ? null : Number(ads.roas?.toFixed(2)),
      pct_da_receita: Number(ads.pct_receita?.toFixed(1)),
    },
    produtos,
    alertas: (painel.alertas || []).map((a) => a.texto).slice(0, 15),
  };
}

const INSTRUCAO = `Você é um analista de e-commerce que assessora um vendedor do Mercado Livre no Brasil.
Recebe os números reais da operação dele nos últimos dias e deve dizer o que fazer.

Regras:
- Escreva em português do Brasil, direto, sem jargão e sem enrolação.
- Baseie CADA afirmação nos números recebidos. Cite o número junto da recomendação.
- Se um dado essencial estiver faltando (por exemplo custo de compra zerado), diga que a conclusão fica comprometida e que isso precisa ser preenchido antes.
- Nunca invente números que não estão nos dados.
- Priorize: primeiro o que está drenando dinheiro, depois o que pode crescer.
- Seja específico: qual produto, qual ação, qual número muda.

Responda SOMENTE com um JSON válido, sem markdown, sem crases, neste formato:
{
  "resumo": "2 a 3 frases sobre a saúde da operação",
  "diagnosticos": [
    {
      "titulo": "curto e direto",
      "gravidade": "critico" | "atencao" | "oportunidade",
      "achado": "o que os números mostram, com os valores",
      "acao": "o que fazer, concreto",
      "impacto": "o que muda em reais ou em pontos de margem, se der para estimar"
    }
  ],
  "perguntas": ["até 3 perguntas cuja resposta melhoraria a análise"]
}
Entre 3 e 6 diagnósticos, ordenados do mais urgente ao menos.`;

async function tentarModelo(modelo, chave, dossie) {
  const r = await fetch(`${HOST}/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": chave, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCAO }] },
      contents: [
        {
          parts: [
            {
              text: `Dados da operação:\n\n${JSON.stringify(dossie, null, 1)}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });

  const texto = await r.text();
  let corpo;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = { error: { message: texto.slice(0, 300) } };
  }
  if (!r.ok) {
    const e = new Error(corpo.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return corpo;
}

export async function analisar(dias = 30) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) {
    const e = new Error(
      "Falta a variável GEMINI_API_KEY na Vercel. Pegue a chave em aistudio.google.com e faça redeploy.",
    );
    e.configuracao = true;
    throw e;
  }

  const painel = await montarPainel(dias);
  const dossie = montarDossie(painel);
  const cfg = await getConfigs();

  const ordem = [cfg.gemini_modelo, ...FALLBACK].filter(
    (m, i, a) => m && a.indexOf(m) === i,
  );

  let ultimo;
  for (const modelo of ordem) {
    try {
      const resposta = await tentarModelo(modelo, chave, dossie);
      const bruto =
        resposta.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("") || "";
      const limpo = bruto.replace(/```json|```/g, "").trim();

      let analise;
      try {
        analise = JSON.parse(limpo);
      } catch {
        analise = {
          resumo: limpo.slice(0, 1200),
          diagnosticos: [],
          perguntas: [],
        };
      }

      return { analise, modelo, dossie, gerado_em: new Date().toISOString() };
    } catch (e) {
      ultimo = e;
      // 404 = nome de modelo aposentado, tenta o próximo. Outros erros são reais.
      if (e.status !== 404) throw e;
    }
  }
  throw ultimo || new Error("Nenhum modelo do Gemini respondeu.");
}

export { brl, pct };
