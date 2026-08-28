export const brl = (v) =>
  (Number(v) || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });

export const pct = (v) =>
  v === null || v === undefined ? '—' : `${(Number(v) || 0).toFixed(1)}%`;

export const dataCurta = (d) =>
  d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';

export const sinal = (v) => (Number(v) < 0 ? 'prejuizo' : 'lucro');
