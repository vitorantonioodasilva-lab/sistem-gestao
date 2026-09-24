"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { brl, pct, dataCurta, sinal } from "@/components/formato";

const PERIODOS = [
  [7, "7 dias"],
  [30, "30 dias"],
  [90, "90 dias"],
  [180, "6 meses"],
];

export default function Painel() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [aberto, setAberto] = useState(null);

  async function carregar(d = dias) {
    setCarregando(true);
    setErro(null);
    try {
      const r = await fetch(`/api/dashboard?dias=${d}`);
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
    carregar(dias);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias]);

  async function sincronizar() {
    setSincronizando(true);
    setErro(null);
    try {
      const r = await fetch("/api/ml/sync");
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "Falha na sincronização");
      await carregar(dias);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  }

  if (erro && erro.includes("DATABASE_URL")) {
    return (
      <div className="aviso">
        <h2>Falta conectar o banco de dados</h2>
        Defina a variável <code>DATABASE_URL</code> no projeto da Vercel
        apontando para um Postgres (Neon e Supabase têm plano gratuito). As
        tabelas são criadas sozinhas no primeiro acesso.
      </div>
    );
  }

  if (carregando && !dados)
    return <p style={{ fontFamily: "var(--mono)" }}>Carregando…</p>;

  const semConta = !dados?.conta;
  const d = dados?.dre;
  // Só quem realmente vendeu no período entra na comparação.
  const canais = (dados?.canais || []).filter((c) => c.pedidos > 0);
  const multicanal = canais.length > 1;

  return (
    <>
      {semConta && (
        <div className="aviso">
          <h2>Conecte sua conta do Mercado Livre</h2>
          Sem a conexão, o painel fica vazio. Você autoriza uma vez e o sistema
          passa a puxar pedidos, tarifas e estoque sozinho.{" "}
          <Link href="/config">Ir para os ajustes →</Link>
        </div>
      )}

      {erro && !semConta && <div className="alerta">{erro}</div>}

      <div className="secao-titulo">
        <span>Resultado dos últimos {dias} dias</span>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="periodo">
            {PERIODOS.map(([v, texto]) => (
              <button
                key={v}
                data-ativo={v === dias ? "1" : "0"}
                onClick={() => setDias(v)}
              >
                {texto}
              </button>
            ))}
          </span>
          <button
            className="principal"
            onClick={sincronizar}
            disabled={sincronizando || semConta}
          >
            {sincronizando ? "Buscando…" : "Atualizar do ML"}
          </button>
        </span>
      </div>

      {d && (
        <div className="kpis secao">
          <div className="kpi">
            <div className="kpi-rotulo">Receita bruta</div>
            <div className="kpi-valor">{brl(d.receita)}</div>
            <div className="kpi-nota">{d.pedidos} pedidos válidos</div>
          </div>
          <div className="kpi">
            <div className="kpi-rotulo">Margem de contribuição</div>
            <div className={`kpi-valor ${sinal(d.margem_contribuicao)}`}>
              {brl(d.margem_contribuicao)}
            </div>
            <div className="kpi-nota">{pct(d.margem_pct)} da receita</div>
          </div>
          <div className="kpi">
            <div className="kpi-rotulo">Lucro operacional</div>
            <div className={`kpi-valor ${sinal(d.lucro_operacional)}`}>
              <span className="destaque">{brl(d.lucro_operacional)}</span>
            </div>
            <div className="kpi-nota">já descontando custo fixo</div>
          </div>
          <div className="kpi">
            <div className="kpi-rotulo">Ticket médio</div>
            <div className="kpi-valor">{brl(d.ticket_medio)}</div>
            <div className="kpi-nota">
              {d.cancelados} cancelado(s) no período
            </div>
          </div>
        </div>
      )}

      {dados?.alertas?.length > 0 && (
        <section className="secao">
          <div className="secao-titulo">O que precisa de decisão</div>
          {dados.alertas.map((a, i) => (
            <div
              key={i}
              className={`alerta ${a.nivel === "atencao" ? "atencao" : ""}`}
            >
              {a.texto}
            </div>
          ))}
        </section>
      )}

      {dados?.ads?.investido > 0 && (
        <BlocoAds ads={dados.ads} receita={d?.receita} />
      )}

      {d && (
        <section
          className="secao"
          style={{
            display: "grid",
            gap: 28,
            gridTemplateColumns: "minmax(280px, 420px) 1fr",
          }}
        >
          <div>
            {multicanal && (
              <>
                <div className="secao-titulo">Cada canal</div>
                <div className="canais">
                  {canais.map((c) => (
                    <div key={c.canal} className={`canal-linha ${c.canal}`}>
                      <div className="canal-nome">
                        {c.canal === "shopee" ? "Shopee" : "Mercado Livre"}
                        <span>
                          {c.pedidos} pedido{c.pedidos === 1 ? "" : "s"} ·{" "}
                          {pct(c.pct_receita)} da receita
                        </span>
                      </div>
                      <div
                        className="canal-barra"
                        title={`${pct(c.pct_receita)} da receita do período`}
                      >
                        <i style={{ width: `${Math.max(2, c.pct_receita)}%` }} />
                      </div>
                      <div className="canal-num">
                        <b className={sinal(c.lucro)}>{brl(c.lucro)}</b>
                        margem {pct(c.margem_pct)}
                      </div>
                      {/* Se o que o marketplace diz que repassou não bate com
                          a nossa conta, é a modelagem de tarifa que está
                          incompleta — melhor avisar que esconder no lucro. */}
                      {c.diferenca_repasse !== null &&
                        Math.abs(c.diferenca_repasse) >= 1 && (
                          <div className="canal-aviso">
                            O repasse informado difere da nossa conta em{" "}
                            <strong>{brl(c.diferenca_repasse)}</strong> em{" "}
                            {c.pedidos_com_repasse} pedido
                            {c.pedidos_com_repasse === 1 ? "" : "s"}. O lucro
                            desse canal é estimativa até isso fechar.
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="secao-titulo">Onde o dinheiro foi</div>
            <div className="fita">
              <div className="fita-cab">Período de {dias} dias</div>
              <Linha rotulo="Receita bruta" valor={d.receita} />
              <Linha
                rotulo={multicanal ? "Tarifa dos marketplaces" : "Tarifa Mercado Livre"}
                valor={-d.tarifa}
              />
              <Linha rotulo="Frete por sua conta" valor={-d.frete} />
              <Linha rotulo="Custo dos produtos" valor={-d.cmv} />
              <Linha rotulo="Embalagem" valor={-d.embalagem} />
              <Linha rotulo="Imposto" valor={-d.imposto} />
              {d.provisao > 0 && (
                <Linha rotulo="Provisão de devolução" valor={-d.provisao} />
              )}
              {d.ads > 0 && (
                <Linha rotulo="Mercado Ads (rateado)" valor={-d.ads} />
              )}
              <div className="fita-linha total">
                <span>Margem de contribuição</span>
                <span className={sinal(d.margem_contribuicao)}>
                  {brl(d.margem_contribuicao)}
                </span>
              </div>
              {d.ads_sem_venda > 0 && (
                <Linha
                  rotulo="Ads sem venda atribuída"
                  valor={-d.ads_sem_venda}
                />
              )}
              <Linha rotulo="Custo fixo rateado" valor={-d.custo_fixo} />
              <div className="fita-linha total">
                <span>Lucro operacional</span>
                <span className={sinal(d.lucro_operacional)}>
                  {brl(d.lucro_operacional)}
                </span>
              </div>
            </div>
          </div>

          <div>
            <div className="secao-titulo">Lucro por dia</div>
            <Grafico serie={dados.serie} />
          </div>
        </section>
      )}

      <section className="secao">
        <div className="secao-titulo">
          <span>Pedidos</span>
          <span style={{ textTransform: "none", letterSpacing: 0 }}>
            clique numa linha para ver a conta aberta
          </span>
        </div>
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Pedido</th>
                <th>Produto</th>
                <th className="num">Receita</th>
                <th className="num">Tarifa</th>
                <th className="num">Frete</th>
                <th className="num">Custo</th>
                <th className="num">Lucro</th>
                <th className="num">Margem</th>
              </tr>
            </thead>
            <tbody>
              {(dados?.pedidos || []).slice(0, 60).map((p) => (
                <Pedido
                  key={p.order_id}
                  p={p}
                  aberto={aberto === p.order_id}
                  onClick={() =>
                    setAberto(aberto === p.order_id ? null : p.order_id)
                  }
                />
              ))}
              {!dados?.pedidos?.length && (
                <tr>
                  <td colSpan={9} style={{ color: "var(--tinta-fraca)" }}>
                    Nenhum pedido no período. Conecte a conta e use “Atualizar
                    do ML”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="secao">
        <div className="secao-titulo">
          <span>Produtos por resultado</span>
          <Link
            href="/produtos"
            style={{ textTransform: "none", letterSpacing: 0 }}
          >
            editar custos →
          </Link>
        </div>
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>ABC</th>
                <th className="num">Un.</th>
                <th className="num">Receita</th>
                <th className="num">Ads</th>
                <th className="num">ACOS</th>
                <th className="num">Lucro</th>
                <th className="num">Margem</th>
                <th className="num">Estoque</th>
                <th className="num">Cobertura</th>
                <th className="num">Comprar</th>
              </tr>
            </thead>
            <tbody>
              {(dados?.produtos || [])
                .filter((p) => p.unidades_vendidas > 0)
                .slice(0, 25)
                .map((p) => (
                  <tr key={`${p.canal}|${p.item_id}|${p.variation_id}`}>
                    <td>
                      {multicanal && (
                        <span className={`r-canal ${p.canal}`}>
                          {p.canal === "shopee" ? "Shopee" : "Mercado Livre"}
                        </span>
                      )}{" "}
                      {p.titulo}
                      {p.custo_unitario === 0 && (
                        <span
                          className="tag"
                          style={{
                            marginLeft: 6,
                            borderColor: "var(--prejuizo)",
                            color: "var(--prejuizo)",
                          }}
                        >
                          sem custo
                        </span>
                      )}
                    </td>
                    <td>
                      {p.curva && (
                        <span className={`tag ${p.curva.toLowerCase()}`}>
                          {p.curva}
                        </span>
                      )}
                    </td>
                    <td className="num">{p.unidades_vendidas}</td>
                    <td className="num">{brl(p.receita)}</td>
                    <td className="num">
                      {p.ads_custo > 0 ? brl(p.ads_custo) : "—"}
                    </td>
                    <td
                      className="num"
                      style={
                        p.ads_acos > 30
                          ? { color: "var(--prejuizo)" }
                          : undefined
                      }
                    >
                      {p.ads_acos === null ? "—" : pct(p.ads_acos)}
                    </td>
                    <td className={`num ${sinal(p.lucro)}`}>{brl(p.lucro)}</td>
                    <td className={`num ${sinal(p.margem ?? 0)}`}>
                      {pct(p.margem)}
                    </td>
                    <td className="num">{p.estoque_atual}</td>
                    <td className="num">
                      {p.cobertura_dias === null
                        ? "—"
                        : `${p.cobertura_dias.toFixed(0)} d`}
                    </td>
                    <td className="num">{p.sugestao_compra || "—"}</td>
                  </tr>
                ))}
              {!dados?.produtos?.some((p) => p.unidades_vendidas > 0) && (
                <tr>
                  <td colSpan={11} style={{ color: "var(--tinta-fraca)" }}>
                    Nenhuma venda registrada ainda no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="rodape">
        No Mercado Livre a tarifa vem do campo <code>sale_fee</code> do pedido,
        que é a estimativa — o valor definitivo só aparece na fatura do mês.
        Confira em Ajustes se a sua tarifa é cobrada por unidade ou por linha do
        pedido.
        {multicanal && (
          <>
            {" "}
            Na Shopee a tarifa não é estimativa: comissão, taxa de serviço e
            taxa de transação vêm do repasse (escrow) do próprio pedido.
          </>
        )}
      </p>
    </>
  );
}

function BlocoAds({ ads, receita }) {
  const roasRuim = ads.roas !== null && ads.roas < 3;
  return (
    <section className="secao">
      <div className="secao-titulo">
        <span>Mercado Ads</span>
        <span style={{ textTransform: "none", letterSpacing: 0 }}>
          {ads.dias_com_dados} dia(s) com dados
        </span>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-rotulo">Investido em anúncios</div>
          <div className="kpi-valor prejuizo">{brl(ads.investido)}</div>
          <div className="kpi-nota">
            {pct(ads.pct_receita)} da receita bruta
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-rotulo">Receita atribuída</div>
          <div className="kpi-valor">{brl(ads.receita_atribuida)}</div>
          <div className="kpi-nota">vendas diretas e assistidas</div>
        </div>
        <div className="kpi">
          <div className="kpi-rotulo">ACOS</div>
          <div className={`kpi-valor ${ads.acos > 30 ? "prejuizo" : ""}`}>
            {pct(ads.acos)}
          </div>
          <div className="kpi-nota">custo do anúncio sobre a venda</div>
        </div>
        <div className="kpi">
          <div className="kpi-rotulo">ROAS</div>
          <div className={`kpi-valor ${roasRuim ? "prejuizo" : "lucro"}`}>
            {ads.roas === null ? "—" : `${ads.roas.toFixed(2)}×`}
          </div>
          <div className="kpi-nota">retorno por real investido</div>
        </div>
      </div>
      <p className="rodape" style={{ marginTop: 12 }}>
        O Mercado Livre cobra por clique, não por pedido. O sistema divide o
        gasto de cada anúncio entre as unidades que ele vendeu no período — é
        rateio, não atribuição pedido a pedido.
        {ads.sem_venda > 0 && (
          <>
            {" "}
            <strong>{brl(ads.sem_venda)}</strong> foram para anúncios sem venda
            no período e entram direto no resultado.
          </>
        )}
      </p>
    </section>
  );
}

function Linha({ rotulo, valor }) {
  return (
    <div className="fita-linha">
      <span>{rotulo}</span>
      <span>{brl(valor)}</span>
    </div>
  );
}

function Pedido({ p, aberto, onClick }) {
  const cancelado = p.status === "cancelled" || p.status === "invalid";
  return (
    <>
      <tr
        className="clicavel"
        onClick={onClick}
        style={cancelado ? { opacity: 0.5 } : undefined}
      >
        <td className="num" style={{ textAlign: "left" }}>
          {dataCurta(p.data)}
        </td>
        <td className="num" style={{ textAlign: "left" }}>
          {p.order_id}
        </td>
        <td>
          {p.itens[0]?.titulo?.slice(0, 46) || "—"}
          {p.itens.length > 1 && ` +${p.itens.length - 1}`}
          {cancelado && (
            <span className="tag" style={{ marginLeft: 6 }}>
              cancelado
            </span>
          )}
        </td>
        <td className="num">{brl(p.receita)}</td>
        <td className="num">{brl(p.tarifa)}</td>
        <td className="num">{brl(p.frete)}</td>
        <td className="num">{brl(p.cmv + p.embalagem)}</td>
        <td className={`num ${sinal(p.lucro)}`}>{brl(p.lucro)}</td>
        <td className={`num ${sinal(p.margem)}`}>{pct(p.margem)}</td>
      </tr>
      {aberto && (
        <tr>
          <td
            colSpan={9}
            style={{
              background: "var(--papel)",
              paddingTop: 14,
              paddingBottom: 18,
            }}
          >
            <div className="fita">
              <div className="fita-cab">
                Pedido {p.order_id} ·{" "}
                {p.logistic_type || "envio não identificado"}
              </div>
              {p.itens.map((i, idx) => (
                <div className="fita-linha" key={idx}>
                  <span>
                    {i.quantidade}× {i.titulo?.slice(0, 30)}
                  </span>
                  <span>{brl(i.preco_unitario * i.quantidade)}</span>
                </div>
              ))}
              <div className="fita-linha total">
                <span>Receita</span>
                <span>{brl(p.receita)}</span>
              </div>
              <Linha rotulo="Tarifa ML" valor={-p.tarifa} />
              <Linha rotulo="Frete vendedor" valor={-p.frete} />
              <Linha rotulo="Custo do produto" valor={-p.cmv} />
              <Linha rotulo="Embalagem" valor={-p.embalagem} />
              <Linha rotulo="Imposto" valor={-p.imposto} />
              {p.provisao > 0 && (
                <Linha rotulo="Provisão devolução" valor={-p.provisao} />
              )}
              {p.ads > 0 && (
                <Linha rotulo="Mercado Ads (rateado)" valor={-p.ads} />
              )}
              <div className="fita-linha total">
                <span>Sobrou</span>
                <span className={sinal(p.lucro)}>
                  <span className="destaque">{brl(p.lucro)}</span>
                </span>
              </div>
              {p.sem_custo && (
                <div
                  style={{
                    marginTop: 10,
                    color: "var(--prejuizo)",
                    fontSize: 11.5,
                  }}
                >
                  Um dos produtos está sem custo cadastrado. O lucro acima está
                  inflado.
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Grafico({ serie = [] }) {
  if (!serie.length)
    return (
      <p style={{ color: "var(--tinta-fraca)", fontSize: 13 }}>Sem dados.</p>
    );
  const max = Math.max(...serie.map((s) => Math.abs(s.lucro)), 1);
  return (
    <>
      <div className="grafico">
        {serie.map((s) => (
          <div
            key={s.dia}
            className={s.lucro >= 0 ? "pos" : "neg"}
            style={{
              height: `${Math.max(2, (Math.abs(s.lucro) / max) * 100)}%`,
            }}
            title={`${s.dia}: ${brl(s.lucro)} em ${s.pedidos} pedido(s)`}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--tinta-fraca)",
          marginTop: 6,
        }}
      >
        <span>{serie[0]?.dia}</span>
        <span>melhor dia: {brl(Math.max(...serie.map((s) => s.lucro)))}</span>
        <span>{serie[serie.length - 1]?.dia}</span>
      </div>
    </>
  );
}
