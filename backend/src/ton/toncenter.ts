import { cfg, TONCENTER_V3 } from '../config.js';

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(TONCENTER_V3 + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: cfg.TONCENTER_API_KEY ? { 'X-API-Key': cfg.TONCENTER_API_KEY } : {} });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new Error(`toncenter ${res.status} ${path}`);
    await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
  }
}

export type JettonTransfer = {
  query_id: string; source: string; destination: string; amount: string; jetton_master: string;
  transaction_hash: string; transaction_lt: string; transaction_now: number; transaction_aborted: boolean;
  forward_payload?: string | null;
};
export type TonMessage = {
  hash: string; source: string | null; destination: string; value: string; created_lt: string; created_at: string;
  bounced?: boolean; opcode?: number | null;
  message_content?: { decoded?: { type?: string; comment?: string } | null } | null;
};

export async function jettonTransfers(o: {
  owner: string; direction: 'in' | 'out'; startLt?: bigint; startUtime?: number; limit?: number; offset?: number;
}): Promise<JettonTransfer[]> {
  const r = await get<{ jetton_transfers: JettonTransfer[] }>('/jetton/transfers', {
    owner_address: o.owner, jetton_master: cfg.MINE_JETTON_MASTER, direction: o.direction, sort: 'asc',
    start_lt: o.startLt?.toString(), start_utime: o.startUtime, limit: o.limit ?? 100, offset: o.offset ?? 0,
  });
  return r.jetton_transfers ?? [];
}

export async function incomingMessages(o: { destination: string; startLt?: bigint; limit?: number; offset?: number }): Promise<TonMessage[]> {
  const r = await get<{ messages: TonMessage[] }>('/messages', {
    destination: o.destination, direction: 'in', exclude_externals: 'true', sort: 'asc',
    start_lt: o.startLt?.toString(), limit: o.limit ?? 100, offset: o.offset ?? 0,
  });
  return r.messages ?? [];
}
