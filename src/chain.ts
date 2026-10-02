import { createPublicClient, encodePacked, fallback, getAddress, http, keccak256, toHex, type Hex, type PublicClient } from "viem";

export const NOBLE = {
  chainId: "noble-1",
  rpc: "https://rpc-noble.keplr.app",
  rest: "https://lcd-noble.keplr.app",
  domain: 4,
};

export interface Destination {
  domain: number;
  name: string;
  chainId: number;
  gasSymbol: string;
  rpcs: string[];
  messageTransmitter: Hex; // CCTP V1
  explorer: string;
}

// The EVM domains Noble has a remote token messenger for. Each transmitter was checked on-chain
// to report this localDomain and version 0 (V1).
export const DESTINATIONS: Destination[] = [
  { domain: 1, name: "Avalanche", chainId: 43114, gasSymbol: "AVAX", rpcs: ["https://api.avax.network/ext/bc/C/rpc"], messageTransmitter: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880", explorer: "https://snowtrace.io" },
  { domain: 0, name: "Ethereum", chainId: 1, gasSymbol: "ETH", rpcs: ["https://ethereum-rpc.publicnode.com"], messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81", explorer: "https://etherscan.io" },
  { domain: 2, name: "OP Mainnet", chainId: 10, gasSymbol: "ETH", rpcs: ["https://mainnet.optimism.io"], messageTransmitter: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8", explorer: "https://optimistic.etherscan.io" },
  { domain: 3, name: "Arbitrum", chainId: 42161, gasSymbol: "ETH", rpcs: ["https://arb1.arbitrum.io/rpc"], messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca", explorer: "https://arbiscan.io" },
  { domain: 6, name: "Base", chainId: 8453, gasSymbol: "ETH", rpcs: ["https://mainnet.base.org"], messageTransmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4", explorer: "https://basescan.org" },
  { domain: 7, name: "Polygon PoS", chainId: 137, gasSymbol: "POL", rpcs: ["https://polygon.drpc.org", "https://1rpc.io/matic"], messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9", explorer: "https://polygonscan.com" },
  { domain: 10, name: "Unichain", chainId: 130, gasSymbol: "ETH", rpcs: ["https://mainnet.unichain.org"], messageTransmitter: "0x353bE9E2E38AB1D19104534e4edC21c643Df86f4", explorer: "https://uniscan.xyz" },
];

export function destination(domain: number): Destination {
  const d = DESTINATIONS.find((x) => x.domain === domain);
  if (!d) throw new Error(`Unsupported destination domain ${domain}`);
  return d;
}

const clients = new Map<number, PublicClient>();
export function publicClient(domain: number): PublicClient {
  let c = clients.get(domain);
  if (!c) {
    c = createPublicClient({ transport: fallback(destination(domain).rpcs.map((url) => http(url))) });
    clients.set(domain, c);
  }
  return c;
}

// Noble's globalfee minimum for uusdc.
export const GAS_PRICE_UUSDC = 0.1;
const IRIS = "https://iris-api.circle.com";
const RANGE = "https://usdc.range.org/usdc";

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
  domain: number;
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
  if (!msg || !DESTINATIONS.some((d) => d.domain === msg.destination_domain)) return null;
  const recipientBytes = Uint8Array.from(atob(msg.mint_recipient), (c) => c.charCodeAt(0));
  return {
    hash: txResponse.txhash,
    domain: msg.destination_domain,
    from: msg.from,
    amount: msg.amount,
    recipient: getAddress(toHex(recipientBytes.slice(12))),
    timestamp: Date.parse(txResponse.timestamp),
    failed: txResponse.code !== 0,
  };
}

// Returns undefined while the tx is not yet included, and null if it is not a burn to a supported EVM chain.
export async function fetchNobleBurn(hash: string): Promise<NobleBurn | null | undefined> {
  const res = await fetch(`${NOBLE.rest}/cosmos/tx/v1beta1/txs/${normalizeHash(hash)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Noble REST returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.tx_response.code !== 0) {
    return { hash: json.tx_response.txhash, domain: -1, from: "", amount: "0", recipient: "", timestamp: 0, failed: true };
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

export async function isMinted(domain: number, nonce: string): Promise<boolean> {
  const key = keccak256(encodePacked(["uint32", "uint64"], [NOBLE.domain, BigInt(nonce)]));
  const used = await publicClient(domain).readContract({
    address: destination(domain).messageTransmitter,
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
export const explorerTxUrl = (domain: number, hash: string) => `${destination(domain).explorer}/tx/${hash}`;
export const explorerAddressUrl = (domain: number, address: string) => `${destination(domain).explorer}/address/${address}`;
