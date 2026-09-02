import { PDFDocument } from "pdf-lib";
import { query, getConfigs } from "./db";

const API = "https://api.mercadolibre.com";

/**
 * A etiqueta do Mercado Livre vem numa folha A4 com a etiqueta no canto
 * superior esquerdo. Para impressora térmica é preciso recortar. Os valores
 * abaixo são em pontos PDF (72 por polegada), medidos numa etiqueta real:
 * 90 x 149 mm, que é o padrão 10x15.
 */
const RECORTE_PADRAO = { x0: 28, y0: 142, x1: 289, y1: 570 };

async function api(caminho, token, opcoes = {}) {
  const r = await fetch(`${API}${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${token}`, ...(opcoes.headers || {}) },
  });
  if (!r.ok) {
    const texto = await r.text();
    let msg = texto.slice(0, 200);
    try {
      msg = JSON.parse(texto).message || msg;
    } catch {}
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return r;
}

const json = async (caminho, token) => (await api(caminho, token)).json();

/**
 * Traduz status e substatus do envio para o que o vendedor precisa fazer.
 * A regra que importa: enquanto o substatus for invoice_pending, o Mercado
 * Livre não libera a etiqueta. Emitir a nota é o que destrava a impressão.
 */
export function situacao(env) {
  const st = env.status;
  const sub = env.substatus;
  const impresso = Boolean(env.impresso_em);
  const enviado = Boolean(env.despachado_em);

  if (st === "cancelled")
    return { etapa: "cancelado", rotulo: "Cancelado", ordem: 9 };
  if (st === "delivered")
    return { etapa: "entregue", rotulo: "Entregue", ordem: 8 };
  if (st === "shipped")
    return { etapa: "transporte", rotulo: "A caminho", ordem: 7 };

  // Marcações feitas aqui dentro têm prioridade sobre o status do Mercado
  // Livre, que só muda quando a transportadora bipa o pacote.
  if (env.despachado_em)
    return { etapa: "transporte", rotulo: "Despachado", ordem: 6 };
  if (env.impresso_em && st === "ready_to_ship") {
    return {
      etapa: "impresso",
      rotulo: "Impressa, falta despachar",
      ordem: 3,
      acao: "A etiqueta já saiu. Cole no pacote e entregue à transportadora.",
    };
  }

  if (sub === "invoice_pending") {
    return {
      etapa: "nf",
      rotulo: "Aguardando nota fiscal",
      ordem: 1,
      acao: "A etiqueta só é liberada depois que a NF (ou a DC-e) for emitida.",
    };
  }
  if (sub === "picked_up" || sub === "in_hub" || sub === "dropped_off") {
    return { etapa: "transporte", rotulo: "Coletado", ordem: 7 };
  }
  if (st === "ready_to_ship") {
    return { etapa: "imprimir", rotulo: "Pronto para imprimir", ordem: 2 };
  }
  if (st === "pending" || st === "handling") {
    return { etapa: "preparando", rotulo: "Em preparação", ordem: 3 };
  }
  return { etapa: "outro", rotulo: st || "sem status", ordem: 6 };
}

/**
 * Atualiza os envios dos pedidos recentes. Não busca de novo o que já chegou
 * a um estado final, para economizar chamadas.
 */
export async function sincronizarEnvios(token, dias = 15) {
  const desde = new Date(Date.now() - dias * 86400000);
  const pend = await query(
    `SELECT p.order_id, p.shipment_id, p.payload
       FROM pedidos p
       LEFT JOIN envios e ON e.shipment_id = p.shipment_id
      WHERE p.shipment_id IS NOT NULL
        AND p.data_criacao >= $1
        AND p.status NOT IN ('cancelled','invalid')
        AND (e.shipment_id IS NULL OR e.status NOT IN ('delivered','cancelled','not_delivered'))`,
    [desde],
  );

  let gravados = 0;
  let erros = 0;
  for (const linha of pend.rows) {
    try {
      const env = await json(`/shipments/${linha.shipment_id}`, token);
      const rec = env.receiver_address || {};
      const packId = linha.payload?.pack_id || env.pack_id || null;

      await query(
        `INSERT INTO envios
           (shipment_id, order_id, pack_id, status, substatus, logistic_type,
            tags, destinatario, cidade, uf, cep, data_criacao, prazo_despacho,
            payload, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (shipment_id) DO UPDATE SET
           status = EXCLUDED.status,
           substatus = EXCLUDED.substatus,
           logistic_type = EXCLUDED.logistic_type,
           tags = EXCLUDED.tags,
           prazo_despacho = EXCLUDED.prazo_despacho,
           payload = EXCLUDED.payload,
           atualizado_em = now()`,
        [
          String(env.id),
          String(linha.order_id),
          packId ? String(packId) : null,
          env.status ?? null,
          env.substatus ?? null,
          env.logistic_type ?? env.logistic?.type ?? null,
          JSON.stringify(env.tags || []),
          rec.receiver_name ?? null,
          rec.city?.name ?? null,
          rec.state?.id ?? null,
          rec.zip_code ?? null,
          env.date_created ?? null,
          env.shipping_option?.estimated_handling_limit?.date ?? null,
          JSON.stringify(env),
        ],
      );
      gravados++;
    } catch (e) {
      erros++;
      if (e.status === 429) break;
    }
  }
  return { gravados, erros, candidatos: pend.rows.length };
}

/** Lista para a tela de expedição, já classificada por etapa. */
export async function listarExpedicao(dias = 15) {
  const desde = new Date(Date.now() - dias * 86400000);
  const r = await query(
    `SELECT e.*, p.data_criacao AS pedido_em, p.comprador, p.total_pedido
       FROM envios e
       JOIN pedidos p ON p.order_id = e.order_id
      WHERE p.data_criacao >= $1
      ORDER BY p.data_criacao DESC`,
    [desde],
  );

  const itensRes = await query(
    `SELECT pi.order_id, pi.titulo, pi.sku, pi.quantidade,
            pi.preco_unitario, pi.item_id, pi.variation_id
       FROM pedido_itens pi
       JOIN pedidos p ON p.order_id = pi.order_id
      WHERE p.data_criacao >= $1`,
    [desde],
  );
  const porPedido = new Map();
  for (const it of itensRes.rows) {
    const arr = porPedido.get(String(it.order_id)) || [];
    arr.push(it);
    porPedido.set(String(it.order_id), arr);
  }

  return r.rows.map((e) => {
    const s = situacao(e);
    const itens = porPedido.get(String(e.order_id)) || [];
    return {
      shipment_id: e.shipment_id,
      order_id: e.order_id,
      pack_id: e.pack_id,
      status: e.status,
      substatus: e.substatus,
      logistic_type: e.logistic_type,
      destinatario: e.destinatario,
      cidade: e.cidade,
      uf: e.uf,
      comprador: e.comprador,
      total: Number(e.total_pedido || 0),
      pedido_em: e.pedido_em,
      prazo_despacho: e.prazo_despacho,
      impresso_em: e.impresso_em,
      despachado_em: e.despachado_em,
      nf_numero: e.nf_numero,
      nf_status: e.nf_status,
      nf_erro: e.nf_erro,
      itens,
      unidades_total: itens.reduce((a, i) => a + Number(i.quantidade || 0), 0),
      volumes: itens.length,
      cep: e.cep,
      tags: e.tags || [],
      // Prazo estourando: menos de 6 horas para despachar.
      atrasado: Boolean(
        e.prazo_despacho &&
        !e.despachado_em &&
        new Date(e.prazo_despacho).getTime() < Date.now() + 6 * 3600000,
      ),
      ...s,
      aba: s.etapa,
    };
  });
}

/**
 * Monta o PDF de impressão. Busca a etiqueta de cada envio separadamente
 * para saber com certeza qual página é a etiqueta (a segunda é a lista de
 * separação) e, se pedido, recorta no tamanho da etiqueta térmica.
 */
export async function montarEtiquetas(token, shipmentIds, opcoes = {}) {
  const {
    apenasPrimeira = true,
    recortar = true,
    recorte = RECORTE_PADRAO,
  } = opcoes;
  const saida = await PDFDocument.create();
  const falhas = [];

  for (const id of shipmentIds) {
    try {
      const r = await api(
        `/shipment_labels?shipment_ids=${id}&response_type=pdf`,
        token,
      );
      const bytes = new Uint8Array(await r.arrayBuffer());
      const doc = await PDFDocument.load(bytes);
      const total = doc.getPageCount();
      const indices = apenasPrimeira ? [0] : [...Array(total).keys()];
      const copiadas = await saida.copyPages(doc, indices);

      for (const pag of copiadas) {
        if (recortar) {
          const { width, height } = pag.getSize();
          // Só recorta se a caixa couber na página, senão deixa inteira.
          if (recorte.x1 <= width && recorte.y1 <= height) {
            pag.setMediaBox(
              recorte.x0,
              recorte.y0,
              recorte.x1 - recorte.x0,
              recorte.y1 - recorte.y0,
            );
            pag.setCropBox(
              recorte.x0,
              recorte.y0,
              recorte.x1 - recorte.x0,
              recorte.y1 - recorte.y0,
            );
          }
        }
        saida.addPage(pag);
      }
    } catch (e) {
      falhas.push({ shipment_id: id, erro: e.message, status: e.status });
    }
  }

  if (saida.getPageCount() === 0) {
    const e = new Error(
      falhas.length
        ? `Nenhuma etiqueta pôde ser gerada. ${falhas[0].erro}`
        : "Nenhum envio selecionado.",
    );
    e.falhas = falhas;
    throw e;
  }

  return { pdf: await saida.save(), falhas };
}

/** Etiqueta em ZPL (Zebra). Vem como ZIP, repassado direto. */
export async function etiquetasZpl(token, shipmentIds) {
  const r = await api(
    `/shipment_labels?shipment_ids=${shipmentIds.join(",")}&response_type=zpl2`,
    token,
  );
  return new Uint8Array(await r.arrayBuffer());
}

/** Marca envios como impressos ou despachados. */
export async function marcar(shipmentIds, campo) {
  const coluna = campo === "despachado" ? "despachado_em" : "impresso_em";
  await query(
    `UPDATE envios SET ${coluna} = now() WHERE shipment_id = ANY($1::text[])`,
    [shipmentIds.map(String)],
  );
}

/** Lê a configuração de recorte, com os padrões medidos numa etiqueta real. */
export async function recorteConfigurado() {
  const cfg = await getConfigs();
  const num = (v, p) => (v === undefined || v === "" ? p : Number(v));
  return {
    recortar: cfg.etiqueta_recortar !== "false",
    recorte: {
      x0: num(cfg.etiqueta_x0, RECORTE_PADRAO.x0),
      y0: num(cfg.etiqueta_y0, RECORTE_PADRAO.y0),
      x1: num(cfg.etiqueta_x1, RECORTE_PADRAO.x1),
      y1: num(cfg.etiqueta_y1, RECORTE_PADRAO.y1),
    },
  };
}

export { RECORTE_PADRAO };
