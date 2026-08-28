import { query, getConfigs } from './db';

const n = (v) => Number(v ?? 0);

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
 *  = margem de contribuição
 */
export function calcularPedido(pedido, itens, produtosPorChave, cfg) {
  const aliquota = n(cfg.aliquota_imposto) / 100;
  const provisao = n(cfg.provisao_devolucao) / 100;
  const feePorUnidade = cfg.sale_fee_por_unidade !== 'false';

  let receita = 0;
  let tarifa = 0;
  let cmv = 0;
  let embalagem = 0;
  let semCusto = false;

  for (const it of itens) {
    const qtd = n(it.quantidade) || 1;
    const chave = `${it.item_id}|${it.variation_id || ''}`;
    const prod = produtosPorChave.get(chave);

    receita += n(it.preco_unitario) * qtd;
    tarifa += feePorUnidade ? n(it.sale_fee) * qtd : n(it.sale_fee);
    cmv += n(prod?.custo_unitario) * qtd;
    embalagem += n(prod?.custo_embalagem) * qtd;
    if (!prod || n(prod.custo_unitario) === 0) semCusto = true;
  }

  const frete = n(pedido.frete_vendedor);
  const imposto = receita * aliquota;
  const provisaoDevolucao = receita * provisao;
  const lucro = receita - tarifa - frete - cmv - embalagem - imposto - provisaoDevolucao;

  return {
    order_id: String(pedido.order_id),
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
    lucro,
    margem: receita > 0 ? (lucro / receita) * 100 : 0,
    sem_custo: semCusto,
  };
}

export async function montarPainel(dias = 30) {
  const cfg = await getConfigs();
  const desde = new Date(Date.now() - dias * 86400000);

  const [pedidosRes, itensRes, produtosRes, fixosRes, contaRes] = await Promise.all([
    query(
      `SELECT * FROM pedidos WHERE data_criacao >= $1 ORDER BY data_criacao DESC`,
      [desde]
    ),
    query(
      `SELECT pi.* FROM pedido_itens pi
       JOIN pedidos p ON p.order_id = pi.order_id
       WHERE p.data_criacao >= $1`,
      [desde]
    ),
    query(`SELECT * FROM produtos ORDER BY titulo`),
    query(`SELECT * FROM custos_fixos ORDER BY valor_mensal DESC`),
    query(`SELECT seller_id, nickname, conectado_em, expira_em FROM conta_ml WHERE id = 1`),
  ]);

  const produtosPorChave = new Map(
    produtosRes.rows.map((p) => [`${p.item_id}|${p.variation_id || ''}`, p])
  );
  const itensPorPedido = new Map();
  for (const it of itensRes.rows) {
    const arr = itensPorPedido.get(String(it.order_id)) || [];
    arr.push(it);
    itensPorPedido.set(String(it.order_id), arr);
  }

  const cancelados = new Set(['cancelled', 'invalid']);
  const pedidos = pedidosRes.rows.map((p) =>
    calcularPedido(p, itensPorPedido.get(String(p.order_id)) || [], produtosPorChave, cfg)
  );
  const validos = pedidos.filter((p) => !cancelados.has(p.status));

  const soma = (campo) => validos.reduce((acc, p) => acc + p[campo], 0);
  const receita = soma('receita');
  const custoFixoMensal = fixosRes.rows.reduce((a, r) => a + n(r.valor_mensal), 0);
  const custoFixoPeriodo = (custoFixoMensal / 30) * dias;
  const margemContribuicao = soma('lucro');

  const dre = {
    receita,
    tarifa: soma('tarifa'),
    frete: soma('frete'),
    cmv: soma('cmv'),
    embalagem: soma('embalagem'),
    imposto: soma('imposto'),
    provisao: soma('provisao'),
    margem_contribuicao: margemContribuicao,
    custo_fixo: custoFixoPeriodo,
    lucro_operacional: margemContribuicao - custoFixoPeriodo,
    pedidos: validos.length,
    cancelados: pedidos.length - validos.length,
    ticket_medio: validos.length ? receita / validos.length : 0,
    margem_pct: receita ? (margemContribuicao / receita) * 100 : 0,
  };

  // Agregação por produto
  const porProduto = new Map();
  for (const p of validos) {
    const itens = itensPorPedido.get(p.order_id) || [];
    const receitaPedido = p.receita || 1;
    for (const it of itens) {
      const chave = `${it.item_id}|${it.variation_id || ''}`;
      const base = porProduto.get(chave) || {
        chave,
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
    const chave = `${prod.item_id}|${prod.variation_id || ''}`;
    const v = porProduto.get(chave);
    const unidades = v?.unidades ?? 0;
    const vendaDia = unidades / dias;
    const estoque = n(prod.estoque_atual);
    return {
      id: prod.id,
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
      receita: v?.receita ?? 0,
      lucro: v?.lucro ?? 0,
      margem: v?.receita ? (v.lucro / v.receita) * 100 : null,
      venda_media_dia: vendaDia,
      cobertura_dias: vendaDia > 0 ? estoque / vendaDia : null,
      ponto_pedido: vendaDia * (n(prod.lead_time_dias) || 15) + n(prod.estoque_minimo),
      sugestao_compra: Math.max(
        0,
        Math.ceil(vendaDia * ((n(prod.lead_time_dias) || 15) + 30) - estoque)
      ),
    };
  });

  // Curva ABC por receita
  const ordenados = [...produtos].filter((p) => p.receita > 0).sort((a, b) => b.receita - a.receita);
  const totalReceita = ordenados.reduce((a, p) => a + p.receita, 0);
  let acumulado = 0;
  for (const p of ordenados) {
    acumulado += p.receita;
    const pct = totalReceita ? acumulado / totalReceita : 0;
    p.curva = pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C';
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
  const serie = [...serieMap.values()].sort((a, b) => a.dia.localeCompare(b.dia));

  // Alertas
  const alertas = [];
  const semCusto = produtos.filter((p) => p.unidades_vendidas > 0 && p.custo_unitario === 0);
  if (semCusto.length) {
    alertas.push({
      tipo: 'custo',
      nivel: 'critico',
      texto: `${semCusto.length} produto(s) venderam sem custo cadastrado — a margem está superestimada.`,
    });
  }
  const negativos = produtos.filter((p) => p.margem !== null && p.margem < 0 && p.custo_unitario > 0);
  for (const p of negativos.slice(0, 5)) {
    alertas.push({
      tipo: 'margem',
      nivel: 'critico',
      texto: `${p.titulo}: margem de ${p.margem.toFixed(1)}% no período. Vendeu ${p.unidades_vendidas} un. no prejuízo.`,
    });
  }
  const ruptura = produtos.filter(
    (p) => p.cobertura_dias !== null && p.cobertura_dias < p.lead_time_dias
  );
  for (const p of ruptura.slice(0, 5)) {
    alertas.push({
      tipo: 'estoque',
      nivel: 'atencao',
      texto: `${p.titulo}: ${p.estoque_atual} un. em estoque, ${p.cobertura_dias.toFixed(0)} dia(s) de cobertura contra ${p.lead_time_dias} de reposição.`,
    });
  }

  return {
    dias,
    conta: contaRes.rows[0] || null,
    dre,
    pedidos: pedidos.slice(0, 200),
    produtos: produtos.sort((a, b) => b.receita - a.receita),
    custos_fixos: fixosRes.rows.map((r) => ({ ...r, valor_mensal: n(r.valor_mensal) })),
    serie,
    alertas,
    config: cfg,
  };
}
