import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import type { ExactEIP3009Payload, ExactEvmPayloadV2 } from '@x402/evm'
import type { Hex } from 'viem'

export type AgentPaymentIntentStatus =
  | 'created'
  | 'awaiting_approval'
  | 'approved'
  | 'authorization_issued'
  | 'settlement_unknown'
  | 'settled'
  | 'expired'
  | 'rejected'
  | 'failed_pre_authorization'
  | 'reverted'
  | 'paused'

export type AgentPaymentResourceStatus =
  | 'not_requested'
  | 'response_received'
  | 'unknown'
  | 'failed'

export type AgentPaymentBudgetBalance = {
  limitAtomic: string
  reservedAtomic: string
  committedAtomic: string
  settledAtomic: string
  availableAtomic: string
}

export type AgentPaymentRuntimeBudget = {
  asset: 'USDC'
  decimals: 6
  windowStart: string
  windowEnd: string
  organization: AgentPaymentBudgetBalance
  agent: AgentPaymentBudgetBalance
}

export type AgentPaymentRecord = {
  intentId: string
  status: AgentPaymentIntentStatus
  resourceStatus: AgentPaymentResourceStatus
  method: 'GET'
  resourceUrl: string
  origin: string
  payTo: string
  network: string
  asset: 'USDC'
  assetContract: string
  assetDecimals: number
  maxAmountAtomic: string
  approvalId?: string
  approvalExpiresAt?: string
  createdAt: string
  updatedAt: string
  settledAt: string | null
  requirements?: PaymentRequirements
}

export type CreateX402IntentInput = {
  idempotencyKey: string
  method: 'GET'
  resourceUrl: string
  requirements: PaymentRequirements
}

export type CreateX402IntentResult = {
  intentId: string
  status: AgentPaymentIntentStatus
  approvalId?: string
  approvalExpiresAt?: string
}

export type CreateAuthorizationResult = {
  intentId: string
  authorizationId: string
  grant: string
}

export type GetX402IntentResult = {
  intentId: string
  status: AgentPaymentIntentStatus
  requirements: PaymentRequirements
}

export type ReportX402ResultInput = {
  authorizationId: string
  requestOutcome: 'response_received' | 'timeout' | 'request_error' | 'signing_failed'
  httpStatus?: number
  paymentResponse?: string
  resourceBodyHash?: string
  signatureHash?: string
  reportedAt: string
}

export interface AgentPaymentsControl {
  createX402Intent(input: CreateX402IntentInput): Promise<CreateX402IntentResult>
  getX402Intent(intentId: string): Promise<GetX402IntentResult>
  createAuthorization(
    intentId: string,
    resourceUrl: string,
    requirements: PaymentRequirements,
  ): Promise<CreateAuthorizationResult>
  reportX402Result(intentId: string, input: ReportX402ResultInput): Promise<void>
  getBudget?(): Promise<AgentPaymentRuntimeBudget>
  getPayment?(intentId: string): Promise<AgentPaymentRecord>
  listRecentPayments?(limit?: number): Promise<AgentPaymentRecord[]>
}

export type SidecarAuthorizationResult = {
  grantId: string
  authorizationId: string
  walletAddress: string
  typedDataHash: Hex
  payload?: ExactEvmPayloadV2 | { transaction: string }
  authorization?: Required<ExactEIP3009Payload>['authorization']
  signature?: string
}

export interface AgentSignerSidecar {
  sign(grant: string): Promise<SidecarAuthorizationResult>
}

export type SafeHttpResponse = {
  status: number
  headers: Headers
  body: Uint8Array
  url: string
}

export interface SafeResourceRequester {
  get(
    url: string,
    options?: {
      headers?: Readonly<Record<string, string>>
      allowRedirects?: boolean
    },
  ): Promise<SafeHttpResponse>
}

export type X402FetchOptions = {
  idempotencyKey?: string
  resumeIntentId?: string
}

export type X402FetchResult =
  | {
      status: 'not_required'
      response: Response
      responseUrl: string
    }
  | {
      status: 'awaiting_approval'
      intentId: string
      approvalId?: string
      approvalExpiresAt?: string
    }
  | {
      status: 'paid'
      intentId: string
      authorizationId: string
      response: Response
      responseUrl: string
      paymentResponse?: SettleResponse
      resultReported: boolean
    }

export type ParsedX402Requirement = {
  paymentRequired: PaymentRequired
  selected: PaymentRequirements
}
