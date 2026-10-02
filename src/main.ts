import { Registry } from "@cosmjs/proto-signing";
import { SigningStargateClient, defaultRegistryTypes, type StdFee } from "@cosmjs/stargate";
import type { Keplr } from "@keplr-wallet/types";
import { PublicKey } from "@solana/web3.js";
import type { WalletAccount } from "@wallet-standard/base";
import { encodeFunctionData, formatEther, formatUnits, isAddress, pad, toBytes, toHex, type EIP1193Provider, type Hex } from "viem";
import { MsgDepositForBurn, MsgDepositForBurnTypeUrl } from "./cctpProto";
import { CHAINS, NOBLE, SOLANA, addressUrl, chain, evmChain, gasSymbol, publicClient, route, txUrl, type Version } from "./chains";
import {
  FINALITY,
  depositForBurnV2Abi,
  discoverWallets,
  erc20Abi,
  evmWallets,
  isMinted as evmIsMinted,
  messageTransmitter,
  receiveMessageAbi,
  switchChain,
  usdcBalance,
} from "./evm";
import { feeFor, fetchFees, fetchMessage, normalizeHash, type FeeQuote } from "./iris";
import { GAS_PRICE_UUSDC, fetchBurnLimit, fetchCctpPaused, fetchNobleBurn, fetchRangeMintTx, listNobleBurns, rangeUrl } from "./noble";
import * as sol from "./solana";

type Status = "burning" | "attesting" | "ready" | "minting" | "complete" | "failed";
type Speed = "fast" | "standard";

interface Transfer {
  id: string; // `${src}:${burnTx}`, since hashes are only unique per chain
  src: number; // CCTP source domain
  dst: number; // CCTP destination domain
  version: Version;
  speed?: Speed; // V2 only
  burnTx: string;
  from: string;
  recipient: string; // on Solana, the USDC token account
  recipientOwner?: string; // Solana wallet that owns the recipient token account, when known
  amount: string; // micro USDC burned
  fee?: string; // V2 fee deducted from the amount
  createdAt: number;
  status: Status;
  // "app" transfers were started here and get an automatic mint prompt; "found" ones were discovered later.
  origin: "app" | "found";
  nonce?: string;
  message?: Hex;
  attestation?: Hex;
  mintTx?: string;
  error?: string;
}

const STORE_KEY = "cctp:transfers";
const CONNECTED_KEY = "cctp:connected";
const EVM_WALLET_KEY = "cctp:evmWallet";
const SOL_WALLET_KEY = "cctp:solWallet";
const LEGACY_PENDING_KEY = "cctp:pendingBurn";
const ROUTE_KEY = "cctp:route";
const DEAD: Hex = "0x000000000000000000000000000000000000dEaD";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const formatUsdc = (micro: string | bigint) => {
  const v = BigInt(micro);
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${v / 1_000_000n}${frac ? `.${frac}` : ""}`;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const isSolanaAddress = (s: string) => {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};

// ---------- state ----------

const wallet = {
  noble: "",
  client: undefined as SigningStargateClient | undefined,
  nobleBalance: undefined as bigint | undefined,
  nobleFee: undefined as StdFee | undefined,
  burnLimit: undefined as bigint | undefined,
  paused: false,
  evmName: "",
  evm: "" as Hex | "",
  provider: undefined as EIP1193Provider | undefined,
  solName: "",
  sol: "",
  solWallet: undefined as sol.SolanaWallet | undefined,
  solAccount: undefined as WalletAccount | undefined,
  // Per EVM or Solana domain.
  usdc: new Map<number, bigint>(),
  gas: new Map<number, bigint>(),
};
let transfers: Transfer[] = load();
let selected: string | undefined = transfers.find((t) => t.status !== "complete" && t.status !== "failed")?.id ?? transfers[0]?.id;
let notice: { text: string; tone: "idle" | "busy" | "ok" | "err" | "action" } | undefined;
const tracking = new Set<string>();
const declined = new Set<string>();
let mintInFlight = false;
let { src, dst, speed } = loadRoute();
let fees: (FeeQuote & { src: number; dst: number }) | undefined;

function loadRoute(): { src: number; dst: number; speed: Speed } {
  try {
    const r = JSON.parse(stored(ROUTE_KEY) ?? "{}");
    if (route(r.src, r.dst)) return { src: r.src, dst: r.dst, speed: r.speed === "standard" ? "standard" : "fast" };
  } catch {}
  return { src: NOBLE.domain, dst: 1, speed: "fast" };
}

function load(): Transfer[] {
  try {
    const list: any[] = JSON.parse(stored(STORE_KEY) ?? "[]");
    const legacy = stored(LEGACY_PENDING_KEY);
    if (legacy && !list.some((t) => t.burnTx === legacy.toUpperCase())) {
      list.unshift({ burnTx: legacy.toUpperCase(), from: "", domain: 1, recipient: "", amount: "0", createdAt: Date.now(), status: "burning", origin: "app" });
    }
    localStorage.removeItem(LEGACY_PENDING_KEY);
    // Transfers saved before any-to-any support were all Noble V1 burns, with the destination in `domain`.
    for (const t of list) {
      if (t.src !== undefined) continue;
      Object.assign(t, { src: NOBLE.domain, dst: t.domain ?? 1, version: 1, id: `${NOBLE.domain}:${t.burnTx}` });
      delete t.domain;
    }
    return list;
  } catch {
    return [];
  }
}

function save() {
  // History is a convenience; the chain is the source of truth.
  store(STORE_KEY, JSON.stringify(transfers));
}

function update(t: Transfer, patch: Partial<Transfer>) {
  Object.assign(t, patch);
  save();
  render();
}

function addTransfer(t: Transfer): Transfer {
  const existing = transfers.find((x) => x.id === t.id);
  if (existing) return existing;
  transfers.unshift(t);
  transfers.sort((a, b) => b.createdAt - a.createdAt);
  save();
  return t;
}

function log(line: string) {
  $("log").textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + $("log").textContent;
}

function setNotice(text: string, tone: NonNullable<typeof notice>["tone"]) {
  notice = { text, tone };
  log(text);
  render();
}

// ---------- wallets ----------

function keplr(): Keplr {
  if (!window.keplr) throw new Error("Keplr extension not found");
  return window.keplr;
}

function evm<T = unknown>(method: string, params?: unknown[]): Promise<T> {
  if (!wallet.provider) throw new Error("Connect an EVM wallet first");
  return wallet.provider.request({ method, params } as any) as Promise<T>;
}

// The wallet that signs on a chain, and its address there.
function walletName(domain: number) {
  const kind = chain(domain).kind;
  return kind === "noble" ? "Keplr" : kind === "evm" ? wallet.evmName || "an EVM wallet" : wallet.solName || "a Solana wallet";
}

function account(domain: number) {
  const kind = chain(domain).kind;
  return kind === "noble" ? wallet.noble : kind === "evm" ? wallet.evm : wallet.sol;
}

async function connectKeplr() {
  setNotice("Connecting to Keplr…", "busy");
  await keplr().enable(NOBLE.chainId);
  const signer = keplr().getOfflineSigner(NOBLE.chainId);
  wallet.noble = (await signer.getAccounts())[0].address;
  wallet.client = await SigningStargateClient.connectWithSigner(NOBLE.rpc, signer, {
    registry: new Registry([...defaultRegistryTypes, [MsgDepositForBurnTypeUrl, MsgDepositForBurn]]),
  });
  store(CONNECTED_KEY, "1");
  notice = undefined;
  log(`Connected Noble ${wallet.noble}`);
  await refreshBalances();
  await scanBurns();
}

async function connectEvm(id: string) {
  const w = evmWallets().find((x) => x.id === id);
  if (!w) throw new Error("That wallet is no longer available");
  setNotice(`Connecting to ${w.name}…`, "busy");
  wallet.provider = w.provider;
  let accounts: Hex[];
  try {
    accounts = await evm<Hex[]>("eth_requestAccounts");
  } catch {
    // Keplr only exposes accounts once one of its EVM chains is active.
    await switchChain(w.provider, chain(src).kind === "evm" ? src : chain(dst).kind === "evm" ? dst : 1);
    accounts = await evm<Hex[]>("eth_requestAccounts");
  }
  wallet.evm = accounts[0];
  wallet.evmName = w.name;
  store(EVM_WALLET_KEY, id);
  fillRecipient();
  notice = undefined;
  log(`Connected ${w.name} ${wallet.evm}`);
  await refreshBalances();
}

async function connectSol(id: string) {
  const w = sol.solanaWallets().find((x) => x.id === id);
  if (!w) throw new Error("That wallet is no longer available");
  setNotice(`Connecting to ${w.name}…`, "busy");
  const acct = await sol.connectSolana(w);
  wallet.solWallet = w;
  wallet.solAccount = acct;
  wallet.sol = acct.address;
  wallet.solName = w.name;
  store(SOL_WALLET_KEY, id);
  fillRecipient();
  notice = undefined;
  log(`Connected ${w.name} ${wallet.sol}`);
  await refreshBalances();
}

// Prefill the recipient with the connected address on the destination's chain family, unless the user typed another.
function fillRecipient() {
  const input = $("recipient");
  const current = input.value.trim();
  if (current && current !== wallet.evm && current !== wallet.sol) return;
  input.value = chain(dst).kind === "solana" ? wallet.sol : wallet.evm;
}

async function refreshChain(domain: number) {
  const kind = chain(domain).kind;
  if (kind === "evm" && wallet.evm) {
    const [gas, usdc] = await Promise.all([publicClient(domain).getBalance({ address: wallet.evm }), usdcBalance(domain, wallet.evm)]);
    wallet.gas.set(domain, gas);
    wallet.usdc.set(domain, usdc);
  } else if (kind === "solana" && wallet.sol) {
    const b = await sol.balances(new PublicKey(wallet.sol));
    wallet.gas.set(domain, b.lamports);
    wallet.usdc.set(domain, b.usdc);
  }
  render();
}

async function refreshBalances() {
  const domains = new Set([src, dst, ...transfers.filter((t) => t.status === "ready").map((t) => t.dst)]);
  await Promise.all([
    ...[...domains].map((d) => refreshChain(d).catch(() => {})),
    refreshNoble().catch((e) => log(`Noble refresh failed: ${errorText(e)}`)),
    refreshFees().catch((e) => log(`Fee quote failed: ${errorText(e)}`)),
  ]);
  render();
}

async function refreshNoble() {
  if (!wallet.client) return;
  const [usdc, limit, paused] = await Promise.all([wallet.client.getBalance(wallet.noble, "uusdc"), fetchBurnLimit(), fetchCctpPaused()]);
  wallet.nobleBalance = BigInt(usdc.amount);
  wallet.burnLimit = limit;
  wallet.paused = paused;
  wallet.nobleFee = await estimateNobleFee();
}

async function refreshFees() {
  if (route(src, dst) !== 2) return;
  const [s, d] = [src, dst];
  const quote = await fetchFees(s, d);
  if (s === src && d === dst) fees = { ...quote, src: s, dst: d };
}

const currentFees = () => (fees && fees.src === src && fees.dst === dst ? fees : undefined);

// Gas is simulated with a 1 uusdc burn; the fee does not depend on the amount or recipient.
// Simulation fails on an empty balance, so fall back to a limit above the ~110k a burn uses.
async function estimateNobleFee(): Promise<StdFee> {
  const gas = await wallet.client!.simulate(wallet.noble, [nobleBurnMsg("1", toBytes(pad(DEAD, { size: 32 })), route(NOBLE.domain, dst) ? dst : 1)], "").catch(() => 200_000);
  const gasLimit = Math.ceil(gas * 1.5);
  return { amount: [{ denom: "uusdc", amount: Math.ceil(gasLimit * GAS_PRICE_UUSDC).toString() }], gas: gasLimit.toString() };
}

const nobleFeeAmount = () => BigInt(wallet.nobleFee?.amount[0].amount ?? 0);

const sourceBalance = () => (src === NOBLE.domain ? wallet.nobleBalance : wallet.usdc.get(src));

function maxAmount(): bigint {
  const balance = sourceBalance();
  if (balance === undefined) return 0n;
  if (src !== NOBLE.domain) return balance;
  let max = balance - nobleFeeAmount();
  if (wallet.burnLimit !== undefined && max > wallet.burnLimit) max = wallet.burnLimit;
  return max > 0n ? max : 0n;
}

// ---------- burn ----------

function toMicroUsdc(input: string): bigint {
  const match = input.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) throw new Error("Amount must be a number with at most 6 decimals");
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function nobleBurnMsg(amount: string, mintRecipient: Uint8Array, domain: number) {
  return {
    typeUrl: MsgDepositForBurnTypeUrl,
    value: { from: wallet.noble, amount, destinationDomain: domain, mintRecipient, burnToken: "uusdc" },
  };
}

async function sendAndWait(domain: number, to: Hex, data: Hex): Promise<Hex> {
  const hash = await evm<Hex>("eth_sendTransaction", [{ from: wallet.evm, to, data }]);
  const receipt = await publicClient(domain).waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return hash;
}

// CCTP mint recipients are bytes32: an EVM address left-padded, or a Solana USDC token account.
function mintRecipient(d: number, recipient: string): { bytes: Uint8Array; recipient: string; owner?: string } {
  if (chain(d).kind === "solana") {
    if (!isSolanaAddress(recipient)) throw new Error("Recipient is not a valid Solana address");
    const account = sol.usdcAccount(new PublicKey(recipient));
    return { bytes: account.toBytes(), recipient: account.toBase58(), owner: recipient };
  }
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid EVM address");
  return { bytes: toBytes(pad(recipient, { size: 32 })), recipient };
}

async function burn() {
  const version = route(src, dst);
  if (!version) throw new Error(`There is no CCTP route from ${chain(src).name} to ${chain(dst).name}`);
  const r = mintRecipient(dst, $("recipient").value.trim());
  const amount = toMicroUsdc($("amount").value);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero");
  if (amount > maxAmount()) throw new Error(`Amount exceeds the maximum of ${formatUsdc(maxAmount())} USDC`);

  const [s, d] = [src, dst];
  const from = account(s);
  if (!from) throw new Error(`Connect ${walletName(s)} first`);
  let hash: string;
  let fee: bigint | undefined;
  if (s === NOBLE.domain) {
    if (!wallet.client || !wallet.nobleFee) throw new Error("Connect Keplr first");
    setNotice(`Approve the burn to ${chain(d).name} in Keplr…`, "action");
    hash = await wallet.client.signAndBroadcastSync(wallet.noble, [nobleBurnMsg(amount.toString(), r.bytes, d)], wallet.nobleFee);
  } else {
    const quote = currentFees() ?? (await fetchFees(s, d));
    fee = feeFor(amount, speed === "fast" ? quote.fastBps : quote.standardBps);
    if (fee >= amount) throw new Error(`The amount must be more than the ${formatUsdc(fee)} USDC fee`);
    if (s === SOLANA.domain) {
      const { ix, eventData } = sol.depositForBurn(new PublicKey(wallet.sol), amount, d, r.bytes, fee, FINALITY[speed]);
      setNotice(`Approve the burn to ${chain(d).name} in ${wallet.solName}…`, "action");
      hash = await sol.signAndSend(wallet.solWallet!, wallet.solAccount!, [ix], [eventData]);
    } else {
      const c = evmChain(s);
      await switchChain(wallet.provider!, s);
      const allowance = await publicClient(s).readContract({ address: c.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet.evm as Hex, c.tokenMessengerV2] });
      if (allowance < amount) {
        setNotice(`Approve ${formatUsdc(amount)} USDC for Circle's TokenMessenger on ${c.name} in ${wallet.evmName}…`, "action");
        await sendAndWait(s, c.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.tokenMessengerV2, amount] }));
      }
      setNotice(`Approve the burn to ${chain(d).name} in ${wallet.evmName}…`, "action");
      const data = encodeFunctionData({
        abi: depositForBurnV2Abi,
        functionName: "depositForBurn",
        args: [amount, d, toHex(r.bytes), c.usdc, pad("0x", { size: 32 }), fee, FINALITY[speed]],
      });
      hash = await evm<Hex>("eth_sendTransaction", [{ from: wallet.evm, to: c.tokenMessengerV2, data }]);
    }
  }
  const burnTx = normalizeHash(s, hash);
  const t = addTransfer({
    id: `${s}:${burnTx}`,
    src: s,
    dst: d,
    version,
    speed: version === 2 ? speed : undefined,
    burnTx,
    from,
    recipient: r.recipient,
    recipientOwner: r.owner,
    amount: amount.toString(),
    fee: fee?.toString(),
    createdAt: Date.now(),
    status: "burning",
    origin: "app",
  });
  selected = t.id;
  notice = undefined;
  $("amount").value = "";
  log(`Burn broadcast on ${chain(s).name}: ${t.burnTx}`);
  render();
  track(t);
}

// ---------- tracking ----------

async function track(t: Transfer) {
  if (tracking.has(t.id)) return;
  tracking.add(t.id);
  try {
    while (t.status !== "complete" && t.status !== "failed") {
      try {
        await step(t);
      } catch (e) {
        update(t, { error: errorText(e) });
        await sleep(10_000);
      }
    }
  } finally {
    tracking.delete(t.id);
  }
}

// Resolves true once the transaction is confirmed, false if it failed; polls Solana, waits on EVM.
async function confirmTx(domain: number, hash: string): Promise<boolean> {
  if (chain(domain).kind === "solana") {
    for (;;) {
      const ok = await sol.txStatus(hash);
      if (ok !== undefined) return ok;
      await sleep(2000);
    }
  }
  const receipt = await publicClient(domain).waitForTransactionReceipt({ hash: hash as Hex, timeout: 180_000 });
  return receipt.status === "success";
}

async function confirmBurn(t: Transfer) {
  if (t.src === NOBLE.domain) {
    const burn = await fetchNobleBurn(t.burnTx);
    if (burn === undefined) return sleep(3000);
    if (burn === null) return update(t, { status: "failed", error: "Not a CCTP burn to a supported chain" });
    if (burn.failed) return update(t, { status: "failed", error: "Burn transaction failed on Noble" });
    update(t, { status: "attesting", from: burn.from, dst: burn.dst, recipient: burn.recipient, amount: burn.amount, createdAt: burn.timestamp, error: undefined });
  } else {
    if (!(await confirmTx(t.src, t.burnTx))) return update(t, { status: "failed", error: `Burn transaction failed on ${chain(t.src).name}` });
    update(t, { status: "attesting", error: undefined });
  }
  refreshBalances().catch(() => {});
}

const isMinted = (t: Transfer) =>
  chain(t.dst).kind === "solana" ? sol.isMinted(t.version, t.message!) : evmIsMinted(t.src, t.dst, t.version, t.nonce!);

const canMint = (t: Transfer) => !!account(t.dst);

async function step(t: Transfer) {
  switch (t.status) {
    case "burning":
      return confirmBurn(t);
    case "attesting": {
      const msg = await fetchMessage(t.src, t.burnTx);
      if (!msg?.attestation) return sleep(5000);
      update(t, { nonce: msg.nonce, message: msg.message, attestation: msg.attestation, recipient: msg.recipient, amount: msg.amount, fee: msg.fee, error: undefined });
      return markMintedOrReady(t);
    }
    case "ready": {
      if (canMint(t) && hasGas(t.dst) && t.origin === "app" && !declined.has(t.id) && !mintInFlight) return mint(t);
      await sleep(10_000);
      return markMintedOrReady(t);
    }
    case "minting": {
      if (!t.mintTx) return update(t, { status: "ready" });
      if (await confirmTx(t.dst, t.mintTx)) {
        update(t, { status: "complete", error: undefined });
        refreshBalances().catch(() => {});
        return;
      }
      update(t, { error: "Mint transaction failed" });
      return markMintedOrReady(t);
    }
  }
}

async function markMintedOrReady(t: Transfer) {
  if (await isMinted(t)) {
    const mintTx = t.mintTx ?? (t.src === NOBLE.domain ? await fetchRangeMintTx(t.nonce!).catch(() => undefined) : undefined);
    update(t, { status: "complete", mintTx, error: undefined });
  } else if (t.status !== "ready") {
    update(t, { status: "ready" });
    refreshChain(t.dst).catch(() => {});
  }
}

async function mintOnSolana(t: Transfer): Promise<string> {
  const payer = new PublicKey(wallet.sol);
  const recipient = sol.recipientAccount(t.version, t.message!);
  // The mint needs the recipient's USDC account to exist. Creating it takes its own transaction, since
  // a V2 receive is already close to Solana's size limit.
  if (!(await sol.accountExists(recipient))) {
    const owner = t.recipientOwner ? new PublicKey(t.recipientOwner) : undefined;
    if (!owner || !sol.usdcAccount(owner).equals(recipient)) throw new Error(`The recipient token account ${recipient.toBase58()} does not exist, and its owner is unknown`);
    setNotice(`Approve creating the recipient's USDC account in ${wallet.solName}…`, "action");
    const sig = await sol.signAndSend(wallet.solWallet!, wallet.solAccount!, [sol.createUsdcAccount(payer, owner)]);
    if (!(await confirmTx(SOLANA.domain, sig))) throw new Error("Creating the USDC account failed");
  }
  setNotice(`Attestation ready. Approve the ${formatUsdc(received(t))} USDC mint on Solana in ${wallet.solName}…`, "action");
  return sol.signAndSend(wallet.solWallet!, wallet.solAccount!, [await sol.receiveMessage(payer, t.version, t.message!, t.attestation!)]);
}

async function mintOnEvm(t: Transfer): Promise<string> {
  setNotice(`Attestation ready. Approve the ${formatUsdc(received(t))} USDC mint on ${chain(t.dst).name} in ${wallet.evmName}…`, "action");
  await switchChain(wallet.provider!, t.dst);
  const data = encodeFunctionData({ abi: receiveMessageAbi, functionName: "receiveMessage", args: [t.message!, t.attestation!] });
  return evm<string>("eth_sendTransaction", [{ from: wallet.evm, to: messageTransmitter(t.dst, t.version), data }]);
}

async function mint(t: Transfer) {
  if (mintInFlight || !canMint(t)) return;
  mintInFlight = true;
  try {
    if (await isMinted(t)) return markMintedOrReady(t);
    selected = t.id;
    const mintTx = chain(t.dst).kind === "solana" ? await mintOnSolana(t) : await mintOnEvm(t);
    notice = undefined;
    log(`Mint broadcast on ${chain(t.dst).name}: ${mintTx}`);
    update(t, { status: "minting", mintTx, error: undefined });
  } catch (e) {
    declined.add(t.id);
    notice = undefined;
    log(`Mint not sent: ${errorText(e)}`);
    update(t, { error: `Mint not sent: ${errorText(e)}` });
  } finally {
    mintInFlight = false;
  }
}

function mintNow(id: string) {
  const t = transfers.find((x) => x.id === id);
  if (!t) return;
  if (!canMint(t)) return setNotice(`Connect ${walletName(t.dst)} to mint`, "err");
  declined.delete(t.id);
  mint(t);
}

// ---------- history lookup ----------

async function lookup() {
  const s = Number($<HTMLSelectElement>("lookup-src").value);
  const raw = $("lookup").value.trim();
  const valid = chain(s).kind === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(raw) : /^(0x)?[0-9a-fA-F]{64}$/.test(raw);
  if (!valid) throw new Error(`That does not look like a ${chain(s).name} transaction hash`);
  const hash = normalizeHash(s, raw);
  setNotice(`Looking up the burn on ${chain(s).name}…`, "busy");
  let t: Transfer;
  if (s === NOBLE.domain) {
    const burn = await fetchNobleBurn(hash);
    if (burn === undefined) throw new Error("Transaction not found on Noble");
    if (burn === null) throw new Error("That transaction is not a CCTP burn to a supported chain");
    if (burn.failed) throw new Error("That burn failed on Noble");
    t = addTransfer({ id: `${s}:${burn.hash}`, src: s, dst: burn.dst, version: 1, burnTx: burn.hash, from: burn.from, recipient: burn.recipient, amount: burn.amount, createdAt: burn.timestamp, status: "attesting", origin: "found" });
  } else {
    const msg = await fetchMessage(s, hash);
    if (!msg) throw new Error(`Circle has no CCTP burn for that hash on ${chain(s).name} yet`);
    if (!CHAINS.some((c) => c.domain === msg.dst && c.kind !== "noble")) throw new Error(`That burn goes to CCTP domain ${msg.dst}, which this page cannot mint on`);
    let createdAt: number;
    if (chain(s).kind === "solana") createdAt = await sol.txTime(hash);
    else {
      const receipt = await publicClient(s).getTransactionReceipt({ hash: hash as Hex });
      createdAt = Number((await publicClient(s).getBlock({ blockNumber: receipt.blockNumber })).timestamp) * 1000;
    }
    t = addTransfer({ id: `${s}:${hash}`, src: s, dst: msg.dst, version: msg.version, burnTx: hash, from: msg.sender, recipient: msg.recipient, amount: msg.amount, fee: msg.fee, createdAt, status: "attesting", origin: "found" });
  }
  selected = t.id;
  $("lookup").value = "";
  notice = undefined;
  render();
  track(t);
}

async function scanBurns() {
  if (!wallet.noble) return;
  const burns = await listNobleBurns(wallet.noble);
  let added = 0;
  for (const b of burns) {
    const id = `${NOBLE.domain}:${b.hash}`;
    if (transfers.some((t) => t.id === id)) continue;
    addTransfer({ id, src: NOBLE.domain, dst: b.dst, version: 1, burnTx: b.hash, from: b.from, recipient: b.recipient, amount: b.amount, createdAt: b.timestamp, status: "attesting", origin: "found" });
    added++;
  }
  log(`Found ${burns.length} CCTP burns on Noble for this address (${added} new)`);
  resumeAll();
  render();
}

function resumeAll() {
  for (const t of transfers) if (t.status !== "complete" && t.status !== "failed") track(t);
}

// ---------- rendering ----------

// An unknown balance counts as having gas, so a slow RPC does not hold back the mint prompt.
const hasGas = (domain: number) => wallet.gas.get(domain) !== 0n;
const received = (t: Transfer) => BigInt(t.amount) - BigInt(t.fee ?? 0);

const STATUS_LABEL: Record<Status, string> = {
  burning: "Burning",
  attesting: "Awaiting attestation",
  ready: "Ready to mint",
  minting: "Minting",
  complete: "Complete",
  failed: "Failed",
};

const attestationWait = (t: Transfer) =>
  t.version === 2 && t.speed !== "fast"
    ? `Standard transfers wait for ${chain(t.src).name} finality, which can take 15–20 minutes on Ethereum and its rollups`
    : "Usually under a minute after the burn confirms";

function statusLine(): { text: string; tone: NonNullable<typeof notice>["tone"] } {
  if (notice) return notice;
  const active = transfers.find((t) => t.id === selected);
  const elapsed = active ? ` (${Math.max(0, Math.round((Date.now() - active.createdAt) / 1000))}s)` : "";
  if (active) {
    const amt = `${formatUsdc(received(active))} USDC`;
    const from = chain(active.src).name;
    const to = chain(active.dst).name;
    switch (active.status) {
      case "burning": return { text: `Waiting for the ${from} burn of ${formatUsdc(active.amount)} USDC to confirm…`, tone: "busy" };
      case "attesting": return { text: `Burn confirmed. Waiting for Circle's attestation${active.origin === "app" ? elapsed : ""}…`, tone: "busy" };
      case "ready":
        if (!hasGas(active.dst)) {
          const relayers = active.src === NOBLE.domain ? ", or wait: public relayers often mint Noble burns for free" : "";
          return { text: `${amt} is attested, but your ${to} address has no ${gasSymbol(active.dst)} for the mint's gas. Add ${gasSymbol(active.dst)}${relayers}.`, tone: "action" };
        }
        return canMint(active)
          ? { text: `${amt} is attested and ready to mint on ${to}.${declined.has(active.id) ? " Click Mint now to sign." : ""}`, tone: "action" }
          : { text: `${amt} is attested. Connect ${walletName(active.dst)} to mint it on ${to}.`, tone: "action" };
      case "minting": return { text: `Waiting for the ${to} mint to confirm…`, tone: "busy" };
      case "failed": return { text: `Transfer failed: ${active.error ?? "unknown error"}`, tone: "err" };
    }
  }
  if (src === NOBLE.domain && wallet.paused) return { text: "CCTP burning and minting is currently paused on Noble.", tone: "err" };
  if (!account(src)) return { text: `Connect ${walletName(src)} to send from ${chain(src).name}.`, tone: "idle" };
  if (active?.status === "complete") return { text: `Last transfer complete: ${formatUsdc(received(active))} USDC delivered on ${chain(active.dst).name}.`, tone: "ok" };
  return { text: "Ready. Enter an amount to transfer.", tone: "ok" };
}

function stepStates(t: Transfer): ("todo" | "active" | "action" | "done" | "error")[] {
  switch (t.status) {
    case "burning": return ["active", "todo", "todo", "todo"];
    case "attesting": return ["done", "active", "todo", "todo"];
    case "ready": return ["done", "done", "action", "todo"];
    case "minting": return ["done", "done", "active", "todo"];
    case "complete": return ["done", "done", "done", "done"];
    case "failed": return ["error", "todo", "todo", "todo"];
  }
}

function link(href: string, text: string) {
  return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

function renderStatus() {
  const s = statusLine();
  $("status").dataset.tone = s.tone;
  $("status-text").textContent = s.text;
}

const routeLabel = (t: Transfer) => `CCTP V${t.version}${t.speed ? ` ${t.speed}` : ""}`;

function feeInfo(version: Version | undefined): string {
  const from = chain(src);
  const to = chain(dst);
  if (!version) return `There is no CCTP route from ${from.name} to ${to.name}.`;
  const mintGas = `Minting on ${to.name} needs a little ${gasSymbol(dst)} for gas${to.kind === "solana" ? ", plus rent if the recipient has no USDC account yet" : ""}.`;
  if (src === NOBLE.domain) {
    if (!wallet.nobleFee) return mintGas;
    return `Network fee ≈ ${formatUsdc(nobleFeeAmount())} USDC (paid on Noble). Per-transfer burn limit: ${
      wallet.burnLimit === undefined ? "–" : formatUsdc(wallet.burnLimit)
    } USDC. ${mintGas}`;
  }
  const f = currentFees();
  const bps = f ? (speed === "fast" ? f.fastBps : f.standardBps) : undefined;
  let amount: bigint | undefined;
  try {
    amount = toMicroUsdc($("amount").value);
  } catch {}
  const circle =
    bps === undefined ? "Circle fee: loading…" : bps === 0 ? "No Circle fee." : `Circle fee: ${bps} bps${amount ? ` (${formatUsdc(feeFor(amount, bps))} USDC, deducted from the amount)` : ""}.`;
  const burnGas = from.kind === "solana" ? "SOL for the burn and a small refundable event account" : `${gasSymbol(src)} for the approval and burn`;
  return `${circle} Burning on ${from.name} needs ${burnGas}. ${mintGas}`;
}

function gasLine(d: number): string {
  const c = chain(d);
  const gas = wallet.gas.get(d);
  if (c.kind === "noble" || gas === undefined) return "";
  const amount = c.kind === "solana" ? formatUnits(gas, 9) : formatEther(gas);
  return `${Number(amount).toFixed(4)} ${gasSymbol(d)} on ${c.name}`;
}

function syncWalletSelect(id: string, wallets: { id: string; name: string }[], storageKey: string, kind: string) {
  const select = $<HTMLSelectElement>(id);
  const options = wallets.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
  if (select.dataset.options === options) return;
  const keep = select.value || stored(storageKey) || "";
  select.innerHTML = options || `<option value="">No ${kind} wallet found</option>`;
  select.dataset.options = options;
  if (keep && wallets.some((w) => w.id === keep)) select.value = keep;
}

function render() {
  renderStatus();

  const version = route(src, dst);
  const pair = [...new Set([src, dst])];
  $("connect-keplr").textContent = wallet.client ? "Refresh" : "Connect Keplr";
  $("connect-evm").textContent = wallet.evm ? "Refresh" : "Connect";
  $("connect-sol").textContent = wallet.sol ? "Refresh" : "Connect";
  $("noble-account").innerHTML = wallet.client ? `<span class="mono">${esc(wallet.noble)}</span> · ${wallet.nobleBalance === undefined ? "–" : formatUsdc(wallet.nobleBalance)} USDC` : "Not connected.";
  const accountLine = (address: string, kind: string) => {
    if (!address) return "Not connected.";
    const gas = pair.filter((d) => chain(d).kind === kind).map(gasLine).filter(Boolean);
    return `<span class="mono">${esc(address)}</span> ${gas.map((s) => `· ${s}`).join(" ")}`;
  };
  $("evm-account").innerHTML = accountLine(wallet.evm, "evm");
  $("sol-account").innerHTML = accountLine(wallet.sol, "solana");
  syncWalletSelect("evm-wallet", evmWallets(), EVM_WALLET_KEY, "EVM");
  syncWalletSelect("sol-wallet", sol.solanaWallets(), SOL_WALLET_KEY, "Solana");
  $<HTMLButtonElement>("connect-evm").disabled = !evmWallets().length;
  $<HTMLButtonElement>("connect-sol").disabled = !sol.solanaWallets().length;

  $<HTMLSelectElement>("src").value = String(src);
  for (const opt of $<HTMLSelectElement>("dst").options) opt.disabled = !route(src, Number(opt.value));
  $<HTMLSelectElement>("dst").value = String(dst);
  $("route").textContent = version ? `via CCTP V${version}` : "no route";
  $("speed-row").hidden = version !== 2;
  $<HTMLInputElement>(`speed-${speed}`).checked = true;

  const balance = sourceBalance();
  $("balance").textContent = balance === undefined ? "–" : `${formatUsdc(balance)} USDC`;
  $<HTMLButtonElement>("max").disabled = maxAmount() === 0n;
  const toSolana = chain(dst).kind === "solana";
  $("recipient-label").textContent = toSolana ? "Recipient address (Solana wallet)" : "Recipient address (EVM)";
  $("recipient").placeholder = toSolana ? "Solana address" : "0x…";
  $("burn").textContent = `Burn on ${chain(src).name}`;
  $<HTMLButtonElement>("burn").disabled = !version || !account(src) || (src === NOBLE.domain && (!wallet.nobleFee || wallet.paused));
  $<HTMLButtonElement>("scan").disabled = !wallet.client;
  $("fee-info").textContent = feeInfo(version);

  const active = transfers.find((t) => t.id === selected);
  $("active").hidden = !active;
  if (active) {
    const states = stepStates(active);
    const fromName = chain(active.src).name;
    const toName = chain(active.dst).name;
    const feeNote = active.fee && active.fee !== "0" ? ` (fee ${formatUsdc(active.fee)})` : "";
    const steps = [
      { title: `Burn on ${fromName}`, detail: `${formatUsdc(active.amount)} USDC${feeNote} · ${link(txUrl(active.src, active.burnTx), short(active.burnTx))}` },
      {
        title: "Circle attestation",
        detail: active.nonce
          ? `Nonce ${short(active.nonce)}${active.src === NOBLE.domain ? ` · ${link(rangeUrl(active.nonce), "Range")}` : ""}`
          : attestationWait(active),
      },
      { title: `Mint on ${toName}`, detail: active.mintTx ? link(txUrl(active.dst, active.mintTx), short(active.mintTx)) : `To ${active.recipient ? link(addressUrl(active.dst, active.recipient), short(active.recipient)) : "…"}` },
      { title: "Complete", detail: active.status === "complete" ? `${formatUsdc(received(active))} USDC delivered on ${toName}` : "" },
    ];
    $("steps").innerHTML = steps
      .map((st, i) => `<li data-state="${states[i]}"><span class="icon">${states[i] === "done" ? "✓" : states[i] === "error" ? "!" : i + 1}</span><div><div class="title">${st.title}</div><div class="muted">${st.detail}</div></div></li>`)
      .join("");
    $("active-summary").textContent = `${routeLabel(active)} · ${new Date(active.createdAt).toLocaleString()}`;
    const showMint = active.status === "ready" && (declined.has(active.id) || active.origin === "found" || !canMint(active) || !hasGas(active.dst));
    $("active-actions").innerHTML =
      (active.error && active.status !== "failed" ? `<p class="muted" style="color: var(--err)">${esc(active.error)}</p>` : "") +
      (showMint ? `<button data-mint="${esc(active.id)}" ${canMint(active) ? "" : "disabled"}>Mint now</button>` : "");
  }

  $("history-empty").hidden = transfers.length > 0;
  $("history").innerHTML = transfers
    .map((t) => {
      const links = [
        link(txUrl(t.src, t.burnTx), chain(t.src).name),
        t.nonce && t.src === NOBLE.domain ? link(rangeUrl(t.nonce), "Range") : "",
        t.mintTx ? link(txUrl(t.dst, t.mintTx), chain(t.dst).name) : "",
      ].filter(Boolean).join(" · ");
      return `<tr data-select="${esc(t.id)}" class="${t.id === selected ? "selected" : ""}"><td>${new Date(t.createdAt).toLocaleString()}</td><td>${formatUsdc(t.amount)}</td><td>${esc(chain(t.src).name)} → ${esc(chain(t.dst).name)}<div class="muted">${routeLabel(t)}</div></td><td class="mono">${t.recipient ? link(addressUrl(t.dst, t.recipient), short(t.recipient)) : "…"}</td><td><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span></td><td>${links}</td></tr>`;
    })
    .join("");
}

// ---------- wiring ----------

function guard(fn: () => Promise<void>) {
  return async (ev: Event) => {
    const button = ev.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      setNotice(errorText(e), "err");
    } finally {
      button.disabled = false;
      render();
    }
  };
}

function setRoute(patch: Partial<{ src: number; dst: number; speed: Speed }>) {
  ({ src, dst, speed } = { src, dst, speed, ...patch });
  if (!route(src, dst)) dst = CHAINS.find((c) => route(src, c.domain))?.domain ?? dst;
  store(ROUTE_KEY, JSON.stringify({ src, dst, speed }));
  fillRecipient();
  render();
  refreshBalances().catch(() => {});
}

const chainOptions = (list: typeof CHAINS) => list.map((c) => `<option value="${c.domain}">${esc(c.name)}</option>`).join("");
$("src").innerHTML = chainOptions(CHAINS);
$("lookup-src").innerHTML = chainOptions(CHAINS);
$("dst").innerHTML = chainOptions(CHAINS.filter((c) => c.kind !== "noble"));

$("connect-keplr").addEventListener("click", guard(async () => (wallet.client ? refreshBalances() : connectKeplr())));
$("connect-evm").addEventListener("click", guard(async () => (wallet.evm ? refreshBalances() : connectEvm($<HTMLSelectElement>("evm-wallet").value))));
$("connect-sol").addEventListener("click", guard(async () => (wallet.sol ? refreshBalances() : connectSol($<HTMLSelectElement>("sol-wallet").value))));
$("evm-wallet").addEventListener("change", () => {
  wallet.evm = "";
  wallet.provider = undefined;
  render();
});
$("sol-wallet").addEventListener("change", () => {
  wallet.sol = "";
  wallet.solWallet = undefined;
  wallet.solAccount = undefined;
  render();
});
$("burn").addEventListener("click", guard(burn));
$("lookup-btn").addEventListener("click", guard(lookup));
$("scan").addEventListener("click", guard(scanBurns));
$("src").addEventListener("change", () => setRoute({ src: Number($<HTMLSelectElement>("src").value) }));
$("dst").addEventListener("change", () => setRoute({ dst: Number($<HTMLSelectElement>("dst").value) }));
for (const s of ["fast", "standard"] as const) $(`speed-${s}`).addEventListener("change", () => setRoute({ speed: s }));
$("max").addEventListener("click", () => {
  $("amount").value = formatUsdc(maxAmount());
  render();
});
$("amount").addEventListener("input", () => {
  if (notice?.tone === "err") notice = undefined;
  render();
});
document.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.closest("a")) return;
  const mintBtn = target.closest<HTMLElement>("[data-mint]");
  if (mintBtn) return mintNow(mintBtn.dataset.mint!);
  const row = target.closest<HTMLElement>("[data-select]");
  if (row) {
    selected = row.dataset.select;
    notice = undefined;
    render();
  }
});

discoverWallets(render);
sol.onSolanaWallets(render);
setInterval(renderStatus, 1000);
render();
resumeAll();
refreshFees().then(render).catch(() => {});
window.addEventListener("load", () => {
  if (stored(CONNECTED_KEY) === "1" && window.keplr) connectKeplr().catch((e) => setNotice(errorText(e), "err"));
  const evmId = stored(EVM_WALLET_KEY);
  if (evmId && evmWallets().some((w) => w.id === evmId)) connectEvm(evmId).catch((e) => setNotice(errorText(e), "err"));
  const solId = stored(SOL_WALLET_KEY);
  if (solId && sol.solanaWallets().some((w) => w.id === solId)) connectSol(solId).catch((e) => setNotice(errorText(e), "err"));
});
