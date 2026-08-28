# Sistema de gestão financeira e de estoque para operação no Mercado Livre

Guia de arquitetura + passo a passo completo da integração via API oficial.

---

## Parte 1 — O que um sistema desses precisa ter

Antes de escrever código, vale entender por que planilha não resolve: no Mercado Livre o preço que aparece no anúncio tem pouca relação com o que entra na conta. Entre um e outro existem tarifa de venda, custo fixo por unidade, frete subsidiado, imposto, devolução, reembolso e Ads. Um sistema útil é aquele que responde três perguntas com número confiável:

1. **Este pedido deu lucro?** (margem por pedido, já líquida de tudo)
2. **Este SKU dá lucro?** (margem por produto no acumulado, não na média do mês)
3. **Vou ficar sem estoque de quê e quando?** (cobertura e ponto de pedido)

### Módulos essenciais

| Módulo | O que faz | Por que importa no ML |
|---|---|---|
| **Catálogo / SKU** | De-para entre seu SKU interno e `item_id` (MLB...) + variação | Um produto seu pode estar em vários anúncios; sem de-para, o custo não cola no pedido |
| **Custos de produto** | Custo de compra, frete de entrada, embalagem, custo médio ponderado | Margem calculada com custo desatualizado é ficção |
| **Estoque** | Saldo por depósito (próprio, Full, cross-docking), reservas, inventário | O Full tem estoque físico na ML; precisa ser um depósito separado |
| **Pedidos** | Espelho de cada `order` com status, itens, pagamentos, envio | Base de tudo |
| **Financeiro** | Contas a receber (liberação Mercado Pago), a pagar, saldo, antecipação | O dinheiro entra em data diferente da venda |
| **Conciliação de tarifas** | Comparar tarifa estimada × tarifa realmente cobrada na fatura | É aqui que aparece o dinheiro que some |
| **Precificação** | Simulador reverso: custo + margem alvo → preço; e preço → margem | Evita vender no negativo sem perceber |
| **Devoluções e reclamações** | Estorno de receita, custo de frete de retorno, produto que volta (ou não) | Uma devolução pode custar mais que a margem de 3 vendas |
| **Ads** | Rateio de investimento por SKU/campanha | Sem isso o ACOS não entra na margem |
| **Fiscal** | Regime (Simples/Presumido/Real), alíquota efetiva, NF-e, ST/DIFAL | Imposto é custo, não detalhe |
| **Compras / reposição** | Cobertura em dias, ponto de pedido, lead time do fornecedor | Ruptura no ML derruba posicionamento |
| **DRE gerencial** | Receita → deduções → CMV → despesas variáveis → fixas → lucro | A visão que o dono precisa |
| **Alertas** | Margem negativa, estoque crítico, tarifa divergente, pedido travado | Sistema que não avisa vira relatório que ninguém abre |

### As armadilhas específicas do Mercado Livre

- **Tarifa de venda não é só percentual.** Existe percentual por categoria/tipo de anúncio (Clássico `gold_special` × Premium `gold_pro`) **mais** um custo fixo por unidade em pedidos de baixo valor. Os limiares e valores mudam com frequência — **nunca fixe no código**, leia via `GET /sites/MLB/listing_prices`.
- **Frete grátis não é grátis.** Acima de determinado valor de pedido o frete é subsidiado, mas parte é descontada do vendedor conforme sua reputação e o tipo logístico. O custo real do envio só é definitivo no faturamento.
- **Estimativa ≠ realidade.** O `sale_fee` que vem no pedido é a expectativa. O valor definitivo aparece nas APIs de faturamento. O sistema precisa guardar os dois e reconciliar.
- **Data da venda ≠ data do dinheiro.** O regime de competência (venda) e o de caixa (liberação Mercado Pago) precisam conviver no mesmo sistema.
- **Cancelamento e devolução chegam depois.** Um pedido "lucrativo" em janeiro pode virar prejuízo em fevereiro. Recalcule retroativamente, não congele o resultado.
- **Catálogo e variações.** `item_id` + `variation_id` é a chave real; ignorar variação embaralha estoque e margem.

### Fórmula do lucro (a conta que importa)

```
Receita bruta        = preço unitário × quantidade
(-) Tarifa ML        = comissão da categoria + custo fixo por unidade
(-) Frete vendedor   = parte do envio bancada por você
(-) CMV              = custo médio do produto × quantidade
(-) Embalagem        = material + mão de obra de expedição
(-) Imposto          = alíquota efetiva × receita bruta
(-) Ads rateado      = investimento atribuído ao SKU/pedido
(-) Provisão devolução = % histórico de devolução do SKU × margem
= Margem de contribuição do pedido

Margem de contribuição total do período
(-) Despesas fixas   = aluguel, salários, sistemas, pró-labore
= Lucro operacional
```

Guarde **cada componente** no banco, não só o resultado. Quando a margem cair, você precisa saber qual linha mexeu.

---

## Parte 2 — Arquitetura recomendada

```
┌──────────────┐   OAuth 2.0      ┌────────────────────┐
│ Mercado Livre│◄─────────────────│  Serviço de Auth   │  guarda access_token
│     API      │                  │  (refresh 1x/5h)   │  e refresh_token
└──────┬───────┘                  └────────────────────┘
       │ webhook POST (<500ms)
       ▼
┌──────────────┐   enfileira      ┌────────────────────┐
│  /webhooks   │─────────────────►│  Fila (Redis/SQS)  │
│  responde 200│                  └─────────┬──────────┘
└──────────────┘                            │
                                            ▼
                                  ┌────────────────────┐
                                  │  Workers           │
                                  │  • sync pedidos    │
                                  │  • sync envios     │
                                  │  • sync estoque    │
                                  │  • conciliação     │
                                  └─────────┬──────────┘
                                            ▼
┌──────────────┐                  ┌────────────────────┐
│  Painel web  │◄─────────────────│  Postgres          │
└──────────────┘                  └────────────────────┘
```

**Stack sugerida (pequena operação, um dev):** Python + FastAPI + PostgreSQL + Redis, ou Node + NestJS. Deploy em Railway/Render/Fly.io. Frontend em React. Se você não é dev, pule para a Parte 5.

**Regras não-negociáveis:**

- O endpoint de webhook **só recebe e enfileira**. Nada de chamar a API do ML dentro dele.
- Todo processamento é **idempotente**: a mesma notificação pode chegar várias vezes.
- Nunca exponha `client_secret`, `access_token` ou `refresh_token` no frontend.
- Guarde o payload bruto de cada pedido (`JSONB`). Quando descobrir um campo novo, você reprocessa o histórico sem precisar rebuscar tudo.

### Modelo de dados mínimo

```sql
ml_accounts        (id, seller_id, nickname, access_token, refresh_token, expires_at)
produtos           (id, sku, nome, custo_medio, custo_embalagem, estoque_min, lead_time_dias)
anuncios           (item_id, variation_id, produto_id, listing_type, preco, qtd_disponivel)
pedidos            (order_id, seller_id, data, status, status_detail, total, payload_raw)
pedido_itens       (order_id, item_id, variation_id, produto_id, qtd, preco_unit, sale_fee_estimada)
envios             (shipment_id, order_id, logistic_type, custo_vendedor, status)
pagamentos         (payment_id, order_id, valor, taxa, data_aprovacao, data_liberacao, status)
faturamento_ml     (periodo, document_id, tipo, order_id, descricao, valor)   -- conciliação
movimentos_estoque (id, produto_id, tipo, qtd, custo_unit, origem, data)
custos_fixos       (id, competencia, categoria, descricao, valor)
ads_gastos         (id, data, campanha, item_id, valor)
```

---

## Parte 3 — Passo a passo da integração com o Mercado Livre

### Passo 0 — Pré-requisitos

- Conta Mercado Livre **de vendedor, com acesso de administrador**. Conta de colaborador/operador não gera token válido para tudo. Se o login for de colaborador, a concessão é inválida.
- Um domínio com **HTTPS** para o redirect e para o webhook. Em desenvolvimento, use ngrok ou Cloudflare Tunnel.
- CNPJ/KYC em dia na conta. Conta com pendência de política pode falhar na autorização.

### Passo 1 — Criar a aplicação

1. Acesse `https://developers.mercadolivre.com.br/devcenter` e faça login com a conta de vendedor.
2. Clique em **Criar nova aplicação**.
3. Preencha:
   - **Nome e descrição** — livres.
   - **URI de redirect** — precisa ser **exatamente** a URL que você vai usar depois. Ex.: `https://seusistema.com.br/auth/ml/callback`. Não pode conter parâmetros variáveis; se a URI enviada divergir um caractere do cadastro, a autorização falha.
   - **Escopos** — marque `read`, `write` e `offline_access`. O `offline_access` é o que libera o `refresh_token`; sem ele você reautoriza a cada 6 horas.
   - **URL de callback de notificações** — ex.: `https://seusistema.com.br/webhooks/ml`.
   - **Tópicos** — marque no mínimo `orders_v2`, `shipments`, `items`. Adicione `payments`, `claims`, `messages` e `stock_locations` conforme for usando.
4. Guarde o **App ID** (`client_id`) e a **Secret Key** (`client_secret`) em variáveis de ambiente. Nunca no repositório.

> Se você habilitar PKCE na aplicação, os parâmetros `code_challenge` e `code_challenge_method` passam a ser **obrigatórios** no fluxo de autorização.

### Passo 2 — Autorização (OAuth 2.0, Authorization Code)

Redirecione o vendedor para:

```
https://auth.mercadolivre.com.br/authorization
  ?response_type=code
  &client_id=SEU_APP_ID
  &redirect_uri=https://seusistema.com.br/auth/ml/callback
  &state=UM_ID_ALEATORIO_UNICO
```

O domínio muda por país (`.com.br` para MLB, `.com.ar` para MLA etc.).

O `state` é seu: gere um valor aleatório único por requisição, guarde na sessão e confira na volta. O Mercado Livre **não valida esse campo** — a verificação é responsabilidade sua. Ele também é o único jeito legítimo de carregar informação de contexto, já que o `redirect_uri` precisa ser estático.

O vendedor autoriza e volta para:

```
https://seusistema.com.br/auth/ml/callback?code=TG-xxxxx&state=UM_ID_ALEATORIO_UNICO
```

### Passo 3 — Trocar o code por token

```bash
curl -X POST \
  -H 'accept: application/json' \
  -H 'content-type: application/x-www-form-urlencoded' \
  'https://api.mercadolibre.com/oauth/token' \
  -d 'grant_type=authorization_code' \
  -d 'client_id=SEU_APP_ID' \
  -d 'client_secret=SUA_SECRET' \
  -d 'code=TG-xxxxx' \
  -d 'redirect_uri=https://seusistema.com.br/auth/ml/callback'
```

Resposta:

```json
{
  "access_token": "APP_USR-...",
  "token_type": "bearer",
  "expires_in": 21600,
  "scope": "offline_access read write",
  "user_id": 1234567,
  "refresh_token": "TG-..."
}
```

Salve `access_token`, `refresh_token`, `user_id` (é o seu `seller_id`) e calcule `expires_at = agora + expires_in`.

### Passo 4 — Renovação do token

O `access_token` vale cerca de 6 horas. Regras que quebram integração se ignoradas:

- **O `refresh_token` é de uso único.** Cada renovação devolve um novo — grave por cima, dentro de transação.
- O `refresh_token` expira em **6 meses** sem uso. Depois disso, refaça o fluxo do Passo 2.
- Troca de senha do vendedor, revogação da permissão ou desvinculação de dispositivo invalidam tudo. Trate `invalid_grant` avisando o usuário para reconectar, não com retry em loop.

```bash
curl -X POST \
  -H 'content-type: application/x-www-form-urlencoded' \
  'https://api.mercadolibre.com/oauth/token' \
  -d 'grant_type=refresh_token' \
  -d 'client_id=SEU_APP_ID' \
  -d 'client_secret=SUA_SECRET' \
  -d 'refresh_token=TG-...'
```

Agende um job que renova quando faltar ~30 minutos para expirar. Não espere o 401.

Em toda chamada à API: `Authorization: Bearer $ACCESS_TOKEN` **no header** (não em query string).

### Passo 5 — Receber notificações (webhooks)

O ML faz `POST` na sua callback com:

```json
{
  "_id": "f9f08571-1f65-4c46-9e0a-c0f43faas1557e",
  "resource": "/orders/2195160686",
  "user_id": 468424240,
  "topic": "orders_v2",
  "application_id": 5503910054141466,
  "attempts": 1,
  "sent": "2019-10-30T16:19:20.129Z",
  "received": "2019-10-30T16:19:20.106Z"
}
```

**Requisito crítico:** responda **HTTP 200 em até 500 ms**. Se não responder, o ML pode desativar seus tópicos e você precisa se inscrever de novo. Por isso o handler grava a mensagem numa fila e retorna imediatamente — o `GET` no recurso acontece no worker.

O ML assina as notificações; valide a assinatura no header antes de processar e descarte o que não bater. Existe também um simulador de notificações no DevCenter para testar cada cenário sem precisar de venda real.

Como o `resource` vem no payload, o worker só precisa fazer:

```bash
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
  https://api.mercadolibre.com/orders/2195160686
```

Se seu servidor cair, notificações são perdidas. Tenha **sempre** um job de varredura por período (Passo 6) rodando em paralelo como rede de segurança — webhook é otimização, não fonte única de verdade.

### Passo 6 — Carga inicial e varredura de segurança

```bash
curl -H 'Authorization: Bearer $ACCESS_TOKEN' -X GET \
 'https://api.mercadolibre.com/orders/search?seller=$SELLER_ID
  &order.date_created.from=2026-08-01T00:00:00.000-03:00
  &order.date_created.to=2026-08-31T23:59:59.000-03:00
  &offset=0&limit=50'
```

- Pagine com `offset`/`limit` (limite de 50 por página; há teto de offset — quebre em janelas de datas curtas).
- Para a carga inicial, varra mês a mês para trás até onde você tem histórico.
- Depois, rode a cada 15–30 min uma janela das últimas 48 horas para capturar o que o webhook perdeu.
- Use também `order.status=paid` quando só interessar venda concretizada.

### Passo 7 — Detalhe do pedido

`GET /orders/$ORDER_ID` traz o que alimenta a margem:

- `order_items[].item.id` / `variation_id` → chave para o seu SKU
- `order_items[].quantity`, `unit_price`
- `order_items[].sale_fee` → **tarifa estimada** por unidade
- `order_items[].listing_type_id` → `gold_special` (Clássico) ou `gold_pro` (Premium)
- `payments[]` → `transaction_amount`, `taxes_amount`, `shipping_cost`, `date_approved`, `installments`
- `shipping.id` → chave para buscar o envio
- `status` / `status_detail` → `paid`, `cancelled`, `invalid`...
- `billing_info.id` → dados fiscais do comprador, via `/orders/billing-info/MLB/$BILLING_INFO_ID`, para emissão de NF-e

**Grave o JSON inteiro.** Você vai precisar de campos que hoje não sabe que existem.

### Passo 8 — Envio e frete

```bash
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
  https://api.mercadolibre.com/shipments/$SHIPMENT_ID
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
  https://api.mercadolibre.com/shipments/$SHIPMENT_ID/costs
```

De `/costs` você tira quanto foi cobrado do comprador, quanto foi subsidiado pelo ML e **quanto sobrou para você** — é essa última parcela que entra na margem. O `logistic_type` (`fulfillment`, `self_service`/Flex, `cross_docking`, `drop_off`) muda a regra de custo e precisa virar dimensão nos seus relatórios.

Para simular frete grátis antes de precificar: `GET /users/$SELLER_ID/shipping_options/free`.

### Passo 9 — Conciliação com o faturamento real

Este é o passo que a maioria pula e é o que separa um sistema de uma planilha bonita.

```bash
# períodos disponíveis
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
 'https://api.mercadolibre.com/billing/integration/periods?group=ML&limit=6'

# documentos (faturas e notas de crédito) do período
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
 'https://api.mercadolibre.com/billing/integration/periods/key/2026-08-01/group/ML/documents'

# resumo
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
 'https://api.mercadolibre.com/billing/integration/periods/key/2026-08-01/summary?group=ML'

# detalhe linha a linha
curl -H 'Authorization: Bearer $ACCESS_TOKEN' \
 'https://api.mercadolibre.com/billing/integration/periods/key/2026-08-01/group/ML/details?document_type=BILL&limit=1000'
```

A `key` do período é sempre o primeiro dia do mês (`2026-08-01`). O parâmetro `group` aceita `ML` (Mercado Livre) ou `MP` (Mercado Pago) — sem ele vêm os dois. Pagine com `limit` (máx. 1000) e `from_id`.

No detalhe vêm comissões de venda, custos de publicação, serviços (Mercado Envios, Mercado Shops), campanhas de Ads, bonificações e, para MLB, a **composição da tarifa de venda** com descontos e rebates separados por pedido.

Fluxo de conciliação:

1. Importe o detalhe do período.
2. Faça o `join` por `order_id` com seus pedidos.
3. Compare `sale_fee` estimada × cobrada. Guarde a diferença.
4. Recalcule a margem daqueles pedidos com o valor real.
5. Levante alerta quando a divergência de um SKU passar de um limite (ex.: 3%).

> Atenção: a própria documentação do ML diz que as APIs de faturamento existem para **conciliação fiscal e relatórios**, não para ser fonte primária de gestão de vendas ou acompanhamento em tempo real. Use `/orders` para operação e `/billing` para fechamento.

### Passo 10 — Estoque

- Anúncios do vendedor: `GET /users/$SELLER_ID/items/search` (retorna só ativos).
- Detalhe e saldo: `GET /items/$ITEM_ID` → `available_quantity`, `variations[]`.
- Atualizar saldo: `PUT /items/$ITEM_ID` com `{"available_quantity": N}` (ou dentro de `variations`).
- Assine o tópico `stock_locations` para saber quando o estoque de um produto mudar de local, e `stock_fulfillment` se você usa Full.
- **O Full é um depósito à parte.** Trate como armazém separado no seu modelo, com seus próprios custos de armazenagem e retirada (que aparecem no relatório de faturamento de Fulfillment).

Cálculos que o módulo deve entregar:

```
venda_media_diaria  = unidades vendidas nos últimos 30 dias / 30
cobertura_dias      = estoque_atual / venda_media_diaria
ponto_de_pedido     = venda_media_diaria × lead_time_dias + estoque_seguranca
sugestao_compra     = max(0, (lead_time + ciclo) × venda_media_diaria − estoque_atual)
```

### Passo 11 — Testar sem quebrar a operação

Crie **usuários de teste** pela API (`POST /users/test_user`) e rode o fluxo inteiro com eles: autorização, publicação de anúncio, compra, notificação, cancelamento. Use o simulador de notificações do DevCenter para os cenários que são difíceis de reproduzir (devolução, mediação, mudança de status de envio).

### Passo 12 — Produção

- Monitore taxa de erro por endpoint e latência do webhook (a meta é o p99 abaixo de 500 ms).
- Trate `429` com backoff exponencial. Chamadas em excesso são rejeitadas temporariamente.
- Alerta quando `expires_at` do refresh estiver perto dos 6 meses.
- Faça log de toda chamada com `order_id` para conseguir auditar depois.
- **LGPD:** dados do comprador (nome, documento, endereço) são pessoais. Restrinja acesso, criptografe em repouso e defina prazo de retenção. Não use esses dados para nada além da operação da venda.

---

## Parte 4 — Referência rápida de endpoints

| Objetivo | Endpoint |
|---|---|
| Autorizar | `https://auth.mercadolivre.com.br/authorization` |
| Token / refresh | `POST https://api.mercadolibre.com/oauth/token` |
| Meus dados | `GET /users/me` |
| Meus anúncios | `GET /users/$SELLER_ID/items/search` |
| Detalhe do anúncio | `GET /items/$ITEM_ID` |
| Atualizar anúncio/estoque | `PUT /items/$ITEM_ID` |
| Preço de venda vigente | `GET /items/$ITEM_ID/sale_price?context=channel_marketplace` |
| Simular tarifa | `GET /sites/MLB/listing_prices?price=X&listing_type_id=gold_pro&category_id=MLBxxxx` |
| Tipos de anúncio | `GET /sites/MLB/listing_types` |
| Buscar pedidos | `GET /orders/search?seller=$SELLER_ID&order.date_created.from=...` |
| Detalhe do pedido | `GET /orders/$ORDER_ID` |
| Dados fiscais do comprador | `GET /orders/billing-info/MLB/$BILLING_INFO_ID` |
| Envio | `GET /shipments/$SHIPMENT_ID` |
| Custo do envio | `GET /shipments/$SHIPMENT_ID/costs` |
| Frete grátis do vendedor | `GET /users/$SELLER_ID/shipping_options/free` |
| Períodos de faturamento | `GET /billing/integration/periods?group=ML` |
| Documentos do período | `GET /billing/integration/periods/key/$KEY/group/ML/documents` |
| Detalhe do faturamento | `GET /billing/integration/periods/key/$KEY/group/ML/details` |
| Faturamento Fulfillment | `GET /billing/integration/periods/key/$KEY/group/ML/full/details` |
| Reclamações | `GET /post-purchase/v1/claims/search` |
| Usuário de teste | `POST /users/test_user` |

### Erros que você vai encontrar

| Erro | Causa | O que fazer |
|---|---|---|
| `invalid_client` | `client_id`/`client_secret` errados | Conferir variáveis de ambiente |
| `invalid_grant` | code/refresh expirado, já usado, ou permissão revogada | Refazer o fluxo de autorização |
| `invalid_scope` | Escopo fora de `read`, `write`, `offline_access` | Corrigir o cadastro da app |
| `403 forbidden` | Token de outro usuário, ou conta sem acesso ao domínio do país | Conferir `user_id` do token |
| `429 local_rate_limited` | Chamadas em excesso | Backoff exponencial + cache |
| "aplicação não pode conectar" | `redirect_uri` divergente, login de colaborador, KYC pendente | Conferir os quatro pontos do Passo 1 |

---

## Parte 5 — Construir ou comprar?

Seja honesto sobre o custo. Fazer do zero significa manter uma integração que muda sem aviso: novas versões de endpoints, mudanças em tipos de anúncio, novos campos de tarifa. Estimativa realista para uma primeira versão sólida: **6 a 10 semanas** de um dev com dedicação.

Alternativas que já resolvem o básico:

- **Bling, Tiny (Olist), Eccosys** — ERPs brasileiros com integração ML pronta, estoque e emissão de NF-e. Custo baixo. Fraqueza: análise de margem costuma ser rasa.
- **Nubimetrics, Real Trends** — inteligência de mercado e margem, sem gestão de estoque completa.
- **Planilhas com API** — barato, mas frágil.

O caminho que costuma dar mais retorno: **ERP pronto para o operacional** (pedidos, estoque, NF-e) **+ seu sistema próprio para o financeiro/margem**, lendo tanto a API do ML quanto o ERP. Você foca esforço onde o produto pronto é fraco e não reescreve emissão de nota fiscal.

Se decidir construir, faça em fases:

| Fase | Escopo | Semanas |
|---|---|---|
| 1 | OAuth + sync de pedidos + margem estimada por pedido | 1–2 |
| 2 | Cadastro de produtos, custos, estoque, alertas de ruptura | 2–3 |
| 3 | Conciliação com faturamento real + DRE | 2–3 |
| 4 | Devoluções, Ads, precificação, previsão de demanda | 3–4 |

Não pule a Fase 3. É ela que paga o projeto.

---

*Guia elaborado com base na documentação oficial de desenvolvedores do Mercado Livre (agosto/2026). Endpoints e regras comerciais mudam — confirme em `developers.mercadolivre.com.br` antes de implementar.*
