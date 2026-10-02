import { toHex } from "viem";
import { NOBLE, formatRecipient, route } from "./chains";
import { normalizeHash } from "./iris";

// Noble's globalfee minimum for uusdc.
export const GAS_PRICE_UUSDC = 0.1;
const RANGE = "https://usdc.range.org/usdc";

export interface NobleBurn {
  hash: string;
  dst: number;
  from: string;
  amount: string;
  recipient: string;
  timestamp: number;
  failed: boolean;
}

function parseBurn(txResponse: any, tx: any): NobleBurn | null {
  const msg = tx.body.messages.find((m: any) => m["@type"] === "/circle.cctp.v1.MsgDepositForBurn");
  if (!msg || !route(NOBLE.domain, msg.destination_domain)) return null;
  const recipientBytes = Uint8Array.from(atob(msg.mint_recipient), (c) => c.charCodeAt(0));
  return {
    hash: txResponse.txhash,
    dst: msg.destination_domain,
    from: msg.from,
    amount: msg.amount,
    recipient: formatRecipient(msg.destination_domain, toHex(recipientBytes)),
    timestamp: Date.parse(txResponse.timestamp),
    failed: txResponse.code !== 0,
  };
}

// Returns undefined while the tx is not yet included, and null if it is not a burn to a supported chain.
export async function fetchNobleBurn(hash: string): Promise<NobleBurn | null | undefined> {
  const res = await fetch(`${NOBLE.rest}/cosmos/tx/v1beta1/txs/${normalizeHash(NOBLE.domain, hash)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Noble REST returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.tx_response.code !== 0) {
    return { hash: json.tx_response.txhash, dst: -1, from: "", amount: "0", recipient: "", timestamp: 0, failed: true };
  }
  return parseBurn(json.tx_response, json.tx);
}

export async function listNobleBurns(sender: string, limit = 20): Promise<NobleBurn[]> {
  const query = encodeURIComponent(`message.sender='${sender}' AND message.action='/circle.cctp.v1.MsgDepositForBurn'`);
  const res = await fetch(`${NOBLE.rest}/cosmos/tx/v1beta1/txs?query=${query}&limit=${limit}&order_by=2`);
  if (!res.ok) throw new Error(`Noble REST returned HTTP ${res.status}`);
  const json = await res.json();
  return (json.tx_responses ?? [])
    .map((r: any, i: number) => parseBurn(r, json.txs[i]))
    .filter((b: NobleBurn | null): b is NobleBurn => !!b && !b.failed);
}

export async function fetchBurnLimit(): Promise<bigint> {
  const json = await (await fetch(`${NOBLE.rest}/circle/cctp/v1/per_message_burn_limits`)).json();
  return BigInt(json.burn_limits.find((l: any) => l.denom === "uusdc")?.amount ?? 0);
}

export async function fetchCctpPaused(): Promise<boolean> {
  const json = await (await fetch(`${NOBLE.rest}/circle/cctp/v1/burning_and_minting_paused`)).json();
  return json.paused.paused;
}

// Range identifies a Noble CCTP transfer by base64url("noble-1/<nonce>").
const rangeId = (nonce: string) => btoa(`${NOBLE.chainId}/${nonce}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const rangeUrl = (nonce: string) => `${RANGE}/status?id=${rangeId(nonce)}`;

export async function fetchRangeMintTx(nonce: string): Promise<string | undefined> {
  const json = await (await fetch(`${RANGE}/api/status?id=${rangeId(nonce)}`)).json();
  return json.payment?.receiver_tx_hash || undefined;
}
