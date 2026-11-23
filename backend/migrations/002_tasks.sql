-- Tasks: users earn MINE for joining the channel or visiting a link. Paid from a capped system pool.
INSERT INTO accounts (system_name) VALUES ('task_pool');
INSERT INTO balances (account_id, asset, allow_negative)
  SELECT a.id, x.asset, FALSE FROM accounts a CROSS JOIN (VALUES ('MINE'),('TON')) AS x(asset)
  WHERE a.system_name = 'task_pool';

CREATE TABLE tasks (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('channel','link')),
  url         TEXT NOT NULL,
  chat_id     TEXT,                                   -- '@channelname' (required for type=channel)
  reward      BIGINT NOT NULL CHECK (reward > 0),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type <> 'channel' OR chat_id IS NOT NULL)
);

CREATE TABLE user_tasks (
  user_id      BIGINT NOT NULL REFERENCES users(id),
  task_id      BIGINT NOT NULL REFERENCES tasks(id),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, task_id)
);
