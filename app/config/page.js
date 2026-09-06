"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { brl } from "@/components/formato";

export default function Pagina() {
  return (
    <Suspense
      fallback={<p style={{ fontFamily: "var(--mono)" }}>Carregando…</p>}
    >
      <Config />
    </Suspense>
  );
}

function Config() {
  const params = useSearchParams();
  const [d, setD] = useState(null);
  const [novo, setNovo] = useState({ descricao: "", valor_mensal: "" });
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    const r = await fetch("/api/configuracoes");
    setD(await r.json());
  }
  useEffect(() => {
    carregar();
  }, []);

  async function salvar(corpo) {
    setSalvando(true);
    await fetch("/api/configuracoes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    });
    await carregar();
    setSalvando(false);
  }

  if (!d) return <p style={{ fontFamily: "var(--mono)" }}>Carregando…</p>;

  const cfg = d.config || {};
  const amb = d.ambiente || {};
  const faltaAmbiente =
    !amb.client_id || !amb.client_secret || !amb.redirect_uri;
  const faltaShopee =
    !amb.shopee_partner_id || !amb.shopee_partner_key || !amb.shopee_redirect_uri;
  const totalFixo = (d.custos_fixos || []).reduce(
    (a, c) => a + Number(c.valor_mensal),
    0,
  );

  return (
    <>
      {params.get("conectado") && (
        <div className="aviso">
          <h2>Conta conectada</h2>
          Agora volte ao painel e clique em “Atualizar do ML” para trazer o
          histórico.
        </div>
      )}
      {params.get("shopee") && (
        <div className="aviso">
          <h2>Loja da Shopee conectada</h2>
          Volte ao painel e clique em “Atualizar” para trazer os pedidos.
        </div>
      )}
      {params.get("erro") && (
        <div className="alerta">Falha na conexão: {params.get("erro")}</div>
      )}

      <section className="secao">
        <div className="secao-titulo">Conexão com o Mercado Livre</div>

        {faltaAmbiente ? (
          <div className="aviso">
            <h2>Faltam variáveis de ambiente</h2>
            Cadastre no projeto da Vercel e faça um novo deploy:
            <ul
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                lineHeight: 1.9,
              }}
            >
              <li>ML_CLIENT_ID {amb.client_id ? "✓" : "— faltando"}</li>
              <li>ML_CLIENT_SECRET {amb.client_secret ? "✓" : "— faltando"}</li>
              <li>ML_REDIRECT_URI {amb.redirect_uri || "— faltando"}</li>
            </ul>
            O valor de <code>ML_REDIRECT_URI</code> precisa ser idêntico ao
            cadastrado na sua aplicação no DevCenter, incluindo{" "}
            <code>https://</code> e sem barra final.
          </div>
        ) : d.conta ? (
          <div className="fita" style={{ maxWidth: 460 }}>
            <div className="fita-cab">Conta autorizada</div>
            <div className="fita-linha">
              <span>Vendedor</span>
              <span>{d.conta.nickname || "—"}</span>
            </div>
            <div className="fita-linha">
              <span>Seller ID</span>
              <span>{d.conta.seller_id}</span>
            </div>
            <div className="fita-linha">
              <span>Autorizado em</span>
              <span>
                {new Date(d.conta.conectado_em).toLocaleDateString("pt-BR")}
              </span>
            </div>
            <div className="fita-linha">
              <span>Token expira</span>
              <span>{new Date(d.conta.expira_em).toLocaleString("pt-BR")}</span>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <a className="botao" href="/api/ml/auth">
                Reautorizar
              </a>
              <a className="botao" href="/api/ml/sync">
                Sincronizar agora
              </a>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ maxWidth: 620, lineHeight: 1.6 }}>
              Você será levado ao Mercado Livre para autorizar o acesso de
              leitura aos seus pedidos, anúncios e envios. Entre com a conta
              principal de vendedor — login de colaborador não gera autorização
              válida.
            </p>
            <a
              className="botao"
              href="/api/ml/auth"
              style={{ background: "var(--marcador)" }}
            >
              Conectar conta do Mercado Livre
            </a>
          </div>
        )}
      </section>

      <section className="secao">
        <div className="secao-titulo">Conexão com a Shopee</div>

        {faltaShopee ? (
          <div className="aviso">
            <h2>Faltam variáveis de ambiente</h2>
            Crie um app em <code>open.shopee.com</code>, pegue o Partner ID e a
            Partner Key e cadastre na Vercel:
            <ul
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                lineHeight: 1.9,
              }}
            >
              <li>
                SHOPEE_PARTNER_ID {amb.shopee_partner_id ? "✓" : "— faltando"}
              </li>
              <li>
                SHOPEE_PARTNER_KEY {amb.shopee_partner_key ? "✓" : "— faltando"}
              </li>
              <li>
                SHOPEE_REDIRECT_URI{" "}
                {amb.shopee_redirect_uri || "— faltando"}
              </li>
            </ul>
            O <code>SHOPEE_REDIRECT_URI</code> precisa terminar em{" "}
            <code>/api/shopee/callback</code> e estar cadastrado igual no painel
            da Shopee, incluindo <code>https://</code>.
          </div>
        ) : d.conta_shopee ? (
          <div className="fita" style={{ maxWidth: 460 }}>
            <div className="fita-cab">Loja autorizada</div>
            <div className="fita-linha">
              <span>Loja</span>
              <span>{d.conta_shopee.shop_name || "—"}</span>
            </div>
            <div className="fita-linha">
              <span>Shop ID</span>
              <span>{d.conta_shopee.shop_id}</span>
            </div>
            <div className="fita-linha">
              <span>Autorizada em</span>
              <span>
                {new Date(d.conta_shopee.conectado_em).toLocaleDateString(
                  "pt-BR",
                )}
              </span>
            </div>
            <div className="fita-linha">
              <span>Token expira</span>
              <span>
                {new Date(d.conta_shopee.expira_em).toLocaleString("pt-BR")}
              </span>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <a className="botao" href="/api/shopee/auth">
                Reautorizar
              </a>
              <a className="botao" href="/api/shopee/sync">
                Sincronizar agora
              </a>
            </div>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--tinta-fraca)",
                lineHeight: 1.55,
                marginBottom: 0,
              }}
            >
              O token da Shopee dura 4 horas e se renova sozinho a cada
              sincronização. Se ficar muito tempo sem sincronizar, é só
              reautorizar.
            </p>
          </div>
        ) : (
          <div>
            <p style={{ maxWidth: 620, lineHeight: 1.6 }}>
              Você será levado à Shopee para autorizar o acesso de leitura aos
              seus pedidos, anúncios e repasses. Entre com a conta dona da loja.
            </p>
            <a
              className="botao"
              href="/api/shopee/auth"
              style={{ background: "#ee4d2d", color: "#fff" }}
            >
              Conectar loja da Shopee
            </a>
          </div>
        )}
      </section>

      <section className="secao">
        <div className="secao-titulo">Como a margem é calculada</div>
        <div className="form-linha">
          <div className="campo">
            <label>Alíquota de imposto sobre a venda (%)</label>
            <input
              type="number"
              step="0.01"
              defaultValue={cfg.aliquota_imposto}
              onBlur={(e) =>
                salvar({ config: { aliquota_imposto: e.target.value } })
              }
              className="mini"
            />
          </div>
          <div className="campo">
            <label>Provisão de devolução (%)</label>
            <input
              type="number"
              step="0.01"
              defaultValue={cfg.provisao_devolucao}
              onBlur={(e) =>
                salvar({ config: { provisao_devolucao: e.target.value } })
              }
              className="mini"
            />
          </div>
          <div className="campo" style={{ minWidth: 260 }}>
            <label>Campo sale_fee do pedido</label>
            <select
              defaultValue={cfg.sale_fee_por_unidade}
              onChange={(e) =>
                salvar({ config: { sale_fee_por_unidade: e.target.value } })
              }
            >
              <option value="true">
                é por unidade (multiplicar pela quantidade)
              </option>
              <option value="false">já é o total da linha</option>
            </select>
          </div>
          <div className="campo">
            <label>Histórico a sincronizar (dias)</label>
            <input
              type="number"
              defaultValue={cfg.dias_historico}
              onBlur={(e) =>
                salvar({ config: { dias_historico: e.target.value } })
              }
              className="mini"
            />
          </div>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--tinta-fraca)",
            maxWidth: 680,
            lineHeight: 1.6,
          }}
        >
          Compare o total de tarifa do painel com a fatura do mês no Mercado
          Livre. Se der o dobro ou a metade, é a opção do <code>sale_fee</code>{" "}
          acima que precisa mudar.
        </p>
      </section>

      <section className="secao">
        <div className="secao-titulo">Etiquetas e expedição</div>
        <div className="form-linha">
          <div className="campo" style={{ minWidth: 240 }}>
            <label>Recorte para impressora térmica</label>
            <select
              defaultValue={cfg.etiqueta_recortar}
              onChange={(e) =>
                salvar({ config: { etiqueta_recortar: e.target.value } })
              }
            >
              <option value="true">sim, recortar em 10x15</option>
              <option value="false">não, folha A4 inteira</option>
            </select>
          </div>
          <div className="campo">
            <label>Dias de envios na tela</label>
            <input
              type="number"
              defaultValue={cfg.expedicao_dias}
              onBlur={(e) =>
                salvar({ config: { expedicao_dias: e.target.value } })
              }
              className="mini"
            />
          </div>
        </div>
        <div className="form-linha">
          {[
            ["etiqueta_x0", "Recorte esquerda", 28],
            ["etiqueta_y0", "Recorte base", 142],
            ["etiqueta_x1", "Recorte direita", 289],
            ["etiqueta_y1", "Recorte topo", 570],
          ].map(([chave, rotulo, padrao]) => (
            <div className="campo" key={chave}>
              <label>{rotulo} (pt)</label>
              <input
                type="number"
                defaultValue={cfg[chave] ?? padrao}
                onBlur={(e) => salvar({ config: { [chave]: e.target.value } })}
                className="mini"
              />
            </div>
          ))}
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--tinta-fraca)",
            maxWidth: 680,
            lineHeight: 1.6,
          }}
        >
          O Mercado Livre entrega a etiqueta numa folha A4 com a etiqueta no
          canto superior esquerdo e a lista de separacao na segunda pagina. O
          sistema descarta a segunda pagina e recorta a primeira em 90x149 mm,
          que e o tamanho de uma etiqueta 10x15. Os quatro valores acima sao a
          caixa do recorte em pontos (72 por polegada); so mexa neles se a
          impressao sair cortada.
        </p>
      </section>

      <section className="secao">
        <div className="secao-titulo">Mercado Ads</div>
        <div className="form-linha">
          <div className="campo" style={{ minWidth: 260 }}>
            <label>Descontar publicidade da margem</label>
            <select
              defaultValue={cfg.ads_ativo}
              onChange={(e) =>
                salvar({ config: { ads_ativo: e.target.value } })
              }
            >
              <option value="true">
                sim, ratear o gasto por unidade vendida
              </option>
              <option value="false">não, ignorar o Ads</option>
            </select>
          </div>
          <div className="campo">
            <label>Dias de Ads a sincronizar</label>
            <input
              type="number"
              defaultValue={cfg.ads_dias_sync}
              onBlur={(e) =>
                salvar({ config: { ads_dias_sync: e.target.value } })
              }
              className="mini"
            />
          </div>
          <div className="campo">
            <label>Situação</label>
            <div
              style={{ fontFamily: "var(--mono)", fontSize: 12, paddingTop: 8 }}
            >
              {cfg.ads_status === "ok" ? (
                <span className="lucro">conectado</span>
              ) : (
                <span className="prejuizo">
                  {cfg.ads_status || "ainda não sincronizado"}
                </span>
              )}
            </div>
          </div>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--tinta-fraca)",
            maxWidth: 680,
            lineHeight: 1.6,
          }}
        >
          O Mercado Livre cobra publicidade por clique, não por pedido, então
          não existe custo de Ads exato de um pedido. O sistema pega o gasto de
          cada anúncio no período e divide pelas unidades que aquele anúncio
          vendeu. O que sobra — anúncio que consumiu verba e não vendeu — entra
          no resultado como linha separada. Cada dia sincronizado é uma consulta
          à API, então períodos longos demoram mais; 30 dias costuma bastar.
        </p>
      </section>

      <section className="secao">
        <div className="secao-titulo">
          <span>Custos fixos mensais</span>
          <span style={{ textTransform: "none", letterSpacing: 0 }}>
            total {brl(totalFixo)}/mês
          </span>
        </div>
        <div className="rolagem">
          <table style={{ maxWidth: 560 }}>
            <tbody>
              {(d.custos_fixos || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.descricao}</td>
                  <td className="num">{brl(c.valor_mensal)}</td>
                  <td className="num" style={{ width: 60 }}>
                    <button
                      onClick={() => salvar({ remover_custo_fixo: c.id })}
                      style={{ padding: "3px 8px", fontSize: 10 }}
                    >
                      remover
                    </button>
                  </td>
                </tr>
              ))}
              {!d.custos_fixos?.length && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--tinta-fraca)" }}>
                    Sem custos fixos. Aluguel, salários, pró-labore, sistemas e
                    contador entram aqui.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="form-linha" style={{ marginTop: 14 }}>
          <div className="campo" style={{ minWidth: 240 }}>
            <label>Descrição</label>
            <input
              value={novo.descricao}
              onChange={(e) => setNovo({ ...novo, descricao: e.target.value })}
              placeholder="ex.: pró-labore"
            />
          </div>
          <div className="campo">
            <label>Valor mensal</label>
            <input
              className="mini"
              type="number"
              step="0.01"
              value={novo.valor_mensal}
              onChange={(e) =>
                setNovo({ ...novo, valor_mensal: e.target.value })
              }
            />
          </div>
          <button
            disabled={!novo.descricao || salvando}
            onClick={async () => {
              await salvar({ custo_fixo_novo: novo });
              setNovo({ descricao: "", valor_mensal: "" });
            }}
          >
            Adicionar
          </button>
        </div>
      </section>

      <section className="secao">
        <div className="secao-titulo">Últimas sincronizações</div>
        <table style={{ maxWidth: 620 }}>
          <thead>
            <tr>
              <th>Quando</th>
              <th className="num">Pedidos</th>
              <th className="num">Anúncios</th>
              <th>Erro</th>
            </tr>
          </thead>
          <tbody>
            {(d.log || []).map((l) => (
              <tr key={l.id}>
                <td className="num" style={{ textAlign: "left" }}>
                  {new Date(l.executado_em).toLocaleString("pt-BR")}
                </td>
                <td className="num">{l.pedidos}</td>
                <td className="num">{l.anuncios}</td>
                <td style={{ color: "var(--prejuizo)", fontSize: 12 }}>
                  {l.erro || ""}
                </td>
              </tr>
            ))}
            {!d.log?.length && (
              <tr>
                <td colSpan={4} style={{ color: "var(--tinta-fraca)" }}>
                  Nada sincronizado ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="rodape">
        Endereço do webhook a cadastrar no DevCenter:{" "}
        <code>
          {amb.redirect_uri
            ? amb.redirect_uri.replace("/api/ml/callback", "/api/ml/webhook")
            : "https://seu-app.vercel.app/api/ml/webhook"}
        </code>
        <br />
        Painel{" "}
        {amb.senha_painel
          ? "protegido por senha."
          : "SEM senha — defina APP_PASSWORD na Vercel."}
      </p>
    </>
  );
}
