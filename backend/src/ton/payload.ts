import { Cell, beginCell, Address } from '@ton/core';

/** Reads a text comment (op 0) from a base64 BOC, with or without the Either bit in front. */
export function parseComment(b64?: string | null): string | null {
  if (!b64) return null;
  try {
    const cell = Cell.fromBase64(b64);
    // attempt 1: payload is the comment cell itself
    let s = cell.beginParse();
    if (s.remainingBits >= 32 && s.preloadUint(32) === 0) { s.loadUint(32); return s.loadStringTail(); }
    // attempt 2: Either bit first (0 = inline, 1 = in a reference)
    s = cell.beginParse();
    if (s.remainingBits >= 1) {
      const inRef = s.loadBit();
      const body = inRef ? s.loadRef().beginParse() : s;
      if (body.remainingBits >= 32 && body.loadUint(32) === 0) return body.loadStringTail();
    }
  } catch { /* not a text comment */ }
  return null;
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try { return Address.parse(a).equals(Address.parse(b)); } catch { return false; }
}

/** TEP-74 jetton transfer body */
export function jettonTransferBody(o: { queryId: bigint; amount: bigint; to: Address; responseTo: Address }) {
  return beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(o.queryId, 64)
    .storeCoins(o.amount)
    .storeAddress(o.to)
    .storeAddress(o.responseTo)
    .storeBit(false)       // no custom payload
    .storeCoins(0n)        // no forward TON
    .storeBit(false)       // no forward payload
    .endCell();
}
