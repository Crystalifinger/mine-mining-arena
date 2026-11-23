// Signs and sends jetton transfers from the hot wallet. Needs HOT_WALLET_MNEMONIC (worker only).
import { WalletContractV4, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { Address } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { cfg, U } from '../config.js';
import { client, hotJettonWallet } from './chain.js';
import { jettonTransferBody } from './payload.js';

let ready: Promise<{ contract: any; secretKey: Buffer; address: Address; jettonWallet: Address }> | null = null;

function init() {
  if (!cfg.HOT_WALLET_MNEMONIC) throw new Error('HOT_WALLET_MNEMONIC is not set');
  return (async () => {
    const key = await mnemonicToPrivateKey(cfg.HOT_WALLET_MNEMONIC!.trim().split(/\s+/));
    const wallet: any = cfg.HOT_WALLET_VERSION === 'v4'
      ? WalletContractV4.create({ workchain: 0, publicKey: key.publicKey })
      : WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
    // safety: the key must belong to the wallet that receives deposits
    if (!wallet.address.equals(Address.parse(cfg.HOT_WALLET_ADDRESS))) {
      throw new Error('mnemonic does not match HOT_WALLET_ADDRESS (check HOT_WALLET_VERSION too)');
    }
    return { contract: client.open(wallet) as any, secretKey: key.secretKey, address: wallet.address as Address, jettonWallet: await hotJettonWallet() };
  })();
}

export async function verifySender() { ready ??= init(); await ready; }

/** Broadcasts one jetton transfer. `rawAmount` is in the jetton's own decimals. queryId = withdrawal id. */
export async function sendJetton(o: { to: string; rawAmount: bigint; queryId: bigint }): Promise<void> {
  ready ??= init();
  const { contract, secretKey, address, jettonWallet } = await ready;
  const seqno: number = await contract.getSeqno();
  await contract.sendTransfer({
    seqno,
    secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: jettonWallet,
        value: U.withdrawGas, // nanoTON attached for gas, the excess returns to the hot wallet
        bounce: true,
        body: jettonTransferBody({ queryId: o.queryId, amount: o.rawAmount, to: Address.parse(o.to), responseTo: address }),
      }),
    ],
  });
  // wait for the wallet seqno to move so two sends never share a seqno
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if ((await contract.getSeqno()) > seqno) return;
  }
  throw new Error('seqno did not advance, broadcast unconfirmed');
}
