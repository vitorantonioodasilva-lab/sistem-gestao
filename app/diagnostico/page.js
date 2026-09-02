"use client";

import { useState } from "react";
import { brl, pct } from "@/components/formato";
import {
  IconeGrafico,
  IconeAlerta,
  IconeCheck,
  IconeAtualizar,
} from "@/components/Icones";

const CORES = {
  critico: { fundo: "#fdecea", borda: "#a32218", rotulo: "Crítico" },
  atencao: { fundo: "#fff8e1", borda: "#b58100", rotulo: "Atenção" },
  oportunidade: { fundo: "#e9f5ee", borda: "#1d6b3f", rotulo: "Oportunidade" },
};

export default function Diagnostico() {
  const [dias, setDias] = useState(30);
  const [r, setR] = useState(null);
  const [erro, setErro] = useState(null);
  const [config, setConfig] = useState(false);
  const [carregando, setCarregando] = useState(false);

  async function analisar() {
    setCarregando(true);
    setErro(null);
    setConfig(false);
    try {
      const res = await fetch(`/api/diagnostico?dias=${dias}`);
      const j = await res.json();
      if (!res.ok) {
        setConfig(Boolean(j.configuracao));
        throw new Error(j.erro || "Falha na análise");
      }
      setR(j);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }

  const d = r?.dossie;

  return (
    <>
      <div className="secao-titulo">
        <span>Diagnóstico de vendas</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              className={dias === n ? "ativo" : ""}
              onClick={() => setDias(n)}
            >
              {n} dias
            </button>
          ))}
          <button
            className="principal"
            onClick={analisar}
            disabled={carregando}
          >
            <IconeAtualizar
              width={15}
              height={15}
              style={{ verticalAlign: -2, marginRight: 6 }}
            />
            {carregando ? "Analisando…" : "Analisar"}
          </button>
        </span>
      </div>

      {!r && !erro && !carregando && (
        <section className="secao">
          <p style={{ maxWidth: 660, lineHeight: 1.7 }}>
            Aqui o sistema junta o resultado do período, o gasto de publicidade
            por anúncio e o desempenho de cada produto, manda tudo para o Gemini
            e traz de volta um diagnóstico do que está drenando dinheiro e do
            que dá para crescer.
          </p>
          <p className="rodape">
            Só vão números agregados do seu negócio: receita, custo, tarifa,
            Ads, estoque e margem. Nenhum dado de comprador, endereço ou
            documento sai daqui.
          </p>
        </section>
      )}

      {erro && (
        <div className="alerta">
          <IconeAlerta
            width={16}
            height={16}
            style={{ verticalAlign: -3, marginRight: 6 }}
          />
          {erro}
          {config && (
            <p style={{ marginTop: 10, fontSize: 13 }}>
              Pegue uma chave gratuita em{" "}
              <code>aistudio.google.com/apikey</code>, cadastre na Vercel como{" "}
              <code>GEMINI_API_KEY</code> e faça um novo deploy.
            </p>
          )}
        </div>
      )}

      {carregando && (
        <section className="secao">
          <p style={{ fontFamily: "var(--mono)" }}>
            Montando o dossiê e consultando o modelo… isso leva alguns segundos.
          </p>
        </section>
      )}

      {r && (
        <>
          <section className="secao">
            <div className="fita">
              <div className="fita-titulo">Resumo</div>
              <p style={{ lineHeight: 1.7, margin: 0 }}>{r.analise.resumo}</p>
            </div>
          </section>

          <section className="secao">
            <div className="secao-titulo">
              <span>O que fazer</span>
              <span style={{ textTransform: "none", letterSpacing: 0 }}>
                {r.analise.diagnosticos?.length || 0} pontos
              </span>
            </div>
            <div style={{ display: "grid", gap: 14 }}>
              {(r.analise.diagnosticos || []).map((x, i) => {
                const c = CORES[x.gravidade] || CORES.atencao;
                return (
                  <article
                    key={i}
                    style={{
                      background: c.fundo,
                      borderLeft: `5px solid ${c.borda}`,
                      borderRadius: 10,
                      padding: "15px 18px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "baseline",
                        marginBottom: 8,
                      }}
                    >
                      <strong style={{ fontSize: 15 }}>{x.titulo}</strong>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: 1,
                          textTransform: "uppercase",
                          color: c.borda,
                        }}
                      >
                        {c.rotulo}
                      </span>
                    </div>
                    <p style={{ margin: "0 0 8px", lineHeight: 1.65 }}>
                      {x.achado}
                    </p>
                    <p style={{ margin: "0 0 6px", lineHeight: 1.65 }}>
                      <strong>Ação:</strong> {x.acao}
                    </p>
                    {x.impacto && (
                      <p
                        style={{
                          margin: 0,
                          fontSize: 13,
                          color: "var(--tinta-fraca)",
                        }}
                      >
                        Impacto estimado: {x.impacto}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          {r.analise.perguntas?.length > 0 && (
            <section className="secao">
              <div className="secao-titulo">Para afinar a análise</div>
              <ul style={{ lineHeight: 1.9 }}>
                {r.analise.perguntas.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="secao">
            <div className="secao-titulo">Números que o modelo recebeu</div>
            <div className="kpis">
              <div className="kpi">
                <div className="kpi-rotulo">Receita</div>
                <div className="kpi-valor">
                  {brl(d.resultado.receita_bruta)}
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-rotulo">Lucro operacional</div>
                <div
                  className={`kpi-valor ${d.resultado.lucro_operacional >= 0 ? "lucro" : "prejuizo"}`}
                >
                  {brl(d.resultado.lucro_operacional)}
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-rotulo">Investido em Ads</div>
                <div className="kpi-valor">{brl(d.publicidade.investido)}</div>
                <div className="kpi-nota">
                  ACOS {pct(d.publicidade.acos_pct)}
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-rotulo">Produtos analisados</div>
                <div className="kpi-valor">{d.produtos.length}</div>
              </div>
            </div>
            <p className="rodape">
              Modelo: {r.modelo}. Gerado em{" "}
              {new Date(r.gerado_em).toLocaleString("pt-BR")}. O diagnóstico é
              uma leitura dos seus números, não uma garantia — confira antes de
              mudar preço ou orçamento.
            </p>
          </section>
        </>
      )}
    </>
  );
}
