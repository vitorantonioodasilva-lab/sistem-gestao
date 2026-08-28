# Livro-caixa — operação Mercado Livre

Sistema de gestão financeira e de estoque para quem vende no Mercado Livre. Puxa seus pedidos pela
API oficial, cruza com os custos que você cadastra e mostra a margem real de cada pedido e de cada
produto — já descontando tarifa, frete, imposto, embalagem e custo fixo.

**Stack:** Next.js 15 (App Router) + PostgreSQL. Roda inteiro em serverless. Custo zero nos planos
gratuitos de Vercel + Neon.

---

## O que ele faz

- **Conexão OAuth** com o Mercado Livre, com renovação automática do token (o `refresh_token` é de
  uso único e a rotação é tratada).
- **Sincronização** de pedidos, itens, envios e anúncios. Manual pelo botão ou diária pelo cron.
- **Webhook** em `/api/ml/webhook` que responde em ~15 ms e processa depois, atendendo o limite de
  500 ms exigido pelo Mercado Livre.
- **Margem por pedido** com a conta aberta linha a linha: receita → tarifa → frete → custo →
  embalagem → imposto → sobra.
- **DRE do período**, incluindo rateio de custo fixo mensal.
- **Estoque e reposição**: cobertura em dias, ponto de pedido, sugestão de compra, curva ABC.
- **Alertas**: produto vendendo com margem negativa, anúncio sem custo cadastrado, ruptura próxima.
- **Painel protegido por senha** — são dados financeiros numa URL pública.

---

## Deploy na Vercel

### 1. Banco de dados (2 minutos)

Crie um Postgres gratuito em [neon.tech](https://neon.tech) ou [supabase.com](https://supabase.com)
e copie a connection string. Também serve o Postgres do próprio marketplace da Vercel.

As tabelas são criadas automaticamente no primeiro acesso — não precisa rodar migração.

### 2. Aplicação no Mercado Livre (5 minutos)

1. Vá em [developers.mercadolivre.com.br/devcenter](https://developers.mercadolivre.com.br/devcenter)
   e entre com a **conta principal de vendedor** (conta de colaborador não gera token válido).
2. **Criar nova aplicação**.
3. Preencha:
   - **URI de redirect:** `https://SEU-APP.vercel.app/api/ml/callback`
   - **URL de notificações:** `https://SEU-APP.vercel.app/api/ml/webhook`
   - **Escopos:** `read`, `write` e `offline_access` (sem o `offline_access` você reautoriza a cada 6 horas)
   - **Tópicos:** `orders_v2`, `shipments`, `items`
4. Guarde o **App ID** e a **Secret Key**.

> Você ainda não tem a URL da Vercel neste ponto. Tudo bem: faça o passo 3, pegue a URL gerada e
> volte aqui para preencher os dois campos.

### 3. Subir o projeto

**Pelo GitHub (recomendado):**

```bash
git init && git add -A && git commit -m "livro-caixa ml"
gh repo create ml-financeiro --private --source=. --push
```

Depois, em [vercel.com/new](https://vercel.com/new), importe o repositório. Ele detecta Next.js
sozinho.

**Pelo CLI:**

```bash
npm i -g vercel
vercel          # primeiro deploy, gera a URL de preview
vercel --prod   # produção
```

### 4. Variáveis de ambiente

No painel da Vercel, em **Settings → Environment Variables**:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | connection string do passo 1 |
| `ML_CLIENT_ID` | App ID do passo 2 |
| `ML_CLIENT_SECRET` | Secret Key do passo 2 |
| `ML_REDIRECT_URI` | `https://SEU-APP.vercel.app/api/ml/callback` — idêntico ao DevCenter |
| `APP_PASSWORD` | a senha que você vai usar para entrar no painel |
| `CRON_SECRET` | qualquer string aleatória (opcional) |

Faça **Redeploy** depois de salvar. Variáveis só entram no build seguinte.

### 5. Conectar e carregar o histórico

1. Abra `https://SEU-APP.vercel.app`, entre com a senha.
2. Vá em **Ajustes → Conectar conta do Mercado Livre**.
3. Autorize.
4. No painel, clique em **Atualizar do ML**. A primeira carga traz 90 dias.
5. Vá em **Produtos e custos** e preencha o custo de compra de cada anúncio. **Sem isso nada
   funciona** — o sistema mostra lucro inflado e avisa em vermelho.

---

## Como rodar local

```bash
cp .env.example .env
# preencha as variáveis
npm install
npm run dev
```

Para testar o OAuth localmente você precisa de HTTPS público. Use `ngrok http 3000` e cadastre a
URL do túnel no DevCenter.

---

## Estrutura

```
lib/db.js         conexão Postgres + schema (criado sozinho)
lib/ml.js         OAuth, refresh, sincronização de pedidos/anúncios/fretes
lib/margem.js     motor de cálculo: margem, DRE, cobertura, curva ABC, alertas
lib/session.js    sessão por senha
middleware.js     protege tudo menos webhook, login e cron
app/page.js       painel
app/produtos/     custos por anúncio
app/config/       conexão, alíquota, custos fixos, log de sincronização
app/api/ml/       auth, callback, webhook, sync
```

---

## Duas coisas que você precisa conferir na primeira semana

**1. O `sale_fee` é por unidade ou por linha?**
Compare o total de "Tarifa Mercado Livre" do painel com a sua fatura do mês. Se der o dobro ou a
metade, mude a opção em **Ajustes → Como a margem é calculada**. Esse campo é a estimativa do ML,
não o valor definitivo.

**2. O frete está vindo?**
O custo do envio é buscado em `/shipments/{id}/costs` e pode ainda não existir quando o pedido é
muito recente. A sincronização seguinte corrige. Se ficar zerado em pedidos antigos, o tipo
logístico da sua operação pode não expor esse campo.

---

## O que ainda não está aqui

Foi deixado de fora de propósito, para a primeira versão ficar de pé:

- **Conciliação com a fatura real** (`/billing/integration/periods/...`). É o próximo passo mais
  valioso: compara tarifa estimada × cobrada e revela o dinheiro que some. Veja
  `DOCS-INTEGRACAO.md`, Passo 9.
- **Devoluções e reclamações** — hoje o pedido cancelado é excluído do resultado, mas o custo do
  frete de retorno não é contabilizado.
- **Rateio de Mercado Ads** por SKU.
- **Emissão de NF-e** — use um ERP para isso, não vale reescrever.
- **Múltiplas contas de vendedor** — o schema guarda uma conta (`conta_ml.id = 1`).

---

## Segurança

- `ML_CLIENT_SECRET` e os tokens ficam só no servidor, nunca chegam ao navegador.
- O painel exige senha. Sem `APP_PASSWORD` definida, ele fica **aberto** para qualquer um que
  souber a URL — defina antes de conectar a conta.
- Dados de comprador vêm no payload dos pedidos e são dados pessoais sob a LGPD. Não exporte nem
  compartilhe fora da operação da venda.
