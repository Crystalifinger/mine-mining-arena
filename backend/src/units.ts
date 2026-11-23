// Internal amounts are BigInt "units" with 9 decimals for both MINE and TON.
export const ONE = 1_000_000_000n;

export function parseUnits(s: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('bad_amount');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * ONE + BigInt(f.padEnd(9, '0'));
}

export function formatUnits(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % ONE).toString().padStart(9, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / ONE).toString() + (frac ? '.' + frac : '');
}

/** internal units -> raw on-chain amount for a jetton with `decimals` */
export function toChain(units: bigint, decimals: number): bigint {
  if (decimals >= 9) return units * 10n ** BigInt(decimals - 9);
  const div = 10n ** BigInt(9 - decimals);
  if (units % div !== 0n) throw new Error('amount_not_representable');
  return units / div;
}

/** raw on-chain amount -> internal units (dust below 1e-9 is dropped) */
export function fromChain(raw: bigint, decimals: number): bigint {
  return decimals >= 9 ? raw / 10n ** BigInt(decimals - 9) : raw * 10n ** BigInt(9 - decimals);
}
