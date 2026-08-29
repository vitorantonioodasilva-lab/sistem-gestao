import { query, getConfig, setConfig } from "./db";

const API = "https://api.mercadolibre.com";
const SITE = process.env.ML_SITE_ID || "MLB";

/** Métricas que interessam para o cálculo de margem. */
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
    corpo = { message: texto.slice(0, 200) };
  }
  if (!r.ok) {
    const e = new Error(corpo.message || corpo.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return corpo;
}

/**
 * Descobre o advertiser_id da conta. É um id próprio da publicidade,
 * diferente do seller_id. Fica guardado para não consultar toda vez.
 */
export async function getAnunciante(token, forcar = false) {
  if (!forcar) {
    const salvo = await getConfig("ads_advertiser_id");
    if (salvo)
      return {
        advertiser_id: salvo,
        site_id: await getConfig("ads_site_id", SITE),
      };
  }

  const dados = await chamar(
    `${API}/advertising/advertisers?product_id=PADS`,
    token,
    "1",
  );
  const lista = dados.advertisers || [];
  if (!lista.length) {
    const e = new Error("ADS_SEM_ANUNCIANTE");
    e.status = 404;
    throw e;
  }
  const escolhido = lista.find((a) => a.site_id === SITE) || lista[0];
  await setConfig("ads_advertiser_id", escolhido.advertiser_id);
  await setConfig("ads_site_id", escolhido.site_id);
  await setConfig("ads_advertiser_nome", escolhido.advertiser_name || "");
  return escolhido;
}

/** Custo por anúncio num único dia. Uma chamada paginada por dia. */
async function custoDoDia(token, advertiserId, data) {
  const linhas = [];
  const limite = 50;
  for (let pagina = 0; pagina < 20; pagina++) {
    const url =
      `${API}/advertising/advertisers/${advertiserId}/product_ads/items` +
      `?limit=${limite}&offset=${pagina * limite}` +
      `&date_from=${data}&date_to=${data}&metrics=${METRICAS}`;
    const dados = await chamar(url, token, "2");
    const res = dados.results || [];
    for (const r of res) {
      const m = r.metrics || {};
      // Só guarda o que teve movimento — evita inchar a tabela com zeros.
      if (n(m.cost) === 0 && n(m.clicks) === 0 && n(m.prints) === 0) continue;
      linhas.push({
        item_id: r.item_id,
        data,
        campaign_id: r.campaign_id ?? null,
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

/** Total diário das campanhas. Serve de referência para conferir o rateio. */
async function totalDoDia(token, advertiserId, data) {
  const url =
    `${API}/advertising/advertisers/${advertiserId}/product_ads/campaigns` +
    `?limit=100&offset=0&date_from=${data}&date_to=${data}` +
    `&metrics=cost,clicks,prints,units_quantity,total_amount`;
  const dados = await chamar(url, token, "2");
  let custo = 0;
  let receita = 0;
  for (const c of dados.results || []) {
    custo += n(c.metrics?.cost);
    receita += n(c.metrics?.total_amount);
  }
  return { custo, receita };
}

/**
 * Sincroniza o investimento em publicidade.
 * Dias já fechados não são buscados de novo; os 3 últimos sim,
 * porque o Mercado Livre ainda ajusta os números recentes.
 */
export async function sincronizarAds(token, dias = 30) {
  let anunciante;
  try {
    anunciante = await getAnunciante(token);
  } catch (e) {
    const motivo =
      e.status === 404 || e.status === 403
        ? "Conta sem Product Ads habilitado. Ative em Mercado Livre > Meu perfil > Publicidade."
        : e.message;
    await setConfig("ads_status", motivo);
    return { ativo: false, motivo, dias: 0, linhas: 0 };
  }

  const hoje = new Date();
  const limite = Math.min(Number(dias) || 30, 90);
  const alvo = [];
  for (let i = 1; i <= limite; i++) {
    alvo.push(dia(new Date(hoje.getTime() - i * 86400000)));
  }

  // O que já está gravado e é antigo o bastante para estar consolidado.
  const corte = dia(new Date(hoje.getTime() - 3 * 86400000));
  const jaTem = await query(
    `SELECT DISTINCT data::text AS d FROM ads_diario WHERE data >= $1`,
    [alvo[alvo.length - 1]],
  );
  const gravados = new Set(jaTem.rows.map((r) => r.d));
  const faltando = alvo.filter((d) => !gravados.has(d) || d >= corte);

  let linhas = 0;
  let erros = 0;
  let ultimoErro = null;

  for (const d of faltando) {
    try {
      const [itens, total] = await Promise.all([
        custoDoDia(token, anunciante.advertiser_id, d),
        totalDoDia(token, anunciante.advertiser_id, d),
      ]);

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

      await query(
        `INSERT INTO ads_diario (data, custo_total, receita_ads, atualizado_em)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (data) DO UPDATE SET
           custo_total = EXCLUDED.custo_total,
           receita_ads = EXCLUDED.receita_ads,
           atualizado_em = now()`,
        [d, total.custo, total.receita],
      );
    } catch (e) {
      erros++;
      ultimoErro = e.message;
      if (e.status === 429) break; // respeita o limite de chamadas
    }
  }

  await setConfig(
    "ads_status",
    erros ? `${erros} dia(s) com falha: ${ultimoErro}` : "ok",
  );
  await setConfig("ads_sync_em", new Date().toISOString());

  return {
    ativo: true,
    advertiser_id: anunciante.advertiser_id,
    dias: faltando.length - erros,
    linhas,
    erros,
  };
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

/** Série diária de investimento, para o gráfico. */
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
