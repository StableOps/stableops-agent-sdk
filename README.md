# StableOps Agent SDK

[![npm version](https://img.shields.io/npm/v/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![npm downloads](https://img.shields.io/npm/dm/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![License](https://img.shields.io/npm/l/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org) [![Node](https://img.shields.io/badge/Node-%3E%3D20-339933)](https://nodejs.org)

[中文文档](./README.zh-CN.md)

StableOps Agent Payments lets autonomous agents initiate stablecoin payments
under explicit policies, organization and agent budgets, and human approvals.
The agent receives a restricted Agent Key instead of a management API key or
unrestricted wallet access.

This SDK runs inside the agent process. It requests paid resources, coordinates
payment intents with the StableOps Control API, obtains signatures from a
customer-hosted `@stableops/agent-signer` sidecar, and retries the original x402
request with the payment proof. StableOps does not proxy the resource request or
hold the customer's private key.

## Features

- End-to-end x402 v2 `exact` payment flow for HTTPS resources.
- Policy, budget, and approval enforcement through the StableOps Control API.
- Customer-controlled signing through a local signer sidecar.
- HTTPS-only resource requests with pinned DNS results and private-address blocking.
- Same-origin redirects before payment and no redirects after attaching a signature.
- Task-scoped idempotency and approval-resume support.
- Read-only budget and payment queries scoped to the current Agent Key.
- Four framework-neutral tool definitions for AI runtimes.
- Dual CJS and ESM builds with generated TypeScript declarations.

## Requirements

- Node.js 20 or newer.
- A StableOps Agent Key. Do not use a management API key in the agent runtime.
- A customer-hosted `@stableops/agent-signer` sidecar.
- An HTTPS x402 resource supported by the current StableOps environment.

## Installation

```bash
pnpm add @stableops/agent-sdk
```

```bash
npm install @stableops/agent-sdk
```

```bash
yarn add @stableops/agent-sdk
```

## Quick Start

```ts
import {
  AgentPaymentsControlClient,
  HttpAgentSignerSidecar,
  SafeHttpsRequester,
  StableOpsAgent,
} from '@stableops/agent-sdk'

const payments = new StableOpsAgent({
  control: new AgentPaymentsControlClient({
    agentKey: process.env.STABLEOPS_AGENT_KEY!,
  }),
  sidecar: new HttpAgentSignerSidecar({
    url: 'http://127.0.0.1:8789',
    authToken: process.env.STABLEOPS_SIDECAR_TOKEN,
  }),
  requester: new SafeHttpsRequester(),
})

const result = await payments.x402Fetch('https://api.example.com/paid', {
  idempotencyKey: 'task_123:paid-resource:v1',
})

if (result.status === 'paid' || result.status === 'not_required') {
  const data = await result.response.json()
  console.log(data)
} else if (result.status === 'awaiting_approval') {
  // Save result.intentId and resume the same payment after approval.

  const resumed = await payments.x402Fetch('https://api.example.com/paid', {
    resumeIntentId: result.intentId,
  })
}
```

After an approver approves the intent, resume it instead of creating another
payment. The same `intentId` preserves the original authorization and budget
reservation.

The SDK also exposes Agent Key-scoped read methods:

```ts
const budget = await payments.getBudget()
const payment = await payments.getPayment('pint_...')
const recentPayments = await payments.listRecentPayments(20)
```

`agentPaymentTools` contains the framework-neutral definitions
`stableops_get_budget`, `stableops_x402_fetch`, `stableops_get_payment`, and
`stableops_list_recent_payments`.

## Documentation

For the complete setup flow, policy and approval behavior, signer deployment,
and x402 examples, see the official documentation:

- English docs: https://stableops.dev/en/docs/agent-payments
- Chinese docs: https://stableops.dev/zh/docs/agent-payments
- Quickstart: https://stableops.dev/en/docs/agent-payments/quickstart

## Current Support

The current release supports:

- x402 v2 `exact` payments.
- `GET` requests on six EVM mainnets and their testnets, plus Solana mainnet and Devnet.
- Configured USDC contracts on those networks. TRON and Nile are excluded.
- Sandbox accepts test networks only. Live supports mainnets after StableOps enables the organization upon completion of its risk and recovery-drill gates.

It does not support browser or Edge runtimes, assets other than USDC, `POST`,
`upto`, direct transfers, or raw private keys.

Never retry a `SettlementUnknownError` by creating another intent. Query the
existing intent and let StableOps reconcile its authorization nonce.

## License

This SDK is licensed under `Apache-2.0`.
