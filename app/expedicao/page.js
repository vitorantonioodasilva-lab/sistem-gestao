"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { brl, dataCurta } from "@/components/formato";
import {
  IconeNota,
  IconeImpressora,
  IconeCaixa,
  IconeCaminhao,
  IconeCheck,
  IconeAtualizar,
  IconeLocal,
  IconeRelogio,
  IconeAlerta,
  IconeEtiqueta,
} from "@/components/Icones";

const ABAS = [
  {
    chave: "nf",
    rotulo: "Aguardando nota",
    Icone: IconeNota,
    urgente: true,
    ajuda:
      "Sem a nota fiscal o Mercado Livre não libera a etiqueta. Emita por aqui.",
  },
  {
    chave: "imprimir",
    rotulo: "Pronto para imprimir",
    Icone: IconeImpressora,
    ajuda: "Etiqueta liberada. Selecione, imprima e separe.",
  },
  {
    chave: "impresso",
    rotulo: "Impresso, falta enviar",
    Icone: IconeCaixa,
    ajuda: "Já saiu da impressora. Falta despachar e marcar aqui.",
  },
  {
    chave: "transporte",
    rotulo: "Já enviado",
    Icone: IconeCaminhao,
    ajuda: "Tudo certo, a transportadora já levou.",
  },
  {
    chave: "futuras",
    rotulo: "Ainda vem por aí",
    Icone: IconeRelogio,
    ajuda:
      "Vendas que o Mercado Livre ainda não liberou. É só para você se preparar.",
  },
];

const ORDENACOES = [
  ["prazo", "prazo mais apertado"],
  ["recente", "venda mais recente"],
  ["valor", "maior valor"],
];

export default function Expedicao() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [aba, setAba] = useState("nf");
  const [recado, setRecado] = useState(null);
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState("prazo");
  const [canal, setCanal] = useState("todos");

  async function carregar(silencioso) {
    if (!silencioso) setCarregando(true);
    try {
      const r = await fetch("/api/expedicao");
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Não consegui carregar");
      setDados(j);
      setErro(null);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  // A primeira aba com trabalho pendente é a que abre.
  useEffect(() => {
    if (!dados) return;
    const primeira = ABAS.find((a) => (dados.resumo?.[a.chave] ?? 0) > 0);
    if (primeira) setAba(primeira.chave);
  }, [dados?.resumo?.nf, dados?.resumo?.imprimir]);

  async function acao(nome, fn) {
    setOcupado(nome);
    setErro(null);
    setRecado(null);
    try {
      await fn();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(null);
    }
  }

  const sincronizar = () =>
    acao("sync", async () => {
      const r = await fetch("/api/expedicao", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro);
      await carregar(true);
    });

  const emitirNotas = () =>
    acao("nf", async () => {
      // O Faturador é do Mercado Livre; nota da Shopee sai no Seller Centre.
      const shopee = selecionadosShopee();
      if (shopee.length) {
        throw new Error(
          `${shopee.length} pedido(s) da Shopee na seleção. A nota da Shopee é emitida no Seller Centre, não por aqui.`,
        );
      }
      const r = await fetch("/api/nf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipment_ids: [...sel] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro);
      const n = j.emitidas?.length ?? 0;
      setRecado(
        j.falhas?.length
          ? `${n} nota(s) emitida(s). ${j.falhas.length} precisam de correção: ${j.falhas[0].erro}`
          : `${n} nota(s) enviada(s) para emissão. A etiqueta libera assim que o status virar autorizada.`,
      );
      setSel(new Set());
      await carregar(true);
    });

  const conferirNotas = () =>
    acao("status", async () => {
      const r = await fetch("/api/nf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao: "status", shipment_ids: [...sel] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro);
      setRecado(`${j.autorizadas} nota(s) já autorizada(s).`);
      await carregar(true);
    });

  /** Quais dos selecionados são da Shopee. As ações abaixo são só do ML. */
  function selecionadosShopee() {
    return (dados?.envios || []).filter(
      (e) => sel.has(e.shipment_id) && e.canal === "shopee",
    );
  }

  /**
   * Baixa sem abrir aba. A etiqueta vai direto para a pasta de downloads,
   * que é de onde ela é mandada para a impressora — abrir no visualizador do
   * navegador só acrescentava um passo e o risco de imprimir com "ajustar à
   * página". O servidor manda Content-Disposition: attachment; o atributo
   * download aqui é a segunda trava.
   */
  function baixar(url, nome) {
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function imprimir(inteira) {
    if (!sel.size) return;
    const shopee = selecionadosShopee();
    if (shopee.length) {
      setRecado(
        `${shopee.length} pedido${shopee.length === 1 ? "" : "s"} da Shopee na seleção. ` +
          "A etiqueta da Shopee ainda não é baixada por aqui: pegue no Seller Centre e passe em Etiquetas.",
      );
      return;
    }
    baixarEtiquetas(inteira);
  }

  /**
   * Busca o PDF, confere que veio PDF mesmo e só então baixa. Apontar o link
   * direto para a rota seria mais curto, mas quando o Mercado Livre recusa a
   * etiqueta a resposta é um JSON de erro — e o navegador salvaria esse JSON
   * com nome de .pdf, entregando um arquivo quebrado em vez da mensagem.
   */
  const baixarEtiquetas = (inteira) =>
    acao("etiqueta", async () => {
      const quantos = sel.size;
      const r = await fetch(
        `/api/expedicao/etiqueta?ids=${[...sel].join(",")}&formato=pdf${inteira ? "&inteira=1" : ""}`,
      );

      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.erro || "Não consegui gerar as etiquetas.");
      }

      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      baixar(url, `etiquetas-${quantos}.pdf`);
      // O blob já foi entregue ao navegador; soltar a memória depois disso.
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      const falhas = Number(r.headers.get("X-Falhas") || 0);
      setRecado(
        `${quantos} etiqueta${quantos === 1 ? "" : "s"} na pasta de downloads.` +
          (falhas ? ` ${falhas} não veio(vieram) do Mercado Livre.` : ""),
      );
      setTimeout(() => carregar(true), 1500);
    });

  function separacao() {
    if (!sel.size) return;
    window.open(`/api/expedicao/separacao?ids=${[...sel].join(",")}`, "_blank");
  }

  const desfazer = (campo) =>
    acao("desfazer", async () => {
      await fetch("/api/expedicao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acao: "marcar",
          campo,
          desfazer: true,
          shipment_ids: [...sel],
        }),
      });
      setRecado(
        campo === "impresso"
          ? "Marcação de impressão desfeita. Voltaram para a fila."
          : "Envio desfeito. Voltaram para a fila de despacho.",
      );
      setSel(new Set());
      await carregar(true);
    });

  const marcarEnviado = () =>
    acao("despacho", async () => {
      await fetch("/api/expedicao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acao: "marcar",
          campo: "despachado",
          shipment_ids: [...sel],
        }),
      });
      setRecado("Marcados como enviados. Bom trabalho!");
      setSel(new Set());
      await carregar(true);
    });

  const todos = dados?.envios || [];
  const termo = busca.trim().toLowerCase();
  // Sem venda na Shopee, nada de canal aparece: a tela continua igual.
  const temShopee = todos.some((e) => e.canal === "shopee");

  const lista = todos
    .filter((e) => e.aba === aba)
    .filter((e) => canal === "todos" || (e.canal || "ml") === canal)
    .filter((e) => {
      if (!termo) return true;
      const alvo = [
        e.order_id,
        e.shipment_id,
        e.destinatario,
        e.comprador,
        e.cidade,
        e.nf_numero,
        ...e.itens.flatMap((i) => [i.titulo, i.sku]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return alvo.includes(termo);
    })
    .sort((a, b) => {
      if (ordem === "valor") return b.total - a.total;
      if (ordem === "recente")
        return new Date(b.pedido_em) - new Date(a.pedido_em);
      // prazo: quem não tem prazo vai para o fim
      const pa = a.prazo_despacho
        ? new Date(a.prazo_despacho).getTime()
        : Infinity;
      const pb = b.prazo_despacho
        ? new Date(b.prazo_despacho).getTime()
        : Infinity;
      return pa - pb;
    });

  const unidadesSelecionadas = todos
    .filter((e) => sel.has(e.shipment_id))
    .reduce((t, e) => t + (e.unidades_total || 0), 0);
  const contas = dados?.resumo || {};
  const totalTarefas =
    (contas.nf || 0) + (contas.imprimir || 0) + (contas.impresso || 0);

  function alternar(id) {
    const n = new Set(sel);
    n.has(id) ? n.delete(id) : n.add(id);
    setSel(n);
  }
  const todosMarcados =
    lista.length > 0 && lista.every((e) => sel.has(e.shipment_id));
  const alternarTodos = () =>
    setSel(
      todosMarcados ? new Set() : new Set(lista.map((e) => e.shipment_id)),
    );

  const abaAtual = ABAS.find((a) => a.chave === aba);

  // Unidades que ainda precisam sair da prateleira hoje.
  const unidadesHoje = todos
    .filter(
      (e) => e.aba === "nf" || e.aba === "imprimir" || e.aba === "impresso",
    )
    .reduce((t, e) => t + (e.unidades_total || 0), 0);

  return (
    <div className="rosa">
      <header className="r-hero r-entra">
        <div className="r-coracoes" aria-hidden="true">
          {[12, 30, 52, 74, 88].map((esq, i) => (
            <span
              key={esq}
              className="r-coracao"
              style={{ left: `${esq}%`, animationDelay: `${i * 0.65}s` }}
            >
              {i % 2 ? "💕" : "🌸"}
            </span>
          ))}
        </div>
        <Image
          src="/sara.png"
          alt="Sara"
          width={104}
          height={104}
          className="r-foto"
          priority
        />
        <div>
          <p className="r-ola">Bem-vinda, Sara! 🌷</p>
          <span className="r-cargo">Chefa da Expedição</span>
          <p className="r-elogio">
            Você é linda, maravilhosa e a operação só funciona porque você
            segura essa ponta.
            {totalTarefas > 0 ? (
              <>
                {" "}
                Hoje tem <strong>{totalTarefas}</strong> pedido
                {totalTarefas === 1 ? "" : "s"} esperando por você.
              </>
            ) : (
              " Hoje está tudo em dia por aqui. 💖"
            )}
          </p>
        </div>
      </header>

      <section className="r-cards">
        {ABAS.map(({ chave, rotulo, Icone, urgente }, i) => {
          const n = contas[chave] ?? 0;
          return (
            <button
              key={chave}
              className={`r-card r-entra r-d${i + 1} ${aba === chave ? "ativo" : ""} ${
                urgente && n > 0 ? "urgente" : ""
              }`}
              onClick={() => {
                setAba(chave);
                setSel(new Set());
                setRecado(null);
              }}
            >
              <span className="r-card-icone">
                <Icone width={21} height={21} />
              </span>
              <span>
                <span className="r-card-num">{n}</span>
                <span className="r-card-rot">{rotulo}</span>
              </span>
            </button>
          );
        })}
      </section>

      <section className="r-missao r-entra r-d3">
        <h3>Missão de hoje</h3>
        {totalTarefas === 0 ? (
          <p className="r-tudocerto">
            <IconeCheck width={20} height={20} /> Nada pendente. Aproveita o
            café! ☕
          </p>
        ) : (
          <ol>
            {contas.nf > 0 && (
              <li>
                Emitir a nota de <strong>{contas.nf}</strong> pedido
                {contas.nf === 1 ? "" : "s"} — sem isso a etiqueta não sai.
              </li>
            )}
            {contas.imprimir > 0 && (
              <li>
                Imprimir <strong>{contas.imprimir}</strong> etiqueta
                {contas.imprimir === 1 ? "" : "s"} e separar os produtos.
              </li>
            )}
            {contas.impresso > 0 && (
              <li>
                Despachar <strong>{contas.impresso}</strong> pacote
                {contas.impresso === 1 ? "" : "s"} já impresso
                {contas.impresso === 1 ? "" : "s"}.
              </li>
            )}
            {unidadesHoje > 0 && (
              <li>
                No total são <strong>{unidadesHoje}</strong> unidade
                {unidadesHoje === 1 ? "" : "s"} para separar na prateleira.
              </li>
            )}
          </ol>
        )}
      </section>

      {erro && (
        <div className="r-aviso">
          <IconeAlerta
            width={17}
            height={17}
            style={{ verticalAlign: -3, marginRight: 6 }}
          />
          {erro}
        </div>
      )}
      {recado && (
        <div className="r-aviso" style={{ borderLeftColor: "var(--r-ok)" }}>
          <IconeCheck
            width={17}
            height={17}
            style={{ verticalAlign: -3, marginRight: 6 }}
          />
          {recado}
        </div>
      )}

      <div className="r-acoes r-entra r-d4">
        <button className="r-btn" onClick={sincronizar} disabled={ocupado}>
          <IconeAtualizar
            width={16}
            height={16}
            className={ocupado === "sync" ? "r-girando" : ""}
          />
          {ocupado === "sync" ? "Buscando…" : "Buscar novos pedidos"}
        </button>

        {lista.length > 0 && (
          <button className="r-btn" onClick={alternarTodos}>
            {todosMarcados ? "Desmarcar tudo" : "Marcar tudo"}
          </button>
        )}

        {aba === "nf" && (
          <>
            <button
              className="r-btn nf"
              onClick={emitirNotas}
              disabled={!sel.size || ocupado}
            >
              <IconeNota width={16} height={16} />
              {ocupado === "nf" ? "Emitindo…" : `Emitir nota (${sel.size})`}
            </button>
            <button
              className="r-btn"
              onClick={conferirNotas}
              disabled={!sel.size || ocupado}
            >
              <IconeRelogio width={16} height={16} /> Conferir se autorizou
            </button>
          </>
        )}

        {(aba === "imprimir" || aba === "impresso") && (
          <>
            <button
              className="r-btn forte"
              onClick={() => imprimir(false)}
              disabled={!sel.size || ocupado}
            >
              <IconeEtiqueta width={16} height={16} />
              {ocupado === "etiqueta"
                ? "Baixando…"
                : `${aba === "impresso" ? "Reimprimir" : "Imprimir"} ${sel.size || ""} etiqueta${sel.size === 1 ? "" : "s"}`}
            </button>
            <button
              className="r-btn"
              onClick={separacao}
              disabled={!sel.size}
              title="Papel para levar ao estoque, agrupado por produto"
            >
              <IconeCaixa width={16} height={16} /> Lista de separação
            </button>
            <button
              className="r-btn"
              onClick={() => imprimir(true)}
              disabled={!sel.size || ocupado}
            >
              Folha A4 inteira
            </button>
            <button
              className="r-btn"
              onClick={marcarEnviado}
              disabled={!sel.size || ocupado}
            >
              <IconeCheck width={16} height={16} /> Marcar como enviado
            </button>
            {aba === "impresso" && (
              <button
                className="r-btn"
                onClick={() => desfazer("impresso")}
                disabled={!sel.size || ocupado}
                title="Volta para a fila de impressão"
              >
                Desfazer impressão
              </button>
            )}
          </>
        )}

        {aba === "transporte" && (
          <button
            className="r-btn"
            onClick={() => desfazer("despachado")}
            disabled={!sel.size || ocupado}
            title="Marcou sem querer? Volta para a fila de despacho"
          >
            Desfazer envio
          </button>
        )}

        <input
          className="r-busca"
          type="search"
          placeholder="Buscar produto, SKU, comprador ou pedido…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />

        {temShopee && (
          <select
            className="r-select"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            title="Filtrar por canal de venda"
          >
            <option value="todos">Todos os canais</option>
            <option value="ml">Só Mercado Livre</option>
            <option value="shopee">Só Shopee</option>
          </select>
        )}

        <select
          className="r-select"
          value={ordem}
          onChange={(e) => setOrdem(e.target.value)}
          title="Ordenar a lista"
        >
          {ORDENACOES.map(([v, r]) => (
            <option key={v} value={v}>
              {r}
            </option>
          ))}
        </select>

        <span className="r-contador">
          {sel.size
            ? `${sel.size} pacote${sel.size === 1 ? "" : "s"} · ${unidadesSelecionadas} unidade${
                unidadesSelecionadas === 1 ? "" : "s"
              }`
            : abaAtual?.ajuda}
        </span>
      </div>

      {carregando && !dados ? (
        <div className="r-vazio">
          <span className="r-vazio-emoji">🌸</span>
          Carregando os pedidos…
        </div>
      ) : lista.length === 0 ? (
        <div className="r-vazio">
          <span className="r-vazio-emoji">
            {aba === "transporte" ? "🚚" : "✨"}
          </span>
          Nada nesta etapa agora.
          <br />
          {aba !== "transporte" &&
            "Use “Buscar novos pedidos” se acabou de entrar venda."}
        </div>
      ) : (
        <div className="r-lista">
          {lista.map((e, i) => (
            <article
              key={e.shipment_id}
              className={`r-item ${sel.has(e.shipment_id) ? "marcado" : ""}`}
              style={{ animationDelay: `${Math.min(i * 0.04, 0.4)}s` }}
            >
              <input
                type="checkbox"
                className="r-check"
                checked={sel.has(e.shipment_id)}
                onChange={() => alternar(e.shipment_id)}
                aria-label={`Selecionar pedido ${e.order_id}`}
              />

              <div>
                {temShopee && (
                  <span className={`r-canal ${e.canal || "ml"}`}>
                    {(e.canal || "ml") === "shopee" ? "Shopee" : "Mercado Livre"}
                  </span>
                )}
                {e.itens.map((it, k) => (
                  <div className="r-prod" key={k}>
                    <span className="r-qtd">{it.quantidade}×</span>
                    {it.titulo}
                  </div>
                ))}

                <div className="r-meta">
                  {e.itens.some((it) => it.sku) && (
                    <>
                      SKU{" "}
                      <strong>
                        {e.itens
                          .map((it) => it.sku)
                          .filter(Boolean)
                          .join(", ")}
                      </strong>
                      {" · "}
                    </>
                  )}
                  <strong>{e.unidades_total}</strong> unidade
                  {e.unidades_total === 1 ? "" : "s"} no pacote
                  <br />
                  <IconeLocal
                    width={13}
                    height={13}
                    style={{ verticalAlign: -2 }}
                  />{" "}
                  {e.destinatario || e.comprador}
                  {e.cidade && (
                    <>
                      {" — "}
                      {e.cidade}
                      {e.uf ? `/${e.uf}` : ""}
                    </>
                  )}
                  <br />
                  Pedido {e.order_id} · {dataCurta(e.pedido_em)}
                  {e.prazo_despacho && (
                    <>
                      {" · "}
                      <IconeRelogio
                        width={13}
                        height={13}
                        style={{ verticalAlign: -2 }}
                      />{" "}
                      despachar até {dataCurta(e.prazo_despacho)}
                    </>
                  )}
                </div>

                <div className="r-chips">
                  <span className="r-chip">
                    {e.logistic_type || "sem logística"}
                  </span>
                  {e.nf_status && (
                    <span
                      className={`r-chip ${
                        e.nf_status === "AUTHORIZED"
                          ? "ok"
                          : e.nf_status === "ERRO"
                            ? "erro"
                            : "neutro"
                      }`}
                    >
                      NF{" "}
                      {e.nf_numero
                        ? `nº ${e.nf_numero}`
                        : e.nf_status.toLowerCase()}
                    </span>
                  )}
                  {e.impresso_em && (
                    <span className="r-chip ok">
                      impressa {dataCurta(e.impresso_em)}
                      {e.vezes_impresso > 1 && ` · ${e.vezes_impresso}×`}
                    </span>
                  )}
                  {e.despachado_em && (
                    <span className="r-chip neutro">
                      enviado {dataCurta(e.despachado_em)}
                    </span>
                  )}
                  {e.atrasado && (
                    <span className="r-chip erro">prazo estourando</span>
                  )}
                </div>

                {e.nf_erro && (
                  <div
                    className="r-meta"
                    style={{ color: "var(--r-alerta)", marginTop: 6 }}
                  >
                    Nota recusada: {e.nf_erro}
                  </div>
                )}
              </div>

              <div className="r-direita">
                <div className="r-valor">{brl(e.total)}</div>
                <div className="r-meta">{e.rotulo}</div>
                <a
                  className="r-link"
                  href={e.link_ml}
                  target="_blank"
                  rel="noreferrer"
                >
                  abrir {(e.canal || "ml") === "shopee" ? "na Shopee" : "no ML"} ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="r-nota">
        A etiqueta sai recortada em 10×15, pronta para a impressora térmica, e a
        segunda folha (a lista de separação) é descartada. Se sair cortada, dá
        para ajustar o recorte em Ajustes. “Emitir nota” usa o Faturador do
        próprio Mercado Livre — a mesma nota que sairia clicando no painel, só
        que sem clicar um por um.
      </p>
    </div>
  );
}
