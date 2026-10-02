# Noble → EVM CCTP

This is a web page for moving USDC from Noble mainnet to an EVM chain with Circle CCTP V1. Keplr signs on both sides. The supported destinations are Avalanche, Ethereum, OP Mainnet, Arbitrum, Base, Polygon PoS and Unichain, chosen from a dropdown.

Live: https://jasbanza.github.io/cctp/

> **Deadline:** Circle is [discontinuing USDC and CCTP V1 on Noble](https://www.circle.com/blog/circle-is-discontinuing-support-for-usdc-and-cctp-v1-on-noble). Burn limits gradually drop to zero from Oct 31, 2026, and all routes pause on Jan 12, 2027.

## Features

- **Status bar.** A status line is always visible, and a step tracker follows each transfer: burn on Noble, Circle attestation, mint on Avalanche, then complete.
- **Amount helpers.** The page shows your balance, and Max fills in the balance minus the estimated fee, capped at Noble's burn limit for a single transfer.
- **Automatic mint prompt.** Once Circle attests a transfer started on this page, Keplr asks you to sign the mint on the destination chain. If you decline, a Mint now button appears.
- **History in the browser.** Transfers are saved in localStorage and resume after a refresh. Look up any Noble burn tx hash, or use "Find my burns on Noble" to pull your recent EVM burns from the chain.
- **Links for each transfer.** Mintscan for the burn, [Range](https://usdc.range.org/usdc) for the CCTP status, and the destination chain's explorer for the mint and the recipient.

## How status is determined

- **Burn.** Noble REST `/cosmos/tx/v1beta1/txs/{hash}`.
- **Attestation.** Circle Iris `/v1/messages/4/{HASH}`. Iris only matches Noble hashes in uppercase without a `0x` prefix.
- **Minted.** `usedNonces(keccak256(abi.encodePacked(uint32 4, uint64 nonce)))` on the destination's V1 MessageTransmitter. The addresses are in `src/chain.ts`, and each one was checked on-chain to report its own domain and V1.
- **Range link.** `https://usdc.range.org/usdc/status?id=<base64url("noble-1/<nonce>")>`.

## Run locally

```
npm install
npm run dev
```

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`.
