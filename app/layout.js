import './globals.css';
import Nav from '@/components/Nav';

export const metadata = {
  title: 'Livro-caixa — operação Mercado Livre',
  description: 'Margem por pedido, custo real e reposição de estoque.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="topo">
          <div className="topo-linha">
            <div className="marca">
              Livro-caixa
              <span>operação Mercado Livre</span>
            </div>
            <Nav />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
