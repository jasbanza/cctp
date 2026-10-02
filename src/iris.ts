import type { Hex } from "viem";
import { NOBLE, chain, formatRecipient, type Version } from "./chains";

const IRIS = "https://iris-api.circle.com";

// Iris matches hashes exactly: Noble's are uppercase without 0x, EVM's are lowercase with 0x, and
// Solana's are base58 signatures as-is.
export function normalizeHash(domain: number, hash: string) {
  const trimmed = hash.trim();
  if (chain(domain).kind === "solana") return trimmed;
  const bare = trimmed.replace(/^0x/i, "");
  return domain === NOBLE.domain ? bare.toUpperCase() : `0x${bare.toLowerCase()}`;
}

export interface IrisMessage {
  version: Version;
  dst: number;
  sender: string;
  recipient: string;
  amount: string;
  fee?: string; // V2 fee actually charged, deducted from the amount
  nonce: string;
  message: Hex;
  attestation?: Hex; // undefined while pending
}

// Returns undefined until Iris has indexed the burn. Works for V1 and V2 burns alike.
export async function fetchMessage(src: number, hash: string): Promise<IrisMessage | undefined> {
  const res = await fetch(`${IRIS}/v2/messages/${src}?transactionHash=${normalizeHash(src, hash)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Iris returned HTTP ${res.status}`);
  const m = (await res.json()).messages?.[0];
  if (!m?.decodedMessage) return undefined;
  const body = m.decodedMessage.decodedMessageBody;
  const dst = Number(m.decodedMessage.destinationDomain);
  return {
    version: m.cctpVersion,
    dst,
    sender: body.messageSender,
    recipient: formatRecipient(dst, body.mintRecipient),
    amount: body.amount,
    fee: body.feeExecuted,
    nonce: m.eventNonce,
    message: m.message,
    attestation: m.status === "complete" && m.attestation !== "PENDING" ? m.attestation : undefined,
  };
}

export interface FeeQuote {
  fastBps: number;
  standardBps: number;
}

export async function fetchFees(src: number, dst: number): Promise<FeeQuote> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${src}/${dst}`);
  if (!res.ok) throw new Error(`Iris fee quote returned HTTP ${res.status}`);
  const quotes: { finalityThreshold: number; minimumFee: number }[] = await res.json();
  const bps = (threshold: number) => quotes.find((q) => q.finalityThreshold === threshold)?.minimumFee ?? 0;
  return { fastBps: bps(1000), standardBps: bps(2000) };
}

// Fees are quoted in (possibly fractional) basis points of the amount; Iris charges the ceiling.
export const feeFor = (amount: bigint, bps: number) => (amount * BigInt(Math.round(bps * 100)) + 999_999n) / 1_000_000n;
