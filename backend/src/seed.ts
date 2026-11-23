// Idempotent: funds the emission and task pools once, and creates the channel task.
// These MINE must really exist in the hot wallet (they become withdrawable balances).
import { pool, tx } from './db.js';
import { cfg, U } from './config.js';
import { transfer } from './ledger.js';
import { formatUnits } from './units.js';

async function fund(kind: string, to: string, amount: bigint) {
  if (amount <= 0n) return console.log(`${to}: nothing to fund`);
  const done = await pool.query('SELECT 1 FROM ledger WHERE kind=$1 AND ref=$2 LIMIT 1', [kind, 'initial']);
  if (done.rowCount) return console.log(`${to} already funded`);
  await tx(c => transfer(c, { from: { sys: 'genesis' }, to: { sys: to }, asset: 'MINE', amount, kind, ref: 'initial' }));
  console.log(`${to} funded:`, formatUnits(amount), 'MINE');
}
await fund('genesis_pool', 'emission', U.miningPool);
await fund('genesis_task_pool', 'task_pool', U.taskPool);

if (cfg.SUPPORT_CHANNEL) {
  const name = cfg.SUPPORT_CHANNEL.trim().replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '');
  const exists = await pool.query('SELECT 1 FROM tasks WHERE chat_id=$1', ['@' + name]);
  if (!exists.rowCount) {
    await pool.query(
      `INSERT INTO tasks (title, description, type, url, chat_id, reward, sort_order) VALUES ($1,$2,'channel',$3,$4,$5,0)`,
      ['Join our channel', 'Get news, updates and bonus tasks', `https://t.me/${name}`, '@' + name, U.channelReward.toString()]);
    console.log('channel task created for @' + name);
  }
}
await pool.end();
