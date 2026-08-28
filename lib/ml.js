import { query } from './db';

const API = 'https://api.mercadolibre.com';
const AUTH_HOST = process.env.ML_AUTH_HOST || 'https://auth.mercadolivre.com.br';

export function authUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID || '',
    redirect_uri: process.env.ML_REDIRECT_URI || '',
    state,
  });
  return `${AUTH_HOST}/authorization?${params}`;
}

export async function trocarCodePorToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri: process.env.ML_REDIRECT_URI,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || data.error_description || 'Falha ao gerar token');
  return data;
}

export async function salvarConta(tokenData) {
  const expira = new Date(Date.now() + (tokenData.expires_in ?? 21600) * 1000);
  let nickname = null;
  try {
    const me = await fetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    }).then((r) => r.json());
    nickname = me.nickname ?? null;
  } catch {}

  await query(
    `INSERT INTO conta_ml (id, seller_id, nickname, access_token, refresh_token, expira_em, conectado_em)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       seller_id = EXCLUDED.seller_id,
       nickname = EXCLUDED.nickname,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expira_em = EXCLUDED.expira_em,
       conectado_em = now()`,
    [tokenData.user_id, nickname, tokenData.access_token, tokenData.refresh_token, expira]
  );
}

export async function getConta() {
  const r = await query('SELECT * FROM conta_ml WHERE id = 1');
  return r.rows[0] || null;
}

/**
 * Devolve um access_token válido. Renova quando faltam menos de 30 minutos,
 * sem esperar o 401. O refresh_token é de uso único: gravamos o novo na hora.
 */
export async function getTokenValido() {
  const conta = await getConta();
  if (!conta) throw new Error('SEM_CONTA');

  const margem = 30 * 60 * 1000;
  if (conta.expira_em && new Date(conta.expira_em).getTime() - Date.now() > margem) {
    return { token: conta.access_token, sellerId: conta.seller_id };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: conta.refresh_token,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok) {
    if (data.error === 'invalid_grant') throw new Error('RECONECTAR');
    throw new Error(data.error_description || 'Falha ao renovar token');
  }
  await salvarConta(data);
  return { token: data.access_token, sellerId: data.user_id };
}

async function api(path, token) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 1500));
    return api(path, token);
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${r.status} em ${path}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

/* ------------------------------------------------------------------ */
/* Sincronização                                                       */
/* ------------------------------------------------------------------ */

export async function sincronizarAnuncios(token, sellerId) {
  let offset = 0;
  let total = 0;
  const ids = [];

  while (offset < 1000) {
    const res = await api(
      `/users/${sellerId}/items/search?limit=50&offset=${offset}`,
      token
    );
    ids.push(...(res.results || []));
    if (!res.results?.length || ids.length >= (res.paging?.total ?? 0)) break;
    offset += 50;
  }

  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20).join(',');
    const itens = await api(
      `/items?ids=${lote}&attributes=id,title,price,available_quantity,seller_custom_field,listing_type_id,variations`,
      token
    );
    for (const wrap of itens) {
      const it = wrap.body;
      if (!it?.id) continue;
      if (it.variations?.length) {
        for (const v of it.variations) {
          await upsertProduto({
            item_id: it.id,
            variation_id: String(v.id),
            sku: v.seller_custom_field || it.seller_custom_field || null,
            titulo: `${it.title} — ${(v.attribute_combinations || [])
              .map((a) => a.value_name)
              .join(' / ')}`,
            estoque: v.available_quantity ?? 0,
            preco: v.price ?? it.price ?? 0,
            listing_type: it.listing_type_id,
          });
          total++;
        }
      } else {
        await upsertProduto({
          item_id: it.id,
          variation_id: '',
          sku: it.seller_custom_field || null,
          titulo: it.title,
          estoque: it.available_quantity ?? 0,
          preco: it.price ?? 0,
          listing_type: it.listing_type_id,
        });
        total++;
      }
    }
  }
  return total;
}

async function upsertProduto({ item_id, variation_id, sku, titulo, estoque, preco, listing_type }) {
  await query(
    `INSERT INTO produtos (item_id, variation_id, sku, titulo, estoque_atual, preco_anuncio, listing_type, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (item_id, variation_id) DO UPDATE SET
       sku = COALESCE(EXCLUDED.sku, produtos.sku),
       titulo = EXCLUDED.titulo,
       estoque_atual = EXCLUDED.estoque_atual,
       preco_anuncio = EXCLUDED.preco_anuncio,
       listing_type = EXCLUDED.listing_type,
       atualizado_em = now()`,
    [item_id, variation_id, sku, titulo, estoque, preco, listing_type]
  );
}

export async function sincronizarPedidos(token, sellerId, desde) {
  const from = desde.toISOString().replace('Z', '-00:00');
  const to = new Date().toISOString().replace('Z', '-00:00');
  let offset = 0;
  let gravados = 0;

  while (offset < 4000) {
    const url =
      `/orders/search?seller=${sellerId}` +
      `&order.date_created.from=${encodeURIComponent(from)}` +
      `&order.date_created.to=${encodeURIComponent(to)}` +
      `&sort=date_desc&limit=50&offset=${offset}`;
    const res = await api(url, token);
    const results = res.results || [];
    for (const order of results) {
      await gravarPedido(order, token);
      gravados++;
    }
    offset += 50;
    if (offset >= (res.paging?.total ?? 0) || results.length === 0) break;
  }
  return gravados;
}

export async function sincronizarPedidoPorId(orderId, token) {
  const order = await api(`/orders/${orderId}`, token);
  await gravarPedido(order, token);
}

async function gravarPedido(order, token) {
  let frete = 0;
  let logistic = null;
  const shipmentId = order.shipping?.id ?? null;

  if (shipmentId) {
    try {
      const custos = await api(`/shipments/${shipmentId}/costs`, token);
      const sender = (custos.senders || [])[0];
      frete = Number(sender?.cost ?? 0);
      logistic = custos.receiver?.logistic_type ?? null;
    } catch {
      // envio ainda sem custo calculado; a próxima sincronização pega
    }
    if (!logistic) {
      try {
        const env = await api(`/shipments/${shipmentId}`, token);
        logistic = env.logistic_type ?? null;
      } catch {}
    }
  }

  await query(
    `INSERT INTO pedidos (order_id, data_criacao, data_fechamento, status, status_detail,
       comprador, total_pedido, shipment_id, frete_vendedor, logistic_type, payload, sincronizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (order_id) DO UPDATE SET
       status = EXCLUDED.status,
       status_detail = EXCLUDED.status_detail,
       total_pedido = EXCLUDED.total_pedido,
       frete_vendedor = EXCLUDED.frete_vendedor,
       logistic_type = COALESCE(EXCLUDED.logistic_type, pedidos.logistic_type),
       payload = EXCLUDED.payload,
       sincronizado_em = now()`,
    [
      order.id,
      order.date_created,
      order.date_closed,
      order.status,
      order.status_detail,
      order.buyer?.nickname ?? null,
      order.total_amount ?? 0,
      shipmentId,
      frete,
      logistic,
      JSON.stringify(order),
    ]
  );

  for (const it of order.order_items || []) {
    const variation = it.item?.variation_id ? String(it.item.variation_id) : '';
    await query(
      `INSERT INTO pedido_itens (order_id, item_id, variation_id, sku, titulo, quantidade,
         preco_unitario, sale_fee, listing_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (order_id, item_id, variation_id) DO UPDATE SET
         quantidade = EXCLUDED.quantidade,
         preco_unitario = EXCLUDED.preco_unitario,
         sale_fee = EXCLUDED.sale_fee`,
      [
        order.id,
        it.item?.id,
        variation,
        it.item?.seller_sku || it.item?.seller_custom_field || null,
        it.item?.title,
        it.quantity ?? 1,
        it.unit_price ?? 0,
        it.sale_fee ?? 0,
        it.listing_type_id ?? null,
      ]
    );

    // Cria a ficha do produto se a venda trouxe um anúncio que ainda não conhecíamos.
    await query(
      `INSERT INTO produtos (item_id, variation_id, sku, titulo, preco_anuncio, listing_type)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (item_id, variation_id) DO NOTHING`,
      [
        it.item?.id,
        variation,
        it.item?.seller_sku || it.item?.seller_custom_field || null,
        it.item?.title,
        it.unit_price ?? 0,
        it.listing_type_id ?? null,
      ]
    );
  }
}
