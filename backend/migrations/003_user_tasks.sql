-- Sponsored tasks: users promote their own channel. The budget is locked in escrow and
-- paid out per new member (part to the joiner, the rest is the platform fee).
INSERT INTO accounts (system_name) VALUES ('task_escrow');
INSERT INTO balances (account_id, asset, allow_negative)
  SELECT a.id, x.asset, FALSE FROM accounts a CROSS JOIN (VALUES ('MINE'),('TON')) AS x(asset)
  WHERE a.system_name = 'task_escrow';

ALTER TABLE tasks
  ADD COLUMN owner_id          BIGINT REFERENCES users(id),     -- NULL = platform task
  ADD COLUMN cost_per_join     BIGINT,
  ADD COLUMN max_joins         INT,
  ADD COLUMN joins             INT NOT NULL DEFAULT 0,
  ADD COLUMN new_members_only  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN review            TEXT NOT NULL DEFAULT 'approved'
             CHECK (review IN ('pending','approved','rejected','cancelled','finished'));

ALTER TABLE user_tasks ADD COLUMN ineligible BOOLEAN NOT NULL DEFAULT FALSE;

-- one live promotion per channel
CREATE UNIQUE INDEX tasks_one_live_per_chat ON tasks (chat_id)
  WHERE owner_id IS NOT NULL AND review IN ('pending','approved');
CREATE INDEX tasks_owner ON tasks (owner_id) WHERE owner_id IS NOT NULL;
