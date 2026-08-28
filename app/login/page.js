'use client';
import { useState } from 'react';

export default function Login() {
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(e) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    if (r.ok) window.location.href = '/';
    else {
      setErro('Senha incorreta.');
      setEnviando(false);
    }
  }

  return (
    <form onSubmit={entrar} style={{ maxWidth: 340, marginTop: 60 }}>
      <div className="secao-titulo">Acesso ao livro-caixa</div>
      <div className="campo" style={{ marginBottom: 14 }}>
        <label>Senha do painel</label>
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoFocus />
      </div>
      {erro && <div className="alerta">{erro}</div>}
      <button className="principal" type="submit" disabled={enviando}>
        {enviando ? 'Entrando…' : 'Entrar'}
      </button>
      <p className="rodape">
        A senha é a variável APP_PASSWORD definida no projeto da Vercel.
      </p>
    </form>
  );
}
