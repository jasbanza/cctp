import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { Buffer } from "buffer";
import { hexToBytes, type Hex } from "viem";
import type { Version } from "./chains";

export const connection = new Connection("https://solana-rpc.publicnode.com", "confirmed");

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MESSAGE_TRANSMITTER = { 1: new PublicKey("CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd"), 2: new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC") };
const TOKEN_MESSENGER_MINTER = { 1: new PublicKey("CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3"), 2: new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe") };

// Anchor instruction discriminators, from Circle's IDLs in circlefin/solana-cctp-contracts.
const RECEIVE_MESSAGE = [38, 144, 127, 225, 31, 225, 238, 25];
const DEPOSIT_FOR_BURN = [215, 60, 61, 46, 114, 55, 128, 176];

const utf8 = new TextEncoder();
const pda = (program: PublicKey, ...seeds: (string | Uint8Array | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? utf8.encode(s) : s instanceof PublicKey ? s.toBytes() : s)), program)[0];

export const usdcAccount = (owner: PublicKey) => pda(ATA_PROGRAM, owner, TOKEN_PROGRAM, USDC);

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });

class Writer {
  bytes: number[] = [];
  raw(b: ArrayLike<number>) {
    this.bytes.push(...Array.from(b));
    return this;
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.raw(b);
  }
  u64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.raw(b);
  }
  vec(b: Uint8Array) {
    return this.u32(b.length).raw(b);
  }
  done() {
    return Buffer.from(this.bytes);
  }
}

// ---------- wallets ----------

export interface SolanaWallet {
  id: string;
  name: string;
  wallet: Wallet;
}

const isSolanaWallet = (w: Wallet) =>
  w.chains.some((c) => c.startsWith("solana:")) && "standard:connect" in w.features && "solana:signTransaction" in w.features;

export function solanaWallets(): SolanaWallet[] {
  return getWallets().get().filter(isSolanaWallet).map((wallet) => ({ id: wallet.name, name: wallet.name, wallet }));
}

export function onSolanaWallets(onChange: () => void) {
  getWallets().on("register", onChange);
}

export async function connectSolana(w: SolanaWallet): Promise<WalletAccount> {
  const { accounts } = await (w.wallet.features["standard:connect"] as any).connect();
  if (!accounts.length) throw new Error(`${w.name} returned no Solana account`);
  return accounts[0];
}

// The wallet signs first, so any instructions it adds are covered, then the extra signers sign the same message.
export async function signAndSend(w: SolanaWallet, account: WalletAccount, instructions: TransactionInstruction[], extraSigners: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = new PublicKey(account.publicKey);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const [{ signedTransaction }] = await (w.wallet.features["solana:signTransaction"] as any).signTransaction({
    account,
    chain: "solana:mainnet",
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  });
  const signed = Transaction.from(signedTransaction);
  for (const kp of extraSigners) signed.partialSign(kp);
  return connection.sendRawTransaction(signed.serialize());
}

// Returns undefined while the transaction is unknown, true once confirmed, false if it failed.
export async function txStatus(signature: string): Promise<boolean | undefined> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];
  if (!status) return undefined;
  if (status.err) return false;
  return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? true : undefined;
}

export async function txTime(signature: string): Promise<number> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const time = value[0] ? await connection.getBlockTime(value[0].slot) : null;
  return time ? time * 1000 : Date.now();
}

export async function balances(owner: PublicKey): Promise<{ usdc: bigint; lamports: bigint }> {
  // Token accounts store the amount as a u64 at offset 64. (publicnode refuses getTokenAccountBalance.)
  const [lamports, account] = await Promise.all([connection.getBalance(owner), connection.getAccountInfo(usdcAccount(owner))]);
  const usdc = account ? new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(64, true) : 0n;
  return { usdc, lamports: BigInt(lamports) };
}

// ---------- burn (V2 only: Solana can send to EVM chains, and Noble no longer receives) ----------

export function depositForBurn(owner: PublicKey, amount: bigint, dst: number, mintRecipient: Uint8Array, maxFee: bigint, minFinalityThreshold: number) {
  const mt = MESSAGE_TRANSMITTER[2];
  const tmm = TOKEN_MESSENGER_MINTER[2];
  const eventData = Keypair.generate();
  const data = new Writer()
    .raw(DEPOSIT_FOR_BURN)
    .u64(amount)
    .u32(dst)
    .raw(mintRecipient)
    .raw(new Uint8Array(32)) // destination caller: anyone
    .u64(maxFee)
    .u32(minFinalityThreshold)
    .done();
  const ix = new TransactionInstruction({
    programId: tmm,
    data,
    keys: [
      meta(owner, false, true),
      meta(owner, true, true), // event rent payer
      meta(pda(tmm, "sender_authority")),
      meta(usdcAccount(owner), true),
      meta(pda(tmm, "denylist_account", owner)),
      meta(pda(mt, "message_transmitter"), true),
      meta(pda(tmm, "token_messenger")),
      meta(pda(tmm, "remote_token_messenger", String(dst))),
      meta(pda(tmm, "token_minter")),
      meta(pda(tmm, "local_token", USDC), true),
      meta(USDC, true),
      meta(eventData.publicKey, true, true),
      meta(mt),
      meta(tmm),
      meta(TOKEN_PROGRAM),
      meta(SystemProgram.programId),
      meta(pda(tmm, "__event_authority")),
      meta(tmm),
    ],
  });
  return { ix, eventData };
}

// Every V2 burn passes the sender's denylist PDA, which nothing else touches, so its signatures are
// exactly the owner's burns.
export async function findBurnSignatures(owner: PublicKey, limit = 20): Promise<{ signature: string; time: number }[]> {
  const sigs = await connection.getSignaturesForAddress(pda(TOKEN_MESSENGER_MINTER[2], "denylist_account", owner), { limit });
  return sigs.filter((s) => !s.err).map((s) => ({ signature: s.signature, time: (s.blockTime ?? 0) * 1000 }));
}

// ---------- mint ----------

interface Parsed {
  src: number;
  usedNonce: PublicKey;
  burnToken: Uint8Array;
  recipient: PublicKey;
  nonceV1: bigint;
}

// Header sizes: V1 is 116 bytes with a u64 nonce at 12; V2 is 148 bytes with a bytes32 nonce at 12.
// The burn message body starts with a u32 version, then burnToken and mintRecipient as bytes32.
function parse(version: Version, message: Hex): Parsed {
  const msg = hexToBytes(message);
  const view = new DataView(msg.buffer, msg.byteOffset);
  const src = view.getUint32(4);
  const body = msg.slice(version === 1 ? 116 : 148);
  const nonceV1 = version === 1 ? view.getBigUint64(12) : 0n;
  let usedNonce: PublicKey;
  if (version === 1) {
    // UsedNonces accounts hold bitmaps of 6400 nonces; domains >= 11 get a "-" in the seed.
    const first = ((nonceV1 - 1n) / 6400n) * 6400n + 1n;
    usedNonce = pda(MESSAGE_TRANSMITTER[1], "used_nonces", String(src), src >= 11 ? "-" : "", String(first));
  } else {
    usedNonce = pda(MESSAGE_TRANSMITTER[2], "used_nonce", msg.slice(12, 44));
  }
  return { src, usedNonce, burnToken: body.slice(4, 36), recipient: new PublicKey(body.slice(36, 68)), nonceV1 };
}

export async function isMinted(version: Version, message: Hex): Promise<boolean> {
  const p = parse(version, message);
  const info = await connection.getAccountInfo(p.usedNonce);
  if (!info) return false;
  if (version === 2) return info.data[8] === 1;
  // UsedNonces: discriminator(8), remote_domain u32, first_nonce u64, then [u64; 100] little-endian bitmap.
  const view = new DataView(info.data.buffer, info.data.byteOffset);
  const first = view.getBigUint64(12, true);
  const position = Number(p.nonceV1 - first);
  const word = view.getBigUint64(20 + Math.floor(position / 64) * 8, true);
  return ((word >> BigInt(position % 64)) & 1n) === 1n;
}

export const recipientAccount = (version: Version, message: Hex) => parse(version, message).recipient;

export async function accountExists(address: PublicKey) {
  return (await connection.getAccountInfo(address)) !== null;
}

export function createUsdcAccount(payer: PublicKey, owner: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]), // CreateIdempotent
    keys: [meta(payer, true, true), meta(usdcAccount(owner), true), meta(owner), meta(USDC), meta(SystemProgram.programId), meta(TOKEN_PROGRAM)],
  });
}

export async function receiveMessage(payer: PublicKey, version: Version, message: Hex, attestation: Hex): Promise<TransactionInstruction> {
  const p = parse(version, message);
  const mt = MESSAGE_TRANSMITTER[version];
  const tmm = TOKEN_MESSENGER_MINTER[version];
  const tokenMessenger = pda(tmm, "token_messenger");
  const remaining = [
    meta(tokenMessenger),
    meta(pda(tmm, "remote_token_messenger", String(p.src))),
    meta(pda(tmm, "token_minter"), true),
    meta(pda(tmm, "local_token", USDC), true),
    meta(pda(tmm, "token_pair", String(p.src), p.burnToken)),
  ];
  if (version === 2) {
    // TokenMessenger V2: discriminator(8), denylister, owner, pending_owner (32 each), message_body_version u32, authority_bump u8, fee_recipient.
    const info = await connection.getAccountInfo(tokenMessenger);
    if (!info) throw new Error("Solana TokenMessenger V2 account not found");
    remaining.push(meta(usdcAccount(new PublicKey(info.data.subarray(109, 141))), true));
  }
  remaining.push(
    meta(p.recipient, true),
    meta(pda(tmm, "custody", USDC), true),
    meta(TOKEN_PROGRAM),
    meta(pda(tmm, "__event_authority")),
    meta(tmm),
  );
  return new TransactionInstruction({
    programId: mt,
    data: new Writer().raw(RECEIVE_MESSAGE).vec(hexToBytes(message)).vec(hexToBytes(attestation)).done(),
    keys: [
      meta(payer, true, true),
      meta(payer, false, true), // caller
      meta(pda(mt, "message_transmitter_authority", tmm)),
      meta(pda(mt, "message_transmitter")),
      meta(p.usedNonce, true),
      meta(tmm),
      meta(SystemProgram.programId),
      meta(pda(mt, "__event_authority")),
      meta(mt),
      ...remaining,
    ],
  });
}
