import { query, getConfig, setConfig } from "./db";

const API = "https://api.mercadolibre.com";
const SITE_PADRAO = process.env.ML_SITE_ID || "MLB";

const METRICAS = [
  "clicks",
  "prints",
  "cost",
  "cpc",
  "acos",
  "organic_units_quantity",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_amount",
  "indirect_amount",
  "total_amount",
].join(",");

const n = (v) => Number(v ?? 0);
const dia = (d) => new Date(d).toISOString().slice(0, 10);

async function chamar(url, token, versao = "2") {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Api-Version": versao,
      "Content-Type": "application/json",
    },
  });
  const texto = await r.text();
  let corpo;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = { message: texto.slice(0, 300) };
  }
  if (!r.ok) {
    const e = new Error(corpo.message || corpo.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.corpo = corpo;
    throw e;
  }
  return corpo;
}

/**
 * A API de publicidade mudou de caminho: o que era /advertising/advertisers/...
 * virou /marketplace/advertising/{site}/advertisers/... e alguns recursos
 * ganharam /search no fim. A documentação oficial não é consistente sobre
 * quais, então tentamos as variantes e guardamos a que respondeu.
 */
function caminhosAds(site, adv, tipo) {
  const base = `${API}/marketplace/advertising/${site}/advertisers/${adv}/product_ads`;
  const legado = `${API}/advertising/advertisers/${adv}/product_ads`;
  if (tipo === "ads") {
    return [`${base}/ads/search`, `${base}/ads`, `${legado}/items`];
  }
  return [
    `${base}/campaigns/search`,
    `${base}/campaigns`,
    `${legado}/campaigns`,
  ];
}

/** Testa as variantes e devolve a que funcionou, memorizando a escolha. */
async function resolver(token, site, adv, tipo, queryString) {
  const chaveConfig = `ads_rota_${tipo}`;
  const salva = await getConfig(chaveConfig);
  const candidatos = caminhosAds(site, adv, tipo);
  const ordem = salva
    ? [salva, ...candidatos.filter((c) => c !== salva)]
    : candidatos;

  let ultimo;
  for (const base of ordem) {
    try {
      const dados = await chamar(`${base}?${queryString}`, token, "2");
      if (base !== salva) await setConfig(chaveConfig, base);
      return { dados, base };
    } catch (e) {
      ultimo = e;
      // 404 = caminho errado, tenta o próximo. Outros erros são reais.
      if (e.status !== 404) throw e;
    }
  }
  throw ultimo || new Error("Nenhuma rota de Ads respondeu");
}

/**
 * Descobre o advertiser_id da conta. É um id da publicidade, diferente
 * do seller_id. Fica guardado para não consultar toda vez.
 */
export async function getAnunciante(token, sellerId, forcar = false) {
  if (!forcar) {
    const salvo = await getConfig("ads_advertiser_id");
    if (salvo) {
      return {
        advertiser_id: salvo,
        site_id: await getConfig("ads_site_id", SITE_PADRAO),
      };
    }
  }

  const url = `${API}/advertising/advertisers?product_id=PADS${sellerId ? `&user_id=${sellerId}` : ""}`;
  const dados = await chamar(url, token, "1");
  const lista = dados.advertisers || [];
  if (!lista.length) {
    const e = new Error("ADS_SEM_ANUNCIANTE");
    e.status = 404;
    throw e;
  }
  const escolhido = lista.find((a) => a.site_id === SITE_PADRAO) || lista[0];
  await setConfig("ads_advertiser_id", escolhido.advertiser_id);
  await setConfig("ads_site_id", escolhido.site_id);
  await setConfig("ads_advertiser_nome", escolhido.advertiser_name || "");
  return escolhido;
}

/** Custo por anúncio num único dia. */
async function custoDoDia(token, site, adv, data) {
  const linhas = [];
  const limite = 50;
  for (let pagina = 0; pagina < 20; pagina++) {
    const qs =
      `limit=${limite}&offset=${pagina * limite}` +
      `&date_from=${data}&date_to=${data}&metrics=${METRICAS}`;
    const { dados } = await resolver(token, site, adv, "ads", qs);
    const res = dados.results || [];
    for (const r of res) {
      const m = r.metrics || r.metrics_summary || {};
      if (n(m.cost) === 0 && n(m.clicks) === 0 && n(m.prints) === 0) continue;
      linhas.push({
        item_id: r.item_id,
        data,
        campaign_id: r.campaign_id || null,
        custo: n(m.cost),
        clicks: n(m.clicks),
        prints: n(m.prints),
        unidades_diretas: n(m.direct_units_quantity),
        unidades_indiretas: n(m.indirect_units_quantity),
        unidades_organicas: n(m.organic_units_quantity),
        receita_ads: n(m.total_amount),
      });
    }
    const total = n(dados.paging?.total);
    if (res.length < limite || (pagina + 1) * limite >= total) break;
  }
  return linhas;
}

/**
 * Total investido por dia, no período inteiro. Uma única chamada,
 * usando a agregação diária das campanhas.
 */
async function totaisDiarios(token, site, adv, de, ate) {
  const qs =
    `limit=100&offset=0&date_from=${de}&date_to=${ate}` +
    `&metrics=cost,clicks,prints,units_quantity,total_amount&aggregation_type=DAILY`;
  const { dados } = await resolver(token, site, adv, "campanhas", qs);
  const linhas = Array.isArray(dados) ? dados : dados.results || [];
  const porDia = new Map();
  for (const l of linhas) {
    const d = l.date || l.data;
    if (!d) continue;
    const chave = dia(d);
    const cur = porDia.get(chave) || { custo: 0, receita: 0 };
    cur.custo += n(l.cost ?? l.metrics?.cost);
    cur.receita += n(l.total_amount ?? l.metrics?.total_amount);
    porDia.set(chave, cur);
  }
  return porDia;
}

/**
 * Sincroniza o investimento em publicidade.
 * Dias antigos já gravados não são buscados de novo; os 3 últimos sim,
 * porque o Mercado Livre ainda ajusta os números recentes (a validação
 * das métricas roda às 10h GMT-3).
 */
export async function sincronizarAds(token, sellerId, dias = 30) {
  const inicio = Date.now();
  const ORCAMENTO_MS = 45000; // deixa folga antes do limite da função

  let anunciante;
  try {
    anunciante = await getAnunciante(token, sellerId);
  } catch (e) {
    const motivo =
      e.status === 404 || e.status === 403
        ? "Conta sem Product Ads. Ative em Mercado Livre > Gestão de anúncios > Campanha de publicidade."
        : e.message;
    await setConfig("ads_status", motivo);
    return { ativo: false, motivo };
  }

  const site = anunciante.site_id || SITE_PADRAO;
  const adv = anunciante.advertiser_id;
  const hoje = new Date();
  const limite = Math.min(Number(dias) || 30, 90);

  const alvo = [];
  for (let i = 1; i <= limite; i++) {
    alvo.push(dia(new Date(hoje.getTime() - i * 86400000)));
  }
  const primeiro = alvo[alvo.length - 1];
  const ultimo = alvo[0];

  // Totais do período inteiro numa chamada só.
  let totais = new Map();
  try {
    totais = await totaisDiarios(token, site, adv, primeiro, ultimo);
    for (const [d, v] of totais) {
      await query(
        `INSERT INTO ads_diario (data, custo_total, receita_ads, atualizado_em)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (data) DO UPDATE SET
           custo_total = EXCLUDED.custo_total,
           receita_ads = EXCLUDED.receita_ads,
           atualizado_em = now()`,
        [d, v.custo, v.receita],
      );
    }
  } catch (e) {
    await setConfig(
      "ads_status",
      `Falha ao ler campanhas: ${e.status || ""} ${e.message}`,
    );
    return { ativo: false, motivo: e.message };
  }

  // Detalhe por anúncio, dia a dia. Só faz sentido nos dias que tiveram gasto.
  const jaTem = await query(
    `SELECT DISTINCT data::text AS d FROM ads_custos WHERE data >= $1`,
    [primeiro],
  );
  const gravados = new Set(jaTem.rows.map((r) => r.d));
  const corte = dia(new Date(hoje.getTime() - 3 * 86400000));

  const pendentes = alvo.filter((d) => {
    const t = totais.get(d);
    if (!t || t.custo === 0) return false; // dia sem investimento
    return !gravados.has(d) || d >= corte;
  });

  let linhas = 0;
  let erros = 0;
  let ultimoErro = null;
  let processados = 0;

  for (const d of pendentes) {
    if (Date.now() - inicio > ORCAMENTO_MS) break; // continua na próxima rodada
    try {
      const itens = await custoDoDia(token, site, adv, d);
      await query(`DELETE FROM ads_custos WHERE data = $1`, [d]);
      for (const l of itens) {
        await query(
          `INSERT INTO ads_custos
             (item_id, data, campaign_id, custo, clicks, prints,
              unidades_diretas, unidades_indiretas, unidades_organicas, receita_ads)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (item_id, data) DO UPDATE SET
             custo = EXCLUDED.custo, clicks = EXCLUDED.clicks, prints = EXCLUDED.prints,
             unidades_diretas = EXCLUDED.unidades_diretas,
             unidades_indiretas = EXCLUDED.unidades_indiretas,
             unidades_organicas = EXCLUDED.unidades_organicas,
             receita_ads = EXCLUDED.receita_ads`,
          [
            l.item_id,
            l.data,
            l.campaign_id,
            l.custo,
            l.clicks,
            l.prints,
            l.unidades_diretas,
            l.unidades_indiretas,
            l.unidades_organicas,
            l.receita_ads,
          ],
        );
        linhas++;
      }
      processados++;
    } catch (e) {
      erros++;
      ultimoErro = `${e.status || ""} ${e.message}`.trim();
      if (e.status === 429) break;
    }
  }

  const faltam = pendentes.length - processados - erros;
  const status = erros
    ? `${erros} dia(s) com falha: ${ultimoErro}`
    : faltam > 0
      ? `ok — faltam ${faltam} dia(s), rode a sincronização de novo`
      : "ok";
  await setConfig("ads_status", status);
  await setConfig("ads_sync_em", new Date().toISOString());

  return {
    ativo: true,
    advertiser_id: adv,
    site,
    dias_totais: totais.size,
    dias_detalhados: processados,
    faltam,
    linhas,
    erros,
  };
}

/** Diagnóstico: mostra qual caminho da API respondeu. */
export async function diagnosticoAds(token, sellerId) {
  const out = { advertiser: null, rotas: {} };
  try {
    const a = await getAnunciante(token, sellerId, true);
    out.advertiser = {
      id: a.advertiser_id,
      site: a.site_id,
      nome: a.advertiser_name,
    };
    const ontem = dia(new Date(Date.now() - 86400000));
    for (const tipo of ["ads", "campanhas"]) {
      for (const base of caminhosAds(
        out.advertiser.site,
        out.advertiser.id,
        tipo,
      )) {
        const qs = `limit=1&offset=0&date_from=${ontem}&date_to=${ontem}&metrics=cost,clicks`;
        try {
          await chamar(`${base}?${qs}`, token, "2");
          out.rotas[tipo] = { ok: base };
          break;
        } catch (e) {
          out.rotas[tipo] = out.rotas[tipo] || { tentativas: [] };
          out.rotas[tipo].tentativas = [
            ...(out.rotas[tipo].tentativas || []),
            { url: base.replace(API, ""), status: e.status, msg: e.message },
          ];
        }
      }
    }
  } catch (e) {
    out.erro = `${e.status || ""} ${e.message}`.trim();
  }
  return out;
}

/** Custo de publicidade por anúncio dentro de um período. */
export async function adsPorItem(desde) {
  const r = await query(
    `SELECT item_id,
            SUM(custo)              AS custo,
            SUM(clicks)             AS clicks,
            SUM(prints)             AS prints,
            SUM(unidades_diretas)   AS unidades_diretas,
            SUM(unidades_indiretas) AS unidades_indiretas,
            SUM(receita_ads)        AS receita_ads
       FROM ads_custos
      WHERE data >= $1
      GROUP BY item_id`,
    [dia(desde)],
  );
  const mapa = new Map();
  for (const row of r.rows) {
    mapa.set(row.item_id, {
      custo: n(row.custo),
      clicks: n(row.clicks),
      prints: n(row.prints),
      unidades_diretas: n(row.unidades_diretas),
      unidades_indiretas: n(row.unidades_indiretas),
      receita_ads: n(row.receita_ads),
    });
  }
  return mapa;
}

/** Total investido no período, direto do consolidado por campanha. */
export async function adsTotal(desde) {
  const r = await query(
    `SELECT COALESCE(SUM(custo_total),0) AS custo,
            COALESCE(SUM(receita_ads),0) AS receita,
            COUNT(*) AS dias
       FROM ads_diario WHERE data >= $1`,
    [dia(desde)],
  );
  return {
    custo: n(r.rows[0]?.custo),
    receita: n(r.rows[0]?.receita),
    dias: n(r.rows[0]?.dias),
  };
}

/** Série diária de investimento. */
export async function adsSerie(desde) {
  const r = await query(
    `SELECT data::text AS dia, custo_total, receita_ads
       FROM ads_diario WHERE data >= $1 ORDER BY data`,
    [dia(desde)],
  );
  return r.rows.map((x) => ({
    dia: x.dia,
    custo: n(x.custo_total),
    receita: n(x.receita_ads),
  }));
}
