import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { describe, expect, it } from 'vitest'

import { X402ProtocolError } from './errors'
import { parseX402Requirement } from './x402'

const URL = 'https://api.example.com/paid'

describe('parseX402Requirement', () => {
  it('接受 Base Sepolia USDC 的 exact EIP-3009 要求', () => {
    const selected = parseX402Requirement(challenge([requirement()])).selected
    expect(selected).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '100',
    })
  })

  it('接受 BNB Smart Chain 测试网 Permit2 和 Solana Devnet USDC 要求', () => {
    const bsc = parseX402Requirement(
      challenge([
        requirement({
          network: 'eip155:97',
          asset: '0x64544969ed7EBf5f083679233325356EbE738930',
          extra: { assetTransferMethod: 'permit2' },
        }),
      ]),
    ).selected
    expect(bsc.network).toBe('eip155:97')

    const solana = parseX402Requirement(
      challenge([
        requirement({
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          payTo: 'Vote111111111111111111111111111111111111111',
          extra: { feePayer: '11111111111111111111111111111111' },
        }),
      ]),
    ).selected
    expect(solana.network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')
  })

  it('拒绝网络中未配置的 USDC', () => {
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
