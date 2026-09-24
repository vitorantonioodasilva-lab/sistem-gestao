import { Pool } from "pg";

let pool;
let migrated = false;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL não configurada.");
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conta_ml (
  id             INT PRIMARY KEY DEFAULT 1,
  seller_id      BIGINT,
  nickname       TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expira_em      TIMESTAMPTZ,
  conectado_em   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT conta_unica CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS conta_shopee (
  id             INT PRIMARY KEY DEFAULT 1,
  shop_id        BIGINT,
  shop_name      TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expira_em      TIMESTAMPTZ,
  conectado_em   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT conta_shopee_unica CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave  TEXT PRIMARY KEY,
  valor  TEXT
);

CREATE TABLE IF NOT EXISTS produtos (
  id                BIGSERIAL PRIMARY KEY,
  item_id           TEXT NOT NULL,
  variation_id      TEXT NOT NULL DEFAULT '',
  canal             TEXT NOT NULL DEFAULT 'ml',
  sku               TEXT,
  titulo            TEXT,
  custo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0,
  custo_embalagem   NUMERIC(12,2) NOT NULL DEFAULT 0,
  estoque_atual     INT NOT NULL DEFAULT 0,
  estoque_minimo    INT NOT NULL DEFAULT 0,
  lead_time_dias    INT NOT NULL DEFAULT 15,
  preco_anuncio     NUMERIC(12,2) DEFAULT 0,
  listing_type      TEXT,
  atualizado_em     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (canal, item_id, variation_id)
);

CREATE TABLE IF NOT EXISTS pedidos (
  order_id       TEXT PRIMARY KEY,
  canal          TEXT NOT NULL DEFAULT 'ml',
  data_criacao   TIMESTAMPTZ,
  data_fechamento TIMESTAMPTZ,
  status         TEXT,
  status_detail  TEXT,
  comprador      TEXT,
  total_pedido   NUMERIC(12,2) DEFAULT 0,
  shipment_id    TEXT,
  frete_vendedor NUMERIC(12,2) DEFAULT 0,
  tarifa_pedido  NUMERIC(12,2) NOT NULL DEFAULT 0,
  repasse_liquido NUMERIC(12,2),
  logistic_type  TEXT,
  payload        JSONB,
  sincronizado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT REFERENCES pedidos(order_id) ON DELETE CASCADE,
  canal          TEXT NOT NULL DEFAULT 'ml',
  item_id        TEXT,
  variation_id   TEXT NOT NULL DEFAULT '',
  sku            TEXT,
  titulo         TEXT,
  quantidade     INT DEFAULT 1,
  preco_unitario NUMERIC(12,2) DEFAULT 0,
  sale_fee       NUMERIC(12,2) DEFAULT 0,
  listing_type   TEXT,
  UNIQUE (order_id, item_id, variation_id)
);

CREATE TABLE IF NOT EXISTS custos_fixos (
  id          BIGSERIAL PRIMARY KEY,
  descricao   TEXT NOT NULL,
  valor_mensal NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fila_webhook (
  id           BIGSERIAL PRIMARY KEY,
  notification_id TEXT,
  topic        TEXT,
  resource     TEXT,
  recebido_em  TIMESTAMPTZ DEFAULT now(),
  processado   BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS envios (
  shipment_id    TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  pack_id        TEXT,
  canal          TEXT NOT NULL DEFAULT 'ml',
  status         TEXT,
  substatus      TEXT,
  logistic_type  TEXT,
  tags           JSONB,
  destinatario   TEXT,
  cidade         TEXT,
  uf             TEXT,
  cep            TEXT,
  data_criacao   TIMESTAMPTZ,
  prazo_despacho TIMESTAMPTZ,
  vezes_impresso INT DEFAULT 0,
  nf_numero      TEXT,
  nf_status      TEXT,
  nf_erro        TEXT,
  nf_emitida_em  TIMESTAMPTZ,
  impresso_em    TIMESTAMPTZ,
  despachado_em  TIMESTAMPTZ,
  payload        JSONB,
  atualizado_em  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_custos (
  item_id            TEXT NOT NULL,
  data               DATE NOT NULL,
  campaign_id        BIGINT,
  custo              NUMERIC(12,2) NOT NULL DEFAULT 0,
  clicks             INT DEFAULT 0,
  prints             INT DEFAULT 0,
  unidades_diretas   NUMERIC(12,2) DEFAULT 0,
  unidades_indiretas NUMERIC(12,2) DEFAULT 0,
  unidades_organicas NUMERIC(12,2) DEFAULT 0,
  receita_ads        NUMERIC(12,2) DEFAULT 0,
  PRIMARY KEY (item_id, data)
);

CREATE TABLE IF NOT EXISTS ads_diario (
  data          DATE PRIMARY KEY,
  custo_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  receita_ads   NUMERIC(12,2) NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS log_sync (
  id           BIGSERIAL PRIMARY KEY,
  executado_em TIMESTAMPTZ DEFAULT now(),
  origem       TEXT,
  pedidos      INT DEFAULT 0,
  anuncios     INT DEFAULT 0,
  erro         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pedidos_data ON pedidos (data_criacao);
CREATE INDEX IF NOT EXISTS idx_itens_item ON pedido_itens (item_id, variation_id);
CREATE INDEX IF NOT EXISTS idx_ads_data ON ads_custos (data);
-- Multicanal. O identificador de pedido da Shopee é alfanumérico
-- (2609045186BFA), então order_id e shipment_id passam de BIGINT para TEXT.
-- A conversão preserva o que já está gravado e é idempotente. Uma versão
-- anterior fazia o caminho contrário (TEXT -> BIGINT) para consertar um JOIN
-- que não casava; agora os dois lados são TEXT e o JOIN volta a funcionar.
ALTER TABLE pedidos      ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE envios       ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE produtos     ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'ml';
ALTER TABLE pedidos      ADD COLUMN IF NOT EXISTS tarifa_pedido NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE pedidos      ADD COLUMN IF NOT EXISTS repasse_liquido NUMERIC(12,2);

DO $canal$
DECLARE
  col TEXT;
BEGIN
  -- A chave estrangeira trava a troca de tipo: sai antes e volta depois.
  ALTER TABLE pedido_itens DROP CONSTRAINT IF EXISTS pedido_itens_order_id_fkey;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pedidos'
       AND column_name = 'order_id' AND data_type <> 'text'
  ) THEN
    ALTER TABLE pedidos ALTER COLUMN order_id TYPE TEXT USING order_id::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pedido_itens'
       AND column_name = 'order_id' AND data_type <> 'text'
  ) THEN
    ALTER TABLE pedido_itens ALTER COLUMN order_id TYPE TEXT USING order_id::text;
  END IF;

  ALTER TABLE pedido_itens
    ADD CONSTRAINT pedido_itens_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES pedidos(order_id) ON DELETE CASCADE;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pedidos'
       AND column_name = 'shipment_id' AND data_type <> 'text'
  ) THEN
    ALTER TABLE pedidos ALTER COLUMN shipment_id TYPE TEXT USING shipment_id::text;
  END IF;

  FOREACH col IN ARRAY ARRAY['shipment_id','order_id','pack_id'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'envios'
         AND column_name = col AND data_type <> 'text'
    ) THEN
      EXECUTE format('ALTER TABLE envios ALTER COLUMN %I TYPE TEXT USING %I::text', col, col);
    END IF;
  END LOOP;

  -- O mesmo SKU pode existir nos dois canais com item_id diferente, então a
  -- unicidade de produto passa a incluir o canal.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'produtos_item_id_variation_id_key'
       AND conrelid = 'produtos'::regclass
  ) THEN
    ALTER TABLE produtos DROP CONSTRAINT produtos_item_id_variation_id_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'produtos_canal_item_id_variation_id_key'
       AND conrelid = 'produtos'::regclass
  ) THEN
    ALTER TABLE produtos
      ADD CONSTRAINT produtos_canal_item_id_variation_id_key
      UNIQUE (canal, item_id, variation_id);
  END IF;
END
$canal$;

ALTER TABLE envios ADD COLUMN IF NOT EXISTS vezes_impresso INT DEFAULT 0;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS nf_status TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS nf_erro TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS nf_emitida_em TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_envios_order ON envios (order_id);
CREATE INDEX IF NOT EXISTS idx_envios_status ON envios (status, substatus);
CREATE INDEX IF NOT EXISTS idx_pedidos_canal ON pedidos (canal, data_criacao);
CREATE INDEX IF NOT EXISTS idx_envios_canal ON envios (canal);
`;

export async function query(text, params) {
  const p = getPool();
  if (!migrated) {
    await p.query(SCHEMA);
    migrated = true;
  }
  return p.query(text, params);
}

/** Insere sem rodar migração — usado no webhook, que precisa ser rápido. */
export async function queryRaw(text, params) {
  return getPool().query(text, params);
}

export async function getConfig(chave, padrao = null) {
  const r = await query("SELECT valor FROM configuracoes WHERE chave = $1", [
    chave,
  ]);
  return r.rows.length ? r.rows[0].valor : padrao;
}

export async function setConfig(chave, valor) {
  await query(
    `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
    [chave, String(valor)],
  );
}

export async function getConfigs() {
  const r = await query("SELECT chave, valor FROM configuracoes");
  const out = {};
  for (const row of r.rows) out[row.chave] = row.valor;
  return {
    aliquota_imposto: out.aliquota_imposto ?? "4",
    sale_fee_por_unidade: out.sale_fee_por_unidade ?? "true",
    provisao_devolucao: out.provisao_devolucao ?? "0",
    dias_historico: out.dias_historico ?? "90",
    ads_ativo: out.ads_ativo ?? "true",
    ads_dias_sync: out.ads_dias_sync ?? "30",
    ...out,
  };
}
