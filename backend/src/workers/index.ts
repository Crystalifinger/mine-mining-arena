import { cfg } from '../config.js';
import { pool } from '../db.js';
import { runBlocks } from '../services/mining.js';
import { pollDeposits } from './deposits.js';
import { reconcile, sendApproved } from './withdrawals.js';
import { verifySender } from '../ton/sender.js';

// Only one worker may run at a time: take a session-level advisory lock (waits until we are the leader).
const lock = await pool.connect();
await lock.query('SELECT pg_advisory_lock(7001)');
console.log('worker is leader');

function every(ms: number, name: string, fn: () => Promise<void>) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(`[${name}]`, e); } finally { busy = false; }
  };
  void run();
  setInterval(run, ms);
}

every(15_000, 'blocks', runBlocks);
every(10_000, 'deposits', pollDeposits);
every(30_000, 'reconcile', reconcile);

if (cfg.HOT_WALLET_MNEMONIC) {
  await verifySender(); // fail fast if the mnemonic does not match HOT_WALLET_ADDRESS
  every(15_000, 'withdraw-send', sendApproved);
} else {
  console.warn('HOT_WALLET_MNEMONIC not set: running WITHOUT sending withdrawals (watch-only mode)');
}

process.on('SIGTERM', async () => { lock.release(); await pool.end(); process.exit(0); });
