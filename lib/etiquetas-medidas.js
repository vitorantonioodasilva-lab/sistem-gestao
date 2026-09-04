/**
 * Medidas e padrões do conversor de etiquetas.
 *
 * Fica separado de `lib/etiquetas.js` porque a tela precisa dessas contas para
 * mostrar a prévia, e importar o conversor inteiro levaria o pdf-lib junto
 * para o navegador sem necessidade.
 */

export const MM = 72 / 25.4;
export const mm = (v) => v * MM;
export const ptParaMm = (v) => v / MM;

/** Mídias da impressora. A 10x15 é a etiqueta padrão de envio do Mercado Livre. */
export const MIDIAS = {
  "10x15": { rotulo: "10 × 15 cm — etiqueta padrão de envio", l: 100, a: 150 },
  "10x10": { rotulo: "10 × 10 cm", l: 100, a: 100 },
  "10x7.5": { rotulo: "10 × 7,5 cm", l: 100, a: 75 },
  a4: { rotulo: "A4 — 21 × 29,7 cm", l: 210, a: 297 },
};

export const PADROES = {
  midia: "10x15",
  modo: "auto", // auto | unica | grade
  colunas: 2,
  linhas: 3,
  margem: 2, // mm de sobra na borda da etiqueta
  espaco: 2, // mm entre uma etiqueta e outra
  girar: "auto", // auto | nao | 90
};

/** Abaixo disso a etiqueta é pequena e vale a pena juntar várias por folha. */
export const LIMITE_UNICA = 0.55;

/**
 * Conta como fica a folha com uma configuração: tamanho final de cada
 * etiqueta e quantas linhas ainda caberiam sem diminuir nada.
 * Recebe e devolve tudo em milímetros.
 */
export function medirGrade(tamanho, cfg) {
  const midia = MIDIAS[cfg.midia] || MIDIAS["10x15"];
  const margem = Math.max(0, Number(cfg.margem) || 0);
  const espaco = Math.max(0, Number(cfg.espaco) || 0);
  const colunas = Math.max(1, Math.round(Number(cfg.colunas)) || 1);
  const linhas = Math.max(1, Math.round(Number(cfg.linhas)) || 1);

  const usavelL = midia.l - 2 * margem;
  const usavelA = midia.a - 2 * margem;
  if (usavelL <= 0 || usavelA <= 0 || !tamanho) return null;

  const celulaL = (usavelL - (colunas - 1) * espaco) / colunas;
  const celulaA = (usavelA - (linhas - 1) * espaco) / linhas;
  if (celulaL <= 0 || celulaA <= 0) return null;

  const escala = Math.min(celulaL / tamanho.l, celulaA / tamanho.a);
  const finalL = tamanho.l * escala;
  const finalA = tamanho.a * escala;

  // Quantas linhas caberiam se a largura da coluna fosse o único limite —
  // é o jeito de aproveitar a folha sem encolher mais a etiqueta.
  const escalaPorLargura = celulaL / tamanho.l;
  const alturaCheia = tamanho.a * escalaPorLargura;
  const linhasQueCabem = Math.max(
    1,
    Math.floor((usavelA + espaco) / (alturaCheia + espaco)),
  );

  return {
    escala,
    final: { l: finalL, a: finalA },
    celula: { l: celulaL, a: celulaA },
    linhasQueCabem,
    porFolha: colunas * linhas,
  };
}

/** No automático: etiqueta que quase preenche a mídia vai sozinha na folha. */
export function modoAutomatico(tamanho, midiaChave) {
  const midia = MIDIAS[midiaChave] || MIDIAS["10x15"];
  if (!tamanho) return "unica";
  const ocupa = (tamanho.l * tamanho.a) / (midia.l * midia.a);
  return ocupa >= LIMITE_UNICA ? "unica" : "grade";
}

/**
 * Maior margem que ainda deixa a etiqueta sair em tamanho real. Serve para o
 * caso da etiqueta de envio, que tem quase a altura da mídia: qualquer sobra
 * na borda já obriga a encolher.
 */
export function margemParaTamanhoReal(tamanho, midiaChave) {
  const midia = MIDIAS[midiaChave] || MIDIAS["10x15"];
  if (!tamanho) return null;
  const folga = Math.min((midia.l - tamanho.l) / 2, (midia.a - tamanho.a) / 2);
  return folga < 0 ? null : Math.floor(folga * 2) / 2;
}
