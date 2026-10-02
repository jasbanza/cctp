# USDC CCTP transfers

This is a web page for moving USDC between chains with Circle CCTP. It covers Noble, Solana and 25 EVM chains. Pick a source and a destination, and the page chooses the route: CCTP V2 between any two chains that support it, or V1 for burns from Noble.

Live: https://jasbanza.github.io/cctp/

> **Noble deadline:** Circle is [discontinuing USDC and CCTP V1 on Noble](https://www.circle.com/blog/circle-is-discontinuing-support-for-usdc-and-cctp-v1-on-noble). Noble can already only send: every V1 TokenMessenger has had Noble removed, so nothing can be minted on Noble. Burn limits gradually drop to zero from Oct 31, 2026, and all routes pause on Jan 12, 2027.

## Routes

| From | To | Version |
| --- | --- | --- |
| Noble | Ethereum, Avalanche, OP Mainnet, Arbitrum, Base, Polygon PoS, Unichain, Solana | V1 |
| Any EVM chain or Solana | Any other EVM chain or Solana | V2, Fast or Standard |

The EVM chains are Ethereum, Avalanche, OP Mainnet, Arbitrum, Base, Polygon PoS, Unichain, Linea, Codex, Sonic, World Chain, Monad, Sei, XDC, HyperEVM, Ink, Plume, Arc, EDGE, Injective, Morph, Pharos, Cronos, Plasma and X Layer. BNB Smart Chain has V2 contracts but no USDC registered with them, so it is left out. Sui and the other non-EVM chains are not supported.

## Wallets

- **Noble:** Keplr.
- **EVM:** any injected wallet. Wallets are discovered with EIP-6963, so MetaMask, Rabby, Keplr and others can be chosen from a list. The page switches chains, or adds a chain the wallet does not know yet.
- **Solana:** any Wallet Standard wallet, such as Phantom, Solflare or Backpack.

## Features

- **Status bar and step tracker.** Each transfer moves through burn, Circle attestation, mint and complete.
- **Fast or Standard on V2.** Fast settles in seconds and pays the fee Iris quotes, which is deducted from the amount. Standard is free on most routes but waits for source finality, about 15–20 minutes on Ethereum and its rollups.
- **Automatic mint prompt.** Once Circle attests a transfer started on this page, the destination wallet asks you to sign the mint. If you decline, a Mint now button appears. On Solana, the page creates the recipient's USDC account first if it does not exist.
- **History in the browser.** Transfers are saved in localStorage and resume after a refresh. Look up any burn by source chain and transaction hash, or use "Find my Noble burns" to pull your recent Noble burns from the chain.

## How it works

- **Contracts.** `src/chains.ts` lists each chain's domain, USDC and CCTP contracts. Each was checked on-chain: the V2 MessageTransmitter reports its own domain, and the USDC is what the V2 TokenMinter maps Ethereum USDC to.
- **Attestations.** Circle Iris `/v2/messages/{sourceDomain}?transactionHash=…` returns V1 and V2 messages alike. Hashes must match exactly: Noble's are uppercase without `0x`, EVM's are lowercase with `0x`, and Solana's are base58 signatures.
- **Fees.** Iris `/v2/burn/USDC/fees/{src}/{dst}` quotes basis points for Fast (finality 1000) and Standard (2000). The page sets `maxFee` to the quoted fee, rounded up.
- **Minted.** On EVM, `usedNonces` on the destination MessageTransmitter: `keccak256(abi.encodePacked(uint32 source, uint64 nonce))` for V1, and the bytes32 nonce for V2. On Solana, the used-nonce account of Circle's MessageTransmitter program.
- **Solana instructions.** `deposit_for_burn` and `receive_message` are encoded by hand from Circle's IDLs in [circlefin/solana-cctp-contracts](https://github.com/circlefin/solana-cctp-contracts), which keeps Anchor out of the bundle.

## Run locally

```
npm install
npm run dev
```

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`.
