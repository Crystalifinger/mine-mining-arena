import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { formatUnits, fromChain, parseUnits } from '../units.js';
import { balanceOf } from '../ledger.js';
import { assignDeposit } from '../services/deposits.js';
import { adminApproveTask, adminRejectTask } from '../services/tasks.js';
import { tx } from '../db.js';
import { transfer } from '../ledger.js';
import { adminApprove, adminMarkConfirmed, adminRefundReview, adminReject, adminRequeue } from '../services/withdraw.js';
import { recheckWithdrawal } from '../workers/withdrawals.js';
import { hotJettonBalance, hotTonBalance } from '../ton/chain.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async req => {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const want = Buffer.from(cfg.ADMIN_TOKEN);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'unauthorized');
  });
  const id = (req: any) => z.coerce.number().int().positive().parse(req.params.id);

  /** Can we pay everyone? internal MINE owed to users vs MINE actually held by the hot wallet. */
  app.get('/solvency', async () => {
    const users = BigInt((await pool.query(
      `SELECT COALESCE(SUM(b.amount),0) AS s FROM balances b JOIN accounts a ON a.id=b.account_id WHERE a.user_id IS NOT NULL AND b.asset='MINE'`)).rows[0].s);
    const c = await pool.connect();
    try {
      const pending = await balanceOf(c, { sys: 'pending_rewards' }, 'MINE');
      const hold = await balanceOf(c, { sys: 'withdraw_hold' }, 'MINE');
      const unclaimedFuture = await balanceOf(c, { sys: 'emission' }, 'MINE');
      const liabilities = users + pending + hold;
      const onchain = fromChain(await hotJettonBalance(), cfg.MINE_DECIMALS);
      return {
        userBalances: formatUnits(users), pendingRewards: formatUnits(pending), lockedInWithdrawals: formatUnits(hold),
        liabilities: formatUnits(liabilities), hotWalletMine: formatUnits(onchain),
        surplus: formatUnits(onchain - liabilities), emissionPoolLeft: formatUnits(unclaimedFuture),
        hotWalletTon: formatUnits(await hotTonBalance()), solvent: onchain >= liabilities,
      };
    } finally { c.release(); }
  });

  app.get('/stats', async () => {
    const q = async (sql: string) => (await pool.query(sql)).rows[0];
    return {
      users: Number((await q('SELECT count(*) n FROM users')).n),
      miners: Number((await q('SELECT count(*) n FROM user_miners')).n),
      activeListings: Number((await q(`SELECT count(*) n FROM listings WHERE status='active'`)).n),
      pendingWithdrawals: Number((await q(`SELECT count(*) n FROM withdrawals WHERE status='pending_review'`)).n),
      needsReview: Number((await q(`SELECT count(*) n FROM withdrawals WHERE status='needs_review'`)).n),
      unmatchedDeposits: Number((await q(`SELECT count(*) n FROM deposits WHERE status='unmatched'`)).n),
    };
  });

  app.get('/withdrawals', async req => {
    const s = z.object({ status: z.string().default('pending_review') }).parse(req.query).status;
    const r = await pool.query(
      `SELECT w.*, u.username, u.tg_id FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=$1 ORDER BY w.id LIMIT 200`, [s]);
    return r.rows.map(w => ({ ...w, amount: formatUnits(BigInt(w.amount)), fee: formatUnits(BigInt(w.fee)) }));
  });
  app.post('/withdrawals/:id/approve', async req => adminApprove(id(req)));
  app.post('/withdrawals/:id/reject', async req => adminReject(id(req), z.object({ reason: z.string().max(200).default('rejected by admin') }).parse(req.body ?? {}).reason));
  app.post('/withdrawals/:id/recheck', async req => recheckWithdrawal(id(req)));
  app.post('/withdrawals/:id/requeue', async req => adminRequeue(id(req)));
  app.post('/withdrawals/:id/refund', async req => adminRefundReview(id(req), z.object({ reason: z.string().max(200).default('refunded by admin') }).parse(req.body ?? {}).reason));
  app.post('/withdrawals/:id/mark-confirmed', async req => adminMarkConfirmed(id(req), z.object({ txHash: z.string().min(10) }).parse(req.body).txHash));

  app.get('/deposits', async req => {
    const s = z.object({ status: z.string().default('unmatched') }).parse(req.query).status;
    const r = await pool.query('SELECT * FROM deposits WHERE status=$1 ORDER BY id DESC LIMIT 200', [s]);
    return r.rows.map(d => ({ ...d, amount: formatUnits(BigInt(d.amount)) }));
  });
  app.post('/deposits/:id/assign', async req => assignDeposit(id(req), z.object({ userId: z.number().int().positive() }).parse(req.body).userId));

  app.post('/users/:id/ban', async req => {
    const b = z.object({ banned: z.boolean() }).parse(req.body);
    await pool.query('UPDATE users SET banned=$2 WHERE id=$1', [id(req), b.banned]);
    await pool.query('INSERT INTO admin_audit (action, payload) VALUES ($1,$2)', ['user_ban', JSON.stringify({ id: id(req), ...b })]);
    return { ok: true };
  });

  /** Change a miner's price / stock / availability without redeploying. */
  app.post('/miner-types/:typeId', async req => {
    const b = z.object({
      priceTon: z.string().nullable().optional(), priceMine: z.string().nullable().optional(),
      stock: z.number().int().nullable().optional(), active: z.boolean().optional(),
      bonusGh: z.number().int().min(0).optional(), rarity: z.enum(['common','rare','epic','legendary']).optional(),
      isEvent: z.boolean().optional(), recycleRewardMine: z.string().optional(), recycleRewardTypeId: z.string().nullable().optional(),
    }).parse(req.body);
    const sets: string[] = []; const vals: unknown[] = [(req.params as any).typeId];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.priceTon !== undefined) add('price_ton', b.priceTon === null ? null : parseUnits(b.priceTon).toString());
    if (b.priceMine !== undefined) add('price_mine', b.priceMine === null ? null : parseUnits(b.priceMine).toString());
    if (b.stock !== undefined) add('stock', b.stock);
    if (b.active !== undefined) add('active', b.active);
    if (b.bonusGh !== undefined) add('bonus_gh', b.bonusGh);
    if (b.rarity !== undefined) add('rarity', b.rarity);
    if (b.isEvent !== undefined) add('is_event', b.isEvent);
    if (b.recycleRewardMine !== undefined) add('recycle_reward_mine', parseUnits(b.recycleRewardMine).toString());
    if (b.recycleRewardTypeId !== undefined) add('recycle_reward_type_id', b.recycleRewardTypeId);
    if (!sets.length) throw new HttpError(400, 'nothing_to_update');
    const r = await pool.query(`UPDATE miner_types SET ${sets.join(', ')} WHERE id=$1 RETURNING id`, vals);
    if (!r.rows[0]) throw new HttpError(404, 'miner_type_not_found');
    return { ok: true };
  });
  /* ---------- tasks ---------- */
  const taskBody = z.object({
    title: z.string().min(1).max(80), description: z.string().max(200).default(''),
    type: z.enum(['channel', 'link']), url: z.string().url(), chatId: z.string().optional(),
    rewardMine: z.string(), sortOrder: z.number().int().default(0), active: z.boolean().default(true),
  });
  app.get('/tasks', async () => (await pool.query('SELECT * FROM tasks ORDER BY sort_order, id')).rows.map(t => ({ ...t, reward: formatUnits(BigInt(t.reward)) })));
  app.post('/tasks', async req => {
    const b = taskBody.parse(req.body);
    if (b.type === 'channel' && !b.chatId) throw new HttpError(400, 'chat_id_required');
    const r = await pool.query(
      'INSERT INTO tasks (title, description, type, url, chat_id, reward, sort_order, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [b.title, b.description, b.type, b.url, b.chatId ?? null, parseUnits(b.rewardMine).toString(), b.sortOrder, b.active]);
    return { id: Number(r.rows[0].id) };
  });
  app.post('/tasks/:id', async req => {
    const b = z.object({ title: z.string().optional(), description: z.string().optional(), rewardMine: z.string().optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(req.body);
    const sets: string[] = []; const vals: unknown[] = [id(req)];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.title !== undefined) add('title', b.title);
    if (b.description !== undefined) add('description', b.description);
    if (b.rewardMine !== undefined) add('reward', parseUnits(b.rewardMine).toString());
    if (b.active !== undefined) add('active', b.active);
    if (b.sortOrder !== undefined) add('sort_order', b.sortOrder);
    if (!sets.length) throw new HttpError(400, 'nothing_to_update');
    const r = await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1 RETURNING id`, vals);
    if (!r.rows[0]) throw new HttpError(404, 'task_not_found');
    return { ok: true };
  });
  app.post('/tasks/:id/approve', async req => adminApproveTask(id(req)));
  /** Rejecting a sponsored task refunds the owner's unused budget. */
  app.post('/tasks/:id/reject', async req => adminRejectTask(id(req)));
  /** Adds MINE to the task reward pool (those MINE must really be in the hot wallet). */
  app.post('/task-pool/topup', async req => {
    const b = z.object({ amount: z.string() }).parse(req.body);
    const amount = parseUnits(b.amount);
    await tx(c => transfer(c, { from: { sys: 'genesis' }, to: { sys: 'task_pool' }, asset: 'MINE', amount, kind: 'genesis_task_pool', ref: `topup:${Date.now()}` }));
    return { ok: true };
  });
}
