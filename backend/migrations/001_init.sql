-- Arena Mining schema. Amounts are BIGINT "units" with 9 decimals (1 MINE = 1_000_000_000).

CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  tg_id            BIGINT UNIQUE NOT NULL,
  username         TEXT,
  first_name       TEXT,
  memo             TEXT UNIQUE NOT NULL,          -- deposit memo (comment) for this user
  ref_by           BIGINT REFERENCES users(id),
  block_hash       BIGINT NOT NULL DEFAULT 0,     -- hash power at the last block (drives rank and caps)
  banned           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- double-entry ledger: every balance change is a transfer between two accounts
CREATE TABLE accounts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT UNIQUE REFERENCES users(id),
  system_name TEXT UNIQUE,
  CHECK ((user_id IS NULL) <> (system_name IS NULL))
);

CREATE TABLE balances (
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  asset          TEXT   NOT NULL CHECK (asset IN ('MINE','TON')),
  amount         BIGINT NOT NULL DEFAULT 0,
  allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (account_id, asset),
  CHECK (amount >= 0 OR allow_negative)
);

CREATE TABLE ledger (
  id         BIGSERIAL PRIMARY KEY,
  tx_id      UUID   NOT NULL,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  asset      TEXT   NOT NULL,
  amount     BIGINT NOT NULL,                     -- signed
  kind       TEXT   NOT NULL,
  ref        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_account_idx ON ledger (account_id, id DESC);
CREATE UNIQUE INDEX ledger_idem ON ledger (kind, ref, account_id, asset) WHERE ref IS NOT NULL;

INSERT INTO accounts (system_name) VALUES
  ('genesis'), ('emission'), ('pending_rewards'), ('treasury'), ('burn'),
  ('chain_in'), ('chain_out'), ('withdraw_hold');
INSERT INTO balances (account_id, asset, allow_negative)
  SELECT a.id, x.asset, a.system_name IN ('genesis','chain_in')
  FROM accounts a CROSS JOIN (VALUES ('MINE'),('TON')) AS x(asset)
  WHERE a.system_name IS NOT NULL;

CREATE TABLE miner_types (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  hash_gh    INT  NOT NULL,
  tier       SMALLINT NOT NULL,
  price_ton  BIGINT,
  price_mine BIGINT,
  tradable   BOOLEAN NOT NULL DEFAULT TRUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  stock      INT                                  -- NULL = unlimited
);
INSERT INTO miner_types (id, name, hash_gh, tier, price_ton, price_mine, tradable) VALUES
  ('spark',   'Spark Node',   10,   0, NULL,          NULL,           FALSE),
  ('ember',   'Ember Rig',    40,   1, 600000000,     60000000000,    TRUE),
  ('forge',   'Forge-X',      120,  2, 1800000000,    180000000000,   TRUE),
  ('titan',   'Arena Titan',  400,  3, 6000000000,    600000000000,   TRUE),
  ('inferno', 'Inferno Core', 1200, 4, 18000000000,   1800000000000,  TRUE);

CREATE TABLE user_miners (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  type_id    TEXT   NOT NULL REFERENCES miner_types(id),
  slot       SMALLINT CHECK (slot BETWEEN 0 AND 11),
  listed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (listed AND slot IS NOT NULL))
);
CREATE UNIQUE INDEX user_miners_slot ON user_miners (user_id, slot) WHERE slot IS NOT NULL;
CREATE INDEX user_miners_user ON user_miners (user_id);

CREATE TABLE store_orders (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  type_id    TEXT   NOT NULL REFERENCES miner_types(id),
  currency   TEXT   NOT NULL CHECK (currency IN ('MINE','TON')),
  price      BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id         BIGSERIAL PRIMARY KEY,
  miner_id   BIGINT NOT NULL REFERENCES user_miners(id),
  seller_id  BIGINT NOT NULL REFERENCES users(id),
  price      BIGINT NOT NULL CHECK (price > 0),
  status     TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  buyer_id   BIGINT REFERENCES users(id),
  fee        BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at  TIMESTAMPTZ
);
CREATE INDEX listings_active_price ON listings (price) WHERE status = 'active';
CREATE UNIQUE INDEX listings_one_active ON listings (miner_id) WHERE status = 'active';

CREATE TABLE blocks (
  height   BIGINT PRIMARY KEY,
  mined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stats    JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE block_rewards (
  id         BIGSERIAL PRIMARY KEY,
  height     BIGINT NOT NULL REFERENCES blocks(height),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  rank       SMALLINT NOT NULL,
  hash       BIGINT NOT NULL,
  difficulty NUMERIC(14,4) NOT NULL,
  amount     BIGINT NOT NULL,
  claimed    BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at TIMESTAMPTZ
);
CREATE INDEX block_rewards_unclaimed ON block_rewards (user_id) WHERE NOT claimed;

CREATE TABLE deposits (
  id         BIGSERIAL PRIMARY KEY,
  chain_ref  TEXT UNIQUE NOT NULL,                -- ton:<msg hash> or jetton:<tx hash>
  asset      TEXT NOT NULL CHECK (asset IN ('MINE','TON')),
  amount     BIGINT NOT NULL,
  source     TEXT,
  memo       TEXT,
  user_id    BIGINT REFERENCES users(id),
  status     TEXT NOT NULL CHECK (status IN ('credited','unmatched','below_min')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain_cursors (
  name TEXT PRIMARY KEY,
  lt   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE withdrawals (
  id           BIGSERIAL PRIMARY KEY,              -- also used as the on-chain query_id
  user_id      BIGINT NOT NULL REFERENCES users(id),
  address      TEXT   NOT NULL,
  amount       BIGINT NOT NULL,                    -- what the user receives
  fee          BIGINT NOT NULL DEFAULT 0,          -- locked on top of amount
  status       TEXT   NOT NULL CHECK (status IN
               ('pending_review','approved','sending','sent','confirmed','rejected','failed','needs_review')),
  reason       TEXT,
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX withdrawals_status ON withdrawals (status);
CREATE INDEX withdrawals_user_day ON withdrawals (user_id, created_at);

CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
