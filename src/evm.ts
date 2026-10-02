import { encodePacked, keccak256, parseAbi, toHex, type EIP1193Provider, type Hex } from "viem";
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

export const usdcBalance = (domain: number, owner: Hex) =>
  publicClient(domain).readContract({ address: evmChain(domain).usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
