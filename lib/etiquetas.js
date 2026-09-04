/**
 * Conversor de etiquetas para impressora térmica.
 *
 * O Mercado Livre (e o Full) manda as etiquetas diagramadas para folha A4:
 * as de envio vêm três lado a lado na horizontal, as de produto vêm dez por
 * folha em duas colunas. A impressora térmica não imprime A4 — ela imprime
 * uma etiqueta de cada vez, em rolo. Este módulo acha cada etiqueta dentro do
 * PDF original, recorta e remonta tudo no tamanho da mídia da impressora.
 *
 * Todo cálculo interno é em pontos PDF (72 por polegada). Só a interface fala
 * em milímetros.
 */

import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";

import {
  mm,
  ptParaMm,
  MIDIAS,
  PADROES,
  modoAutomatico,
} from "./etiquetas-medidas";

export { MM, mm, ptParaMm, MIDIAS, PADROES } from "./etiquetas-medidas";

/* =========================================================
   1. Leitura do content stream
   ========================================================= */

const ESPACO = new Set([" ", "\t", "\r", "\n", "\f", "\0"]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const ehEspaco = (c) => ESPACO.has(c);
const ehDelim = (c) => DELIM.has(c);

/** Junta os streams de conteúdo de uma página ou form num texto só. */
function textoDoConteudo(contexto, no) {
  const bruto = no instanceof PDFDict ? no.get(PDFName.of("Contents")) : no;
  const alvo = contexto.lookup(bruto) || bruto;
  const partes = [];

  const juntar = (obj) => {
    const st = contexto.lookup(obj) || obj;
    if (st instanceof PDFRawStream) {
      try {
        partes.push(decodePDFRawStream(st).decode());
      } catch {
        /* filtro que não sabemos abrir: ignora esse pedaço */
      }
    } else if (st instanceof PDFStream && st.getContents) {
      partes.push(st.getContents());
    }
  };

  if (alvo instanceof PDFArray) {
    for (let i = 0; i < alvo.size(); i++) juntar(alvo.get(i));
  } else {
    juntar(alvo);
  }

  return partes
    .map((b) => Buffer.from(b).toString("latin1"))
    .join("\n");
}

/* =========================================================
   2. Matrizes
   ========================================================= */

const IDENTIDADE = [1, 0, 0, 1, 0, 0];

/** Resultado de aplicar `m` e depois `n`. */
function compor(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const levar = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Caixa que envolve os quatro cantos do retângulo já transformados. */
function caixaTransformada(m, x, y, l, a) {
  const cantos = [
    levar(m, x, y),
    levar(m, x + l, y),
    levar(m, x, y + a),
    levar(m, x + l, y + a),
  ];
  const xs = cantos.map((c) => c[0]);
  const ys = cantos.map((c) => c[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/* =========================================================
   3. Varredura do content stream
   ========================================================= */

/**
 * Percorre o content stream juntando os retângulos (`re`) e os forms
 * colocados na página, cada um já convertido para a coordenada da página.
 * Entra dentro dos forms porque a etiqueta de envio do Full é assim: a página
 * só posiciona três XObjects e o desenho de verdade está lá dentro.
 */
function varrer(texto, contexto, recursos, ctm, achados, profundidade) {
  if (profundidade > 6) return;

  const pilha = [];
  let atual = ctm;
  let operandos = [];
  let i = 0;
  const n = texto.length;

  const numeros = (qtd) => {
    const fim = operandos.slice(-qtd).map(Number);
    return fim.length === qtd && fim.every(Number.isFinite) ? fim : null;
  };

  while (i < n) {
    const c = texto[i];

    if (ehEspaco(c)) {
      i++;
      continue;
    }

    if (c === "%") {
      while (i < n && texto[i] !== "\n" && texto[i] !== "\r") i++;
      continue;
    }

    // Strings literais: pulam inteiras para o conteúdo não virar operador.
    if (c === "(") {
      let nivel = 1;
      i++;
      while (i < n && nivel > 0) {
        if (texto[i] === "\\") i += 2;
        else {
          if (texto[i] === "(") nivel++;
          else if (texto[i] === ")") nivel--;
          i++;
        }
      }
      operandos.push(null);
      continue;
    }

    if (c === "<") {
      if (texto[i + 1] === "<") {
        i += 2;
        operandos.push(null);
        continue;
      }
      while (i < n && texto[i] !== ">") i++;
      i++;
      operandos.push(null);
      continue;
    }

    if (c === ">" || c === "[" || c === "]" || c === "{" || c === "}") {
      i += c === ">" && texto[i + 1] === ">" ? 2 : 1;
      continue;
    }

    if (c === "/") {
      let j = i + 1;
      while (j < n && !ehEspaco(texto[j]) && !ehDelim(texto[j])) j++;
      operandos.push({ nome: texto.slice(i + 1, j) });
      i = j;
      continue;
    }

    if ((c >= "0" && c <= "9") || c === "+" || c === "-" || c === ".") {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(texto[j])) j++;
      operandos.push(texto.slice(i, j));
      i = j;
      continue;
    }

    // Operador.
    let j = i;
    while (j < n && !ehEspaco(texto[j]) && !ehDelim(texto[j])) j++;
    const op = texto.slice(i, j);
    i = j;

    if (op === "q") {
      pilha.push(atual);
    } else if (op === "Q") {
      atual = pilha.pop() || IDENTIDADE;
    } else if (op === "cm") {
      const v = numeros(6);
      if (v) atual = compor(v, atual);
    } else if (op === "re") {
      const v = numeros(4);
      if (v) achados.retangulos.push(caixaTransformada(atual, v[0], v[1], v[2], v[3]));
    } else if (op === "Do") {
      const ref = operandos[operandos.length - 1];
      if (ref?.nome) {
        desenharXObject(ref.nome, contexto, recursos, atual, achados, profundidade);
      }
    } else if (op === "BI") {
      // Imagem embutida: o binário entre ID e EI não é código, pula tudo.
      const id = texto.indexOf("ID", i);
      const ei = id < 0 ? -1 : texto.indexOf("EI", id + 2);
      i = ei < 0 ? n : ei + 2;
    }

    operandos = [];
  }
}

function desenharXObject(nome, contexto, recursos, ctm, achados, profundidade) {
  const dicXObj = contexto.lookup(recursos?.get(PDFName.of("XObject")));
  if (!(dicXObj instanceof PDFDict)) return;

  const forma = contexto.lookup(dicXObj.get(PDFName.of(nome)));
  if (!(forma instanceof PDFStream)) return;

  const dic = forma.dict;
  const subtipo = contexto.lookup(dic.get(PDFName.of("Subtype")));
  if (subtipo?.asString?.() !== "/Form") return;

  const matriz = contexto.lookup(dic.get(PDFName.of("Matrix")));
  let interno = ctm;
  if (matriz instanceof PDFArray && matriz.size() === 6) {
    const v = [];
    for (let k = 0; k < 6; k++) v.push(Number(contexto.lookup(matriz.get(k))?.asNumber?.() ?? 0));
    if (v.every(Number.isFinite)) interno = compor(v, ctm);
  }

  // A BBox do form já é, em muitos PDFs, exatamente o contorno da etiqueta.
  const bbox = contexto.lookup(dic.get(PDFName.of("BBox")));
  if (bbox instanceof PDFArray && bbox.size() === 4) {
    const v = [];
    for (let k = 0; k < 4; k++) v.push(Number(contexto.lookup(bbox.get(k))?.asNumber?.() ?? NaN));
    if (v.every(Number.isFinite)) {
      const x = Math.min(v[0], v[2]);
      const y = Math.min(v[1], v[3]);
      achados.retangulos.push(
        caixaTransformada(interno, x, y, Math.abs(v[2] - v[0]), Math.abs(v[3] - v[1])),
      );
    }
  }

  const recursosForm = contexto.lookup(dic.get(PDFName.of("Resources")));
  varrer(
    textoDoConteudo(contexto, forma),
    contexto,
    recursosForm instanceof PDFDict ? recursosForm : recursos,
    interno,
    achados,
    profundidade + 1,
  );
}

/* =========================================================
   4. Detecção das etiquetas
   ========================================================= */

const MIN_LADO = mm(15); // nada menor que 15 mm é etiqueta
const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);

/** Quanto de `a` está dentro de `b`, de 0 a 1. */
function sobreposicao(a, b) {
  const l = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const propria = area(a);
  return propria > 0 ? (l * h) / propria : 0;
}

/**
 * Acha as etiquetas de uma página.
 *
 * A ideia: toda etiqueta desenha o próprio contorno. Sobram muitos retângulos
 * (moldura dupla, recortes internos, fundos), então joga fora tudo que está
 * dentro de outro e fica com o grupo de retângulos do mesmo tamanho que ocupa
 * mais papel — esse grupo é a grade de etiquetas.
 */
export function acharEtiquetas(pagina) {
  const contexto = pagina.node.context;
  const achados = { retangulos: [] };

  try {
    const recursos = contexto.lookup(pagina.node.Resources());
    varrer(
      textoDoConteudo(contexto, pagina.node.Contents()),
      contexto,
      recursos instanceof PDFDict ? recursos : undefined,
      IDENTIDADE,
      achados,
      0,
    );
  } catch {
    return [];
  }

  const { width: lp, height: ap } = pagina.getSize();
  const areaPagina = lp * ap;

  const candidatos = achados.retangulos
    .filter((r) => {
      const l = r.x1 - r.x0;
      const a = r.y1 - r.y0;
      return (
        l >= MIN_LADO &&
        a >= MIN_LADO &&
        area(r) <= areaPagina * 0.94 &&
        r.x1 > -1 &&
        r.y1 > -1 &&
        r.x0 < lp + 1 &&
        r.y0 < ap + 1
      );
    })
    .sort((x, y) => area(y) - area(x));

  // Fica só com os retângulos "de fora": moldura interna e recorte somem.
  const externos = [];
  for (const r of candidatos) {
    if (!externos.some((e) => sobreposicao(r, e) > 0.5)) externos.push(r);
  }

  // Agrupa por tamanho, com 2 pt de folga para a moldura dupla não virar grupo.
  const grupos = new Map();
  for (const r of externos) {
    const chave = `${Math.round((r.x1 - r.x0) / 2)}x${Math.round((r.y1 - r.y0) / 2)}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(r);
  }

  let melhor = [];
  let melhorPeso = 0;
  for (const g of grupos.values()) {
    const peso = g.length * area(g[0]);
    if (peso > melhorPeso) {
      melhorPeso = peso;
      melhor = g;
    }
  }

  return ordemDeLeitura(melhor);
}

/** Da esquerda para a direita, de cima para baixo — como se lê a folha. */
function ordemDeLeitura(rects) {
  if (rects.length < 2) return rects;
  const alturaMedia = rects.reduce((s, r) => s + (r.y1 - r.y0), 0) / rects.length;
  const folga = Math.max(alturaMedia * 0.35, 4);

  const linhas = [];
  for (const r of [...rects].sort((a, b) => b.y1 - a.y1)) {
    const linha = linhas.find((l) => Math.abs(l.topo - r.y1) <= folga);
    if (linha) linha.itens.push(r);
    else linhas.push({ topo: r.y1, itens: [r] });
  }

  return linhas.flatMap((l) => l.itens.sort((a, b) => a.x0 - b.x0));
}

/* =========================================================
   5. Montagem do PDF de saída
   ========================================================= */

/** Normaliza o /Rotate da página para 0, 90, 180 ou 270. */
function giroDaPagina(pagina) {
  const g = Math.round((pagina.getRotation()?.angle || 0) / 90) * 90;
  return ((g % 360) + 360) % 360;
}

/**
 * Desenha uma etiqueta encaixada numa caixa, girando se preciso.
 * `giro` é 0, 90, 180 ou 270 no sentido anti-horário.
 */
function encaixar(folha, embutida, caixa, giro) {
  const el = embutida.width;
  const ea = embutida.height;
  const deitada = giro === 90 || giro === 270;
  const fl = deitada ? ea : el;
  const fa = deitada ? el : ea;

  const escala = Math.min(caixa.l / fl, caixa.a / fa);
  const l = el * escala;
  const a = ea * escala;

  const ox = caixa.x + (caixa.l - fl * escala) / 2;
  const oy = caixa.y + (caixa.a - fa * escala) / 2;

  // Cada giro leva a origem do desenho para um canto diferente da caixa.
  const origem =
    giro === 90
      ? { x: ox + a, y: oy }
      : giro === 180
        ? { x: ox + l, y: oy + a }
        : giro === 270
          ? { x: ox, y: oy + l }
          : { x: ox, y: oy };

  folha.drawPage(embutida, {
    ...origem,
    width: l,
    height: a,
    rotate: degrees(giro),
  });
}

/** Escolhe o giro que faz a etiqueta sair maior dentro da caixa. */
function melhorGiro(el, ea, caixaL, caixaA, preferencia) {
  if (preferencia === "nao") return 0;
  if (preferencia === "90") return 90;
  const reto = Math.min(caixaL / el, caixaA / ea);
  const virado = Math.min(caixaL / ea, caixaA / el);
  return virado > reto * 1.05 ? 90 : 0;
}

/**
 * Converte um ou mais PDFs de etiqueta num PDF pronto para a térmica.
 * Devolve os bytes e um resumo do que foi feito com cada arquivo.
 */
export async function converter(arquivos, opcoes = {}) {
  const cfg = { ...PADROES, ...opcoes };
  const midia = MIDIAS[cfg.midia] || MIDIAS["10x15"];
  const folhaL = mm(midia.l);
  const folhaA = mm(midia.a);
  const margem = mm(Math.max(0, Number(cfg.margem) || 0));
  const espaco = mm(Math.max(0, Number(cfg.espaco) || 0));

  const saida = await PDFDocument.create();
  saida.setTitle("Etiquetas para impressora térmica");
  saida.setProducer("Livro-caixa — operação Mercado Livre");

  const resumo = [];

  for (const arquivo of arquivos) {
    const item = {
      nome: arquivo.nome,
      paginas: 0,
      etiquetas: 0,
      tamanho: null,
      modo: null,
      colunas: 1,
      linhas: 1,
      folhas: 0,
      aviso: null,
    };

    let origem;
    try {
      origem = await PDFDocument.load(arquivo.bytes, { ignoreEncryption: true });
    } catch {
      item.aviso = "Não consegui abrir esse PDF. Ele pode estar corrompido ou protegido.";
      resumo.push(item);
      continue;
    }

    item.paginas = origem.getPageCount();

    // Acha as etiquetas de todas as páginas antes de montar a saída.
    const recortes = [];
    for (const pagina of origem.getPages()) {
      const giro = giroDaPagina(pagina);
      const achadas = acharEtiquetas(pagina);
      const { width: lp, height: ap } = pagina.getSize();

      const caixas = achadas.length
        ? achadas
        : [{ x0: 0, y0: 0, x1: lp, y1: ap }]; // sem contorno: usa a página toda

      if (!achadas.length) {
        item.aviso =
          "Não achei o contorno das etiquetas em alguma página; usei a folha inteira nesses casos.";
      }

      for (const c of caixas) recortes.push({ pagina, caixa: c, giro });
    }

    if (!recortes.length) {
      item.aviso = item.aviso || "Nenhuma etiqueta encontrada.";
      resumo.push(item);
      continue;
    }

    item.etiquetas = recortes.length;

    // Tamanho da etiqueta como ela aparece impressa, já contando o /Rotate.
    const amostra = recortes[0];
    const brutoL = amostra.caixa.x1 - amostra.caixa.x0;
    const brutoA = amostra.caixa.y1 - amostra.caixa.y0;
    const vistaL = amostra.giro % 180 ? brutoA : brutoL;
    const vistaA = amostra.giro % 180 ? brutoL : brutoA;
    item.tamanho = {
      l: Math.round(ptParaMm(vistaL) * 10) / 10,
      a: Math.round(ptParaMm(vistaA) * 10) / 10,
    };

    // No automático, etiqueta grande vai uma por folha; pequena vai em grade.
    const modo =
      cfg.modo === "auto" ? modoAutomatico(item.tamanho, cfg.midia) : cfg.modo;
    item.modo = modo;

    const colunas = modo === "unica" ? 1 : Math.max(1, Math.round(Number(cfg.colunas)) || 1);
    const linhas = modo === "unica" ? 1 : Math.max(1, Math.round(Number(cfg.linhas)) || 1);
    item.colunas = colunas;
    item.linhas = linhas;

    const celulaL = (folhaL - 2 * margem - (colunas - 1) * espaco) / colunas;
    const celulaA = (folhaA - 2 * margem - (linhas - 1) * espaco) / linhas;

    if (celulaL <= 0 || celulaA <= 0) {
      item.aviso = "Margem e espaçamento não cabem na mídia escolhida.";
      resumo.push(item);
      continue;
    }

    const porFolha = colunas * linhas;
    let folha = null;

    // Um lote só: assim o pdf-lib copia a imagem do código de barras e as
    // fontes uma vez, em vez de uma vez por etiqueta.
    const embutidas = await saida.embedPages(
      recortes.map((r) => r.pagina),
      recortes.map((r) => ({
        left: r.caixa.x0,
        bottom: r.caixa.y0,
        right: r.caixa.x1,
        top: r.caixa.y1,
      })),
    );

    for (let k = 0; k < recortes.length; k++) {
      const posicao = k % porFolha;
      if (posicao === 0) {
        folha = saida.addPage([folhaL, folhaA]);
        item.folhas++;
      }

      const { giro } = recortes[k];
      const embutida = embutidas[k];

      const col = posicao % colunas;
      const lin = Math.floor(posicao / colunas);

      const giroTotal =
        (giro +
          melhorGiro(
            giro % 180 ? embutida.height : embutida.width,
            giro % 180 ? embutida.width : embutida.height,
            celulaL,
            celulaA,
            cfg.girar,
          )) %
        360;

      encaixar(
        folha,
        embutida,
        {
          x: margem + col * (celulaL + espaco),
          // Preenche de cima para baixo: a primeira etiqueta sai primeiro.
          y: folhaA - margem - (lin + 1) * celulaA - lin * espaco,
          l: celulaL,
          a: celulaA,
        },
        giroTotal,
      );
    }

    resumo.push(item);
  }

  if (saida.getPageCount() === 0) {
    const e = new Error(
      resumo.find((r) => r.aviso)?.aviso || "Nenhuma etiqueta encontrada nos arquivos enviados.",
    );
    e.resumo = resumo;
    throw e;
  }

  return { pdf: await saida.save(), resumo };
}

/** Só olha os arquivos e conta o que achou, sem montar PDF nenhum. */
export async function analisar(arquivos) {
  const relatorio = [];

  for (const arquivo of arquivos) {
    try {
      const doc = await PDFDocument.load(arquivo.bytes, { ignoreEncryption: true });
      const paginas = doc.getPages();
      let total = 0;
      let amostra = null;

      for (const pagina of paginas) {
        const achadas = acharEtiquetas(pagina);
        total += achadas.length;
        if (!amostra && achadas.length) {
          const giro = giroDaPagina(pagina);
          const l = achadas[0].x1 - achadas[0].x0;
          const a = achadas[0].y1 - achadas[0].y0;
          amostra = {
            l: Math.round(ptParaMm(giro % 180 ? a : l) * 10) / 10,
            a: Math.round(ptParaMm(giro % 180 ? l : a) * 10) / 10,
            porPagina: achadas.length,
          };
        }
      }

      relatorio.push({
        nome: arquivo.nome,
        paginas: paginas.length,
        etiquetas: total,
        tamanho: amostra,
        detectado: total > 0,
      });
    } catch {
      relatorio.push({
        nome: arquivo.nome,
        paginas: 0,
        etiquetas: 0,
        tamanho: null,
        detectado: false,
        erro: "Não consegui abrir esse PDF.",
      });
    }
  }

  return relatorio;
}
