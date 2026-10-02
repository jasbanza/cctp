import { Registry } from "@cosmjs/proto-signing";
import { GasPrice, SigningStargateClient, defaultRegistryTypes } from "@cosmjs/stargate";
import type { Keplr } from "@keplr-wallet/types";
import { encodeFunctionData, isAddress, pad, type Hex } from "viem";
import { MsgDepositForBurn, MsgDepositForBurnTypeUrl } from "./cctpProto";

declare global {
  interface Window {
    keplr?: Keplr;
  }
}

const NOBLE_CHAIN_ID = "noble-1";
const NOBLE_RPC = "https://rpc-noble.keplr.app";
const NOBLE_DOMAIN = 4;
const AVALANCHE_DOMAIN = 1;
const AVALANCHE_CHAIN_ID = "0xa86a"; // 43114
const MESSAGE_TRANSMITTER_V1 = "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880";
const IRIS = "https://iris-api.circle.com";
const PENDING_KEY = "cctp:pendingBurn";

const receiveMessageAbi = [
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

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const log = (line: string) => {
  $("log").textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nobleAddress = "";
let evmAddress = "";
let client: SigningStargateClient | undefined;

function keplr(): Keplr {
  if (!window.keplr) throw new Error("Keplr extension not found");
  return window.keplr;
}

function evm<T = unknown>(method: string, params?: unknown[]): Promise<T> {
  return keplr().ethereum.request({ method, params }) as Promise<T>;
}

// Converts a decimal USDC string to micro-units without floating point.
function toMicroUsdc(input: string): string {
  const match = input.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) throw new Error("Amount must be a number with at most 6 decimals");
  const micro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micro <= 0n) throw new Error("Amount must be greater than zero");
  return micro.toString();
}

async function connect() {
  await keplr().enable(NOBLE_CHAIN_ID);
  const signer = keplr().getOfflineSigner(NOBLE_CHAIN_ID);
  nobleAddress = (await signer.getAccounts())[0].address;
  client = await SigningStargateClient.connectWithSigner(NOBLE_RPC, signer, {
    registry: new Registry([...defaultRegistryTypes, [MsgDepositForBurnTypeUrl, MsgDepositForBurn]]),
    gasPrice: GasPrice.fromString("0.1uusdc"),
  });

  await evm("wallet_switchEthereumChain", [{ chainId: AVALANCHE_CHAIN_ID }]);
  evmAddress = (await evm<string[]>("eth_requestAccounts"))[0];

  const usdc = await client.getBalance(nobleAddress, "uusdc");
  const avaxWei = BigInt(await evm<string>("eth_getBalance", [evmAddress, "latest"]));
  $("accounts").textContent =
    `Noble: ${nobleAddress} (${Number(usdc.amount) / 1e6} USDC)\n` +
    `Avalanche: ${evmAddress} (${Number(avaxWei) / 1e18} AVAX)`;
  if (!$("recipient").value) $("recipient").value = evmAddress;
  $("burn").removeAttribute("disabled");
  $("mint").removeAttribute("disabled");
  log("Connected");
}

async function burn() {
  if (!client) throw new Error("Connect first");
  const recipient = $("recipient").value.trim();
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid EVM address");
  const amount = toMicroUsdc($("amount").value);

  const msg = {
    typeUrl: MsgDepositForBurnTypeUrl,
    value: {
      from: nobleAddress,
      amount,
      destinationDomain: AVALANCHE_DOMAIN,
      mintRecipient: Uint8Array.from(
        pad(recipient as Hex, { size: 32 }).slice(2).match(/../g)!.map((b) => parseInt(b, 16)),
      ),
      burnToken: "uusdc",
    },
  };
  log(`Burning ${amount} uusdc for ${recipient}…`);
  const result = await client.signAndBroadcast(nobleAddress, [msg], "auto");
  if (result.code !== 0) throw new Error(`Burn failed (code ${result.code}): ${result.rawLog}`);

  localStorage.setItem(PENDING_KEY, result.transactionHash);
  $("txhash").value = result.transactionHash;
  log(`Burn tx: https://www.mintscan.io/noble/tx/${result.transactionHash}`);
  await attestAndMint();
}

async function fetchAttestation(txHash: string): Promise<{ message: Hex; attestation: Hex }> {
  const url = `${IRIS}/v1/messages/${NOBLE_DOMAIN}/0x${txHash.replace(/^0x/i, "").toLowerCase()}`;
  log("Waiting for Circle attestation…");
  for (;;) {
    const res = await fetch(url);
    if (res.ok) {
      const msg = (await res.json()).messages?.[0];
      if (msg && msg.attestation && msg.attestation !== "PENDING") return msg;
    } else if (res.status !== 404) {
      log(`Iris returned HTTP ${res.status}, retrying`);
    }
    await sleep(5000);
  }
}

async function attestAndMint() {
  const txHash = $("txhash").value.trim();
  if (!txHash) throw new Error("No Noble burn tx hash");
  if (!evmAddress) throw new Error("Connect first");

  const { message, attestation } = await fetchAttestation(txHash);
  log("Attestation received, minting on Avalanche…");

  await evm("wallet_switchEthereumChain", [{ chainId: AVALANCHE_CHAIN_ID }]);
  const data = encodeFunctionData({ abi: receiveMessageAbi, functionName: "receiveMessage", args: [message, attestation] });
  let mintHash: string;
  try {
    mintHash = await evm<string>("eth_sendTransaction", [{ from: evmAddress, to: MESSAGE_TRANSMITTER_V1, data }]);
  } catch (e) {
    if (String((e as Error).message).toLowerCase().includes("nonce already used")) {
      localStorage.removeItem(PENDING_KEY);
      log("This burn was already minted on Avalanche.");
      return;
    }
    throw e;
  }
  log(`Mint tx: https://snowtrace.io/tx/${mintHash}`);

  for (;;) {
    const receipt = await evm<{ status: string } | null>("eth_getTransactionReceipt", [mintHash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("Mint transaction reverted");
      localStorage.removeItem(PENDING_KEY);
      log("Done. USDC minted on Avalanche.");
      return;
    }
    await sleep(3000);
  }
}

function guard(fn: () => Promise<void>, button: string) {
  return async () => {
    $(button).setAttribute("disabled", "");
    try {
      await fn();
    } catch (e) {
      log(`Error: ${(e as Error).message ?? e}`);
    } finally {
      $(button).removeAttribute("disabled");
    }
  };
}

$("connect").addEventListener("click", guard(connect, "connect"));
$("burn").addEventListener("click", guard(burn, "burn"));
$("mint").addEventListener("click", guard(attestAndMint, "mint"));

const pending = localStorage.getItem(PENDING_KEY);
if (pending) {
  $("txhash").value = pending;
  log(`Unfinished transfer found (${pending}). Connect, then click "Wait for attestation and mint".`);
}
