"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MIDIAS,
  PADROES,
  medirGrade,
  modoAutomatico,
  margemParaTamanhoReal,
} from "@/lib/etiquetas-medidas";
import {
  IconeEtiqueta,
  IconeTesoura,
  IconeUpload,
  IconeBaixar,
  IconeAlerta,
  IconeCheck,
} from "@/components/Icones";

/** Marca de onde veio a etiqueta, para bater o olho e reconhecer. */
const SELO = { shopee: "SHOPEE", mercadolivre: "MERCADO LIVRE", desconhecido: "?" };

const num = (v, casas = 1) =>
  Number(v)
    .toFixed(casas)
    .replace(/\.0+$/, "")
    .replace(".", ",");

export default function Etiquetas() {
  const [arquivos, setArquivos] = useState([]);
  const [analise, setAnalise] = useState(null);
  const [cfg, setCfg] = useState(PADROES);
  const [estado, setEstado] = useState("vazio");
  const [erro, setErro] = useState(null);
  const [saida, setSaida] = useState(null);
  const [papelada, setPapelada] = useState(null);
  const [arrastando, setArrastando] = useState(false);
  const campoRef = useRef(null);

  // O blob do PDF vive enquanto a prévia está na tela; some junto com ela.
  useEffect(() => () => saida && URL.revokeObjectURL(saida.url), [saida]);
  useEffect(() => () => papelada && URL.revokeObjectURL(papelada.url), [papelada]);

  function limparSaida() {
    setSaida((s) => {
      if (s) URL.revokeObjectURL(s.url);
      return null;
    });
    setPapelada((s) => {
      if (s) URL.revokeObjectURL(s.url);
      return null;
    });
  }

  /** Baixa à parte as páginas A4 que não são etiqueta. */
  async function baixarDocumentos() {
    if (papelada) return;
    const corpo = new FormData();
    corpo.append("acao", "documentos");
    for (const a of arquivos) corpo.append("arquivos", a);
    try {
      const r = await fetch("/api/etiquetas", { method: "POST", body: corpo });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.erro || "Não consegui separar os documentos.");
      }
      const blob = await r.blob();
      setPapelada({ url: URL.createObjectURL(blob) });
    } catch (e) {
      setErro(e.message);
    }
  }

  function ajustar(campo, valor) {
    setCfg((c) => ({ ...c, [campo]: valor }));
    limparSaida();
  }

  async function receber(lista) {
    const pdfs = [...lista].filter(
      (a) => a.type === "application/pdf" || /\.pdf$/i.test(a.name),
    );
    if (!pdfs.length) {
      setErro("Só dá para converter arquivo PDF.");
      return;
    }

    setArquivos(pdfs);
    setAnalise(null);
    setErro(null);
    limparSaida();
    setEstado("analisando");

    const corpo = new FormData();
    corpo.append("acao", "analisar");
    for (const a of pdfs) corpo.append("arquivos", a);

    try {
      const r = await fetch("/api/etiquetas", { method: "POST", body: corpo });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro || "Não consegui ler os arquivos.");
      setAnalise(d.arquivos);
      setEstado("pronto");
    } catch (e) {
      setErro(e.message);
      setEstado("erro");
    }
  }

  async function gerar() {
    setEstado("gerando");
    setErro(null);
    limparSaida();

    const corpo = new FormData();
    corpo.append("acao", "converter");
    corpo.append("opcoes", JSON.stringify(cfg));
    for (const a of arquivos) corpo.append("arquivos", a);

    try {
      const r = await fetch("/api/etiquetas", { method: "POST", body: corpo });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.erro || "Não consegui converter.");
      }
      const cabecalho = r.headers.get("X-Resumo");
      const resumo = cabecalho ? JSON.parse(decodeURIComponent(cabecalho)) : [];
      const nome =
        (r.headers.get("Content-Disposition") || "").match(/filename="(.+?)"/)?.[1] ||
        "etiquetas-termica.pdf";
      const blob = await r.blob();
      setSaida({ url: URL.createObjectURL(blob), resumo, nome, bytes: blob.size });
      setEstado("feito");
      requestAnimationFrame(() =>
        document.querySelector(".etq-saida")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    } catch (e) {
      setErro(e.message);
      setEstado("erro");
    }
  }

  function recomecar() {
    setArquivos([]);
    setAnalise(null);
    setErro(null);
    limparSaida();
    setEstado("vazio");
    if (campoRef.current) campoRef.current.value = "";
  }

  // Cada tamanho de etiqueta é um grupo com a sua própria distribuição, e
  // começa numa folha nova. Junta os grupos iguais dos vários arquivos.
  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const a of analise || []) {
      for (const g of a.grupos || []) {
        const chave = `${Math.round(g.tamanho.l / 2)}x${Math.round(g.tamanho.a / 2)}`;
        const atual = mapa.get(chave) || { ...g, etiquetas: 0 };
        atual.etiquetas += g.etiquetas;
        mapa.set(chave, atual);
      }
    }

    return [...mapa.values()].map((g) => {
      const modo = cfg.modo === "auto" ? modoAutomatico(g.tamanho, cfg.midia) : cfg.modo;
      const cabem = modo === "unica" ? 1 : cfg.colunas * cfg.linhas;
      return {
        ...g,
        modo,
        cabem,
        folhas: Math.ceil(g.etiquetas / cabem),
        medida: medirGrade(
          g.tamanho,
          modo === "unica" ? { ...cfg, colunas: 1, linhas: 1 } : cfg,
        ),
      };
    });
  }, [analise, cfg]);

  // O grupo com mais etiquetas é o que vale a pena desenhar na prévia.
  const principal = grupos.reduce((a, b) => (!a || b.etiquetas > a.etiquetas ? b : a), null);
  const grade = principal?.medida || null;
  const modoReal = principal?.modo || (cfg.modo === "auto" ? "unica" : cfg.modo);
  const temGrade = grupos.some((g) => g.modo === "grade");

  const totalEtiquetas = grupos.reduce((s, g) => s + g.etiquetas, 0);
  const totalDocumentos = analise?.reduce((s, a) => s + (a.documentos?.length || 0), 0) || 0;
  const folhas = grupos.reduce((s, g) => s + g.folhas, 0);

  const sobra =
    principal?.modo === "grade" && grade && grade.linhasQueCabem > cfg.linhas
      ? grade.linhasQueCabem
      : null;

  // A etiqueta de envio tem quase a altura da mídia: 2 mm de margem já a
  // encolhem. Quando dá para sair em tamanho real, oferece o atalho.
  const margemCheia = margemParaTamanhoReal(principal?.tamanho, cfg.midia);
  const podeTamanhoReal =
    principal?.modo === "unica" &&
    grade &&
    grade.escala < 0.999 &&
    margemCheia !== null &&
    margemCheia < cfg.margem;

  return (
    <>
      <div className="secao-titulo">
        <span>Edição de etiquetas</span>
        {arquivos.length > 0 && (
          <button onClick={recomecar}>Trocar arquivo</button>
        )}
      </div>

      <p className="etq-intro">
        Mercado Livre e Shopee mandam as etiquetas diagramadas para folha A4 —
        várias lado a lado, ou uma sozinha no canto. Aqui elas são reconhecidas,
        recortadas uma a uma e remontadas no tamanho da sua etiqueta térmica,
        sempre retas e uma embaixo da outra. Declaração de conteúdo e outros
        papéis A4 ficam de fora, para você baixar à parte.
      </p>

      {/* ---------- Entrada ---------- */}

      <div
        className={`etq-solta${arrastando ? " sobre" : ""}${arquivos.length ? " cheia" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault();
          setArrastando(false);
          receber(e.dataTransfer.files);
        }}
        onClick={() => campoRef.current?.click()}
      >
        <input
          ref={campoRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => e.target.files?.length && receber(e.target.files)}
        />
        <IconeUpload width={26} height={26} />
        {arquivos.length ? (
          <div>
            <strong>
              {arquivos.length === 1
                ? arquivos[0].name
                : `${arquivos.length} arquivos`}
            </strong>
            <span>Clique para trocar, ou arraste outro PDF aqui.</span>
          </div>
        ) : (
          <div>
            <strong>Arraste o PDF da etiqueta aqui</strong>
            <span>Ou clique para escolher. Pode mandar mais de um.</span>
          </div>
        )}
      </div>

      {estado === "analisando" && <p className="etq-espera">Lendo o arquivo…</p>}

      {erro && (
        <div className="alerta">
          <IconeAlerta width={16} height={16} /> {erro}
        </div>
      )}

      {/* ---------- O que foi reconhecido ---------- */}

      {analise && (
        <div className="etq-achados">
          {analise.map((a) => (
            <div key={a.nome} className={`etq-achado${a.detectado ? "" : " ruim"}`}>
              <div className="etq-achado-nome">{a.nome}</div>

              {a.formatos?.map((f) => (
                <div key={f.rotulo} className="etq-formato">
                  <span className={`etq-selo ${f.origem}`}>{SELO[f.origem] || "?"}</span>
                  <b>{f.rotulo}</b>
                  <span className="etq-formato-nota">
                    {f.paginas} página{f.paginas === 1 ? "" : "s"}
                    {f.nota ? ` · ${f.nota}` : ""}
                  </span>
                </div>
              ))}

              {a.detectado ? (
                <div className="etq-achado-dado">
                  {a.grupos?.map((g, i) => (
                    <div key={i}>
                      <b>{g.etiquetas}</b> etiqueta{g.etiquetas === 1 ? "" : "s"} de{" "}
                      {num(g.tamanho.l)} × {num(g.tamanho.a)} mm
                    </div>
                  ))}
                  {a.semContorno && (
                    <div>
                      Alguma página não tinha contorno reconhecível; usei a folha
                      inteira nesses casos.
                    </div>
                  )}
                </div>
              ) : (
                <div className="etq-achado-dado">
                  {a.erro || "Não achei nenhuma etiqueta nesse arquivo."}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------- Ajustes e prévia ---------- */}

      {analise && (
        <div className="etq-painel">
          <div className="etq-ajustes">
            <div className="campo">
              <label>Etiqueta da impressora</label>
              <select
                value={cfg.midia}
                onChange={(e) => ajustar("midia", e.target.value)}
              >
                {Object.entries(MIDIAS).map(([chave, m]) => (
                  <option key={chave} value={chave}>
                    {m.rotulo}
                  </option>
                ))}
              </select>
            </div>

            <div className="campo">
              <label>Como distribuir</label>
              <select value={cfg.modo} onChange={(e) => ajustar("modo", e.target.value)}>
                <option value="auto">
                  Decidir sozinho (grande sozinha, pequena em grade)
                </option>
                <option value="unica">Uma etiqueta por folha</option>
                <option value="grade">Várias por folha</option>
              </select>
            </div>

            {temGrade && (
              <>
                <div className="campo estreito">
                  <label>Colunas</label>
                  <input
                    type="number"
                    min="1"
                    max="6"
                    value={cfg.colunas}
                    onChange={(e) => ajustar("colunas", Number(e.target.value))}
                  />
                </div>
                <div className="campo estreito">
                  <label>Linhas</label>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    value={cfg.linhas}
                    onChange={(e) => ajustar("linhas", Number(e.target.value))}
                  />
                </div>
              </>
            )}

            <div className="campo estreito">
              <label>Margem (mm)</label>
              <input
                type="number"
                min="0"
                max="15"
                step="0.5"
                value={cfg.margem}
                onChange={(e) => ajustar("margem", Number(e.target.value))}
              />
            </div>

            {temGrade && (
              <div className="campo estreito">
                <label>Espaço (mm)</label>
                <input
                  type="number"
                  min="0"
                  max="15"
                  step="0.5"
                  value={cfg.espaco}
                  onChange={(e) => ajustar("espaco", Number(e.target.value))}
                />
              </div>
            )}

            <div className="campo">
              <label>Girar</label>
              <select value={cfg.girar} onChange={(e) => ajustar("girar", e.target.value)}>
                <option value="auto">Só se sair maior</option>
                <option value="nao">Nunca girar</option>
                <option value="90">Sempre deitar 90°</option>
              </select>
            </div>
          </div>

          {grade && (
            <div className="etq-previa">
              <div className="etq-folha-caixa">
                <Folha cfg={cfg} grade={grade} modo={modoReal} />
                {grupos.length > 1 && (
                  <span className="etq-folha-nota">{principal.rotulo}</span>
                )}
              </div>
              <div className="etq-previa-texto">
                {grupos.map((g, i) => (
                  <div key={i} className="etq-grupo">
                    {grupos.length > 1 && (
                      <div className="etq-grupo-nome">
                        {g.rotulo} · {g.etiquetas} de {num(g.tamanho.l)} ×{" "}
                        {num(g.tamanho.a)} mm
                      </div>
                    )}
                    <div className="etq-linha">
                      <span>
                        {grupos.length > 1 ? "Sai com" : "Cada etiqueta sai com"}
                      </span>
                      <b>
                        {num(g.medida.final.l)} × {num(g.medida.final.a)} mm
                      </b>
                    </div>
                    <div className="etq-linha">
                      <span>Tamanho do original</span>
                      <b>{Math.round(g.medida.escala * 100)}%</b>
                    </div>
                    <div className="etq-linha">
                      <span>Por folha</span>
                      <b>
                        {g.cabem} · {g.folhas} folha{g.folhas === 1 ? "" : "s"}
                      </b>
                    </div>
                  </div>
                ))}

                <div className="etq-linha total">
                  <span>{totalEtiquetas} etiquetas</span>
                  <b>{folhas} folha{folhas === 1 ? "" : "s"}</b>
                </div>

                {sobra && (
                  <button
                    className="etq-dica"
                    onClick={() => ajustar("linhas", sobra)}
                    title="Aproveita a folha sem diminuir a etiqueta"
                  >
                    <IconeTesoura width={15} height={15} />
                    Cabem {sobra} linhas nesse mesmo tamanho — usar {cfg.colunas *
                      sobra}{" "}
                    por folha
                  </button>
                )}
                {podeTamanhoReal && (
                  <button
                    className="etq-dica"
                    onClick={() => ajustar("margem", margemCheia)}
                    title="Imprime a etiqueta no tamanho exato do original"
                  >
                    <IconeTesoura width={15} height={15} />
                    Com margem de {num(margemCheia)} mm ela sai em tamanho real
                    (100%)
                  </button>
                )}
                {grade.escala < 0.75 && (
                  <p className="etq-aviso">
                    A etiqueta está saindo com {Math.round(grade.escala * 100)}% do
                    tamanho original. Se o código de barras não bipar, diminua as
                    colunas.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="etq-acoes">
            <button
              className="principal"
              onClick={gerar}
              disabled={estado === "gerando" || !totalEtiquetas}
            >
              <IconeEtiqueta width={16} height={16} />
              {estado === "gerando" ? "Convertendo…" : "Converter para impressão"}
            </button>
          </div>
        </div>
      )}

      {/* ---------- Resultado ---------- */}

      {saida && (
        <div className="etq-saida">
          <div className="etq-saida-topo">
            <span>
              <IconeCheck width={16} height={16} /> Pronto para imprimir —{" "}
              {saida.resumo.reduce((s, r) => s + r.folhas, 0)} etiqueta
              {saida.resumo.reduce((s, r) => s + r.folhas, 0) === 1 ? "" : "s"} de{" "}
              {MIDIAS[cfg.midia].rotulo.split(" —")[0]}
            </span>
            <a className="etq-baixar" href={saida.url} download={saida.nome}>
              <IconeBaixar width={16} height={16} /> Baixar PDF
            </a>
          </div>

          {totalDocumentos > 0 && (
            <div className="etq-papelada">
              <span>
                {totalDocumentos} página{totalDocumentos === 1 ? "" : "s"} de
                declaração de conteúdo {totalDocumentos === 1 ? "ficou" : "ficaram"}{" "}
                de fora — {totalDocumentos === 1 ? "ela é" : "elas são"} A4 e{" "}
                {totalDocumentos === 1 ? "vai" : "vão"} dentro da caixa, não na
                etiqueta.
              </span>
              {papelada ? (
                <a className="etq-baixar claro" href={papelada.url} download="documentos-a4.pdf">
                  <IconeBaixar width={16} height={16} /> Baixar em A4
                </a>
              ) : (
                <button className="etq-baixar claro" onClick={baixarDocumentos}>
                  <IconeBaixar width={16} height={16} /> Separar em A4
                </button>
              )}
            </div>
          )}
          <iframe
            className="etq-visor"
            src={`${saida.url}#view=Fit`}
            title="Prévia do PDF"
          />
          <p className="etq-nota">
            Na hora de imprimir, escolha <b>tamanho real</b> (ou 100%) e nunca
            &ldquo;ajustar à página&rdquo; — senão o código de barras encolhe e a
            leitora não pega.
          </p>
        </div>
      )}
    </>
  );
}

/** Desenho da folha em escala, só para conferir a distribuição antes de gerar. */
function Folha({ cfg, grade, modo }) {
  const midia = MIDIAS[cfg.midia];
  const colunas = modo === "unica" ? 1 : cfg.colunas;
  const linhas = modo === "unica" ? 1 : cfg.linhas;
  const alturaAlvo = 190;
  const escala = alturaAlvo / midia.a;

  const celulas = [];
  for (let l = 0; l < linhas; l++) {
    for (let c = 0; c < colunas; c++) {
      const cx = cfg.margem + c * (grade.celula.l + cfg.espaco);
      const cy = cfg.margem + l * (grade.celula.a + cfg.espaco);
      celulas.push({
        x: (cx + (grade.celula.l - grade.final.l) / 2) * escala,
        y: (cy + (grade.celula.a - grade.final.a) / 2) * escala,
        l: grade.final.l * escala,
        a: grade.final.a * escala,
        n: l * colunas + c + 1,
      });
    }
  }

  return (
    <svg
      className="etq-folha"
      width={midia.l * escala}
      height={alturaAlvo}
      viewBox={`0 0 ${midia.l * escala} ${alturaAlvo}`}
      aria-label={`Folha de ${midia.l} por ${midia.a} milímetros com ${celulas.length} etiquetas`}
    >
      <rect
        x="0.5"
        y="0.5"
        width={midia.l * escala - 1}
        height={alturaAlvo - 1}
        rx="3"
        className="etq-folha-borda"
      />
      {celulas.map((c) => (
        <g key={c.n}>
          <rect x={c.x} y={c.y} width={c.l} height={c.a} className="etq-folha-etq" />
          <text x={c.x + c.l / 2} y={c.y + c.a / 2 + 4} className="etq-folha-num">
            {c.n}
          </text>
        </g>
      ))}
    </svg>
  );
}
