import { cfg, U } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { balanceOf, transfer } from '../ledger.js';
import { RANKS, FLOOR_HASH, REF_HASH, emissionAt, rankIndex } from '../economy.js';
import { formatUnits } from '../units.js';

type RankStat = { rank: number; miners: number; totalHash: number; difficulty: number; emission: string };

/** Distributes one block. Each rank is its own network: the rank's emission is split by hash share. */
export async function processBlock(height: bigint): Promise<boolean> {
  return tx(async c => {
    const ins = await c.query('INSERT INTO blocks (height) VALUES ($1) ON CONFLICT DO NOTHING RETURNING height', [height.toString()]);
    if (!ins.rows[0]) return false; // already processed

    const { rows } = await c.query(
      `SELECT um.user_id, SUM(mt.hash_gh + mt.bonus_gh)::bigint AS hash
         FROM user_miners um
         JOIN miner_types mt ON mt.id = um.type_id
         JOIN users u ON u.id = um.user_id
        WHERE um.slot IS NOT NULL AND NOT u.banned
        GROUP BY um.user_id`,
    );
    const miners = rows.map(r => ({ uid: Number(r.user_id), hash: Number(r.hash) }));
    const byRank: { uid: number; hash: number }[][] = RANKS.map(() => []);
    for (const m of miners) byRank[rankIndex(m.hash)].push(m);

    const stats: RankStat[] = [];
    const rew = { uid: [] as number[], rank: [] as number[], hash: [] as string[], diff: [] as string[], amt: [] as bigint[] };
    let total = 0n;

    byRank.forEach((list, ri) => {
      const sum = list.reduce((a, m) => a + m.hash, 0);
      const denom = Math.max(sum, FLOOR_HASH); // floor stops an empty network from paying out the whole emission
      const em = emissionAt(ri, height);
      const diff = denom / REF_HASH;
      stats.push({ rank: ri, miners: list.length, totalHash: sum, difficulty: Number(diff.toFixed(4)), emission: formatUnits(em) });
      for (const m of list) {
        const a = (em * BigInt(m.hash)) / BigInt(denom);
        if (a <= 0n) continue;
        rew.uid.push(m.uid); rew.rank.push(ri); rew.hash.push(String(m.hash)); rew.diff.push(diff.toFixed(4)); rew.amt.push(a);
        total += a;
      }
    });

    // never pay more than what is left in the emission pool
    const avail = await balanceOf(c, { sys: 'emission' }, 'MINE');
    if (total > avail) {
      const orig = total;
      total = 0n;
      rew.amt = rew.amt.map(a => { const s = orig > 0n ? (a * avail) / orig : 0n; total += s; return s; });
    }
    if (total > 0n) {
      await transfer(c, { from: { sys: 'emission' }, to: { sys: 'pending_rewards' }, asset: 'MINE', amount: total, kind: 'block_reward', ref: `block:${height}` });
      await c.query(
        `INSERT INTO block_rewards (height, user_id, rank, hash, difficulty, amount)
         SELECT $1::bigint, * FROM unnest($2::bigint[], $3::smallint[], $4::bigint[], $5::numeric[], $6::bigint[])`,
        [height.toString(), rew.uid, rew.rank, rew.hash, rew.diff, rew.amt.map(String)],
      );
    }

    // snapshot hash power: rank and withdrawal caps follow this, so placing a miner for a moment gains nothing
    await c.query('UPDATE users SET block_hash = 0 WHERE block_hash <> 0');
    if (miners.length) {
      await c.query(
        'UPDATE users u SET block_hash = t.h FROM unnest($1::bigint[], $2::bigint[]) AS t(id, h) WHERE u.id = t.id',
        [miners.map(m => m.uid), miners.map(m => m.hash)],
      );
    }
    await c.query('UPDATE blocks SET stats = $2 WHERE height = $1', [height.toString(), JSON.stringify(stats)]);
    return true;
  });
}

export async function runBlocks(): Promise<void> {
  const cur = BigInt(Math.floor(Date.now() / 1000 / cfg.BLOCK_SECONDS));
  const last = (await pool.query('SELECT max(height) AS h FROM blocks')).rows[0].h;
  let start = last === null ? cur : BigInt(last) + 1n;
  if (cur - start > 200n) start = cur - 200n; // cap catch-up after long downtime
  for (let h = start; h <= cur; h++) await processBlock(h);
}

export async function claim(userId: number) {
  return tx(async c => {
    const r = await c.query(
      'UPDATE block_rewards SET claimed = TRUE, claimed_at = now() WHERE user_id = $1 AND NOT claimed RETURNING amount',
      [userId],
    );
    const sum = r.rows.reduce((a, x) => a + BigInt(x.amount), 0n);
    if (sum < U.claimMin) throw new HttpError(400, 'nothing_to_claim'); // rolls the update back
    await transfer(c, { from: { sys: 'pending_rewards' }, to: { user: userId }, asset: 'MINE', amount: sum, kind: 'claim' });
    return { claimed: formatUnits(sum) };
  });
}

export async function pendingRewards(userId: number): Promise<bigint> {
  const r = await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM block_rewards WHERE user_id=$1 AND NOT claimed', [userId]);
  return BigInt(r.rows[0].s);
}

export async function liveHash(userId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(mt.hash_gh + mt.bonus_gh),0)::int AS h FROM user_miners um JOIN miner_types mt ON mt.id=um.type_id
      WHERE um.user_id=$1 AND um.slot IS NOT NULL`,
    [userId],
  );
  return r.rows[0].h;
}

export async function getNetwork(userId?: number) {
  const b = (await pool.query('SELECT height, stats FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
  const height = b ? BigInt(b.height) : BigInt(Math.floor(Date.now() / 1000 / cfg.BLOCK_SECONDS));
  const stats: RankStat[] = b?.stats ?? [];
  const ranks = RANKS.map((r, i) => {
    const s = stats.find(x => x.rank === i);
    return {
      name: r.name, minHash: r.min, dailyWithdrawCap: formatUnits(r.cap),
      emissionPerBlock: formatUnits(emissionAt(i, height + 1n)),
      miners: s?.miners ?? 0, totalHash: s?.totalHash ?? 0, difficulty: s?.difficulty ?? 1,
    };
  });
  const now = Math.floor(Date.now() / 1000);
  const out: any = { height: height.toString(), blockSeconds: cfg.BLOCK_SECONDS, nextBlockIn: cfg.BLOCK_SECONDS - (now % cfg.BLOCK_SECONDS), ranks };
  if (userId !== undefined) {
    const hash = await liveHash(userId);
    const u = (await pool.query('SELECT block_hash FROM users WHERE id=$1', [userId])).rows[0];
    const ri = rankIndex(hash);
    const stat = stats.find(x => x.rank === ri);
    const mine = rankIndex(Number(u.block_hash)) === ri ? Number(u.block_hash) : 0;
    const others = Math.max(0, (stat?.totalHash ?? 0) - mine);
    const denom = Math.max(others + hash, FLOOR_HASH);
    const est = hash > 0 ? (emissionAt(ri, height + 1n) * BigInt(hash)) / BigInt(denom) : 0n;
    out.me = {
      hash, rank: RANKS[ri].name, share: hash > 0 ? hash / denom : 0,
      estPerBlock: formatUnits(est), estPerDay: formatUnits(est * BigInt(Math.floor(86400 / cfg.BLOCK_SECONDS))),
    };
  }
  return out;
}
