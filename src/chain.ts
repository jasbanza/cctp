import { createPublicClient, encodePacked, getAddress, http, keccak256, toHex, type Hex } from "viem";
import { avalanche } from "viem/chains";

export const NOBLE = {
  chainId: "noble-1",
  rpc: "https://rpc-noble.keplr.app",
  rest: "https://lcd-noble.keplr.app",
  domain: 4,
};
export const AVALANCHE = {
  chainIdHex: "0xa86a", // 43114
  rpc: "https://api.avax.network/ext/bc/C/rpc",
  domain: 1,
  messageTransmitter: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880" as Hex, // CCTP V1
};
// Noble's globalfee minimum for uusdc.
export const GAS_PRICE_UUSDC = 0.1;
const IRIS = "https://iris-api.circle.com";
const RANGE = "https://usdc.range.org/usdc";

export const avalancheClient = createPublicClient({ chain: avalanche, transport: http(AVALANCHE.rpc) });

export const receiveMessageAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const usedNoncesAbi = [
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface NobleBurn {
  hash: string;
  from: string;
  amount: string;
  recipient: string;
  timestamp: number;
  failed: boolean;
}

export type Attestation =
  | { status: "pending" }
  | { status: "attested"; nonce: string; message: Hex; attestation: Hex };

const normalizeHash = (hash: string) => hash.trim().replace(/^0x/i, "").toUpperCase();

function parseBurn(txResponse: any, tx: any): NobleBurn | null {
  const msg = tx.body.messages.find((m: any) => m["@type"] === "/circle.cctp.v1.MsgDepositForBurn");
  if (!msg || msg.destination_domain !== AVALANCHE.domain) return null;
  const recipientBytes = Uint8Array.from(atob(msg.mint_recipient), (c) => c.charCodeAt(0));
  return {
    hash: txResponse.txhash,
    from: msg.from,
    amount: msg.amount,
    recipient: getAddress(toHex(recipientBytes.slice(12))),
    timestamp: Date.parse(txResponse.timestamp),
    failed: txResponse.code !== 0,
  };
}

// Returns undefined while the tx is not yet included, and null if it is not a Noble→Avalanche burn.
export async function fetchNobleBurn(hash: string): Promise<NobleBurn | null | undefined> {
  const res = await fetch(`${NOBLE.rest}/cosmos/tx/v1beta1/txs/${normalizeHash(hash)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Noble REST returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.tx_response.code !== 0) {
    return { hash: json.tx_response.txhash, from: "", amount: "0", recipient: "", timestamp: 0, failed: true };
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

// Iris only finds Noble burns by the uppercase hash without a 0x prefix.
export async function fetchAttestation(burnTx: string): Promise<Attestation> {
  const res = await fetch(`${IRIS}/v1/messages/${NOBLE.domain}/${normalizeHash(burnTx)}`);
  if (res.status === 404) return { status: "pending" };
  if (!res.ok) throw new Error(`Iris returned HTTP ${res.status}`);
  const msg = (await res.json()).messages?.[0];
  if (!msg || !msg.attestation || msg.attestation === "PENDING") return { status: "pending" };
  return { status: "attested", nonce: msg.eventNonce, message: msg.message, attestation: msg.attestation };
}

export async function isMinted(nonce: string): Promise<boolean> {
  const key = keccak256(encodePacked(["uint32", "uint64"], [NOBLE.domain, BigInt(nonce)]));
  const used = await avalancheClient.readContract({
    address: AVALANCHE.messageTransmitter,
    abi: usedNoncesAbi,
    functionName: "usedNonces",
    args: [key],
  });
  return used !== 0n;
}

// Range identifies a CCTP transfer by base64url("<source chain id>/<nonce>").
const rangeId = (nonce: string) => btoa(`${NOBLE.chainId}/${nonce}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const rangeUrl = (nonce: string) => `${RANGE}/status?id=${rangeId(nonce)}`;

export async function fetchRangeMintTx(nonce: string): Promise<string | undefined> {
  const json = await (await fetch(`${RANGE}/api/status?id=${rangeId(nonce)}`)).json();
  return json.payment?.receiver_tx_hash || undefined;
}

export const mintscanUrl = (hash: string) => `https://www.mintscan.io/noble/tx/${normalizeHash(hash)}`;
export const snowtraceUrl = (hash: string) => `https://snowtrace.io/tx/${hash}`;
export const snowtraceAddressUrl = (address: string) => `https://snowtrace.io/address/${address}`;
