export const COOKIE = 'ml_sessao';

/** Token derivado da senha do painel. Sem senha configurada, o painel fica aberto. */
export async function tokenEsperado() {
  const senha = process.env.APP_PASSWORD;
  if (!senha) return null;
  const dados = new TextEncoder().encode(`${senha}::ml-financeiro`);
  const hash = await crypto.subtle.digest('SHA-256', dados);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sessaoValida(cookieValor) {
  const esperado = await tokenEsperado();
  if (!esperado) return true;
  return cookieValor === esperado;
}
