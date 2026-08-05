import { generateKeyPairSync } from 'node:crypto'

import {
  LocalTestSigner,
  MemoryGrantAuthorizationStore,
  buildTransferWithAuthorizationTypedData,
  hashGrantTypedData,
  signExecutionGrant,
  startSignerSidecar,
  type ExecutionGrantClaims,
} from '@stableops/agent-signer'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { recoverTypedDataAddress } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StableOpsAgent } from './agent'
import { HttpAgentSignerSidecar } from './sidecar-client'
import type { AgentPaymentsControl, SafeHttpResponse, SafeResourceRequester } from './types'

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const RESOURCE_URL = 'https://api.example.com/report'

describe('Agent SDK 与 Signer Sidecar 本地闭环', () => {
  const servers: Awaited<ReturnType<typeof startSignerSidecar>>[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        ({ server }) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
    )
  })

  it('Control Grant 经真实 Sidecar 验证签名后形成 x402 v2 payload', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signer = new LocalTestSigner({
      privateKey: TEST_PRIVATE_KEY,
      grantVerification: { publicKeys: { sandbox_1: publicKey } },
      store: new MemoryGrantAuthorizationStore(),
    })
    const sidecar = await startSignerSidecar({
      signer,
      authToken: 'sidecar-token',
    })
    servers.push(sidecar)

    const requirement = paymentRequirement()
    let claims: ExecutionGrantClaims | undefined
    const control: AgentPaymentsControl = {
      createX402Intent: vi.fn().mockResolvedValue({
        intentId: 'pint_e2e',
        status: 'approved',
      }),
      getX402Intent: vi.fn().mockResolvedValue({
        intentId: 'pint_e2e',
        status: 'approved',
        requirements: requirement,
      }),
      createAuthorization: vi.fn().mockImplementation(() => {
        claims = createClaims(signer.address, requirement)
        return Promise.resolve({
          intentId: 'pint_e2e',
          authorizationId: claims.authorizationId,
          grant: signExecutionGrant(claims, {
            keyId: 'sandbox_1',
            privateKey,
          }),
        })
      }),
      reportX402Result: vi.fn().mockResolvedValue(undefined),
    }
    const requester = new CapturingRequester([
      challenge(requirement),
      challenge(requirement),
      response(200),
    ])
    const agent = new StableOpsAgent({
      control,
      sidecar: new HttpAgentSignerSidecar({
        url: sidecar.url,
        authToken: 'sidecar-token',
      }),
      requester,
    })

    const result = await agent.x402Fetch(RESOURCE_URL, {
      idempotencyKey: 'task:e2e',
    })

    expect(result.status).toBe('paid')
    expect(claims).toBeDefined()
    const header = requester.calls[2].options?.headers?.['payment-signature']
    const payload = decodePaymentSignatureHeader(header!)
    const signedPayload = payload.payload as {
      signature: `0x${string}`
      authorization: Record<string, unknown>
    }
    expect(signedPayload.authorization).toMatchObject({
      from: signer.address,
      to: requirement.payTo,
      value: requirement.amount,
    })
    await expect(
      recoverTypedDataAddress({
        ...buildTransferWithAuthorizationTypedData(claims!),
        signature: signedPayload.signature,
      }),
    ).resolves.toBe(signer.address)
  })
})

class CapturingRequester implements SafeResourceRequester {
  readonly calls: Array<{
    url: string
    options?: Parameters<SafeResourceRequester['get']>[1]
  }> = []

  constructor(private readonly values: SafeHttpResponse[]) {}

  async get(
    url: string,
    options?: Parameters<SafeResourceRequester['get']>[1],
  ): Promise<SafeHttpResponse> {
    this.calls.push({ url, options })
    const value = this.values.shift()
    if (!value) throw new Error('unexpected request')
    return value
  }
}

function createClaims(
  walletAddress: `0x${string}`,
  requirement: PaymentRequirements,
): ExecutionGrantClaims {
  const now = Math.floor(Date.now() / 1000)
  const claims: ExecutionGrantClaims = {
    issuer: 'stableops',
    audience: 'stableops-agent-signer',
    grantId: 'grant_e2e',
    organizationId: 'org_e2e',
    environment: 'SANDBOX',
    agentId: 'pagt_e2e',
    intentId: 'pint_e2e',
    authorizationId: 'paut_e2e',
    walletId: 'paw_e2e',
    walletAddress,
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:84532',
    assetContract: requirement.asset as `0x${string}`,
    tokenName: 'USDC',
    tokenVersion: '2',
    payTo: requirement.payTo as `0x${string}`,
    amountAtomic: requirement.amount,
    validAfter: '0',
    validBefore: String(now + 300),
    nonce: `0x${'44'.repeat(32)}`,
    typedDataHash: `0x${'00'.repeat(32)}`,
    issuedAt: now,
    expiresAt: now + 120,
  }
  claims.typedDataHash = hashGrantTypedData(claims)
  return claims
}

function paymentRequirement(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '100',
    payTo: '0x0000000000000000000000000000000000000001',
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
  }
}

function challenge(requirement: PaymentRequirements): SafeHttpResponse {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [requirement],
  }
  return response(402, {
    'payment-required': encodePaymentRequiredHeader(required),
  })
}

function response(status: number, headers: Record<string, string> = {}): SafeHttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: Buffer.from('{"ok":true}'),
    url: RESOURCE_URL,
  }
}
