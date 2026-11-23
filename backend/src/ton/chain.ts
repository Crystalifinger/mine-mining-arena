// Read-only chain access (no private key needed).
import { TonClient, JettonMaster, JettonWallet } from '@ton/ton';
import { Address } from '@ton/core';
import { cfg, TONCENTER_V2 } from '../config.js';

export const client = new TonClient({ endpoint: TONCENTER_V2, apiKey: cfg.TONCENTER_API_KEY });
export const hotAddress = () => Address.parse(cfg.HOT_WALLET_ADDRESS);
export const masterAddress = () => Address.parse(cfg.MINE_JETTON_MASTER);

export async function hotJettonWallet(): Promise<Address> {
  const master = client.open(JettonMaster.create(masterAddress()));
  return master.getWalletAddress(hotAddress());
}

/** Raw jetton balance of the hot wallet. */
export async function hotJettonBalance(): Promise<bigint> {
  const jw = client.open(JettonWallet.create(await hotJettonWallet()));
  return jw.getBalance();
}

export async function hotTonBalance(): Promise<bigint> {
  return client.getBalance(hotAddress());
}
