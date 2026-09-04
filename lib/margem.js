import { query, getConfigs } from "./db";
import { adsPorItem, adsTotal, adsSerie } from "./ads";

const n = (v) => Number(v ?? 0);
const brl = (v) =>
  (Number(v) || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

/**
 * Calcula a margem de um pedido linha a linha.
 *
 * Receita bruta
 *  (-) tarifa do Mercado Livre
 *  (-) frete bancado pelo vendedor
 *  (-) custo do produto (CMV)
 *  (-) embalagem
 *  (-) imposto sobre a receita
 *  (-) provisão de devolução
 *  (-) publicidade rateada por unidade vendida do anúncio
 *  = margem de contribuição
 *
 * adsPorUnidade: mapa item_id -> custo médio de Ads por unidade vendida no
 * período. É rateio, não atribuição: o Mercado Livre cobra por clique, não
 * por pedido, então o gasto do anúncio é dividido entre as unidades que ele
 * vendeu no período.
 */
export function calcularPedido(
  pedido,
  itens,
  produtosPorChave,
  cfg,
  adsPorUnidade,
) {
  const aliquota = n(cfg.aliquota_imposto) / 100;
  const provisao = n(cfg.provisao_devolucao) / 100;
  const feePorUnidade = cfg.sale_fee_por_unidade !== "false";

  let receita = 0;
  let tarifa = 0;
  let cmv = 0;
  let embalagem = 0;
  let ads = 0;
  let semCusto = false;

  for (const it of itens) {
    const qtd = n(it.quantidade) || 1;
    // O mesmo item_id pode existir nos dois canais, então a chave leva o canal.
    const chave = `${it.canal || "ml"}|${it.item_id}|${it.variation_id || ""}`;
    const prod = produtosPorChave.get(chave);

    receita += n(it.preco_unitario) * qtd;
    tarifa += feePorUnidade ? n(it.sale_fee) * qtd : n(it.sale_fee);
    cmv += n(prod?.custo_unitario) * qtd;
    embalagem += n(prod?.custo_embalagem) * qtd;
    ads += n(adsPorUnidade?.get(it.item_id)) * qtd;
    if (!prod || n(prod.custo_unitario) === 0) semCusto = true;
  }

  // O Mercado Livre cobra por item (sale_fee); a Shopee cobra por pedido
  // (comissão + serviço + transação), que a sincronização grava aqui.
  tarifa += n(pedido.tarifa_pedido);

  const frete = n(pedido.frete_vendedor);
  const imposto = receita * aliquota;
  const provisaoDevolucao = receita * provisao;
  const lucro =
    receita -
    tarifa -
    frete -
    cmv -
    embalagem -
    imposto -
    provisaoDevolucao -
    ads;

  return {
    order_id: String(pedido.order_id),
    canal: pedido.canal || "ml",
    repasse_liquido:
      pedido.repasse_liquido == null ? null : n(pedido.repasse_liquido),
    data: pedido.data_criacao,
    status: pedido.status,
    status_detail: pedido.status_detail,
    comprador: pedido.comprador,
    logistic_type: pedido.logistic_type,
    itens: itens.map((i) => ({
      titulo: i.titulo,
      sku: i.sku,
      quantidade: n(i.quantidade),
      preco_unitario: n(i.preco_unitario),
    })),
    receita,
    tarifa,
    frete,
    cmv,
    embalagem,
    imposto,
    provisao: provisaoDevolucao,
    ads,
    lucro,
    margem: receita > 0 ? (lucro / receita) * 100 : 0,
    sem_custo: semCusto,
  };
}

export async function montarPainel(dias = 30) {
  const cfg = await getConfigs();
  const desde = new Date(Date.now() - dias * 86400000);

  const [
    pedidosRes,
    itensRes,
    produtosRes,
    fixosRes,
    contaRes,
    shopeeRes,
    adsItens,
    adsGeral,
    adsDiaria,
  ] = await Promise.all([
    query(
      `SELECT * FROM pedidos WHERE data_criacao >= $1 ORDER BY data_criacao DESC`,
      [desde],
    ),
    query(
      `SELECT pi.* FROM pedido_itens pi
       JOIN pedidos p ON p.order_id = pi.order_id
       WHERE p.data_criacao >= $1`,
      [desde],
    ),
    query(`SELECT * FROM produtos ORDER BY titulo`),
    query(`SELECT * FROM custos_fixos ORDER BY valor_mensal DESC`),
    query(
      `SELECT seller_id, nickname, conectado_em, expira_em FROM conta_ml WHERE id = 1`,
    ),
    query(
      `SELECT shop_id, shop_name, conectado_em, expira_em FROM conta_shopee WHERE id = 1`,
    ).catch(() => ({ rows: [] })),
    adsPorItem(desde).catch(() => new Map()),
    adsTotal(desde).catch(() => ({ custo: 0, receita: 0, dias: 0 })),
    adsSerie(desde).catch(() => []),
  ]);

  const produtosPorChave = new Map(
    produtosRes.rows.map((p) => [
      `${p.canal || "ml"}|${p.item_id}|${p.variation_id || ""}`,
      p,
    ]),
  );
  const itensPorPedido = new Map();
  for (const it of itensRes.rows) {
    const arr = itensPorPedido.get(String(it.order_id)) || [];
    arr.push(it);
    itensPorPedido.set(String(it.order_id), arr);
  }

  // Unidades vendidas por anúncio no período — base do rateio da publicidade.
  const unidadesPorItem = new Map();
  for (const it of itensRes.rows) {
    unidadesPorItem.set(
      it.item_id,
      n(unidadesPorItem.get(it.item_id)) + n(it.quantidade),
    );
  }

  // Custo de Ads por unidade vendida. Anúncio que gastou e não vendeu nada
  // no período fica de fora daqui e entra no DRE como investimento sem retorno.
  const adsAtivo = cfg.ads_ativo !== "false";
  const adsPorUnidade = new Map();
  if (adsAtivo) {
    for (const [itemId, a] of adsItens) {
      const un = n(unidadesPorItem.get(itemId));
      if (un > 0 && a.custo > 0) adsPorUnidade.set(itemId, a.custo / un);
    }
  }

  const cancelados = new Set(["cancelled", "invalid"]);
  const pedidos = pedidosRes.rows.map((p) =>
    calcularPedido(
      p,
      itensPorPedido.get(String(p.order_id)) || [],
      produtosPorChave,
      cfg,
      adsPorUnidade,
    ),
  );
  const validos = pedidos.filter((p) => !cancelados.has(p.status));

  const soma = (campo) => validos.reduce((acc, p) => acc + p[campo], 0);
  const receita = soma("receita");
  const custoFixoMensal = fixosRes.rows.reduce(
    (a, r) => a + n(r.valor_mensal),
    0,
  );
  const custoFixoPeriodo = (custoFixoMensal / 30) * dias;
  const margemContribuicao = soma("lucro");

  // Publicidade: o total gasto é o das campanhas. O que sobrou depois do
  // rateio é dinheiro investido em anúncio que não converteu em venda no
  // período — continua saindo do bolso e precisa aparecer no resultado.
  const adsRateado = adsAtivo ? soma("ads") : 0;
  const adsInvestido = adsAtivo ? adsGeral.custo : 0;
  const adsSemVenda = Math.max(0, adsInvestido - adsRateado);
  const lucroOperacional = margemContribuicao - custoFixoPeriodo - adsSemVenda;

  const dre = {
    receita,
    tarifa: soma("tarifa"),
    frete: soma("frete"),
    cmv: soma("cmv"),
    embalagem: soma("embalagem"),
    imposto: soma("imposto"),
    provisao: soma("provisao"),
    ads: adsRateado,
    margem_contribuicao: margemContribuicao,
    ads_sem_venda: adsSemVenda,
    custo_fixo: custoFixoPeriodo,
    lucro_operacional: lucroOperacional,
    pedidos: validos.length,
    cancelados: pedidos.length - validos.length,
    ticket_medio: validos.length ? receita / validos.length : 0,
    margem_pct: receita ? (margemContribuicao / receita) * 100 : 0,
  };

  /**
   * O mesmo DRE, canal a canal. A publicidade sincronizada é a do Mercado
   * Livre, então ela fica só no canal dele — somar no total da Shopee daria
   * um lucro que não existe.
   *
   * `repasse_informado` é o que o marketplace diz que caiu na conta
   * (escrow_amount, no caso da Shopee). `diferenca_repasse` compara com a
   * nossa conta: se abrir, é a nossa modelagem de tarifa que está incompleta,
   * e é melhor isso aparecer do que ficar escondido dentro do lucro.
   */
  const canais = [];
  for (const nome of [...new Set(validos.map((p) => p.canal))].sort()) {
    const doCanal = validos.filter((p) => p.canal === nome);
    const somaCanal = (campo) => doCanal.reduce((a, p) => a + p[campo], 0);
    const receitaCanal = somaCanal("receita");
    const comRepasse = doCanal.filter((p) => p.repasse_liquido != null);
    const repasse = comRepasse.reduce((a, p) => a + p.repasse_liquido, 0);
    const nossoLiquido = comRepasse.reduce(
      (a, p) => a + p.receita - p.tarifa - p.frete,
      0,
    );

    canais.push({
      canal: nome,
      pedidos: doCanal.length,
      receita: receitaCanal,
      tarifa: somaCanal("tarifa"),
      frete: somaCanal("frete"),
      cmv: somaCanal("cmv"),
      embalagem: somaCanal("embalagem"),
      imposto: somaCanal("imposto"),
      provisao: somaCanal("provisao"),
      ads: somaCanal("ads"),
      lucro: somaCanal("lucro"),
      ticket_medio: doCanal.length ? receitaCanal / doCanal.length : 0,
      margem_pct: receitaCanal ? (somaCanal("lucro") / receitaCanal) * 100 : 0,
      pct_receita: receita ? (receitaCanal / receita) * 100 : 0,
      repasse_informado: comRepasse.length ? repasse : null,
      diferenca_repasse: comRepasse.length ? repasse - nossoLiquido : null,
      pedidos_com_repasse: comRepasse.length,
    });
  }

  const ads = {
    ativo: adsAtivo,
    investido: adsInvestido,
    rateado: adsRateado,
    sem_venda: adsSemVenda,
    receita_atribuida: adsAtivo ? adsGeral.receita : 0,
    dias_com_dados: adsGeral.dias,
    acos: adsGeral.receita ? (adsInvestido / adsGeral.receita) * 100 : null,
    roas: adsInvestido ? adsGeral.receita / adsInvestido : null,
    pct_receita: receita ? (adsInvestido / receita) * 100 : 0,
    status: cfg.ads_status || null,
    sincronizado_em: cfg.ads_sync_em || null,
    serie: adsDiaria,
  };

  // Agregação por produto
  const porProduto = new Map();
  for (const p of validos) {
    const itens = itensPorPedido.get(p.order_id) || [];
    const receitaPedido = p.receita || 1;
    for (const it of itens) {
      const chave = `${it.canal || "ml"}|${it.item_id}|${it.variation_id || ""}`;
      const base = porProduto.get(chave) || {
        chave,
        canal: it.canal || "ml",
        item_id: it.item_id,
        variation_id: it.variation_id,
        titulo: it.titulo,
        sku: it.sku,
        unidades: 0,
        receita: 0,
        lucro: 0,
      };
      const receitaItem = n(it.preco_unitario) * n(it.quantidade);
      base.unidades += n(it.quantidade);
      base.receita += receitaItem;
      // rateia o resultado do pedido proporcionalmente à receita do item
      base.lucro += p.lucro * (receitaItem / receitaPedido);
      porProduto.set(chave, base);
    }
  }

  const produtos = produtosRes.rows.map((prod) => {
    const chave = `${prod.canal || "ml"}|${prod.item_id}|${prod.variation_id || ""}`;
    const v = porProduto.get(chave);
    const unidades = v?.unidades ?? 0;
    const vendaDia = unidades / dias;
    const estoque = n(prod.estoque_atual);

    // O gasto de Ads é por anúncio (item_id). Quando o anúncio tem variações,
    // divide-se entre elas pela participação nas unidades vendidas.
    const a = adsAtivo ? adsItens.get(prod.item_id) : null;
    const unItem = n(unidadesPorItem.get(prod.item_id));
    const fatia = unItem > 0 ? unidades / unItem : a ? 1 : 0;
    const adsCusto = a ? a.custo * fatia : 0;
    const receitaProd = v?.receita ?? 0;

    return {
      id: prod.id,
      canal: prod.canal || "ml",
      item_id: prod.item_id,
      variation_id: prod.variation_id,
      sku: prod.sku,
      titulo: prod.titulo,
      custo_unitario: n(prod.custo_unitario),
      custo_embalagem: n(prod.custo_embalagem),
      preco_anuncio: n(prod.preco_anuncio),
      listing_type: prod.listing_type,
      estoque_atual: estoque,
      estoque_minimo: n(prod.estoque_minimo),
      lead_time_dias: n(prod.lead_time_dias) || 15,
      unidades_vendidas: unidades,
      receita: receitaProd,
      lucro: v?.lucro ?? 0,
      margem: v?.receita ? (v.lucro / v.receita) * 100 : null,
      ads_custo: adsCusto,
      ads_por_unidade: unidades > 0 ? adsCusto / unidades : null,
      ads_clicks: a ? Math.round(a.clicks * fatia) : 0,
      ads_acos:
        adsCusto > 0 && receitaProd > 0 ? (adsCusto / receitaProd) * 100 : null,
      ads_roas: adsCusto > 0 ? receitaProd / adsCusto : null,
      lucro_sem_ads: (v?.lucro ?? 0) + adsCusto,
      venda_media_dia: vendaDia,
      cobertura_dias: vendaDia > 0 ? estoque / vendaDia : null,
      ponto_pedido:
        vendaDia * (n(prod.lead_time_dias) || 15) + n(prod.estoque_minimo),
      sugestao_compra: Math.max(
        0,
        Math.ceil(vendaDia * ((n(prod.lead_time_dias) || 15) + 30) - estoque),
      ),
    };
  });

  // Curva ABC por receita
  const ordenados = [...produtos]
    .filter((p) => p.receita > 0)
    .sort((a, b) => b.receita - a.receita);
  const totalReceita = ordenados.reduce((a, p) => a + p.receita, 0);
  let acumulado = 0;
  for (const p of ordenados) {
    acumulado += p.receita;
    const pct = totalReceita ? acumulado / totalReceita : 0;
    p.curva = pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C";
  }

  // Série diária
  const serieMap = new Map();
  for (const p of validos) {
    const dia = new Date(p.data).toISOString().slice(0, 10);
    const cur = serieMap.get(dia) || { dia, receita: 0, lucro: 0, pedidos: 0 };
    cur.receita += p.receita;
    cur.lucro += p.lucro;
    cur.pedidos += 1;
    serieMap.set(dia, cur);
  }
  const serie = [...serieMap.values()].sort((a, b) =>
    a.dia.localeCompare(b.dia),
  );

  // Alertas
  const alertas = [];
  const semCusto = produtos.filter(
    (p) => p.unidades_vendidas > 0 && p.custo_unitario === 0,
  );
  if (semCusto.length) {
    alertas.push({
      tipo: "custo",
      nivel: "critico",
      texto: `${semCusto.length} produto(s) venderam sem custo cadastrado — a margem está superestimada.`,
    });
  }
  const negativos = produtos.filter(
    (p) => p.margem !== null && p.margem < 0 && p.custo_unitario > 0,
  );
  for (const p of negativos.slice(0, 5)) {
    alertas.push({
      tipo: "margem",
      nivel: "critico",
      texto: `${p.titulo}: margem de ${p.margem.toFixed(1)}% no período. Vendeu ${p.unidades_vendidas} un. no prejuízo.`,
    });
  }
  if (adsAtivo && adsInvestido > 0) {
    // Anúncio que só dá lucro porque o Ads ainda não foi descontado.
    const comidos = produtos.filter(
      (p) => p.ads_custo > 0 && p.lucro < 0 && p.lucro_sem_ads > 0,
    );
    for (const p of comidos.slice(0, 5)) {
      alertas.push({
        tipo: "ads",
        nivel: "critico",
        texto: `${p.titulo}: dava ${brl(p.lucro_sem_ads)} de lucro, mas ${brl(p.ads_custo)} de Ads viraram ${brl(p.lucro)}. A publicidade está comendo a margem inteira.`,
      });
    }

    if (
      adsSemVenda > 0 &&
      adsInvestido > 0 &&
      adsSemVenda / adsInvestido > 0.25
    ) {
      alertas.push({
        tipo: "ads",
        nivel: "atencao",
        texto: `${brl(adsSemVenda)} em publicidade (${((adsSemVenda / adsInvestido) * 100).toFixed(0)}% do investido) foram para anúncios sem venda atribuída no período.`,
      });
    }

    const caros = produtos.filter(
      (p) => p.ads_acos !== null && p.ads_acos > 30 && p.lucro > 0,
    );
    for (const p of caros.slice(0, 3)) {
      alertas.push({
        tipo: "ads",
        nivel: "atencao",
        texto: `${p.titulo}: ACOS de ${p.ads_acos.toFixed(0)}% — cada real de venda custa ${(p.ads_acos / 100).toFixed(2)} em anúncio.`,
      });
    }
  }

  const ruptura = produtos.filter(
    (p) => p.cobertura_dias !== null && p.cobertura_dias < p.lead_time_dias,
  );
  for (const p of ruptura.slice(0, 5)) {
    alertas.push({
      tipo: "estoque",
      nivel: "atencao",
      texto: `${p.titulo}: ${p.estoque_atual} un. em estoque, ${p.cobertura_dias.toFixed(0)} dia(s) de cobertura contra ${p.lead_time_dias} de reposição.`,
    });
  }

  return {
    dias,
    conta: contaRes.rows[0] || null,
    conta_shopee: shopeeRes.rows[0] || null,
    dre,
    canais,
    pedidos: pedidos.slice(0, 200),
    produtos: produtos.sort((a, b) => b.receita - a.receita),
    custos_fixos: fixosRes.rows.map((r) => ({
      ...r,
      valor_mensal: n(r.valor_mensal),
    })),
    serie,
    ads,
    alertas,
    config: cfg,
  };
}
