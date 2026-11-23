import { cfg, U } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { transfer } from '../ledger.js';
import { formatUnits, parseUnits } from '../units.js';
import { notifyAdmin, notifyUser } from '../notify.js';
import { botInfo, isMember, memberStatus, tgCall } from './telegramApi.js';

const live = `t.active AND t.review = 'approved'`;

export async function listTasks(userId: number) {
  const r = await pool.query(
    `SELECT t.id, t.title, t.description, t.type, t.url, t.reward, (t.owner_id IS NOT NULL) AS sponsored,
            (ut.completed_at IS NOT NULL) AS completed
       FROM tasks t LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = $1
      WHERE ${live} AND COALESCE(t.owner_id, 0) <> $1 AND NOT COALESCE(ut.ineligible, FALSE)
      ORDER BY (t.owner_id IS NOT NULL), t.sort_order, t.id DESC`, [userId]);
  return r.rows.map(t => ({
    id: Number(t.id), title: t.title, description: t.description, type: t.type, url: t.url,
    reward: formatUnits(BigInt(t.reward)), sponsored: t.sponsored, completed: t.completed,
  }));
}

export async function startTask(userId: number, taskId: number) {
  const t = (await pool.query(`SELECT t.* FROM tasks t WHERE t.id=$1 AND ${live}`, [taskId])).rows[0];
  if (!t) throw new HttpError(404, 'task_not_found');
  if (t.owner_id && Number(t.owner_id) === userId) throw new HttpError(400, 'own_task');
  const u = (await pool.query('SELECT tg_id FROM users WHERE id=$1', [userId])).rows[0];

  if (t.type === 'channel' && t.new_members_only) {
    // sponsored tasks pay for NEW members only: anyone already in the channel is not eligible
    const st = await memberStatus(t.chat_id, String(u.tg_id));
    if (st === null) throw new HttpError(503, 'cannot_verify');
    if (isMember(st)) {
      await pool.query(
        `INSERT INTO user_tasks (user_id, task_id, ineligible) VALUES ($1,$2,TRUE)
         ON CONFLICT (user_id, task_id) DO UPDATE SET ineligible = TRUE WHERE user_tasks.completed_at IS NULL`, [userId, taskId]);
      throw new HttpError(400, 'already_member');
    }
  }
  await pool.query(
    `INSERT INTO user_tasks (user_id, task_id, started_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id, task_id) DO UPDATE SET started_at = COALESCE(user_tasks.started_at, now())`, [userId, taskId]);
  return { ok: true };
}

export async function claimTask(userId: number, taskId: number) {
  const t = (await pool.query(`SELECT t.* FROM tasks t WHERE t.id=$1 AND ${live}`, [taskId])).rows[0];
  if (!t) throw new HttpError(404, 'task_not_found');
  if (t.owner_id && Number(t.owner_id) === userId) throw new HttpError(400, 'own_task');
  const ut = (await pool.query('SELECT started_at, completed_at, ineligible FROM user_tasks WHERE user_id=$1 AND task_id=$2', [userId, taskId])).rows[0];
  if (ut?.completed_at) throw new HttpError(409, 'already_completed');
  if (t.new_members_only && (!ut?.started_at || ut.ineligible)) throw new HttpError(400, 'not_eligible');

  if (t.type === 'channel') {
    const u = (await pool.query('SELECT tg_id FROM users WHERE id=$1', [userId])).rows[0];
    const st = await memberStatus(t.chat_id, String(u.tg_id));
    if (st === null) { notifyAdmin(`Task check failed for ${t.chat_id}. Is the bot an admin there?`); throw new HttpError(503, 'cannot_verify'); }
    if (!isMember(st)) throw new HttpError(400, 'not_joined');
  } else {
    const waited = ut?.started_at ? Date.now() - new Date(ut.started_at).getTime() : 0;
    if (!ut?.started_at || waited < cfg.LINK_TASK_MIN_SECONDS * 1000) throw new HttpError(400, 'too_fast');
  }

  const res = await tx(async c => {
    const task = (await c.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
    if (!task || !task.active || task.review !== 'approved') throw new HttpError(409, 'task_closed');
    const r = await c.query(
      `INSERT INTO user_tasks (user_id, task_id, started_at, completed_at) VALUES ($1,$2,now(),now())
       ON CONFLICT (user_id, task_id) DO UPDATE SET completed_at = now() WHERE user_tasks.completed_at IS NULL
       RETURNING task_id`, [userId, taskId]);
    if (!r.rows[0]) throw new HttpError(409, 'already_completed');
    const reward = BigInt(task.reward);
    const ref = `task:${taskId}:${userId}`;
    let finishedFor: string | null = null;
    try {
      if (task.owner_id === null) {
        await transfer(c, { from: { sys: 'task_pool' }, to: { user: userId }, asset: 'MINE', amount: reward, kind: 'task_reward', ref });
      } else {
        if (task.joins >= task.max_joins) throw new HttpError(409, 'task_closed');
        const cost = BigInt(task.cost_per_join);
        await transfer(c, { from: { sys: 'task_escrow' }, to: { user: userId }, asset: 'MINE', amount: reward, kind: 'task_reward', ref });
        if (cost > reward) await transfer(c, { from: { sys: 'task_escrow' }, to: { sys: 'treasury' }, asset: 'MINE', amount: cost - reward, kind: 'task_fee', ref });
        const joins = task.joins + 1;
        const done = joins >= task.max_joins;
        await c.query(`UPDATE tasks SET joins=$2, review=$3, active=$4 WHERE id=$1`, [taskId, joins, done ? 'finished' : 'approved', !done]);
        if (done) finishedFor = String((await c.query('SELECT tg_id FROM users WHERE id=$1', [task.owner_id])).rows[0].tg_id);
      }
    } catch (e) {
      if (e instanceof HttpError && e.code === 'insufficient_funds') throw new HttpError(503, 'task_pool_empty');
      throw e;
    }
    return { reward: formatUnits(reward), finishedFor, title: task.title as string };
  });
  if (res.finishedFor) notifyUser(res.finishedFor, `Your promotion "${res.title}" is complete. All new members joined.`);
  return { reward: res.reward };
}

/* ---------- sponsored tasks (users promote a channel) ---------- */

export async function userTaskConfig() {
  const b = await botInfo();
  return {
    cost: formatUnits(U.utCost), reward: formatUnits(U.utReward), minBudget: formatUnits(U.utMin), maxBudget: formatUnits(U.utMax),
    maxActive: cfg.USER_TASK_MAX_ACTIVE, autoApprove: cfg.USER_TASK_AUTO_APPROVE === 'true', botUsername: b?.username ?? null,
  };
}

export async function createUserTask(userId: number, channelInput: string, budgetStr: string) {
  const m = /^(?:https?:\/\/t\.me\/|@)?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(channelInput.trim());
  if (!m) throw new HttpError(400, 'bad_channel');
  const chatId = '@' + m[1];

  let budget: bigint;
  try { budget = parseUnits(budgetStr); } catch { throw new HttpError(400, 'bad_amount'); }
  if (budget < U.utMin || budget > U.utMax || budget % U.utCost !== 0n) throw new HttpError(400, 'budget_out_of_range');
  const maxJoins = Number(budget / U.utCost);

  const chat = await tgCall<{ type: string; title: string; username?: string }>('getChat', { chat_id: chatId });
  if (!chat.ok || !chat.result || !['channel', 'supergroup'].includes(chat.result.type)) throw new HttpError(400, 'channel_not_found');
  const bot = await botInfo();
  if (!bot) throw new HttpError(503, 'cannot_verify');
  if ((await memberStatus(chatId, bot.id)) !== 'administrator') throw new HttpError(400, 'bot_not_admin');
  const u = (await pool.query('SELECT tg_id FROM users WHERE id=$1', [userId])).rows[0];
  const ust = await memberStatus(chatId, String(u.tg_id));
  if (ust !== 'creator' && ust !== 'administrator') throw new HttpError(403, 'not_channel_admin');

  const auto = cfg.USER_TASK_AUTO_APPROVE === 'true';
  const title = chat.result.title.slice(0, 80);
  const out = await tx(async c => {
    await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [userId]); // serialize this user's creations
    const n = Number((await c.query(`SELECT count(*) AS n FROM tasks WHERE owner_id=$1 AND review IN ('pending','approved')`, [userId])).rows[0].n);
    if (n >= cfg.USER_TASK_MAX_ACTIVE) throw new HttpError(400, 'too_many_tasks');
    let id: number;
    try {
      const r = await c.query(
        `INSERT INTO tasks (title, description, type, url, chat_id, reward, owner_id, cost_per_join, max_joins, new_members_only, review, active, sort_order)
         VALUES ($1,$2,'channel',$3,$4,$5,$6,$7,$8,TRUE,$9,$10,10) RETURNING id`,
        [title, 'Join and earn MINE', `https://t.me/${m[1]}`, chatId, U.utReward.toString(), userId, U.utCost.toString(), maxJoins, auto ? 'approved' : 'pending', auto]);
      id = Number(r.rows[0].id);
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'channel_already_promoted');
      throw e;
    }
    await transfer(c, { from: { user: userId }, to: { sys: 'task_escrow' }, asset: 'MINE', amount: budget, kind: 'task_escrow_lock', ref: `utask:${id}` });
    return { id, status: auto ? 'approved' : 'pending' };
  });
  if (!auto) notifyAdmin(`New sponsored task #${out.id} for ${chatId} (${formatUnits(budget)} MINE) needs review.`);
  return out;
}

export async function myTasks(userId: number) {
  const r = await pool.query(
    `SELECT id, title, url, review, joins, max_joins, cost_per_join FROM tasks WHERE owner_id=$1 ORDER BY id DESC LIMIT 30`, [userId]);
  return r.rows.map(t => ({
    id: Number(t.id), title: t.title, url: t.url, status: t.review, joins: t.joins, maxJoins: t.max_joins,
    budgetLeft: formatUnits(BigInt(t.cost_per_join) * BigInt(t.max_joins - t.joins)),
  }));
}

/** Closes a promotion and returns the unused budget to the owner. */
async function closeTask(taskId: number, newStatus: 'cancelled' | 'rejected', onlyOwner: number | null) {
  return tx(async c => {
    const t = (await c.query('SELECT * FROM tasks WHERE id=$1 AND owner_id IS NOT NULL FOR UPDATE', [taskId])).rows[0];
    if (!t || (onlyOwner !== null && Number(t.owner_id) !== onlyOwner)) throw new HttpError(404, 'task_not_found');
    if (!['pending', 'approved'].includes(t.review)) throw new HttpError(409, 'task_closed');
    const left = BigInt(t.cost_per_join) * BigInt(t.max_joins - t.joins);
    await c.query(`UPDATE tasks SET review=$2, active=FALSE WHERE id=$1`, [taskId, newStatus]);
    if (left > 0n) await transfer(c, { from: { sys: 'task_escrow' }, to: { user: Number(t.owner_id) }, asset: 'MINE', amount: left, kind: 'task_escrow_refund', ref: `utask:${taskId}:refund` });
    return { refunded: formatUnits(left) };
  });
}
export const cancelUserTask = (userId: number, taskId: number) => closeTask(taskId, 'cancelled', userId);
export const adminRejectTask = (taskId: number) => closeTask(taskId, 'rejected', null);
export async function adminApproveTask(taskId: number) {
  const r = await pool.query(`UPDATE tasks SET review='approved', active=TRUE WHERE id=$1 AND review='pending' AND owner_id IS NOT NULL RETURNING id`, [taskId]);
  if (!r.rows[0]) throw new HttpError(409, 'not_pending');
  return { ok: true };
}
