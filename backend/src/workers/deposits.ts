import { cfg } from '../config.js';
import { fromChain } from '../units.js';
import { incomingMessages, jettonTransfers } from '../ton/toncenter.js';
import { parseComment, sameAddress } from '../ton/payload.js';
import { getCursor, recordDeposit, setCursor } from '../services/deposits.js';

const PAGE = 100;

async function pollTon() {
  const cur = await getCursor('ton_in');
  let last = cur;
  const now = Math.floor(Date.now() / 1000);
  for (let offset = 0, stop = false; !stop; offset += PAGE) {
    const msgs = await incomingMessages({ destination: cfg.HOT_WALLET_ADDRESS, startLt: cur, offset, limit: PAGE });
    console.log('[DEPOSIT DEBUG] TON messages:', {
  count: msgs.length,
  cursor: cur.toString(),
  offset,
});
    for (const m of msgs) {
      if (now - Number(m.created_at) < cfg.DEPOSIT_CONFIRM_SECONDS) { stop = true; break; } // wait a few seconds for finality
      const lt = BigInt(m.created_lt);
      if (lt > last) last = lt;
      if (!m.source || m.bounced) continue;
      if (m.opcode) continue;                       // jetton notifications, excess returns, etc. are not deposits
      const value = BigInt(m.value || '0');
      if (value <= 0n) continue;
      const d = m.message_content?.decoded;
      const memo = d?.type === 'text_comment' ? (d.comment ?? null) : null;
      console.log('[DEPOSIT DEBUG] TON transaction:', {
  hash: m.hash,
  source: m.source,
  value: m.value,
  memoPresent: !!memo,
  memoLength: memo?.length ?? 0,
  memoSuffix: memo?.slice(-6) ?? null,
  opcode: m.opcode,
  bounced: m.bounced,
});
      await recordDeposit({ asset: 'TON', amount: value, ref: `ton:${m.hash}`, source: m.source, memo });
    }
    if (msgs.length < PAGE) break;
  }
  if (last > cur) await setCursor('ton_in', last);
}

async function pollJettons() {
  const cur = await getCursor('jetton_in');
  let last = cur;
  const now = Math.floor(Date.now() / 1000);
  for (let offset = 0, stop = false; !stop; offset += PAGE) {
    const rows = await jettonTransfers({ owner: cfg.HOT_WALLET_ADDRESS, direction: 'in', startLt: cur, offset, limit: PAGE });
    for (const t of rows) {
      if (now - t.transaction_now < cfg.DEPOSIT_CONFIRM_SECONDS) { stop = true; break; }
      const lt = BigInt(t.transaction_lt);
      if (lt > last) last = lt;
      if (t.transaction_aborted) continue;
      if (!sameAddress(t.destination, cfg.HOT_WALLET_ADDRESS) || !sameAddress(t.jetton_master, cfg.MINE_JETTON_MASTER)) continue;
      const amount = fromChain(BigInt(t.amount), cfg.MINE_DECIMALS);
      const memo = parseComment(t.forward_payload);

console.log('[DEPOSIT DEBUG] MINE transaction:', {
  hash: t.transaction_hash,
  source: t.source,
  destination: t.destination,
  jettonMaster: t.jetton_master,
  amount: amount.toString(),
  memoPresent: !!memo,
  memoLength: memo?.length ?? 0,
  memoSuffix: memo?.slice(-6) ?? null,
  aborted: t.transaction_aborted,
});
      if (amount <= 0n) continue;
      await recordDeposit({ asset: 'MINE', amount, ref: `jetton:${t.transaction_hash}`, source: t.source, memo });
    }
    if (rows.length < PAGE) break;
  }
  if (last > cur) await setCursor('jetton_in', last);
}

export async function pollDeposits() {
  console.log('[DEPOSIT DEBUG] Poll started', {
    network: cfg.TON_NETWORK,
    wallet: cfg.HOT_WALLET_ADDRESS,
    mineMaster: cfg.MINE_JETTON_MASTER,
    minTon: cfg.DEPOSIT_MIN_TON,
    minMine: cfg.DEPOSIT_MIN_MINE,
  });

  try {
    await pollTon();
    console.log('[DEPOSIT DEBUG] TON scan completed');
  } catch (e) {
    console.error('[DEPOSIT DEBUG] TON scan failed:', e);
  }

  try {
    await pollJettons();
    console.log('[DEPOSIT DEBUG] MINE scan completed');
  } catch (e) {
    console.error('[DEPOSIT DEBUG] MINE scan failed:', e);
  }
}
