import crypto from "crypto";
import { query } from "./db";

/**
 * Integração com a Shopee Open Platform (API v2).
 *
 * Difere do Mercado Livre em três pontos que moldam este arquivo:
 *
 * 1. Não é OAuth com Bearer. Cada chamada leva partner_id, timestamp e uma
 *    assinatura HMAC-SHA256 na query string. A base assinada muda conforme a
 *    chamada seja pública (antes de ter token) ou de loja (depois).
 * 2. O access_token dura 4 horas, bem menos que o do Mercado Livre.
 * 3. Erro não vem por status HTTP. A Shopee responde 200 com {"error": "..."}
 *    no corpo, então quem não olhar o campo `error` acha que deu certo.
 */

const HOST = process.env.SHOPEE_HOST || "https://partner.shopeemobile.com";
const PARTNER_ID = process.env.SHOPEE_PARTNER_ID || "";
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || "";
const REDIRECT = process.env.SHOPEE_REDIRECT_URI || "";

/** Janela máxima que a Shopee aceita em get_order_list. */
const JANELA_DIAS = 14;

export function configurada() {
  return Boolean(PARTNER_ID && PARTNER_KEY);
}

const agora = () => Math.floor(Date.now() / 1000);

/**
 * Assina a chamada. A base é a concatenação crua, sem separador:
 * partner_id + caminho + timestamp, mais access_token + shop_id quando a
 * chamada é feita em nome da loja.
 */
function assinar(caminho, timestamp, token, shopId) {
  const base = `${PARTNER_ID}${caminho}${timestamp}${token || ""}${shopId || ""}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

/** Erro com o código da Shopee preservado, que é o que diz o que fazer. */
function erroShopee(dados, caminho) {
  const e = new Error(
    `${dados.error}${dados.message ? `: ${dados.message}` : ""} (${caminho})`,
  );
  e.codigo = dados.error;
  return e;
}

/** Chamada pública: usada só no fluxo de conexão, antes de existir token. */
async function chamarPublico(caminho, corpo) {
  const ts = agora();
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(ts),
    sign: assinar(caminho, ts),
  });

  const r = await fetch(`${HOST}${caminho}?${params}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...corpo, partner_id: Number(PARTNER_ID) }),
  });

  const dados = await r.json().catch(() => ({ error: "resposta_invalida" }));
  if (dados.error) throw erroShopee(dados, caminho);
  return dados;
}

/** Chamada em nome da loja. Só GET: nada aqui altera dado na Shopee. */
async function chamar(caminho, conta, params = {}) {
  const ts = agora();
  const busca = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(ts),
    access_token: conta.access_token,
    shop_id: String(conta.shop_id),
    sign: assinar(caminho, ts, conta.access_token, conta.shop_id),
  });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") busca.set(k, String(v));
  }

  const r = await fetch(`${HOST}${caminho}?${busca}`, {
    headers: { "content-type": "application/json" },
  });
  const dados = await r.json().catch(() => ({ error: "resposta_invalida" }));
  if (dados.error) throw erroShopee(dados, caminho);
  return dados;
}

/* =========================================================
   Conexão da loja
   ========================================================= */

export function authUrl() {
  if (!configurada()) throw new Error("SEM_CREDENCIAL");
  const ts = agora();
  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(ts),
    sign: assinar("/api/v2/shop/auth_partner", ts),
    redirect: REDIRECT,
  });
  return `${HOST}/api/v2/shop/auth_partner?${params}`;
}

export async function trocarCodePorToken(code, shopId) {
  const dados = await chamarPublico("/api/v2/auth/token/get_access_token", {
    code,
    shop_id: Number(shopId),
  });
  await salvarConta(shopId, dados);
  return dados;
}

async function salvarConta(shopId, tokens, nome) {
  // A Shopee devolve 4 horas; tiramos 5 minutos para não usar token vencido
  // por causa de diferença de relógio.
  const expira = new Date(Date.now() + ((tokens.expire_in ?? 14400) - 300) * 1000);

  await query(
    `INSERT INTO conta_shopee (id, shop_id, shop_name, access_token, refresh_token, expira_em, conectado_em)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       shop_id = EXCLUDED.shop_id,
       shop_name = COALESCE(EXCLUDED.shop_name, conta_shopee.shop_name),
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expira_em = EXCLUDED.expira_em,
       conectado_em = now()`,
    [shopId, nome ?? null, tokens.access_token, tokens.refresh_token, expira],
  );
}

export async function getConta() {
  const r = await query("SELECT * FROM conta_shopee WHERE id = 1");
  return r.rows[0] || null;
}

/**
 * Devolve uma conta com token válido, renovando quando falta pouco.
 * O refresh_token da Shopee também é rotativo: o novo vem na resposta e
 * precisa ser gravado na hora, senão a próxima renovação falha.
 */
export async function getContaValida() {
  if (!configurada()) throw new Error("SEM_CREDENCIAL");

  const conta = await getConta();
  if (!conta?.access_token) throw new Error("SEM_CONTA");

  const faltam = new Date(conta.expira_em).getTime() - Date.now();
  if (faltam > 10 * 60 * 1000) return conta;

  let novos;
  try {
    novos = await chamarPublico("/api/v2/auth/access_token/get", {
      refresh_token: conta.refresh_token,
      shop_id: Number(conta.shop_id),
    });
  } catch (e) {
    const err = new Error("RECONECTAR");
    err.detalhe = e.message;
    throw err;
  }

  await salvarConta(conta.shop_id, novos, conta.shop_name);
  return { ...conta, access_token: novos.access_token, refresh_token: novos.refresh_token };
}

/** Nome e situação da loja, para mostrar na tela de ajustes. */
export async function infoLoja(conta) {
  // get_shop_info devolve os campos na raiz, não dentro de `response`.
  const d = await chamar("/api/v2/shop/get_shop_info", conta);
  const nome = d.shop_name || d.response?.shop_name || null;
  if (nome && nome !== conta.shop_name) {
    await query("UPDATE conta_shopee SET shop_name = $1 WHERE id = 1", [nome]);
  }
  return { shop_name: nome, region: d.region || null, status: d.status || null };
}

/* =========================================================
   Situação do pedido
   ========================================================= */

/**
 * Traduz o status da Shopee para as mesmas etapas que a Expedição já usa
 * para o Mercado Livre, para as duas listas caberem na mesma tela.
 */
export function situacaoShopee(pedido) {
  const st = pedido.status;

  if (st === "CANCELLED" || st === "IN_CANCEL")
    return { etapa: "cancelado", rotulo: "Cancelado", ordem: 9 };
  if (st === "COMPLETED")
    return { etapa: "entregue", rotulo: "Entregue", ordem: 8 };
  if (st === "SHIPPED" || st === "TO_CONFIRM_RECEIVE" || st === "TO_RETURN")
    return { etapa: "transporte", rotulo: "A caminho", ordem: 7 };

  if (pedido.despachado_em)
    return { etapa: "transporte", rotulo: "Despachado", ordem: 6 };

  // Marcação feita aqui dentro vale mais que o status da Shopee, que só muda
  // quando a transportadora bipa o pacote — mesma regra do Mercado Livre.
  if (pedido.impresso_em && (st === "READY_TO_SHIP" || st === "RETRY_SHIP")) {
    return {
      etapa: "impresso",
      rotulo: "Impressa, falta despachar",
      ordem: 3,
      acao: "A etiqueta já saiu. Cole no pacote e entregue à transportadora.",
    };
  }

  if (st === "INVOICE_PENDING") {
    return {
      etapa: "nf",
      rotulo: "Aguardando nota fiscal",
      ordem: 1,
      acao: "A Shopee não libera a etiqueta enquanto a nota não sair.",
    };
  }

  // PROCESSED quer dizer que a coleta já foi combinada com a transportadora.
  if (st === "PROCESSED") {
    return {
      etapa: "impresso",
      rotulo: "Envio combinado, falta despachar",
      ordem: 3,
      acao: "A Shopee já agendou a coleta. Cole a etiqueta e entregue.",
    };
  }
  if (st === "READY_TO_SHIP" || st === "RETRY_SHIP") {
    return { etapa: "imprimir", rotulo: "Pronto para imprimir", ordem: 2 };
  }
  if (st === "UNPAID") {
    return {
      etapa: "futuras",
      rotulo: "Aguardando pagamento",
      ordem: 4,
      acao: "O comprador ainda não pagou. Nada a fazer agora.",
    };
  }

  return { etapa: "outro", rotulo: st || "sem status", ordem: 6 };
}

/* =========================================================
   Dinheiro
   ========================================================= */

const n = (v) => Number(v ?? 0);

/**
 * Traduz o escrow da Shopee para os campos do nosso DRE.
 *
 * `escrow_amount` é o que de fato cai na conta, e fica gravado como
 * repasse_liquido para servir de conferência: se a soma das nossas deduções
 * não bater com ele, o painel mostra a diferença em vez de esconder.
 */
export function financeiroDoEscrow(renda) {
  if (!renda) return { tarifa: 0, frete: 0, repasse: null };

  const tarifa =
    n(renda.commission_fee) +
    n(renda.service_fee) +
    n(renda.seller_transaction_fee) +
    n(renda.order_ams_commission_fee);

  // O frete que sobra para o vendedor é o custo real menos o que o comprador
  // pagou e menos o subsídio da Shopee. Quando a Shopee já manda o valor
  // fechado em final_shipping_fee, ele vale mais que a nossa conta.
  const calculado =
    n(renda.actual_shipping_fee) -
    n(renda.buyer_paid_shipping_fee) -
    n(renda.shopee_shipping_rebate);
  const frete = renda.final_shipping_fee != null
    ? n(renda.final_shipping_fee)
    : Math.max(0, calculado);

  return {
    tarifa,
    frete: Math.max(0, frete),
    repasse: renda.escrow_amount != null ? n(renda.escrow_amount) : null,
  };
}

/* =========================================================
   Sincronização
   ========================================================= */

/** A Shopee só aceita 15 dias por consulta: quebra o período em pedaços. */
function janelas(desde, ate) {
  const passo = JANELA_DIAS * 86400;
  const saida = [];
  for (let ini = Math.floor(desde / 1000); ini < Math.floor(ate / 1000); ini += passo) {
    saida.push([ini, Math.min(ini + passo, Math.floor(ate / 1000))]);
  }
  return saida;
}

async function listarOrderSns(conta, desde) {
  const sns = [];
  for (const [de, ate] of janelas(desde, Date.now())) {
    let cursor = "";
    do {
      const d = await chamar("/api/v2/order/get_order_list", conta, {
        time_range_field: "create_time",
        time_from: de,
        time_to: ate,
        page_size: 100,
        cursor,
        response_optional_fields: "order_status",
      });
      const lista = d.response?.order_list || [];
      for (const o of lista) sns.push(o.order_sn);
      cursor = d.response?.more ? d.response.next_cursor : "";
    } while (cursor);
  }
  return [...new Set(sns)];
}

/** O escrow é uma chamada por pedido; falha nele não derruba a sincronização. */
async function buscarEscrow(conta, orderSn) {
  try {
    const d = await chamar("/api/v2/payment/get_escrow_detail", conta, {
      order_sn: orderSn,
    });
    return d.response?.order_income || null;
  } catch {
    // Pedido novo ainda não tem repasse calculado. Entra na próxima rodada.
    return null;
  }
}

const CAMPOS_PEDIDO = [
  "buyer_username",
  "recipient_address",
  "item_list",
  "pay_time",
  "actual_shipping_fee",
  "estimated_shipping_fee",
  "shipping_carrier",
  "package_list",
  "total_amount",
  "invoice_data",
].join(",");

export async function sincronizarPedidos(conta, dias = 30) {
  const desde = Date.now() - dias * 86400000;
  const sns = await listarOrderSns(conta, desde);
  let gravados = 0;

  // get_order_detail aceita 50 por chamada.
  for (let i = 0; i < sns.length; i += 50) {
    const lote = sns.slice(i, i + 50);
    const d = await chamar("/api/v2/order/get_order_detail", conta, {
      order_sn_list: lote.join(","),
      response_optional_fields: CAMPOS_PEDIDO,
    });

    for (const pedido of d.response?.order_list || []) {
      await gravarPedido(conta, pedido);
      gravados++;
    }
  }

  return gravados;
}

async function gravarPedido(conta, pedido) {
  const renda = await buscarEscrow(conta, pedido.order_sn);
  const { tarifa, frete, repasse } = financeiroDoEscrow(renda);

  const itens = pedido.item_list || [];
  const receita = itens.reduce(
    (s, it) => s + n(it.model_discounted_price) * (n(it.model_quantity_purchased) || 1),
    0,
  );

  const pacote = (pedido.package_list || [])[0] || null;
  const envioId = pacote?.package_number || pedido.order_sn;
  const endereco = pedido.recipient_address || {};

  await query(
    `INSERT INTO pedidos (order_id, canal, data_criacao, data_fechamento, status, status_detail,
       comprador, total_pedido, shipment_id, frete_vendedor, tarifa_pedido, repasse_liquido,
       logistic_type, payload, sincronizado_em)
     VALUES ($1,'shopee',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (order_id) DO UPDATE SET
       status = EXCLUDED.status,
       status_detail = EXCLUDED.status_detail,
       total_pedido = EXCLUDED.total_pedido,
       frete_vendedor = EXCLUDED.frete_vendedor,
       tarifa_pedido = EXCLUDED.tarifa_pedido,
       repasse_liquido = COALESCE(EXCLUDED.repasse_liquido, pedidos.repasse_liquido),
       logistic_type = COALESCE(EXCLUDED.logistic_type, pedidos.logistic_type),
       payload = EXCLUDED.payload,
       sincronizado_em = now()`,
    [
      pedido.order_sn,
      pedido.create_time ? new Date(pedido.create_time * 1000) : null,
      pedido.pay_time ? new Date(pedido.pay_time * 1000) : null,
      pedido.order_status,
      pedido.cancel_reason || null,
      pedido.buyer_username || null,
      receita || n(pedido.total_amount),
      String(envioId),
      frete,
      tarifa,
      repasse,
      pedido.shipping_carrier || null,
      JSON.stringify({ pedido, escrow: renda }),
    ],
  );

  for (const it of itens) {
    const qtd = n(it.model_quantity_purchased) || 1;
    await query(
      `INSERT INTO pedido_itens (order_id, canal, item_id, variation_id, sku, titulo,
         quantidade, preco_unitario, sale_fee, listing_type)
       VALUES ($1,'shopee',$2,$3,$4,$5,$6,$7,0,$8)
       ON CONFLICT (order_id, item_id, variation_id) DO UPDATE SET
         quantidade = EXCLUDED.quantidade,
         preco_unitario = EXCLUDED.preco_unitario,
         titulo = EXCLUDED.titulo,
         sku = EXCLUDED.sku`,
      [
        pedido.order_sn,
        String(it.item_id),
        String(it.model_id || ""),
        it.model_sku || it.item_sku || null,
        it.item_name || null,
        qtd,
        n(it.model_discounted_price),
        pedido.shipping_carrier || null,
      ],
    );
  }

  await query(
    `INSERT INTO envios (shipment_id, order_id, canal, status, substatus, logistic_type,
       destinatario, cidade, uf, cep, data_criacao, prazo_despacho, payload, atualizado_em)
     VALUES ($1,$2,'shopee',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (shipment_id) DO UPDATE SET
       status = EXCLUDED.status,
       substatus = EXCLUDED.substatus,
       destinatario = EXCLUDED.destinatario,
       cidade = EXCLUDED.cidade,
       uf = EXCLUDED.uf,
       prazo_despacho = EXCLUDED.prazo_despacho,
       payload = EXCLUDED.payload,
       atualizado_em = now()`,
    [
      String(envioId),
      pedido.order_sn,
      pedido.order_status,
      pacote?.logistics_status || null,
      pedido.shipping_carrier || null,
      endereco.name || null,
      endereco.city || null,
      endereco.state || null,
      endereco.zipcode || null,
      pedido.create_time ? new Date(pedido.create_time * 1000) : null,
      pedido.ship_by_date ? new Date(pedido.ship_by_date * 1000) : null,
      JSON.stringify(pacote || {}),
    ],
  );
}

/**
 * Traz os anúncios da loja. Preço e estoque vêm da Shopee; o custo de compra
 * é do vendedor e nunca é sobrescrito — mas quando o SKU já existe no
 * Mercado Livre, o custo é copiado de lá para não ter que digitar de novo.
 */
export async function sincronizarProdutos(conta) {
  const ids = [];
  let offset = 0;

  while (ids.length < 5000) {
    const d = await chamar("/api/v2/product/get_item_list", conta, {
      offset,
      page_size: 100,
      item_status: "NORMAL",
    });
    const pagina = d.response?.item || [];
    for (const it of pagina) ids.push(it.item_id);
    if (!d.response?.has_next_page || pagina.length === 0) break;
    offset = d.response.next_offset ?? offset + 100;
  }

  let gravados = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const d = await chamar("/api/v2/product/get_item_base_info", conta, {
      item_id_list: ids.slice(i, i + 50).join(","),
    });

    for (const item of d.response?.item_list || []) {
      const preco = n(item.price_info?.[0]?.current_price);
      const estoque = n(item.stock_info_v2?.summary_info?.total_available_stock);

      if (item.has_model) {
        const m = await chamar("/api/v2/product/get_model_list", conta, {
          item_id: item.item_id,
        });
        for (const modelo of m.response?.model || []) {
          await gravarProduto({
            item_id: String(item.item_id),
            variation_id: String(modelo.model_id),
            sku: modelo.model_sku || item.item_sku || null,
            titulo: `${item.item_name}${modelo.model_name ? ` — ${modelo.model_name}` : ""}`,
            preco: n(modelo.price_info?.[0]?.current_price),
            estoque: n(modelo.stock_info_v2?.summary_info?.total_available_stock),
          });
          gravados++;
        }
      } else {
        await gravarProduto({
          item_id: String(item.item_id),
          variation_id: "",
          sku: item.item_sku || null,
          titulo: item.item_name,
          preco,
          estoque,
        });
        gravados++;
      }
    }
  }

  return gravados;
}

async function gravarProduto(p) {
  await query(
    `INSERT INTO produtos (canal, item_id, variation_id, sku, titulo, preco_anuncio, estoque_atual, atualizado_em)
     VALUES ('shopee',$1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (canal, item_id, variation_id) DO UPDATE SET
       sku = EXCLUDED.sku,
       titulo = EXCLUDED.titulo,
       preco_anuncio = EXCLUDED.preco_anuncio,
       estoque_atual = EXCLUDED.estoque_atual,
       atualizado_em = now()`,
    [p.item_id, p.variation_id, p.sku, p.titulo, p.preco, p.estoque],
  );

  // Mesmo produto, outra vitrine: aproveita o custo já cadastrado no ML.
  if (p.sku) {
    await query(
      `UPDATE produtos alvo
          SET custo_unitario = origem.custo_unitario,
              custo_embalagem = origem.custo_embalagem
         FROM produtos origem
        WHERE alvo.canal = 'shopee' AND alvo.item_id = $1 AND alvo.variation_id = $2
          AND alvo.custo_unitario = 0
          AND origem.canal = 'ml' AND origem.sku = $3 AND origem.custo_unitario > 0`,
      [p.item_id, p.variation_id, p.sku],
    );
  }
}
