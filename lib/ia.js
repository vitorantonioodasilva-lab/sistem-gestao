import { montarPainel } from "./margem";
import { getConfig, setConfig } from "./db";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Os nomes de modelo do Gemini mudam com frequência e alguns aliases já
 * ficaram instáveis. Por isso o modelo é configurável e há uma lista de
 * reserva: se um falhar com 404, tenta o próximo e memoriza o que funcionou.
 */
const MODELOS = [
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-pro-latest",
  "gemini-2.5-flash",
];

/**
 * Monta um retrato compacto da operação. Só números agregados — nada de
 * dados de comprador, endereço ou documento sai daqui.
 */
export async function montarContexto(dias = 30) {
  const p = await montarPainel(dias);

  const produtos = (p.produtos || [])
    .filter((x) => x.unidades_vendidas > 0 || x.ads_custo > 0)
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 25)
    .map((x) => ({
      produto: x.titulo?.slice(0, 70),
      sku: x.sku || null,
      preco: round(x.preco_anuncio),
      custo_compra: round(x.custo_unitario),
      unidades: x.unidades_vendidas,
      receita: round(x.receita),
      lucro: round(x.lucro),
      margem_pct: round(x.margem),
      ads_custo: round(x.ads_custo),
      ads_acos_pct: round(x.ads_acos),
      ads_cliques: x.ads_clicks,
      lucro_sem_ads: round(x.lucro_sem_ads),
      estoque: x.estoque_atual,
      cobertura_dias: round(x.cobertura_dias),
      curva: x.curva,
    }));

  return {
    periodo_dias: dias,
    resultado: {
      receita_bruta: round(p.dre.receita),
      tarifa_ml: round(p.dre.tarifa),
      frete_vendedor: round(p.dre.frete),
      custo_produtos: round(p.dre.cmv),
      imposto: round(p.dre.imposto),
      ads_rateado: round(p.dre.ads),
      ads_sem_venda: round(p.dre.ads_sem_venda),
      custo_fixo: round(p.dre.custo_fixo),
      margem_contribuicao: round(p.dre.margem_contribuicao),
      lucro_operacional: round(p.dre.lucro_operacional),
      margem_pct: round(p.dre.margem_pct),
      pedidos: p.dre.pedidos,
      ticket_medio: round(p.dre.ticket_medio),
    },
    publicidade: p.ads?.investido
      ? {
          investido: round(p.ads.investido),
          receita_atribuida: round(p.ads.receita_atribuida),
          acos_pct: round(p.ads.acos),
          roas: round(p.ads.roas),
          pct_da_receita: round(p.ads.pct_receita),
          gasto_sem_venda: round(p.ads.sem_venda),
        }
      : null,
    produtos,
    alertas: (p.alertas || []).map((a) => a.texto).slice(0, 12),
    produtos_sem_custo_cadastrado: (p.produtos || []).filter(
      (x) => !x.custo_unitario && x.unidades_vendidas > 0,
    ).length,
  };
}

const round = (v) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? null
    : Math.round(Number(v) * 100) / 100;

const INSTRUCAO = `Você é um analista de e-commerce especializado em vendedores do Mercado Livre no Brasil.
Recebe os números reais de uma operação e devolve um diagnóstico direto e acionável.

Regras:
- Fale em português do Brasil, direto, sem jargão e sem elogio vazio.
- Use SOMENTE os números fornecidos. Nunca invente dados. Se algo essencial faltar, diga o que falta.
- Se "produtos_sem_custo_cadastrado" for maior que zero, avise que o lucro está inflado e que esse é o primeiro problema a resolver.
- Priorize pelo impacto em reais, não pela porcentagem. Um item com 2% de margem e alto volume importa mais que um de 40% que vende três unidades.
- Ao sugerir preço, considere que a tarifa do Mercado Livre é percentual: subir preço aumenta a tarifa junto.
- Seja específico: cite o produto e o número. "Aumentar preço" não serve; "subir o item X de R$ 40 para R$ 44 recupera cerca de R$ Y por mês" serve.

Responda APENAS com JSON válido, sem markdown e sem cercas de código, neste formato:
{
  "resumo": "2 a 3 frases sobre a saúde da operação",
  "semaforo": "verde" | "amarelo" | "vermelho",
  "achados": [
    { "titulo": "curto", "gravidade": "alta"|"media"|"baixa", "explicacao": "o que está acontecendo e por quê, com números", "acao": "o que fazer exatamente", "impacto_estimado": "quanto isso vale em reais por mês, ou null se não der para estimar" }
  ],
  "ads": "análise específica da publicidade, ou null se não houver dados",
  "primeira_coisa_a_fazer": "a única ação mais importante da semana"
}
Devolva entre 3 e 6 achados.`;

async function chamarGemini(modelo, chave, contexto) {
  const r = await fetch(`${BASE}/models/${modelo}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCAO }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Analise esta operação e devolva o JSON pedido.\n\n${JSON.stringify(contexto, null, 1)}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2600,
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

export async function diagnosticar(dias = 30) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) {
    const e = new Error(
      "Falta a variável GEMINI_API_KEY na Vercel. Gere a chave em aistudio.google.com e faça redeploy.",
    );
    e.status = 400;
    throw e;
  }

  const contexto = await montarContexto(dias);
  if (!contexto.resultado.pedidos) {
    const e = new Error("Ainda não há vendas no período para analisar.");
    e.status = 400;
    throw e;
  }

  const preferido = await getConfig("ia_modelo");
  const ordem = preferido
    ? [preferido, ...MODELOS.filter((m) => m !== preferido)]
    : MODELOS;

  let ultimoErro;
  for (const modelo of ordem) {
    try {
      const corpo = await chamarGemini(modelo, chave, contexto);
      const bruto = (corpo.candidates?.[0]?.content?.parts || [])
        .map((x) => x.text || "")
        .join("")
        .replace(/```json|```/g, "")
        .trim();

      let analise;
      try {
        analise = JSON.parse(bruto);
      } catch {
        analise = {
          resumo: bruto.slice(0, 1200),
          achados: [],
          semaforo: "amarelo",
        };
      }

      if (modelo !== preferido) await setConfig("ia_modelo", modelo);
      await setConfig("ia_ultimo_em", new Date().toISOString());

      return {
        ...analise,
        modelo,
        contexto,
        gerado_em: new Date().toISOString(),
      };
    } catch (e) {
      ultimoErro = e;
      // 404 = modelo inexistente ou desativado, tenta o próximo.
      if (e.status !== 404) throw e;
    }
  }
  throw ultimoErro || new Error("Nenhum modelo do Gemini respondeu.");
}
