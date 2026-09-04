'use client';

import { useEffect, useState } from 'react';
import { brl } from '@/components/formato';

export default function Produtos() {
  const [lista, setLista] = useState([]);
  const [busca, setBusca] = useState('');
  const [estado, setEstado] = useState('carregando');
  const [sujos, setSujos] = useState(new Set());

  useEffect(() => {
    fetch('/api/produtos')
      .then((r) => r.json())
      .then((d) => {
        setLista(Array.isArray(d) ? d : []);
        setEstado('pronto');
      })
      .catch(() => setEstado('erro'));
  }, []);

  function editar(id, campo, valor) {
    setLista((l) => l.map((p) => (p.id === id ? { ...p, [campo]: valor } : p)));
    setSujos((s) => new Set(s).add(id));
  }

  async function salvar() {
    setEstado('salvando');
    const alterados = lista.filter((p) => sujos.has(p.id));
    const r = await fetch('/api/produtos', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alterados),
    });
    setEstado(r.ok ? 'salvo' : 'erro');
    if (r.ok) setSujos(new Set());
    setTimeout(() => setEstado('pronto'), 2500);
  }

  const filtrada = lista.filter((p) =>
    `${p.titulo} ${p.sku} ${p.item_id} ${p.canal || ''}`
      .toLowerCase()
      .includes(busca.toLowerCase())
  );
  const semCusto = lista.filter((p) => Number(p.custo_unitario) === 0).length;
  // O mesmo produto pode estar nos dois canais com custo separado; sem Shopee
  // cadastrada a coluna de canal nem aparece.
  const multicanal = new Set(lista.map((p) => p.canal || 'ml')).size > 1;

  return (
    <>
      <div className="secao-titulo">
        <span>Custos por anúncio</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {sujos.size > 0 && (
            <span style={{ textTransform: 'none', letterSpacing: 0 }}>
              {sujos.size} alteração(ões) não salva(s)
            </span>
          )}
          <button className="principal" onClick={salvar} disabled={sujos.size === 0 || estado === 'salvando'}>
            {estado === 'salvando' ? 'Salvando…' : estado === 'salvo' ? 'Salvo' : 'Salvar custos'}
          </button>
        </span>
      </div>

      {semCusto > 0 && (
        <div className="alerta">
          {semCusto} anúncio(s) ainda sem custo de compra. Enquanto o campo estiver zerado, a
          margem do painel mostra lucro que não existe.
        </div>
      )}

      <div className="form-linha">
        <div className="campo" style={{ minWidth: 280 }}>
          <label>Buscar por título, SKU ou MLB</label>
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="ex.: MLB123 ou camiseta" />
        </div>
      </div>

      <div className="rolagem">
        <table>
          <thead>
            <tr>
              <th>Anúncio</th>
              <th>SKU</th>
              <th className="num">Preço</th>
              <th className="num">Custo compra</th>
              <th className="num">Embalagem</th>
              <th className="num">Estoque</th>
              <th className="num">Est. mínimo</th>
              <th className="num">Reposição (dias)</th>
              <th className="num">Margem bruta</th>
            </tr>
          </thead>
          <tbody>
            {filtrada.map((p) => {
              const preco = Number(p.preco_anuncio) || 0;
              const custo = Number(p.custo_unitario) || 0;
              const bruta = preco > 0 ? ((preco - custo - Number(p.custo_embalagem || 0)) / preco) * 100 : null;
              return (
                <tr key={p.id}>
                  <td>
                    {multicanal && (
                      <span className={`r-canal ${p.canal || 'ml'}`}>
                        {(p.canal || 'ml') === 'shopee' ? 'Shopee' : 'Mercado Livre'}
                      </span>
                    )}{' '}
                    {p.titulo || p.item_id}
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tinta-fraca)' }}>
                      {p.item_id}
                      {p.variation_id ? ` · var ${p.variation_id}` : ''} · {p.listing_type || '—'}
                    </div>
                  </td>
                  <td>
                    <input
                      className="mini"
                      style={{ textAlign: 'left' }}
                      value={p.sku ?? ''}
                      onChange={(e) => editar(p.id, 'sku', e.target.value)}
                    />
                  </td>
                  <td className="num">{brl(preco)}</td>
                  <td className="num">
                    <input
                      className="mini"
                      type="number"
                      step="0.01"
                      value={p.custo_unitario ?? 0}
                      onChange={(e) => editar(p.id, 'custo_unitario', e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="mini"
                      type="number"
                      step="0.01"
                      value={p.custo_embalagem ?? 0}
                      onChange={(e) => editar(p.id, 'custo_embalagem', e.target.value)}
                    />
                  </td>
                  <td className="num">{p.estoque_atual}</td>
                  <td className="num">
                    <input
                      className="mini"
                      type="number"
                      value={p.estoque_minimo ?? 0}
                      onChange={(e) => editar(p.id, 'estoque_minimo', e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="mini"
                      type="number"
                      value={p.lead_time_dias ?? 15}
                      onChange={(e) => editar(p.id, 'lead_time_dias', e.target.value)}
                    />
                  </td>
                  <td className="num">{bruta === null ? '—' : `${bruta.toFixed(1)}%`}</td>
                </tr>
              );
            })}
            {!filtrada.length && (
              <tr>
                <td colSpan={9} style={{ color: 'var(--tinta-fraca)' }}>
                  {estado === 'carregando'
                    ? 'Carregando…'
                    : 'Nenhum anúncio ainda. Conecte a conta em Ajustes e clique em “Atualizar do ML”.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="rodape">
        Estoque e preço vêm do Mercado Livre a cada sincronização e não são editáveis aqui — mude
        no próprio anúncio. Custo de compra, embalagem, estoque mínimo e prazo de reposição são
        seus e ficam só neste sistema.
      </p>
    </>
  );
}
