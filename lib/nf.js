import { query } from "./db";

const API = "https://api.mercadolibre.com";

/**
 * Emissão de NF pelo Faturador do próprio Mercado Livre.
 *
 * Contexto: em Mercado Envios Full a nota sai sozinha. Nas outras logísticas
 * o padrão é o vendedor clicar no painel, um por um. Mas existe um endpoint
 * que dispara a mesma emissão por API — é ele que automatiza o que hoje é
 * manual. Só funciona para quem usa o Faturador do Mercado Livre; quem emite
 * por ERP próprio precisa importar o XML, que é outro caminho.
 */

async function chamar(caminho, token, opcoes = {}) {
  const r = await fetch(`${API}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opcoes.headers || {}),
    },
  });
  const texto = await r.text();
  let corpo;
  try {
    corpo = texto ? JSON.parse(texto) : {};
  } catch {
    corpo = { message: texto.slice(0, 300) };
  }
  if (!r.ok) {
    const e = new Error(
      corpo.display_message || corpo.message || `HTTP ${r.status}`,
    );
    e.status = r.status;
    e.error_code = corpo.error_code ?? null;
    e.corpo = corpo;
    throw e;
  }
  return corpo;
}

/** Traduz o código de erro do Faturador para algo acionável. */
export async function explicarErro(token, errorCode) {
  if (!errorCode) return null;
  try {
    const d = await chamar(`/invoices/errors/${errorCode}`, token);
    return {
      codigo: errorCode,
      texto: d.display_message || d.source_message || null,
      corrigir_em: d.front_properties?.correctedIn || null,
      campos: d.front_properties?.correctedBy || [],
    };
  } catch {
    return { codigo: errorCode, texto: null };
  }
}

/**
 * Dispara a emissão. Uma nota por pedido, ou uma nota única para um
 * carrinho — nesse caso todas as orders do mesmo pack vão juntas.
 */
export async function emitirNota(token, sellerId, orderIds) {
  const orders = orderIds.map((o) => Number(o)).filter(Boolean);
  if (!orders.length) throw new Error("Nenhum pedido informado.");

  return chamar(`/users/${sellerId}/invoices/orders`, token, {
    method: "POST",
    body: JSON.stringify({ orders }),
  });
}

/** Consulta a nota de um pedido. Status AUTHORIZED = nota válida. */
export async function consultarNota(token, sellerId, orderId) {
  try {
    return await chamar(`/users/${sellerId}/invoices/orders/${orderId}`, token);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Emite em lote e grava o resultado. Devolve o que deu certo e o que
 * precisa de correção, com o motivo já traduzido.
 */
export async function emitirLote(token, sellerId, itens) {
  const ok = [];
  const falhas = [];

  for (const item of itens) {
    const orderIds = item.order_ids?.length ? item.order_ids : [item.order_id];
    try {
      const r = await emitirNota(token, sellerId, orderIds);
      const numero = r.invoice_number ?? r.number ?? r.id ?? null;

      await query(
        `UPDATE envios SET nf_numero = $2, nf_status = $3, nf_erro = NULL,
                           nf_emitida_em = now()
          WHERE order_id = ANY($1::bigint[])`,
        [
          orderIds.map(String),
          numero ? String(numero) : "emitida",
          r.status || "PROCESSING",
        ],
      );
      ok.push({
        order_id: item.order_id,
        numero,
        status: r.status || "PROCESSING",
      });
    } catch (e) {
      const detalhe = await explicarErro(token, e.error_code);
      const motivo = detalhe?.texto || e.message;
      await query(
        `UPDATE envios SET nf_status = 'ERRO', nf_erro = $2 WHERE order_id = $1`,
        [String(item.order_id), motivo],
      );
      falhas.push({
        order_id: item.order_id,
        erro: motivo,
        codigo: e.error_code,
        corrigir_em: detalhe?.corrigir_em || null,
        campos: detalhe?.campos || [],
      });
    }
  }

  return { emitidas: ok, falhas };
}

/** Atualiza o status das notas já disparadas, para saber quais autorizaram. */
export async function atualizarStatusNotas(token, sellerId, orderIds) {
  let autorizadas = 0;
  for (const orderId of orderIds) {
    try {
      const nota = await consultarNota(token, sellerId, orderId);
      if (!nota) continue;
      const status = nota.status || null;
      const numero = nota.invoice_number ?? nota.number ?? null;
      await query(
        `UPDATE envios SET nf_status = $2, nf_numero = COALESCE($3, nf_numero)
          WHERE order_id = $1`,
        [String(orderId), status, numero ? String(numero) : null],
      );
      if (status === "AUTHORIZED") autorizadas++;
    } catch {
      // segue para o próximo
    }
  }
  return autorizadas;
}
