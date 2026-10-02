# Noble → Avalanche CCTP

A small local web page for moving USDC from Noble mainnet to Avalanche C-Chain with Circle CCTP V1. It signs with Keplr for both chains.

> **Deadline:** Circle is [discontinuing USDC and CCTP V1 on Noble](https://www.circle.com/blog/circle-is-discontinuing-support-for-usdc-and-cctp-v1-on-noble). From Oct 31, 2026, burn limits gradually drop to zero, and all routes pause on Jan 12, 2027.

## Run

```
npm install
npm run dev
```

Open the printed URL in a browser where Keplr is installed.

## How it works

1. **Connect.** The page connects Keplr to `noble-1` and Keplr's EVM provider to Avalanche (43114). You need a little AVAX for the mint transaction.
2. **Burn.** It sends `MsgDepositForBurn` on Noble with destination domain 1. The Noble fee is paid in USDC.
3. **Attest.** It polls Circle's Iris API at `/v1/messages/4/0x{txHash}` until the attestation is signed, which usually takes under a minute.
4. **Mint.** It calls `receiveMessage(message, attestation)` on the Avalanche V1 MessageTransmitter, `0x8186359aF5F57FbB40c6b14A588d2A59C0C29880`.

The page saves the burn tx hash in localStorage, so a transfer interrupted by a reload can be resumed. You can also paste any Noble burn tx hash to finish its mint.

Try a 1 USDC transfer first.
