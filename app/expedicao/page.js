"use client";

import { useEffect, useState } from "react";
import { brl, dataCurta } from "@/components/formato";

const ETAPAS = [
  [
    "nf",
    "Aguardando NF",
    "Sem a nota fiscal o Mercado Livre não libera a etiqueta.",
  ],
  [
    "imprimir",
    "Pronto para imprimir",
    "Etiqueta liberada. Imprima e despache.",
  ],
  [
    "preparando",
    "Em preparação",
    "O Mercado Livre ainda não liberou este envio.",
  ],
  ["transporte", "A caminho", "Já saiu com a transportadora."],
];

export default function Expedicao() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [sel, setSel] = useState(new Set());
  const [aba, setAba] = useState("imprimir");

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch("/api/expedicao");
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha ao carregar");
      setDados(j);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  async function sincronizar() {
    setSincronizando(true);
    setErro(null);
    try {
      const r = await fetch("/api/expedicao", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha na sincronização");
      await carregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  }

  function imprimir(formato = "pdf", inteira = false) {
    if (!sel.size) return;
    const ids = [...sel].join(",");
    const qs = `ids=${ids}&formato=${formato}${inteira ? "&inteira=1" : ""}`;
    window.open(`/api/expedicao/etiqueta?${qs}`, "_blank");
    setTimeout(carregar, 2500);
  }

  async function marcarDespachado() {
    if (!sel.size) return;
    await fetch("/api/expedicao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        acao: "marcar",
        campo: "despachado",
        shipment_ids: [...sel],
      }),
    });
    setSel(new Set());
    carregar();
  }

  const lista = (dados?.envios || []).filter((e) => e.etapa === aba);
  const selecionaveis = lista.filter((e) => e.etapa === "imprimir");

  function alternar(id) {
    const novo = new Set(sel);
    novo.has(id) ? novo.delete(id) : novo.add(id);
    setSel(novo);
  }

  function alternarTodos() {
    if (selecionaveis.every((e) => sel.has(e.shipment_id))) setSel(new Set());
    else setSel(new Set(selecionaveis.map((e) => e.shipment_id)));
  }

  if (carregando && !dados)
    return <p style={{ fontFamily: "var(--mono)" }}>Carregando…</p>;

  return (
    <>
      <div className="secao-titulo">
        <span>Expedição</span>
        <button
          className="principal"
          onClick={sincronizar}
          disabled={sincronizando}
        >
          {sincronizando ? "Buscando…" : "Atualizar envios"}
        </button>
      </div>

      {erro && <div className="alerta">{erro}</div>}

      <div className="kpis secao">
        {ETAPAS.map(([chave, rotulo]) => (
          <button
            key={chave}
            className="kpi"
            onClick={() => {
              setAba(chave);
              setSel(new Set());
            }}
            style={{
              textAlign: "left",
              cursor: "pointer",
              background: aba === chave ? "var(--barra)" : undefined,
              borderColor: aba === chave ? "var(--tinta)" : undefined,
            }}
          >
            <div className="kpi-rotulo">{rotulo}</div>
            <div
              className={`kpi-valor ${chave === "nf" && dados?.resumo?.nf > 0 ? "prejuizo" : ""}`}
            >
              {dados?.resumo?.[chave] ?? 0}
            </div>
          </button>
        ))}
      </div>

      <p className="rodape" style={{ marginTop: 0, marginBottom: 18 }}>
        {ETAPAS.find(([c]) => c === aba)?.[2]}
      </p>

      {aba === "imprimir" && (
        <div
          className="secao"
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button onClick={alternarTodos}>
            {selecionaveis.length &&
            selecionaveis.every((e) => sel.has(e.shipment_id))
              ? "Limpar seleção"
              : "Selecionar todos"}
          </button>
          <button
            className="principal"
            onClick={() => imprimir("pdf")}
            disabled={!sel.size}
          >
            Imprimir {sel.size || ""} etiqueta{sel.size === 1 ? "" : "s"}
          </button>
          <button onClick={() => imprimir("pdf", true)} disabled={!sel.size}>
            Folha A4 inteira
          </button>
          <button onClick={() => imprimir("zpl")} disabled={!sel.size}>
            Baixar ZPL
          </button>
          <button onClick={marcarDespachado} disabled={!sel.size}>
            Marcar como despachado
          </button>
        </div>
      )}

      <section className="secao">
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                {aba === "imprimir" && <th style={{ width: 30 }}></th>}
                <th>Pedido</th>
                <th>Produto</th>
                <th>Destino</th>
                <th>Envio</th>
                <th className="num">Valor</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((e) => (
                <tr key={e.shipment_id}>
                  {aba === "imprimir" && (
                    <td>
                      <input
                        type="checkbox"
                        checked={sel.has(e.shipment_id)}
                        onChange={() => alternar(e.shipment_id)}
                      />
                    </td>
                  )}
                  <td className="num" style={{ textAlign: "left" }}>
                    {dataCurta(e.pedido_em)}
                    <br />
                    <span style={{ color: "var(--tinta-fraca)" }}>
                      {e.order_id}
                    </span>
                  </td>
                  <td>
                    {e.itens.map((i, idx) => (
                      <div key={idx}>
                        {i.quantidade}× {i.titulo?.slice(0, 44)}
                        {i.sku && (
                          <span style={{ color: "var(--tinta-fraca)" }}>
                            {" "}
                            · {i.sku}
                          </span>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    {e.destinatario || e.comprador}
                    <br />
                    <span style={{ color: "var(--tinta-fraca)" }}>
                      {e.cidade}
                      {e.uf ? `/${e.uf}` : ""}
                    </span>
                  </td>
                  <td>
                    <span className="tag">{e.logistic_type || "—"}</span>
                  </td>
                  <td className="num">{brl(e.total)}</td>
                  <td>
                    {e.rotulo}
                    {e.impresso_em && (
                      <div style={{ color: "var(--lucro)", fontSize: 11 }}>
                        impressa {dataCurta(e.impresso_em)}
                      </div>
                    )}
                    {e.despachado_em && (
                      <div
                        style={{ color: "var(--tinta-fraca)", fontSize: 11 }}
                      >
                        despachado {dataCurta(e.despachado_em)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!lista.length && (
                <tr>
                  <td colSpan={7} style={{ color: "var(--tinta-fraca)" }}>
                    Nada nesta etapa. Use “Atualizar envios” se acabou de
                    vender.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="rodape">
        A etiqueta sai recortada em 10×15 para a impressora térmica. Se sair
        torta ou cortada, o recorte é ajustável em Ajustes, e “Folha A4 inteira”
        sempre devolve o arquivo original do Mercado Livre. O botão ZPL só serve
        para impressoras que entendem Zebra — a maioria das térmicas portáteis
        Bluetooth não entende, e nessas o PDF é o caminho.
      </p>
    </>
  );
}
