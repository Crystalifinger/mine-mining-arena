import 'dotenv/config';
import { z } from 'zod';
import { parseUnits } from './units.js';

const dec = (d: string) => z.string().regex(/^\d+(\.\d{1,9})?$/).default(d);
const int = (d: number) => z.coerce.number().int().min(0).default(d);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(2).default(10),
  JWT_SECRET: z.string().min(32),
  ADMIN_TOKEN: z.string().min(24),
  CORS_ORIGIN: z.string().default('*'),
  WEBAPP_URL: z.string().default('https://example.com'),

  BOT_TOKEN: z.string().min(10),
  ADMIN_CHAT_ID: z.string().optional(),
  DEV_LOGIN: z.enum(['true', 'false']).default('false'),

  TON_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  TONCENTER_API_KEY: z.string().optional(),
  HOT_WALLET_ADDRESS: z.string().min(10),
  HOT_WALLET_MNEMONIC: z.string().optional(),
  HOT_WALLET_VERSION: z.enum(['v4', 'v5']).default('v5'),
  MINE_JETTON_MASTER: z.string().min(10),
  MINE_DECIMALS: z.coerce.number().int().min(0).max(18).default(9),

  BLOCK_SECONDS: z.coerce.number().int().min(10).default(600),
  HALVING_BLOCKS: int(210240),
  MINING_POOL_TOTAL: dec('0'),
  CLAIM_MIN: dec('0.001'),

  STORE_MINE_BURN_PCT: z.coerce.number().min(0).max(100).default(50),
  MARKET_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(100),
  MARKET_FEE_BURN_PCT: z.coerce.number().min(0).max(100).default(50),
  MARKET_MIN_PRICE: dec('1'),
  MARKET_MAX_PRICE: dec('1000000'),
  MARKET_MAX_LISTINGS: int(20),
  MAX_MINERS_PER_USER: int(200),

  DEPOSIT_MIN_TON: dec('0.1'),
  DEPOSIT_MIN_MINE: dec('1'),
  DEPOSIT_CONFIRM_SECONDS: int(20),

  SUPPORT_CHANNEL: z.string().optional(),
  CHANNEL_TASK_REWARD: dec('20'),
  TASK_POOL_TOTAL: dec('0'),
  LINK_TASK_MIN_SECONDS: int(15),
  // sponsored tasks (users promote their own channel)
  USER_TASK_COST_PER_JOIN: dec('50'),      // what the advertiser pays per new member
  USER_TASK_JOINER_REWARD: dec('35'),      // what the new member receives (the rest is the platform fee)
  USER_TASK_MIN_BUDGET: dec('100'),
  USER_TASK_MAX_BUDGET: dec('1000'),
  USER_TASK_MAX_ACTIVE: int(3),
  USER_TASK_AUTO_APPROVE: z.enum(['true', 'false']).default('false'),

  WITHDRAW_MIN: dec('100'),
  WITHDRAW_AUTO_LIMIT: dec('500'),
  WITHDRAW_FEE: dec('70'),
  WITHDRAW_MIN_ACCOUNT_AGE_HOURS: int(24),
  WITHDRAW_GLOBAL_DAILY_CAP: dec('50000'),
  WITHDRAW_GAS_TON: dec('0.06'),
});

export const cfg = schema.parse(process.env);

export const U = {
  claimMin: parseUnits(cfg.CLAIM_MIN),
  taskPool: parseUnits(cfg.TASK_POOL_TOTAL),
  utCost: parseUnits(cfg.USER_TASK_COST_PER_JOIN),
  utReward: parseUnits(cfg.USER_TASK_JOINER_REWARD),
  utMin: parseUnits(cfg.USER_TASK_MIN_BUDGET),
  utMax: parseUnits(cfg.USER_TASK_MAX_BUDGET),
  channelReward: parseUnits(cfg.CHANNEL_TASK_REWARD),
  miningPool: parseUnits(cfg.MINING_POOL_TOTAL),
  marketMin: parseUnits(cfg.MARKET_MIN_PRICE),
  marketMax: parseUnits(cfg.MARKET_MAX_PRICE),
  depositMinTon: parseUnits(cfg.DEPOSIT_MIN_TON),
  depositMinMine: parseUnits(cfg.DEPOSIT_MIN_MINE),
  withdrawMin: parseUnits(cfg.WITHDRAW_MIN),
  withdrawAuto: parseUnits(cfg.WITHDRAW_AUTO_LIMIT),
  withdrawFee: parseUnits(cfg.WITHDRAW_FEE),
  withdrawGlobalCap: parseUnits(cfg.WITHDRAW_GLOBAL_DAILY_CAP),
  withdrawGas: parseUnits(cfg.WITHDRAW_GAS_TON), // nanoTON, same 9 decimals
};

export const TONCENTER_V3 =
  cfg.TON_NETWORK === 'mainnet' ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3';
export const TONCENTER_V2 =
  cfg.TON_NETWORK === 'mainnet' ? 'https://toncenter.com/api/v2/jsonRPC' : 'https://testnet.toncenter.com/api/v2/jsonRPC';

if (U.utReward > U.utCost) throw new Error('USER_TASK_JOINER_REWARD cannot be higher than USER_TASK_COST_PER_JOIN');
