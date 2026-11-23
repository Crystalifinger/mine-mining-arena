ALTER TABLE miner_types
  ADD COLUMN IF NOT EXISTS bonus_gh INT NOT NULL DEFAULT 0 CHECK (bonus_gh >= 0),
  ADD COLUMN IF NOT EXISTS rarity TEXT NOT NULL DEFAULT 'common',
  ADD COLUMN IF NOT EXISTS is_event BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recycle_reward_mine BIGINT NOT NULL DEFAULT 0 CHECK (recycle_reward_mine >= 0),
  ADD COLUMN IF NOT EXISTS recycle_reward_type_id TEXT REFERENCES miner_types(id);

CREATE TABLE IF NOT EXISTS miner_burns (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  original_miner_id BIGINT NOT NULL,
  type_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('MINE','MINER')),
  reward_amount BIGINT NOT NULL DEFAULT 0,
  reward_type_id TEXT,
  burned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(original_miner_id)
);
CREATE INDEX IF NOT EXISTS miner_burns_user_idx ON miner_burns(user_id, burned_at DESC);

-- Example event-only miner. It is intentionally non-tradable and has no recycling reward
-- until the project owner configures one through SQL/admin tooling.
INSERT INTO miner_types (id, name, hash_gh, bonus_gh, tier, price_ton, price_mine, tradable, active, rarity, is_event)
VALUES ('event_spark', 'Event Spark', 25, 5, 1, NULL, NULL, FALSE, TRUE, 'rare', TRUE)
ON CONFLICT (id) DO NOTHING;
