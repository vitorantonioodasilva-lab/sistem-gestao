import { listaSeparacao } from "@/lib/expedicao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * Lista de separação em HTML pronto para imprimir. É o papel que vai
 * junto para o estoque: o que pegar da prateleira e quantas unidades,
 * agrupado por produto em vez de por pedido.
 */
export async function GET(req) {
  const ids = (new URL(req.url).searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    return new Response("Nenhum envio selecionado.", { status: 400 });
  }

  try {
    const { linhas, total_unidades, total_skus, total_pacotes } =
      await listaSeparacao(ids);
    const agora = new Date().toLocaleString("pt-BR");

    const html = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><title>Lista de separação</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 18px; }
  .resumo { display: flex; gap: 26px; margin-bottom: 18px; font-size: 14px; }
  .resumo b { font-size: 21px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; border-bottom: 2px solid #222; padding: 8px 6px; font-size: 12px;
       text-transform: uppercase; letter-spacing: .5px; }
  td { border-bottom: 1px solid #ddd; padding: 10px 6px; vertical-align: top; }
  .qtd { font-size: 20px; font-weight: 700; text-align: center; width: 70px; }
  .sku { font-family: ui-monospace, monospace; font-size: 13px; color: #555; }
  .box { width: 26px; height: 26px; border: 2px solid #999; border-radius: 5px; }
  .rodape { margin-top: 26px; font-size: 12px; color: #777; }
  @media print { body { margin: 10mm; } .naoimprime { display: none; } }
</style></head><body>
<h1>Lista de separação</h1>
<div class="sub">Gerada em ${esc(agora)}</div>
<div class="resumo">
  <span><b>${total_unidades}</b> unidades</span>
  <span><b>${total_skus}</b> produtos</span>
  <span><b>${total_pacotes}</b> pacotes</span>
</div>
<table>
  <thead><tr><th style="width:34px"></th><th class="qtd">Qtd</th><th>Produto</th><th style="width:130px">SKU</th><th style="width:80px">Pacotes</th></tr></thead>
  <tbody>
    ${linhas
      .map(
        (l) => `<tr>
      <td><div class="box"></div></td>
      <td class="qtd">${l.unidades}</td>
      <td>${esc(l.titulo)}</td>
      <td class="sku">${esc(l.sku || "—")}</td>
      <td>${l.pacotes}</td>
    </tr>`,
      )
      .join("")}
  </tbody>
</table>
<p class="rodape">Confira cada item antes de embalar. Quantidade divergente causa reclamação e devolução.</p>
<p class="naoimprime"><button onclick="window.print()">Imprimir</button></p>
<script>window.onload = () => setTimeout(() => window.print(), 400);</script>
</body></html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Erro: ${e.message}`, { status: 500 });
  }
}
