import { cfg } from './config.js';
import { parseUnits } from './units.js';

export const SLOTS = 12;
export const REF_HASH = 10_000;     // difficulty 1.00x = 10,000 GH/s on a rank network
export const FLOOR_HASH = 346; // a rank network never counts as smaller than this

// PLACEHOLDER numbers: calibrate with an economy simulation before launch.
// emission = MINE shared by the whole rank per block; cap = daily withdrawal limit.
export const RANKS = [
  { name: 'Rookie',    min: 0,    cap: parseUnits('1000'),  emission: parseUnits('12') },
  { name: 'Gladiator', min: 50,   cap: parseUnits('2500'),  emission: parseUnits('40') },
  { name: 'Champion',  min: 300,  cap: parseUnits('6000'),  emission: parseUnits('60') },
  { name: 'Legend',    min: 1000, cap: parseUnits('15000'), emission: parseUnits('150') },
] as const;

export function rankIndex(hash: number): number {
  for (let i = RANKS.length - 1; i >= 0; i--) if (hash >= RANKS[i].min) return i;
  return 0;
}

export function emissionAt(rank: number, height: bigint): bigint {
  const base = RANKS[rank].emission;
  if (cfg.HALVING_BLOCKS === 0) return base;
  const halvings = height / BigInt(cfg.HALVING_BLOCKS);
  return halvings >= 64n ? 0n : base >> halvings;
}
