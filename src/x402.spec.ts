import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { describe, expect, it } from 'vitest'

import { X402ProtocolError } from './errors'
import { parseX402Requirement } from './x402'

const URL = 'https://api.example.com/paid'

describe('parseX402Requirement', () => {
  it('只接受 Base Sepolia 官方 USDC 的 exact EIP-3009 要求', () => {
    const selected = parseX402Requirement(challenge([requirement()])).selected
    expect(selected).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '100',
    })
  })

  it('拒绝非官方 USDC', () => {
    const response = challenge([
      requirement({ asset: '0x0000000000000000000000000000000000000002' }),
    ])
    expect(() => parseX402Requirement(response)).toThrow(X402ProtocolError)
  })

  it('选择唯一的最低金额，并拒绝同价歧义', () => {
    const selected = parseX402Requirement(
      challenge([requirement({ amount: '200' }), requirement({ amount: '100' })]),
    ).selected
    expect(selected.amount).toBe('100')

    expect(() =>
      parseX402Requirement(
        challenge([
          requirement({ payTo: '0x0000000000000000000000000000000000000002' }),
          requirement({ payTo: '0x0000000000000000000000000000000000000003' }),
        ]),
      ),
    ).toThrow(/ambiguous/u)
  })
})

function challenge(accepts: PaymentRequirements[]) {
  const value: PaymentRequired = {
    x402Version: 2,
    resource: { url: URL },
    accepts,
  }
  return {
    status: 402,
    headers: new Headers({ 'payment-required': encodePaymentRequiredHeader(value) }),
    body: new Uint8Array(),
    url: URL,
  }
}

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '100',
    payTo: '0x0000000000000000000000000000000000000001',
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  }
}
