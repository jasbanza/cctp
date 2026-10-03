import { encodePacked, keccak256, parseAbi, parseAbiItem, toHex, type EIP1193Provider, type Hex } from "viem";
import type { Keplr } from "@keplr-wallet/types";
import { evmChain, publicClient, type Version } from "./chains";

declare global {
  interface Window {
    keplr?: Keplr;
    ethereum?: EIP1193Provider;
  }
}

export interface EvmWallet {
  id: string;
  name: string;
  provider: EIP1193Provider;
}

const announced = new Map<string, EvmWallet>();

// EIP-6963: each installed wallet announces itself, so the user can pick one instead of whichever won window.ethereum.
export function discoverWallets(onChange: () => void) {
  window.addEventListener("eip6963:announceProvider", (ev) => {
    const { info, provider } = (ev as CustomEvent).detail;
    announced.set(info.rdns, { id: info.rdns, name: info.name, provider });
    onChange();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function evmWallets(): EvmWallet[] {
  const list = [...announced.values()];
  if (window.keplr?.ethereum && !list.some((w) => /keplr/i.test(w.name))) {
    list.push({ id: "keplr", name: "Keplr", provider: window.keplr.ethereum as unknown as EIP1193Provider });
  }
  if (!list.length && window.ethereum) list.push({ id: "injected", name: "Browser wallet", provider: window.ethereum });
  return list;
}

export async function switchChain(provider: EIP1193Provider, domain: number) {
  const { chain } = evmChain(domain);
  const chainId = toHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message ?? "")) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
      }],
    });
  }
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const depositForBurnV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

export const receiveMessageAbi = parseAbi(["function receiveMessage(bytes message, bytes attestation) returns (bool)"]);

const usedNoncesAbi = parseAbi(["function usedNonces(bytes32) view returns (uint256)"]);

export const FINALITY = { fast: 1000, standard: 2000 } as const;

export function messageTransmitter(dst: number, version: Version): Hex {
  const c = evmChain(dst);
  const address = version === 1 ? c.messageTransmitterV1 : c.messageTransmitterV2;
  if (!address) throw new Error(`${c.name} has no CCTP V${version} transmitter`);
  return address;
}

// V1 keys used nonces by keccak256(sourceDomain, nonce); V2 nonces are already unique bytes32 values.
export async function isMinted(src: number, dst: number, version: Version, nonce: string): Promise<boolean> {
  const key = version === 1 ? keccak256(encodePacked(["uint32", "uint64"], [src, BigInt(nonce)])) : (nonce as Hex);
  const used = await publicClient(dst).readContract({ address: messageTransmitter(dst, version), abi: usedNoncesAbi, functionName: "usedNonces", args: [key] });
  return used !== 0n;
}

const depositForBurnEvent = parseAbiItem(
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);

export interface EvmBurn {
  hash: Hex;
  dst: number;
  amount: bigint;
  mintRecipient: Hex;
  speed: "fast" | "standard";
  timestamp: number;
}

// Public RPCs have no index by sender and cap how many blocks one getLogs call may span, so this walks
// back from the head in chunks (halving the chunk when an RPC refuses it) for a fixed number of calls.
export async function findBurns(domain: number, depositor: Hex, maxCalls = 40): Promise<{ burns: EvmBurn[]; since: number }> {
  const client = publicClient(domain);
  const latest = await client.getBlockNumber();
  const found: Omit<EvmBurn, "timestamp">[] = [];
  const blocks = new Map<Hex, bigint>();
  let span = 10_000n;
  let to = latest;
  for (let calls = 0; calls < maxCalls && to > 0n && found.length < 20; ) {
    // Four ranges at a time, newest first.
    const ranges: [bigint, bigint][] = [];
    for (let end = to; ranges.length < 4 && end > 0n; ) {
      const start = end >= span ? end - span + 1n : 0n;
      ranges.push([start, end]);
      end = start - 1n;
    }
    calls += ranges.length;
    let results;
    try {
      results = await Promise.all(
        ranges.map(([fromBlock, toBlock]) => client.getLogs({ address: evmChain(domain).tokenMessengerV2, event: depositForBurnEvent, args: { depositor }, fromBlock, toBlock })),
      );
    } catch (e) {
      if (span <= 500n) throw e;
      span /= 2n;
      continue;
    }
    for (const l of results.flatMap((logs) => logs.reverse())) {
      blocks.set(l.transactionHash, l.blockNumber);
      found.push({
        hash: l.transactionHash,
        dst: l.args.destinationDomain!,
        amount: l.args.amount!,
        mintRecipient: l.args.mintRecipient!,
        speed: l.args.minFinalityThreshold! <= FINALITY.fast ? "fast" : "standard",
      });
    }
    to = ranges[ranges.length - 1][0] - 1n;
  }
  const times = new Map<bigint, number>();
  for (const n of new Set([...blocks.values(), to + 1n])) times.set(n, Number((await client.getBlock({ blockNumber: n })).timestamp) * 1000);
  return { burns: found.map((b) => ({ ...b, timestamp: times.get(blocks.get(b.hash)!)! })), since: times.get(to + 1n)! };
}

export const usdcBalance = (domain: number, owner: Hex) =>
  publicClient(domain).readContract({ address: evmChain(domain).usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
