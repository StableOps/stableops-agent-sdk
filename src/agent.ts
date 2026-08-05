import { createHash, randomUUID } from 'node:crypto'

import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { getAddress } from 'viem'

import { SettlementUnknownError, SidecarError, X402ProtocolError } from './errors'
import {
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  assertRequirementRefreshAllowed,
  parseX402Requirement,
} from './x402'
import type {
  AgentPaymentsControl,
  AgentSignerSidecar,
  SafeHttpResponse,
  SafeResourceRequester,
  X402FetchOptions,
  X402FetchResult,
  AgentPaymentRecord,
  AgentPaymentRuntimeBudget,
} from './types'

export type StableOpsAgentOptions = {
  control: AgentPaymentsControl
  sidecar: AgentSignerSidecar
  requester: SafeResourceRequester
  now?: () => Date
  createIdempotencyKey?: () => string
}

export class StableOpsAgent {
  private readonly now: () => Date
  private readonly createIdempotencyKey: () => string

  constructor(private readonly options: StableOpsAgentOptions) {
    this.now = options.now ?? (() => new Date())
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => randomUUID())
  }

  getBudget(): Promise<AgentPaymentRuntimeBudget> {
    const getBudget = this.options.control.getBudget
    if (!getBudget) {
      throw new X402ProtocolError('Control client does not support budget queries')
    }
    return getBudget.call(this.options.control)
  }

  getPayment(intentId: string): Promise<AgentPaymentRecord> {
    if (!intentId.trim()) {
      throw new X402ProtocolError('payment intent ID is required')
    }
    const getPayment = this.options.control.getPayment
    if (!getPayment) {
      throw new X402ProtocolError('Control client does not support payment queries')
    }
    return getPayment.call(this.options.control, intentId)
  }

  listRecentPayments(limit = 20): Promise<AgentPaymentRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new X402ProtocolError('recent payment limit must be an integer from 1 to 50')
    }
    const listRecentPayments = this.options.control.listRecentPayments
    if (!listRecentPayments) {
      throw new X402ProtocolError('Control client does not support recent payment queries')
    }
    return listRecentPayments.call(this.options.control, limit)
  }

  async x402Fetch(url: string, options: X402FetchOptions = {}): Promise<X402FetchResult> {
    if (options.resumeIntentId) {
      return this.resumeApprovedIntent(url, options.resumeIntentId)
    }

    const initial = await this.options.requester.get(url)
    if (initial.status !== 402) {
      return {
        status: 'not_required',
        response: toResponse(initial),
        responseUrl: initial.url,
      }
    }

    const requirement = parseX402Requirement(initial)
    const intent = await this.options.control.createX402Intent({
      idempotencyKey: options.idempotencyKey ?? this.createIdempotencyKey(),
      method: 'GET',
      resourceUrl: initial.url,
      requirements: requirement.selected,
    })
    if (intent.status === 'awaiting_approval') {
      return {
        status: 'awaiting_approval',
        intentId: intent.intentId,
        approvalId: intent.approvalId,
        approvalExpiresAt: intent.approvalExpiresAt,
      }
    }
    if (intent.status !== 'approved') {
      throw new X402ProtocolError(`payment intent cannot continue from status ${intent.status}`)
    }

    return this.completeApprovedIntent(initial.url, intent.intentId, requirement.selected)
  }

  private async resumeApprovedIntent(url: string, intentId: string): Promise<X402FetchResult> {
    const intent = await this.options.control.getX402Intent(intentId)
    if (intent.intentId !== intentId || intent.status !== 'approved') {
      throw new X402ProtocolError(`payment intent cannot resume from status ${intent.status}`)
    }
    const refreshed = await this.options.requester.get(url)
    if (refreshed.status !== 402) {
      throw new X402ProtocolError('approved x402 resource no longer requires payment')
    }
    const requirement = parseX402Requirement(refreshed)
    assertRequirementRefreshAllowed(intent.requirements, requirement.selected)
    return this.signAndSend(refreshed, intentId, requirement.selected)
  }

  private async completeApprovedIntent(
    url: string,
    intentId: string,
    original: PaymentRequirements,
  ): Promise<X402FetchResult> {
    const refreshed = await this.options.requester.get(url)
    if (refreshed.status !== 402) {
      throw new X402ProtocolError('x402 resource no longer requires payment after approval')
    }
    const requirement = parseX402Requirement(refreshed)
    assertRequirementRefreshAllowed(original, requirement.selected)
    return this.signAndSend(refreshed, intentId, requirement.selected)
  }

  private async signAndSend(
    challengeResponse: SafeHttpResponse,
    intentId: string,
    requirements: PaymentRequirements,
  ): Promise<X402FetchResult> {
    const authorization = await this.options.control.createAuthorization(
      intentId,
      challengeResponse.url,
      requirements,
    )
    if (authorization.intentId !== intentId) {
      throw new X402ProtocolError('Control API returned an authorization for another intent')
    }
    let signed: Awaited<ReturnType<AgentSignerSidecar['sign']>>
    try {
      signed = await this.options.sidecar.sign(authorization.grant)
    } catch (error) {
      await this.reportSafely(intentId, {
        authorizationId: authorization.authorizationId,
        requestOutcome: 'signing_failed',
        reportedAt: this.now().toISOString(),
      })
      throw error instanceof SidecarError ? error : new SidecarError('signer sidecar failed', error)
    }
    try {
      assertSignedAuthorization(signed, authorization.authorizationId, requirements)
    } catch (error) {
      await this.reportSafely(intentId, {
        authorizationId: authorization.authorizationId,
        requestOutcome: 'signing_failed',
        reportedAt: this.now().toISOString(),
      })
      throw error
    }
    const signatureHash = hashSignature(signed.signature)

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      resource: parseX402Requirement(challengeResponse).paymentRequired.resource,
      accepted: requirements,
      payload: {
        authorization: signed.authorization,
        signature: signed.signature,
      },
    }
    const paymentHeader = encodePaymentSignatureHeader(paymentPayload)

    let paidResponse: SafeHttpResponse
    try {
      paidResponse = await this.options.requester.get(challengeResponse.url, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeader },
        allowRedirects: false,
      })
    } catch (error) {
      await this.reportSafely(intentId, {
        authorizationId: authorization.authorizationId,
        requestOutcome: 'timeout',
        signatureHash,
        reportedAt: this.now().toISOString(),
      })
      throw new SettlementUnknownError(intentId, authorization.authorizationId, error)
    }

    const rawPaymentResponse = paidResponse.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined
    let paymentResponse: SettleResponse | undefined
    if (rawPaymentResponse) {
      try {
        paymentResponse = decodePaymentResponseHeader(rawPaymentResponse)
      } catch (error) {
        await this.reportSafely(intentId, {
          authorizationId: authorization.authorizationId,
          requestOutcome: 'response_received',
          httpStatus: paidResponse.status,
          paymentResponse: rawPaymentResponse,
          resourceBodyHash: hashBody(paidResponse.body),
          signatureHash,
          reportedAt: this.now().toISOString(),
        })
        throw new SettlementUnknownError(intentId, authorization.authorizationId, error)
      }
    }

    let resultReported = true
    try {
      await this.options.control.reportX402Result(intentId, {
        authorizationId: authorization.authorizationId,
        requestOutcome: 'response_received',
        httpStatus: paidResponse.status,
        paymentResponse: rawPaymentResponse,
        resourceBodyHash: hashBody(paidResponse.body),
        signatureHash,
        reportedAt: this.now().toISOString(),
      })
    } catch {
      resultReported = false
    }

    return {
      status: 'paid',
      intentId,
      authorizationId: authorization.authorizationId,
      response: toResponse(paidResponse),
      responseUrl: paidResponse.url,
      paymentResponse,
      resultReported,
    }
  }

  private async reportSafely(
    intentId: string,
    input: Parameters<AgentPaymentsControl['reportX402Result']>[1],
  ): Promise<void> {
    try {
      await this.options.control.reportX402Result(intentId, input)
    } catch {
      // 结果上报失败不能把一个可能已发出的付款请求降级为普通可重试失败。
    }
  }
}

function toResponse(response: SafeHttpResponse): Response {
  return new Response(Buffer.from(response.body), {
    status: response.status,
    headers: response.headers,
  })
}

function hashBody(body: Uint8Array): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

function hashSignature(signature: string): string {
  return `sha256:${createHash('sha256').update(signature).digest('hex')}`
}

function assertSignedAuthorization(
  signed: Awaited<ReturnType<AgentSignerSidecar['sign']>>,
  authorizationId: string,
  requirements: PaymentRequirements,
): void {
  if (signed.authorizationId !== authorizationId) {
    throw new SidecarError('signer sidecar returned a different authorization ID')
  }
  if (
    getAddress(signed.authorization.from) !== getAddress(signed.walletAddress) ||
    getAddress(signed.authorization.to) !== getAddress(requirements.payTo) ||
    signed.authorization.value !== requirements.amount
  ) {
    throw new SidecarError('signer sidecar authorization does not match payment requirements')
  }
}
