import { PublicKey } from "@solana/web3.js";
import { createPublicClient, defineChain, fallback, getAddress, hexToBytes, http, pad, type Chain as ViemChain, type Hex, type PublicClient } from "viem";
import {
  arbitrum, arc, avalanche, base, codex, cronos, hyperEvm, injective, ink, linea, mainnet, monad, morph,
  optimism, plasma, plumeMainnet, polygon, sei, sonic, unichain, worldchain, xLayer, xdc,
} from "viem/chains";

const edge = defineChain({
  id: 3343,
  name: "EDGE",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://edge-mainnet.g.alchemy.com/public"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://edge-mainnet.explorer.alchemy.com" } },
});

const pharos = defineChain({
  id: 1672,
  name: "Pharos",
  nativeCurrency: { name: "Pharos", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.pharos.xyz"] } },
  blockExplorers: { default: { name: "Pharosscan", url: "https://pharosscan.xyz" } },
});

export type Version = 1 | 2;

export interface NobleChain {
  kind: "noble";
  domain: 4;
  name: string;
  chainId: string;
  rpc: string;
  rest: string;
}

export interface EvmChain {
  kind: "evm";
  domain: number;
  name: string;
  chain: ViemChain;
  usdc: Hex;
  tokenMessengerV2: Hex;
  messageTransmitterV2: Hex;
  // Only needed to mint Noble burns, which are V1.
  messageTransmitterV1?: Hex;
}

export interface SolanaChain {
  kind: "solana";
  domain: 5;
  name: string;
}

export type CctpChain = NobleChain | EvmChain | SolanaChain;

export const NOBLE: NobleChain = {
  kind: "noble",
  domain: 4,
  name: "Noble",
  chainId: "noble-1",
  rpc: "https://rpc-noble.keplr.app",
  rest: "https://lcd-noble.keplr.app",
};

export const SOLANA: SolanaChain = { kind: "solana", domain: 5, name: "Solana" };

const TM_V2: Hex = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const MT_V2: Hex = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

const evm = (domain: number, chain: ViemChain, usdc: Hex, extra: Partial<EvmChain> = {}): EvmChain => ({
  kind: "evm",
  domain,
  name: chain.name.replace(/ (One|Mainnet|Network)$/, ""),
  chain,
  usdc,
  tokenMessengerV2: TM_V2,
  messageTransmitterV2: MT_V2,
  ...extra,
});

// Every address was checked on-chain: the V2 transmitter reports this domain, and the USDC is what the
// V2 TokenMinter maps Ethereum USDC to. BNB Smart Chain (17) has V2 contracts but no USDC mapping, so it
// is left out. V1 transmitters report the domain and version 0.
// publicnode refuses older receipts without a token, and viem's fallback does not move past that error,
// so it is only ever a last resort.
export const EVM_CHAINS: EvmChain[] = [
  evm(0, { ...mainnet, rpcUrls: { default: { http: [...mainnet.rpcUrls.default.http, "https://eth.drpc.org", "https://ethereum-rpc.publicnode.com"] } } }, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", { messageTransmitterV1: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81" }),
  evm(1, avalanche, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", { messageTransmitterV1: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880" }),
  evm(2, optimism, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", { name: "OP Mainnet", messageTransmitterV1: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8" }),
  evm(3, arbitrum, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", { messageTransmitterV1: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca" }),
  evm(6, { ...base, rpcUrls: { default: { http: [...base.rpcUrls.default.http, "https://base.drpc.org"] } } }, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", { messageTransmitterV1: "0xAD09780d193884d503182aD4588450C416D6F9D4" }),
  evm(7, { ...polygon, rpcUrls: { default: { http: ["https://polygon.drpc.org", "https://1rpc.io/matic"] } } }, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", { name: "Polygon PoS", messageTransmitterV1: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9" }),
  evm(10, unichain, "0x078D782b760474a361dDA0AF3839290b0EF57AD6", { messageTransmitterV1: "0x353bE9E2E38AB1D19104534e4edC21c643Df86f4" }),
  evm(11, linea, "0x176211869cA2b568f2A7D4EE941E073a821EE1ff"),
  evm(12, codex, "0xd996633a415985DBd7D6D12f4A4343E31f5037cf"),
  evm(13, sonic, "0x29219dd400f2Bf60E5a23d13Be72B486D4038894"),
  evm(14, worldchain, "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1"),
  evm(15, monad, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
  evm(16, sei, "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"),
  evm(18, xdc, "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1"),
  evm(19, hyperEvm, "0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
  evm(21, ink, "0x2D270e6886d130D724215A266106e6832161EAEd"),
  evm(22, plumeMainnet, "0x222365EF19F7947e5484218551B56bb3965Aa7aF"),
  evm(26, arc, "0x3600000000000000000000000000000000000000"),
  evm(28, edge, "0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c", {
    tokenMessengerV2: "0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c",
    messageTransmitterV2: "0x5b61381Fc9e58E70EfC13a4A97516997019198ee",
  }),
  evm(29, injective, "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a"),
  evm(30, morph, "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B"),
  evm(31, pharos, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815"),
  evm(32, cronos, "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D"),
  evm(33, plasma, "0x2d661C89D812261039AF9764eceaAee884f5F67F"),
  evm(37, xLayer, "0xB6CEceAB302E2E4948951eE7843FC24E92933061"),
];

export const CHAINS: CctpChain[] = [NOBLE, SOLANA, ...EVM_CHAINS];

export function chain(domain: number): CctpChain {
  const c = CHAINS.find((x) => x.domain === domain);
  if (!c) throw new Error(`Unsupported CCTP domain ${domain}`);
  return c;
}

export function evmChain(domain: number): EvmChain {
  const c = chain(domain);
  if (c.kind !== "evm") throw new Error(`${c.name} is not an EVM chain`);
  return c;
}

// Noble only speaks V1, and Circle has already removed Noble from every V1 TokenMessenger, so Noble can
// send but not receive. Every other pair of chains goes over V2.
export function route(src: number, dst: number): Version | undefined {
  if (src === dst || dst === NOBLE.domain) return undefined;
  if (src === NOBLE.domain) {
    const d = chain(dst);
    return d.kind === "solana" || (d.kind === "evm" && d.messageTransmitterV1) ? 1 : undefined;
  }
  return 2;
}

// Renders a CCTP mint recipient (hex, 20 or 32 bytes) the way the destination chain writes addresses.
// Solana recipients are USDC token accounts, not wallets.
export function formatRecipient(dst: number, recipient: string): string {
  if (!recipient.startsWith("0x")) return recipient;
  return chain(dst).kind === "solana" ? new PublicKey(hexToBytes(pad(recipient as Hex, { size: 32 }))).toBase58() : getAddress(`0x${recipient.slice(-40)}`);
}

const clients = new Map<number, PublicClient>();
export function publicClient(domain: number): PublicClient {
  let c = clients.get(domain);
  if (!c) {
    const { chain: vc } = evmChain(domain);
    c = createPublicClient({ chain: vc, transport: fallback(vc.rpcUrls.default.http.map((url) => http(url))) });
    clients.set(domain, c);
  }
  return c;
}

export function gasSymbol(domain: number) {
  const c = chain(domain);
  return c.kind === "evm" ? c.chain.nativeCurrency.symbol : c.kind === "solana" ? "SOL" : "USDC";
}

export function txUrl(domain: number, hash: string) {
  const c = chain(domain);
  if (c.kind === "noble") return `https://www.mintscan.io/noble/tx/${hash}`;
  if (c.kind === "solana") return `https://solscan.io/tx/${hash}`;
  return `${c.chain.blockExplorers!.default.url}/tx/${hash}`;
}

export function addressUrl(domain: number, address: string) {
  const c = chain(domain);
  if (c.kind === "noble") return `https://www.mintscan.io/noble/address/${address}`;
  if (c.kind === "solana") return `https://solscan.io/account/${address}`;
  return `${c.chain.blockExplorers!.default.url}/address/${address}`;
}
