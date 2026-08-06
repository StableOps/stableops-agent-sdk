# StableOps Agent SDK

[![npm version](https://img.shields.io/npm/v/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![npm downloads](https://img.shields.io/npm/dm/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![License](https://img.shields.io/npm/l/@stableops/agent-sdk)](https://www.npmjs.com/package/@stableops/agent-sdk) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org) [![Node](https://img.shields.io/badge/Node-%3E%3D20-339933)](https://nodejs.org)

[查看英文说明](./README.md)

StableOps Agent Payments 让自主代理能够在明确的策略、组织与代理预算以及人工审批约束下发起稳定币付款。代理只会获得受限的代理密钥（Agent Key），不会接触管理 API Key 或不受限制的钱包权限。

这个 SDK 运行在代理进程中，负责请求付费资源、通过 StableOps 控制 API 协调付款意图、从客户自行托管的 `@stableops/agent-signer` 签名器伴随服务获取签名，并携带付款凭证重试原始 x402 请求。StableOps 不会代理资源请求，也不会持有客户私钥。

## 功能

- 为 HTTPS 资源提供完整的 x402 v2 `exact` 付款流程。
- 通过 StableOps 控制 API 执行策略、预算和审批约束。
- 通过本地签名器伴随服务完成客户自主管理的签名。
- 仅允许 HTTPS 资源请求，固定 DNS 解析结果并阻止私网地址。
- 付款前仅允许同源重定向，附加付款签名后禁止重定向。
- 支持任务级幂等键和审批后继续执行。
- 提供受当前代理密钥范围约束的预算和付款只读查询。
- 提供四个框架无关的 AI 运行时工具定义。
- 同时输出 CJS、ESM 和 TypeScript 类型声明。

## 环境要求

- Node.js 20 或更高版本。
- StableOps 代理密钥。不要在代理运行时中使用管理 API Key。
- 客户自行托管的 `@stableops/agent-signer` 签名器伴随服务。
- 当前 StableOps 环境支持的 HTTPS x402 资源。

## 安装

```bash
pnpm add @stableops/agent-sdk
```

```bash
npm install @stableops/agent-sdk
```

```bash
yarn add @stableops/agent-sdk
```

## 快速开始

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
  // 保存 result.intentId，审批通过后继续执行同一笔付款。

  const resumed = await payments.x402Fetch('https://api.example.com/paid', {
    resumeIntentId: result.intentId,
  })
}
```

审批人批准付款意图后，应继续执行原付款，不能新建付款。复用同一个 `intentId` 可以保留原有授权和预算预留。

SDK 还提供受代理密钥范围约束的只读方法：

```ts
const budget = await payments.getBudget()
const payment = await payments.getPayment('pint_...')
const recentPayments = await payments.listRecentPayments(20)
```

`agentPaymentTools` 包含 `stableops_get_budget`、`stableops_x402_fetch`、`stableops_get_payment` 和 `stableops_list_recent_payments` 四个框架无关工具定义。

## 官方文档

完整配置流程、策略和审批行为、签名器部署与 x402 示例，请查看官方文档：

- 中文文档：https://stableops.dev/zh/docs/agent-payments
- 英文文档：https://stableops.dev/en/docs/agent-payments
- 快速开始：https://stableops.dev/zh/docs/agent-payments/quickstart

## 当前支持范围

当前版本支持：

- x402 v2 `exact` 付款。
- 六个 EVM 主网及其对应测试网，以及 Solana 主网和 Devnet 上的 `GET` 请求。
- 上述网络中已配置的 USDC；TRON 和 Nile 暂不支持。
- 沙盒只能使用测试网，正式环境只能使用主网；正式环境仍需通过组织风控门禁。

当前不支持浏览器或边缘运行时、USDC 之外的资产、`POST`、`upto`、直接转账或裸私钥。

遇到 `SettlementUnknownError` 时，不能创建新的付款意图重付。应查询原付款意图，并由 StableOps 根据授权随机数对账。

## 许可证

本 SDK 使用 `Apache-2.0` 许可证。
