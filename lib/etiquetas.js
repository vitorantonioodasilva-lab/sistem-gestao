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

const FUGA = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/** Resolve as fugas de uma string literal do PDF. */
function semEscape(bruto) {
  if (!bruto.includes("\\")) return bruto;
  let saida = "";
  for (let i = 0; i < bruto.length; i++) {
    if (bruto[i] !== "\\") {
      saida += bruto[i];
      continue;
    }
    const c = bruto[++i];
    if (c >= "0" && c <= "7") {
      let oct = c;
      while (oct.length < 3 && bruto[i + 1] >= "0" && bruto[i + 1] <= "7") oct += bruto[++i];
      saida += String.fromCharCode(parseInt(oct, 8));
    } else if (c === "\n" || c === "\r") {
      /* quebra de linha escapada: não vira caractere */
    } else {
      saida += FUGA[c] ?? c;
    }
  }
  return saida;
}

/** Converte uma string hexadecimal do PDF em caracteres. */
function deHex(bruto) {
  const limpo = bruto.replace(/[^0-9A-Fa-f]/g, "");
  let saida = "";
  for (let i = 0; i + 1 < limpo.length; i += 2) {
    saida += String.fromCharCode(parseInt(limpo.slice(i, i + 2), 16));
  }
  return saida;
}

/** Lê um par hexadecimal do CMap como número e como texto. */
const hexNum = (h) => parseInt(h, 16);
const hexTexto = (h) => {
  let saida = "";
  for (let i = 0; i + 3 < h.length + 2 && i < h.length; i += 4) {
    saida += String.fromCharCode(parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16));
  }
  return saida;
};

/**
 * Lê o /ToUnicode da fonte — o mapa que diz qual letra cada código representa.
 * Sem ele, fonte de subconjunto (a da Shopee, por exemplo) sai como lixo.
 */
function lerCMap(fluxo) {
  let bruto;
  try {
    bruto = Buffer.from(
      fluxo instanceof PDFRawStream ? decodePDFRawStream(fluxo).decode() : fluxo.getContents(),
    ).toString("latin1");
  } catch {
    return null;
  }

  const mapa = new Map();

  for (const bloco of bruto.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const [, de, para] of bloco.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      mapa.set(hexNum(de), hexTexto(para));
    }
  }

  for (const bloco of bruto.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    // Forma 1: <ini> <fim> <primeiro destino>, somando de um em um.
    for (const [, ini, fim, dest] of bloco.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
    )) {
      const base = hexNum(dest);
      const ate = Math.min(hexNum(fim), hexNum(ini) + 65535);
      for (let c = hexNum(ini); c <= ate; c++) {
        mapa.set(c, String.fromCharCode(base + c - hexNum(ini)));
      }
    }
    // Forma 2: <ini> <fim> [ <d1> <d2> ... ], um destino por código.
    for (const [, ini, , lista] of bloco.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      let c = hexNum(ini);
      for (const [, item] of lista.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        mapa.set(c++, hexTexto(item));
      }
    }
  }

  return mapa.size ? mapa : null;
}

/** Descobre quantos bytes por código a fonte usa e como traduzir cada um. */
function lerFonte(contexto, recursos, nome, cache) {
  const dicFontes = contexto.lookup(recursos?.get(PDFName.of("Font")));
  if (!(dicFontes instanceof PDFDict)) return null;

  const ref = dicFontes.get(PDFName.of(nome));
  const chave = String(ref);
  if (cache.has(chave)) return cache.get(chave);

  let fonte = null;
  const dic = contexto.lookup(ref);
  if (dic instanceof PDFDict) {
    const subtipo = contexto.lookup(dic.get(PDFName.of("Subtype")))?.asString?.();
    const toUnicode = contexto.lookup(dic.get(PDFName.of("ToUnicode")));
    fonte = {
      // Type0 é sempre composta: dois bytes por código.
      duplo: subtipo === "/Type0",
      mapa: toUnicode instanceof PDFStream ? lerCMap(toUnicode) : null,
    };
  }

  cache.set(chave, fonte);
  return fonte;
}

/** Traduz os bytes de uma string mostrada na página para texto de verdade. */
function decodificar(bytes, fonte) {
  if (!fonte?.duplo && !fonte?.mapa) return bytes;

  const passo = fonte.duplo ? 2 : 1;
  let saida = "";
  for (let i = 0; i + passo <= bytes.length; i += passo) {
    const codigo =
      passo === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
    const letra = fonte.mapa?.get(codigo);
    saida += letra ?? (passo === 1 ? bytes[i] : "");
  }
  return saida;
}

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
  let fonte = null;
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
      const inicio = ++i;
      let nivel = 1;
      while (i < n && nivel > 0) {
        if (texto[i] === "\\") i += 2;
        else {
          if (texto[i] === "(") nivel++;
          else if (texto[i] === ")") nivel--;
          i++;
        }
      }
      operandos.push({ bytes: semEscape(texto.slice(inicio, i - 1)) });
      continue;
    }

    if (c === "<") {
      if (texto[i + 1] === "<") {
        i += 2;
        operandos.push(null);
        continue;
      }
      const inicio = ++i;
      while (i < n && texto[i] !== ">") i++;
      operandos.push({ bytes: deHex(texto.slice(inicio, i)) });
      i++;
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
      pilha.push({ ctm: atual, fonte });
    } else if (op === "Q") {
      const anterior = pilha.pop();
      atual = anterior?.ctm || IDENTIDADE;
      fonte = anterior?.fonte ?? null;
    } else if (op === "Tf") {
      const nome = operandos.find((o) => o?.nome)?.nome;
      if (nome) fonte = lerFonte(contexto, recursos, nome, achados.fontes);
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
    } else if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      // Junta o que a página escreve. Serve só para reconhecer o formato da
      // etiqueta, então basta o que der para ler sem montar a tabela da fonte.
      for (const o of operandos) {
        if (o?.bytes) achados.textos.push(decodificar(o.bytes, fonte));
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
export function lerPagina(pagina) {
  const contexto = pagina.node.context;
  const achados = { retangulos: [], textos: [], fontes: new Map() };

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
    /* página que não conseguimos ler vira página sem nada */
  }

  return achados;
}

export function acharEtiquetas(pagina, achadosPreLidos) {
  const achados = achadosPreLidos || lerPagina(pagina);
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

  // Numa folha de etiquetas quase todo retângulo grande é etiqueta. Se sobrou
  // mais área de fora do grupo do que dentro, o que achamos não é uma grade —
  // é uma tabela qualquer, como a da declaração de conteúdo. Melhor desistir e
  // deixar quem chamou tratar a página inteira.
  const dentro = melhor.reduce((t, r) => t + area(r), 0);
  const fora = externos
    .filter((r) => !melhor.includes(r) && !melhor.some((m) => sobreposicao(r, m) > 0.5))
    .reduce((t, r) => t + area(r), 0);
  if (fora > dentro) return [];

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
   5. Que etiqueta é essa
   ========================================================= */

/**
 * Deixa o texto da página comparável: sem acento, sem caixa e sem espaço.
 * O espaço tem que sair porque o PDF quebra palavra no meio para ajustar o
 * kerning — "ENTREGAR NA FULL" chega como "ENTREG AR NA FULL".
 */
function normalizar(textos) {
  return textos
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Marcas que identificam cada formato. A ordem importa: documento primeiro,
 * porque a declaração de conteúdo repete várias palavras da etiqueta.
 */
const FORMATOS = [
  {
    tipo: "declaracao",
    etiqueta: false,
    marcas: ["DECLARACAODECONTEUDO", "IDENTIFICACAODOSBENS", "ASSINATURADODECLARANTE"],
    rotulo: "Declaração de conteúdo",
    nota: "Documento A4 que vai dentro da caixa — não é etiqueta.",
  },
  {
    tipo: "separacao",
    etiqueta: false,
    marcas: ["LISTADESEPARACAO", "PACKINGLIST"],
    rotulo: "Lista de separação",
    nota: "Papel de conferência — não é etiqueta.",
  },
  {
    tipo: "full-volume",
    etiqueta: true,
    marcas: ["ENTREGARNAFULL", "NAOVALIDAPARACOLETA", "CENTROLOGISTICO"],
    origem: "mercadolivre",
    rotulo: "Mercado Livre Full — etiqueta de caixa",
  },
  {
    tipo: "envio",
    etiqueta: true,
    marcas: ["MERCADOENVIOS", "MERCADOLIVRE"],
    origem: "mercadolivre",
    rotulo: "Mercado Livre — etiqueta de envio",
  },
  {
    tipo: "envio",
    etiqueta: true,
    // A etiqueta da Shopee sai pelos Correios: o logo é imagem, mas o texto
    // traz "ID pedido" e o contrato, que a do Mercado Livre não tem.
    marcas: ["SHOPEE", "SHOPNAME", "IDPEDIDO"],
    origem: "shopee",
    rotulo: "Shopee — etiqueta de envio",
  },
  {
    tipo: "produto",
    etiqueta: true,
    // Folha de código de barras com SKU: é o formato das etiquetas de
    // produto que o Full pede para colar em cada peça.
    marcas: ["SKU"],
    origem: "mercadolivre",
    rotulo: "Mercado Livre Full — etiqueta de produto",
  },
];

/**
 * De onde veio a página, olhado à parte do tipo. A declaração de conteúdo da
 * Shopee, por exemplo, é papelada mas continua sendo da Shopee — e é bom que
 * a tela mostre isso.
 */
const ORIGENS = [
  { origem: "shopee", marcas: ["SHOPEE", "SHOPNAME", "IDPEDIDO"] },
  {
    origem: "mercadolivre",
    marcas: [
      "MERCADOLIVRE",
      "MERCADOENVIOS",
      "ENTREGARNAFULL",
      "NAOVALIDAPARACOLETA",
      "CENTROLOGISTICO",
    ],
  },
];

/**
 * Diz o que é a página: de onde veio, se é etiqueta ou papelada, e um rótulo
 * para mostrar na tela. Quando não reconhece, trata como etiqueta mesmo — a
 * geometria já resolve a maioria dos casos sozinha.
 */
export function identificarPagina(achados) {
  const texto = normalizar(achados.textos || []);
  const marcada = ORIGENS.find((o) => o.marcas.some((m) => texto.includes(m)));
  const formato = FORMATOS.find((f) => f.marcas.some((m) => texto.includes(m)));

  if (!formato) {
    return {
      origem: marcada?.origem || "desconhecido",
      tipo: "desconhecido",
      etiqueta: true,
      rotulo: "Formato não identificado",
      nota: null,
    };
  }

  return {
    origem: marcada?.origem || formato.origem || "desconhecido",
    tipo: formato.tipo,
    etiqueta: formato.etiqueta,
    rotulo: formato.rotulo,
    nota: formato.nota || null,
  };
}

/* =========================================================
   6. Montagem do PDF de saída
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
/** Lê um arquivo inteiro: separa etiquetas de papelada e mede tudo. */
async function examinar(arquivo) {
  const doc = await PDFDocument.load(arquivo.bytes, { ignoreEncryption: true });
  const recortes = [];
  const documentos = [];
  const formatos = [];
  let semContorno = false;

  doc.getPages().forEach((pagina, indice) => {
    const achados = lerPagina(pagina);
    const identidade = identificarPagina(achados);

    if (!formatos.some((f) => f.rotulo === identidade.rotulo)) {
      formatos.push({ ...identidade, paginas: 0 });
    }
    formatos.find((f) => f.rotulo === identidade.rotulo).paginas++;

    // Declaração de conteúdo e lista de separação são papel A4 — não cabem
    // numa etiqueta de 10 x 15 e não devem ir para a impressora térmica.
    if (!identidade.etiqueta) {
      documentos.push({ pagina, indice, rotulo: identidade.rotulo });
      return;
    }

    const giro = giroDaPagina(pagina);
    const { width: lp, height: ap } = pagina.getSize();
    const achadas = acharEtiquetas(pagina, achados);
    if (!achadas.length) semContorno = true;

    // Sem contorno reconhecível, a página inteira vira uma etiqueta só.
    for (const caixa of achadas.length ? achadas : [{ x0: 0, y0: 0, x1: lp, y1: ap }]) {
      const bruto = { l: caixa.x1 - caixa.x0, a: caixa.y1 - caixa.y0 };
      const vista = giro % 180 ? { l: bruto.a, a: bruto.l } : bruto;
      recortes.push({
        pagina,
        caixa,
        giro,
        identidade,
        tamanho: {
          l: Math.round(ptParaMm(vista.l) * 10) / 10,
          a: Math.round(ptParaMm(vista.a) * 10) / 10,
        },
      });
    }
  });

  return { doc, recortes, documentos, formatos, semContorno };
}

/**
 * Separa as etiquetas por tamanho, mantendo a ordem em que apareceram.
 * Etiqueta de caixa e etiqueta de produto não dividem a mesma folha: cada
 * tamanho tem a sua distribuição e começa numa folha nova.
 */
function porTamanho(recortes) {
  const grupos = [];
  for (const r of recortes) {
    // 2 mm de folga: variação de arredondamento não cria grupo novo.
    const chave = `${Math.round(r.tamanho.l / 2)}x${Math.round(r.tamanho.a / 2)}`;
    let g = grupos.find((x) => x.chave === chave);
    if (!g) grupos.push((g = { chave, tamanho: r.tamanho, itens: [] }));
    g.itens.push(r);
  }
  return grupos;
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
      documentos: 0,
      formatos: [],
      grupos: [],
      folhas: 0,
      aviso: null,
    };

    let lido;
    try {
      lido = await examinar(arquivo);
    } catch {
      item.aviso = "Não consegui abrir esse PDF. Ele pode estar corrompido ou protegido.";
      resumo.push(item);
      continue;
    }

    item.paginas = lido.doc.getPageCount();
    item.etiquetas = lido.recortes.length;
    item.documentos = lido.documentos.length;
    item.formatos = lido.formatos.map((f) => ({
      rotulo: f.rotulo,
      origem: f.origem,
      tipo: f.tipo,
      etiqueta: f.etiqueta,
      paginas: f.paginas,
      nota: f.nota,
    }));

    if (lido.semContorno) {
      item.aviso =
        "Não achei o contorno das etiquetas em alguma página; usei a folha inteira nesses casos.";
    }
    if (lido.documentos.length) {
      const quais = [...new Set(lido.documentos.map((d) => d.rotulo))].join(" e ");
      item.aviso = `${lido.documentos.length} página(s) de ${quais} ficaram de fora — são A4 e você baixa à parte.`;
    }

    if (!lido.recortes.length) {
      item.aviso = item.aviso || "Nenhuma etiqueta encontrada.";
      resumo.push(item);
      continue;
    }

    // Um lote de embutidas por arquivo: o pdf-lib copia imagem e fonte uma
    // vez só, em vez de uma vez por etiqueta.
    const embutidas = await saida.embedPages(
      lido.recortes.map((r) => r.pagina),
      lido.recortes.map((r) => ({
        left: r.caixa.x0,
        bottom: r.caixa.y0,
        right: r.caixa.x1,
        top: r.caixa.y1,
      })),
    );
    lido.recortes.forEach((r, k) => (r.embutida = embutidas[k]));

    for (const grupo of porTamanho(lido.recortes)) {
      const modo = cfg.modo === "auto" ? modoAutomatico(grupo.tamanho, cfg.midia) : cfg.modo;
      const colunas = modo === "unica" ? 1 : Math.max(1, Math.round(Number(cfg.colunas)) || 1);
      const linhas = modo === "unica" ? 1 : Math.max(1, Math.round(Number(cfg.linhas)) || 1);

      const celulaL = (folhaL - 2 * margem - (colunas - 1) * espaco) / colunas;
      const celulaA = (folhaA - 2 * margem - (linhas - 1) * espaco) / linhas;
      if (celulaL <= 0 || celulaA <= 0) {
        item.aviso = "Margem e espaçamento não cabem na mídia escolhida.";
        continue;
      }

      const registro = {
        tamanho: grupo.tamanho,
        etiquetas: grupo.itens.length,
        rotulo: grupo.itens[0].identidade.rotulo,
        modo,
        colunas,
        linhas,
        folhas: 0,
      };

      const porFolha = colunas * linhas;
      let folha = null;

      grupo.itens.forEach((r, k) => {
        const posicao = k % porFolha;
        if (posicao === 0) {
          folha = saida.addPage([folhaL, folhaA]);
          registro.folhas++;
          item.folhas++;
        }

        const col = posicao % colunas;
        const lin = Math.floor(posicao / colunas);
        const deitada = r.giro % 180;

        const giroTotal =
          (r.giro +
            melhorGiro(
              deitada ? r.embutida.height : r.embutida.width,
              deitada ? r.embutida.width : r.embutida.height,
              celulaL,
              celulaA,
              cfg.girar,
            )) %
          360;

        encaixar(
          folha,
          r.embutida,
          {
            x: margem + col * (celulaL + espaco),
            // Preenche de cima para baixo: a primeira etiqueta sai primeiro.
            y: folhaA - margem - (lin + 1) * celulaA - lin * espaco,
            l: celulaL,
            a: celulaA,
          },
          giroTotal,
        );
      });

      item.grupos.push(registro);
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

/**
 * Junta num PDF à parte as páginas que não são etiqueta — declaração de
 * conteúdo, lista de separação. Sai no tamanho original, para papel comum.
 */
export async function documentos(arquivos) {
  const saida = await PDFDocument.create();
  saida.setTitle("Documentos para papel comum");
  saida.setProducer("Livro-caixa — operação Mercado Livre");

  for (const arquivo of arquivos) {
    let lido;
    try {
      lido = await examinar(arquivo);
    } catch {
      continue;
    }
    if (!lido.documentos.length) continue;

    const copiadas = await saida.copyPages(
      lido.doc,
      lido.documentos.map((d) => d.indice),
    );
    for (const pagina of copiadas) saida.addPage(pagina);
  }

  if (saida.getPageCount() === 0) {
    throw new Error("Nenhum documento A4 para separar — os arquivos só têm etiqueta.");
  }

  return saida.save();
}

/** Só olha os arquivos e conta o que achou, sem montar PDF nenhum. */
export async function analisar(arquivos) {
  const relatorio = [];

  for (const arquivo of arquivos) {
    try {
      const lido = await examinar(arquivo);
      const grupos = porTamanho(lido.recortes).map((g) => ({
        tamanho: g.tamanho,
        etiquetas: g.itens.length,
        rotulo: g.itens[0].identidade.rotulo,
        origem: g.itens[0].identidade.origem,
        tipo: g.itens[0].identidade.tipo,
      }));

      relatorio.push({
        nome: arquivo.nome,
        paginas: lido.doc.getPageCount(),
        etiquetas: lido.recortes.length,
        documentos: lido.documentos.map((d) => d.rotulo),
        formatos: lido.formatos.map((f) => ({
          rotulo: f.rotulo,
          origem: f.origem,
          tipo: f.tipo,
          etiqueta: f.etiqueta,
          paginas: f.paginas,
          nota: f.nota,
        })),
        grupos,
        // A tela usa o maior grupo como amostra para desenhar a folha.
        tamanho: grupos.length
          ? grupos.reduce((a, b) => (b.etiquetas > a.etiquetas ? b : a)).tamanho
          : null,
        semContorno: lido.semContorno,
        detectado: lido.recortes.length > 0,
      });
    } catch {
      relatorio.push({
        nome: arquivo.nome,
        paginas: 0,
        etiquetas: 0,
        documentos: [],
        formatos: [],
        grupos: [],
        tamanho: null,
        detectado: false,
        erro: "Não consegui abrir esse PDF.",
      });
    }
  }

  return relatorio;
}
