import { Registry } from "@cosmjs/proto-signing";
import { SigningStargateClient, defaultRegistryTypes, type StdFee } from "@cosmjs/stargate";
import type { Keplr } from "@keplr-wallet/types";
import { encodeFunctionData, isAddress, pad, toBytes, type Hex } from "viem";
import { MsgDepositForBurn, MsgDepositForBurnTypeUrl } from "./cctpProto";
import {
  AVALANCHE,
  GAS_PRICE_UUSDC,
  NOBLE,
  avalancheClient,
  fetchAttestation,
  fetchBurnLimit,
  fetchCctpPaused,
  fetchNobleBurn,
  fetchRangeMintTx,
  isMinted,
  listNobleBurns,
  mintscanUrl,
  rangeUrl,
  receiveMessageAbi,
  snowtraceUrl,
} from "./chain";

declare global {
  interface Window {
    keplr?: Keplr;
  }
}

type Status = "burning" | "attesting" | "ready" | "minting" | "complete" | "failed";

interface Transfer {
  burnTx: string;
  from: string;
  recipient: string;
  amount: string; // uusdc
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
const LEGACY_PENDING_KEY = "cctp:pendingBurn";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const formatUsdc = (micro: string | bigint) => {
  const v = BigInt(micro);
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${v / 1_000_000n}${frac ? `.${frac}` : ""}`;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- state ----------

const wallet = {
  noble: "",
  evm: "",
  client: undefined as SigningStargateClient | undefined,
  balance: undefined as bigint | undefined,
  avax: undefined as bigint | undefined,
  fee: undefined as StdFee | undefined,
  burnLimit: undefined as bigint | undefined,
  paused: false,
};
let transfers: Transfer[] = load();
let selected: string | undefined = transfers.find((t) => t.status !== "complete" && t.status !== "failed")?.burnTx ?? transfers[0]?.burnTx;
let notice: { text: string; tone: "idle" | "busy" | "ok" | "err" | "action" } | undefined;
const tracking = new Set<string>();
const declined = new Set<string>();
let mintInFlight = false;

function load(): Transfer[] {
  try {
    const list: Transfer[] = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    const legacy = localStorage.getItem(LEGACY_PENDING_KEY);
    if (legacy && !list.some((t) => t.burnTx === legacy.toUpperCase())) {
      list.unshift({ burnTx: legacy.toUpperCase(), from: "", recipient: "", amount: "0", createdAt: Date.now(), status: "burning", origin: "app" });
    }
    localStorage.removeItem(LEGACY_PENDING_KEY);
    return list;
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(transfers));
  } catch {
    // History is a convenience; the chain is the source of truth.
  }
}

function update(t: Transfer, patch: Partial<Transfer>) {
  Object.assign(t, patch);
  save();
  render();
}

function addTransfer(t: Transfer): Transfer {
  const existing = transfers.find((x) => x.burnTx === t.burnTx);
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

// ---------- wallet ----------

function keplr(): Keplr {
  if (!window.keplr) throw new Error("Keplr extension not found");
  return window.keplr;
}

function evm<T = unknown>(method: string, params?: unknown[]): Promise<T> {
  return keplr().ethereum.request({ method, params }) as Promise<T>;
}

async function connect() {
  setNotice("Connecting to Keplr…", "busy");
  await keplr().enable(NOBLE.chainId);
  const signer = keplr().getOfflineSigner(NOBLE.chainId);
  wallet.noble = (await signer.getAccounts())[0].address;
  wallet.client = await SigningStargateClient.connectWithSigner(NOBLE.rpc, signer, {
    registry: new Registry([...defaultRegistryTypes, [MsgDepositForBurnTypeUrl, MsgDepositForBurn]]),
  });
  await evm("wallet_switchEthereumChain", [{ chainId: AVALANCHE.chainIdHex }]);
  wallet.evm = (await evm<string[]>("eth_requestAccounts"))[0];
  try {
    localStorage.setItem(CONNECTED_KEY, "1");
  } catch {}
  if (!$("recipient").value) $("recipient").value = wallet.evm;
  notice = undefined;
  log(`Connected ${wallet.noble} and ${wallet.evm}`);
  await refreshBalances();
  await scanBurns();
}

async function refreshBalances() {
  if (!wallet.client) return;
  const [usdc, avax, limit, paused] = await Promise.all([
    wallet.client.getBalance(wallet.noble, "uusdc"),
    avalancheClient.getBalance({ address: wallet.evm as Hex }),
    fetchBurnLimit(),
    fetchCctpPaused(),
  ]);
  wallet.balance = BigInt(usdc.amount);
  wallet.avax = avax;
  wallet.burnLimit = limit;
  wallet.paused = paused;
  wallet.fee = await estimateFee();
  render();
}

// Gas is simulated with a 1 uusdc burn; the fee does not depend on the amount.
// Simulation fails on an empty balance, so fall back to a limit above the ~110k a burn uses.
async function estimateFee(): Promise<StdFee> {
  const gas = await wallet.client!.simulate(wallet.noble, [burnMsg("1", wallet.evm)], "").catch(() => 200_000);
  const gasLimit = Math.ceil(gas * 1.5);
  return { amount: [{ denom: "uusdc", amount: Math.ceil(gasLimit * GAS_PRICE_UUSDC).toString() }], gas: gasLimit.toString() };
}

const feeAmount = () => BigInt(wallet.fee?.amount[0].amount ?? 0);

function maxAmount(): bigint {
  if (wallet.balance === undefined) return 0n;
  let max = wallet.balance - feeAmount();
  if (wallet.burnLimit !== undefined && max > wallet.burnLimit) max = wallet.burnLimit;
  return max > 0n ? max : 0n;
}

// ---------- burn ----------

function toMicroUsdc(input: string): bigint {
  const match = input.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) throw new Error("Amount must be a number with at most 6 decimals");
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function burnMsg(amount: string, recipient: string) {
  return {
    typeUrl: MsgDepositForBurnTypeUrl,
    value: {
      from: wallet.noble,
      amount,
      destinationDomain: AVALANCHE.domain,
      mintRecipient: toBytes(pad(recipient as Hex, { size: 32 })),
      burnToken: "uusdc",
    },
  };
}

async function burn() {
  if (!wallet.client || !wallet.fee) throw new Error("Connect Keplr first");
  const recipient = $("recipient").value.trim();
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid EVM address");
  const amount = toMicroUsdc($("amount").value);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero");
  if (amount > maxAmount()) throw new Error(`Amount exceeds the maximum of ${formatUsdc(maxAmount())} USDC`);

  setNotice("Approve the burn in Keplr…", "action");
  const hash = await wallet.client.signAndBroadcastSync(wallet.noble, [burnMsg(amount.toString(), recipient)], wallet.fee);
  const t = addTransfer({
    burnTx: hash.toUpperCase(),
    from: wallet.noble,
    recipient,
    amount: amount.toString(),
    createdAt: Date.now(),
    status: "burning",
    origin: "app",
  });
  selected = t.burnTx;
  notice = undefined;
  $("amount").value = "";
  log(`Burn broadcast: ${t.burnTx}`);
  render();
  track(t);
}

// ---------- tracking ----------

async function track(t: Transfer) {
  if (tracking.has(t.burnTx)) return;
  tracking.add(t.burnTx);
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
    tracking.delete(t.burnTx);
  }
}

async function step(t: Transfer) {
  switch (t.status) {
    case "burning": {
      const burn = await fetchNobleBurn(t.burnTx);
      if (burn === undefined) return sleep(3000);
      if (burn === null) return update(t, { status: "failed", error: "Not a Noble → Avalanche CCTP burn" });
      if (burn.failed) return update(t, { status: "failed", error: "Burn transaction failed on Noble" });
      update(t, { status: "attesting", from: burn.from, recipient: burn.recipient, amount: burn.amount, createdAt: burn.timestamp, error: undefined });
      refreshBalances().catch(() => {});
      return;
    }
    case "attesting": {
      const att = await fetchAttestation(t.burnTx);
      if (att.status === "pending") return sleep(5000);
      update(t, { nonce: att.nonce, message: att.message, attestation: att.attestation, error: undefined });
      return markMintedOrReady(t);
    }
    case "ready": {
      if (wallet.evm && wallet.avax !== 0n && t.origin === "app" && !declined.has(t.burnTx) && !mintInFlight) return mint(t);
      await sleep(10_000);
      return markMintedOrReady(t);
    }
    case "minting": {
      if (!t.mintTx) return update(t, { status: "ready" });
      const receipt = await avalancheClient.waitForTransactionReceipt({ hash: t.mintTx as Hex, timeout: 120_000 });
      if (receipt.status === "success") {
        update(t, { status: "complete", error: undefined });
        refreshBalances().catch(() => {});
        return;
      }
      update(t, { error: "Mint transaction reverted" });
      return markMintedOrReady(t);
    }
  }
}

async function markMintedOrReady(t: Transfer) {
  if (await isMinted(t.nonce!)) {
    const mintTx = t.mintTx ?? (await fetchRangeMintTx(t.nonce!).catch(() => undefined));
    update(t, { status: "complete", mintTx, error: undefined });
  } else if (t.status !== "ready") {
    update(t, { status: "ready" });
  }
}

async function mint(t: Transfer) {
  if (mintInFlight) return;
  mintInFlight = true;
  try {
    if (await isMinted(t.nonce!)) return markMintedOrReady(t);
    selected = t.burnTx;
    setNotice(`Attestation ready. Approve the ${formatUsdc(t.amount)} USDC mint on Avalanche in Keplr…`, "action");
    await evm("wallet_switchEthereumChain", [{ chainId: AVALANCHE.chainIdHex }]);
    const data = encodeFunctionData({ abi: receiveMessageAbi, functionName: "receiveMessage", args: [t.message!, t.attestation!] });
    const mintTx = await evm<string>("eth_sendTransaction", [{ from: wallet.evm, to: AVALANCHE.messageTransmitter, data }]);
    notice = undefined;
    log(`Mint broadcast: ${mintTx}`);
    update(t, { status: "minting", mintTx, error: undefined });
  } catch (e) {
    declined.add(t.burnTx);
    notice = undefined;
    log(`Mint not sent: ${errorText(e)}`);
    update(t, { error: `Mint not sent: ${errorText(e)}` });
  } finally {
    mintInFlight = false;
  }
}

function mintNow(burnTx: string) {
  const t = transfers.find((x) => x.burnTx === burnTx);
  if (!t) return;
  if (!wallet.evm) return setNotice("Connect Keplr to mint", "err");
  declined.delete(t.burnTx);
  mint(t);
}

// ---------- history lookup ----------

async function lookup() {
  const hash = $("lookup").value.trim().replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) throw new Error("Enter a 64-character Noble tx hash");
  setNotice("Looking up burn on Noble…", "busy");
  const burn = await fetchNobleBurn(hash);
  if (burn === undefined) throw new Error("Transaction not found on Noble");
  if (burn === null) throw new Error("That transaction is not a Noble → Avalanche CCTP burn");
  if (burn.failed) throw new Error("That burn failed on Noble");
  const t = addTransfer({ burnTx: burn.hash, from: burn.from, recipient: burn.recipient, amount: burn.amount, createdAt: burn.timestamp, status: "attesting", origin: "found" });
  selected = t.burnTx;
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
    if (transfers.some((t) => t.burnTx === b.hash)) continue;
    addTransfer({ burnTx: b.hash, from: b.from, recipient: b.recipient, amount: b.amount, createdAt: b.timestamp, status: "attesting", origin: "found" });
    added++;
  }
  log(`Found ${burns.length} Avalanche burns on Noble for this address (${added} new)`);
  resumeAll();
  render();
}

function resumeAll() {
  for (const t of transfers) if (t.status !== "complete" && t.status !== "failed") track(t);
}

// ---------- rendering ----------

const STATUS_LABEL: Record<Status, string> = {
  burning: "Burning",
  attesting: "Awaiting attestation",
  ready: "Ready to mint",
  minting: "Minting",
  complete: "Complete",
  failed: "Failed",
};

function statusLine(): { text: string; tone: NonNullable<typeof notice>["tone"] } {
  if (notice) return notice;
  const active = transfers.find((t) => t.burnTx === selected);
  const elapsed = active ? ` (${Math.max(0, Math.round((Date.now() - active.createdAt) / 1000))}s)` : "";
  if (active) {
    const amt = `${formatUsdc(active.amount)} USDC`;
    switch (active.status) {
      case "burning": return { text: `Waiting for the Noble burn of ${amt} to confirm…`, tone: "busy" };
      case "attesting": return { text: `Burn confirmed. Waiting for Circle's attestation${active.origin === "app" ? elapsed : ""}…`, tone: "busy" };
      case "ready":
        if (wallet.avax === 0n) return { text: `${amt} is attested, but your Avalanche address has no AVAX for the mint's gas. Add AVAX, or wait: public relayers often mint Noble burns for free.`, tone: "action" };
        return wallet.evm
          ? { text: `${amt} is attested and ready to mint on Avalanche.${declined.has(active.burnTx) ? " Click Mint now to sign." : ""}`, tone: "action" }
          : { text: `${amt} is attested. Connect Keplr to mint it on Avalanche.`, tone: "action" };
      case "minting": return { text: `Waiting for the Avalanche mint to confirm…`, tone: "busy" };
      case "failed": return { text: `Transfer failed: ${active.error ?? "unknown error"}`, tone: "err" };
    }
  }
  if (wallet.paused) return { text: "CCTP burning and minting is currently paused on Noble.", tone: "err" };
  if (!wallet.client) return { text: "Connect Keplr to start a transfer.", tone: "idle" };
  if (active?.status === "complete") return { text: `Last transfer complete: ${formatUsdc(active.amount)} USDC delivered on Avalanche.`, tone: "ok" };
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

function render() {
  renderStatus();

  $("connect").textContent = wallet.client ? "Refresh" : "Connect Keplr";
  $("accounts").innerHTML = wallet.client
    ? `<div class="mono">Noble: ${esc(wallet.noble)}</div><div class="mono">Avalanche: ${esc(wallet.evm)} · ${
        wallet.avax === undefined ? "–" : (Number(wallet.avax) / 1e18).toFixed(4)
      } AVAX</div>`
    : "Not connected.";
  $("balance").textContent = wallet.balance === undefined ? "–" : `${formatUsdc(wallet.balance)} USDC`;
  $<HTMLButtonElement>("max").disabled = maxAmount() === 0n;
  $<HTMLButtonElement>("burn").disabled = !wallet.client || !wallet.fee || wallet.paused;
  $<HTMLButtonElement>("scan").disabled = !wallet.client;
  $("fee-info").textContent = wallet.fee
    ? `Network fee ≈ ${formatUsdc(feeAmount())} USDC (paid on Noble). Per-transfer burn limit: ${
        wallet.burnLimit === undefined ? "–" : formatUsdc(wallet.burnLimit)
      } USDC. Minting on Avalanche needs a little AVAX for gas.`
    : "";

  const active = transfers.find((t) => t.burnTx === selected);
  $("active").hidden = !active;
  if (active) {
    const states = stepStates(active);
    const steps = [
      { title: "Burn on Noble", detail: `${formatUsdc(active.amount)} USDC · ${link(mintscanUrl(active.burnTx), short(active.burnTx))}` },
      { title: "Circle attestation", detail: active.nonce ? `Nonce ${active.nonce} · ${link(rangeUrl(active.nonce), "Range")}` : "Usually under a minute after the burn confirms" },
      { title: "Mint on Avalanche", detail: active.mintTx ? link(snowtraceUrl(active.mintTx), short(active.mintTx)) : `To ${esc(active.recipient ? short(active.recipient) : "…")}` },
      { title: "Complete", detail: active.status === "complete" ? "USDC delivered on Avalanche" : "" },
    ];
    $("steps").innerHTML = steps
      .map((st, i) => `<li data-state="${states[i]}"><span class="icon">${states[i] === "done" ? "✓" : states[i] === "error" ? "!" : i + 1}</span><div><div class="title">${st.title}</div><div class="muted">${st.detail}</div></div></li>`)
      .join("");
    $("active-summary").textContent = new Date(active.createdAt).toLocaleString();
    const showMint = active.status === "ready" && (declined.has(active.burnTx) || active.origin === "found" || !wallet.evm || wallet.avax === 0n);
    $("active-actions").innerHTML =
      (active.error && active.status !== "failed" ? `<p class="muted" style="color: var(--err)">${esc(active.error)}</p>` : "") +
      (showMint ? `<button data-mint="${active.burnTx}" ${wallet.evm ? "" : "disabled"}>Mint now</button>` : "");
  }

  $("history-empty").hidden = transfers.length > 0;
  $("history").innerHTML = transfers
    .map((t) => {
      const links = [link(mintscanUrl(t.burnTx), "Noble"), t.nonce ? link(rangeUrl(t.nonce), "Range") : "", t.mintTx ? link(snowtraceUrl(t.mintTx), "Avalanche") : ""].filter(Boolean).join(" · ");
      return `<tr data-select="${t.burnTx}" class="${t.burnTx === selected ? "selected" : ""}"><td>${new Date(t.createdAt).toLocaleString()}</td><td>${formatUsdc(t.amount)}</td><td class="mono">${esc(short(t.recipient || "…"))}</td><td><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span></td><td>${links}</td></tr>`;
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

$("connect").addEventListener("click", guard(async () => (wallet.client ? refreshBalances() : connect())));
$("burn").addEventListener("click", guard(burn));
$("lookup-btn").addEventListener("click", guard(lookup));
$("scan").addEventListener("click", guard(scanBurns));
$("max").addEventListener("click", () => {
  $("amount").value = formatUsdc(maxAmount());
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

setInterval(renderStatus, 1000);
render();
resumeAll();
window.addEventListener("load", () => {
  let wasConnected = false;
  try {
    wasConnected = localStorage.getItem(CONNECTED_KEY) === "1";
  } catch {}
  if (wasConnected && window.keplr) connect().catch((e) => setNotice(errorText(e), "err"));
});
