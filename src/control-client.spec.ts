import { describe, expect, it, vi } from 'vitest'

import { AgentPaymentsControlClient } from './control-client'

describe('AgentPaymentsControlClient', () => {
  it('映射 snake_case Intent 响应并绑定 Agent Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          intent_id: 'pint_1',
          status: 'awaiting_approval',
          approval_id: 'papr_1',
          approval_expires_at: '2026-07-30T00:30:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const client = new AgentPaymentsControlClient({
      agentKey: 'ak_sandbox_test',
      fetch: fetchMock,
    })

    const result = await client.createX402Intent({
      idempotencyKey: 'task:1',
      method: 'GET',
      resourceUrl: 'https://api.example.com/paid',
      requirements: {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '100',
        payTo: '0x0000000000000000000000000000000000000001',
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    })

    expect(result).toEqual({
      intentId: 'pint_1',
      status: 'awaiting_approval',
      approvalId: 'papr_1',
      approvalExpiresAt: '2026-07-30T00:30:00.000Z',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/agent-payments/runtime/intents/x402'),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer ak_sandbox_test',
          'idempotency-key': 'task:1',
        }),
      }),
    )
  })

  it('刷新授权时把受保护资源 URL 与最新付款要求一并发送', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          intent_id: 'pint_1',
          authorization_id: 'paut_1',
          grant: 'grant-token',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const client = new AgentPaymentsControlClient({
      agentKey: 'ak_sandbox_test',
      fetch: fetchMock,
    })
    const requirements = {
      scheme: 'exact' as const,
      network: 'eip155:84532' as const,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '100',
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    }

    await expect(
      client.createAuthorization('pint_1', 'https://api.example.com/paid?retry=1', requirements),
    ).resolves.toEqual({
      intentId: 'pint_1',
      authorizationId: 'paut_1',
      grant: 'grant-token',
    })

    const request = vi.mocked(fetchMock).mock.calls[0]![1] as RequestInit
    expect(JSON.parse(request.body as string)).toEqual({
      resource_url: 'https://api.example.com/paid?retry=1',
      requirements: {
        x402_version: 2,
        scheme: 'exact',
        network: 'eip155:84532',
        asset: requirements.asset,
        pay_to: requirements.payTo,
        max_amount_atomic: '100',
        max_timeout_seconds: 300,
        extra: requirements.extra,
      },
    })
  })

  it('只通过 Agent Key 运行时接口读取预算和最近付款', async () => {
    const payment = {
      intent_id: 'pint_1',
      status: 'settled',
      resource_status: 'response_received',
      method: 'GET',
      resource_url: 'https://api.example.com/paid',
      origin: 'https://api.example.com',
      pay_to: '0x0000000000000000000000000000000000000001',
      network: 'eip155:56',
      asset: 'USDC',
      asset_contract: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      asset_decimals: 18,
      max_amount_atomic: '100',
      created_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:01:00.000Z',
      settled_at: '2026-07-30T00:01:00.000Z',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          asset: 'USDC',
          decimals: 6,
          window_start: '2026-07-30T00:00:00.000Z',
          window_end: '2026-07-31T00:00:00.000Z',
          organization: {
            limit_atomic: '1000000',
            reserved_atomic: '0',
            committed_atomic: '100',
            settled_atomic: '200',
            available_atomic: '999700',
          },
          agent: {
            limit_atomic: '500000',
            reserved_atomic: '0',
            committed_atomic: '100',
            settled_atomic: '200',
            available_atomic: '499700',
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [payment] }))
      .mockResolvedValueOnce(Response.json(payment))
    const client = new AgentPaymentsControlClient({
      agentKey: 'ak_sandbox_test',
      fetch: fetchMock,
    })

    await expect(client.getBudget()).resolves.toMatchObject({
      windowStart: '2026-07-30T00:00:00.000Z',
      organization: { availableAtomic: '999700' },
      agent: { availableAtomic: '499700' },
    })
    await expect(client.listRecentPayments(5)).resolves.toEqual([
      expect.objectContaining({
        intentId: 'pint_1',
        status: 'settled',
        maxAmountAtomic: '100',
        assetDecimals: 18,
      }),
    ])
    await expect(client.getPayment('pint_1')).resolves.toMatchObject({
      intentId: 'pint_1',
      resourceStatus: 'response_received',
    })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.stableops.dev/v1/agent-payments/runtime/budget',
      'https://api.stableops.dev/v1/agent-payments/runtime/payments?limit=5',
      'https://api.stableops.dev/v1/agent-payments/runtime/intents/pint_1',
    ])
    for (const [, request] of fetchMock.mock.calls) {
      expect(request).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer ak_sandbox_test',
          }),
        }),
      )
    }
  })
})
