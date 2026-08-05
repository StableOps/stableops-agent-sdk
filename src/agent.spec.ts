import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { describe, expect, it, vi } from 'vitest'

import { StableOpsAgent } from './agent'
import { SettlementUnknownError, X402ProtocolError } from './errors'
import type {
  AgentPaymentsControl,
  AgentSignerSidecar,
  SafeHttpResponse,
  SafeResourceRequester,
} from './types'

const RESOURCE_URL = 'https://api.example.com/report'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAY_TO = '0x0000000000000000000000000000000000000001'
const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('StableOpsAgent', () => {
  it('非 402 响应不创建付款意图', async () => {
    const requester = new QueueRequester([response(200, { body: 'free' })])
    const { agent, control } = createAgent(requester)

    const result = await agent.x402Fetch(RESOURCE_URL)

    expect(result.status).toBe('not_required')
    expect(control.createX402Intent).not.toHaveBeenCalled()
  })

  it('需要审批时不领取 Grant，也不发送付款头', async () => {
    const requester = new QueueRequester([challenge()])
    const { agent, control } = createAgent(requester, {
      createX402Intent: vi.fn().mockResolvedValue({
        intentId: 'pint_1',
        status: 'awaiting_approval',
        approvalId: 'papr_1',
      }),
    })

    const result = await agent.x402Fetch(RESOURCE_URL, { idempotencyKey: 'task:1' })

    expect(result).toMatchObject({
      status: 'awaiting_approval',
      intentId: 'pint_1',
      approvalId: 'papr_1',
    })
    expect(control.createAuthorization).not.toHaveBeenCalled()
    expect(requester.calls).toHaveLength(1)
  })

  it('刷新要求后经 Sidecar 签名并发送 v2 PAYMENT-SIGNATURE', async () => {
    const settle: SettleResponse = {
      success: true,
      transaction: '0xtransaction',
      network: 'eip155:84532',
      payer: PAYER,
    }
    const requester = new QueueRequester([
      challenge(),
      challenge(),
      response(200, {
        body: '{"ok":true}',
        headers: { 'payment-response': encodePaymentResponseHeader(settle) },
      }),
    ])
    const { agent, control } = createAgent(requester)

    const result = await agent.x402Fetch(RESOURCE_URL, { idempotencyKey: 'task:paid' })

    expect(result).toMatchObject({
      status: 'paid',
      intentId: 'pint_1',
      authorizationId: 'paut_1',
      paymentResponse: settle,
      resultReported: true,
    })
    const paymentHeader = requester.calls[2].options?.headers?.['payment-signature']
    expect(paymentHeader).toBeTruthy()
    expect(decodePaymentSignatureHeader(paymentHeader!)).toMatchObject({
      x402Version: 2,
      accepted: requirements(),
      payload: {
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: '20000',
        },
      },
    })
    expect(control.reportX402Result).toHaveBeenCalledWith(
      'pint_1',
      expect.objectContaining({
        authorizationId: 'paut_1',
        requestOutcome: 'response_received',
        httpStatus: 200,
        signatureHash: 'sha256:23e20c74adbf5fce07175f3d58bf524a68c19445369dd1ae167a5ba3aad2bf33',
      }),
    )
    expect(control.createAuthorization).toHaveBeenCalledWith('pint_1', RESOURCE_URL, requirements())
  })

  it('刷新后金额上涨时拒绝领取 Grant', async () => {
    const requester = new QueueRequester([challenge(), challenge({ amount: '20001' })])
    const { agent, control } = createAgent(requester)

    await expect(agent.x402Fetch(RESOURCE_URL)).rejects.toBeInstanceOf(X402ProtocolError)
    expect(control.createAuthorization).not.toHaveBeenCalled()
  })

  it('付款请求超时后进入 settlement_unknown 且不产生新授权', async () => {
    const requester = new QueueRequester([challenge(), challenge(), new Error('socket timed out')])
    const { agent, control } = createAgent(requester)

    await expect(agent.x402Fetch(RESOURCE_URL)).rejects.toBeInstanceOf(SettlementUnknownError)
    expect(control.createAuthorization).toHaveBeenCalledTimes(1)
    expect(control.reportX402Result).toHaveBeenCalledWith(
      'pint_1',
      expect.objectContaining({
        authorizationId: 'paut_1',
        requestOutcome: 'timeout',
        signatureHash: 'sha256:23e20c74adbf5fce07175f3d58bf524a68c19445369dd1ae167a5ba3aad2bf33',
      }),
    )
  })

  it('恢复审批时读取锁定要求并拒绝参数上涨', async () => {
    const requester = new QueueRequester([challenge({ amount: '20001' })])
    const { agent, control } = createAgent(requester)

    await expect(
      agent.x402Fetch(RESOURCE_URL, { resumeIntentId: 'pint_1' }),
    ).rejects.toBeInstanceOf(X402ProtocolError)
    expect(control.getX402Intent).toHaveBeenCalledWith('pint_1')
    expect(control.createAuthorization).not.toHaveBeenCalled()
  })

  it('资源已返回但结果上报失败时仍返回资源，并标记待补报', async () => {
    const requester = new QueueRequester([challenge(), challenge(), response(200)])
    const { agent } = createAgent(requester, {
      reportX402Result: vi.fn().mockRejectedValue(new Error('control unavailable')),
    })

    const result = await agent.x402Fetch(RESOURCE_URL)

    expect(result).toMatchObject({
      status: 'paid',
      resultReported: false,
    })
  })

  it('预算和付款查询委托给 Agent Key 专属 Control 客户端', async () => {
    const requester = new QueueRequester([])
    const getBudget = vi.fn().mockResolvedValue({ asset: 'USDC' })
    const getPayment = vi.fn().mockResolvedValue({ intentId: 'pint_1' })
    const listRecentPayments = vi.fn().mockResolvedValue([{ intentId: 'pint_1' }])
    const { agent } = createAgent(requester, {
      getBudget,
      getPayment,
      listRecentPayments,
    })

    await expect(agent.getBudget()).resolves.toEqual({ asset: 'USDC' })
    await expect(agent.getPayment('pint_1')).resolves.toEqual({ intentId: 'pint_1' })
    await expect(agent.listRecentPayments(5)).resolves.toEqual([{ intentId: 'pint_1' }])
    expect(getPayment).toHaveBeenCalledWith('pint_1')
    expect(listRecentPayments).toHaveBeenCalledWith(5)
  })

  it('最近付款查询拒绝越界数量', () => {
    const { agent } = createAgent(new QueueRequester([]))

    expect(() => agent.listRecentPayments(0)).toThrow(X402ProtocolError)
    expect(() => agent.listRecentPayments(51)).toThrow(X402ProtocolError)
  })
})

class QueueRequester implements SafeResourceRequester {
  readonly calls: Array<{
    url: string
    options?: Parameters<SafeResourceRequester['get']>[1]
  }> = []

  constructor(private readonly values: Array<SafeHttpResponse | Error>) {}

  async get(
    url: string,
    options?: Parameters<SafeResourceRequester['get']>[1],
  ): Promise<SafeHttpResponse> {
    this.calls.push({ url, options })
    const value = this.values.shift()
    if (!value) throw new Error('unexpected request')
    if (value instanceof Error) throw value
    return value
  }
}

function createAgent(
  requester: SafeResourceRequester,
  controlOverrides: Partial<AgentPaymentsControl> = {},
) {
  const control: AgentPaymentsControl = {
    createX402Intent: vi.fn().mockResolvedValue({
      intentId: 'pint_1',
      status: 'approved',
    }),
    getX402Intent: vi.fn().mockResolvedValue({
      intentId: 'pint_1',
      status: 'approved',
      requirements: requirements(),
    }),
    createAuthorization: vi.fn().mockResolvedValue({
      intentId: 'pint_1',
      authorizationId: 'paut_1',
      grant: 'grant-token',
    }),
    reportX402Result: vi.fn().mockResolvedValue(undefined),
    ...controlOverrides,
  }
  const sidecar: AgentSignerSidecar = {
    sign: vi.fn().mockResolvedValue({
      grantId: 'grant_1',
      authorizationId: 'paut_1',
      walletAddress: PAYER,
      typedDataHash: `0x${'11'.repeat(32)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: '20000',
        validAfter: '0',
        validBefore: '2000000000',
        nonce: `0x${'22'.repeat(32)}`,
      },
      signature: `0x${'33'.repeat(65)}`,
    }),
  }
  return {
    control,
    agent: new StableOpsAgent({
      control,
      sidecar,
      requester,
      now: () => new Date('2026-07-30T00:00:00.000Z'),
      createIdempotencyKey: () => 'generated-key',
    }),
  }
}

function challenge(overrides: Partial<PaymentRequirements> = {}): SafeHttpResponse {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [{ ...requirements(), ...overrides }],
  }
  return response(402, {
    headers: { 'payment-required': encodePaymentRequiredHeader(paymentRequired) },
  })
}

function requirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: USDC,
    amount: '20000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USDC',
      version: '2',
    },
  }
}

function response(
  status: number,
  options: { headers?: Record<string, string>; body?: string } = {},
): SafeHttpResponse {
  return {
    status,
    headers: new Headers(options.headers),
    body: Buffer.from(options.body ?? ''),
    url: RESOURCE_URL,
  }
}
