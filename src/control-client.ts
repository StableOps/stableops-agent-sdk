import { ControlApiError } from './errors'
import type {
  AgentPaymentRecord,
  AgentPaymentRuntimeBudget,
  AgentPaymentsControl,
  CreateAuthorizationResult,
  CreateX402IntentInput,
  CreateX402IntentResult,
  GetX402IntentResult,
  ReportX402ResultInput,
} from './types'

export type AgentPaymentsControlClientOptions = {
  agentKey: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class AgentPaymentsControlClient implements AgentPaymentsControl {
  private readonly baseUrl: string
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(private readonly options: AgentPaymentsControlClientOptions) {
    if (!options.agentKey.startsWith('ak_sandbox_') && !options.agentKey.startsWith('ak_live_')) {
      throw new ControlApiError('agent key has an invalid prefix', 401, 'invalid_agent_key')
    }
    this.baseUrl = (options.baseUrl ?? 'https://api.stableops.dev').replace(/\/+$/u, '')
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  createX402Intent(input: CreateX402IntentInput): Promise<CreateX402IntentResult> {
    return this.request<WireIntentResult>('/v1/agent-payments/runtime/intents/x402', {
      method: 'POST',
      headers: { 'idempotency-key': input.idempotencyKey },
      body: {
        idempotency_key: input.idempotencyKey,
        method: input.method,
        resource_url: input.resourceUrl,
        requirements: toWireRequirements(input.requirements),
      },
    }).then(fromWireIntent)
  }

  createAuthorization(
    intentId: string,
    resourceUrl: string,
    requirements: CreateX402IntentInput['requirements'],
  ): Promise<CreateAuthorizationResult> {
    return this.request<WireAuthorizationResult>(
      `/v1/agent-payments/runtime/intents/${encodeURIComponent(intentId)}/authorization`,
      {
        method: 'POST',
        body: {
          resource_url: resourceUrl,
          requirements: toWireRequirements(requirements),
        },
      },
    ).then(fromWireAuthorization)
  }

  getX402Intent(intentId: string): Promise<GetX402IntentResult> {
    return this.request<WireIntentDetail>(
      `/v1/agent-payments/runtime/intents/${encodeURIComponent(intentId)}`,
      { method: 'GET' },
    ).then(fromWireIntentDetail)
  }

  getBudget(): Promise<AgentPaymentRuntimeBudget> {
    return this.request<WireRuntimeBudget>('/v1/agent-payments/runtime/budget', {
      method: 'GET',
    }).then(fromWireRuntimeBudget)
  }

  getPayment(intentId: string): Promise<AgentPaymentRecord> {
    return this.request<WireRuntimePayment>(
      `/v1/agent-payments/runtime/intents/${encodeURIComponent(intentId)}`,
      { method: 'GET' },
    ).then(fromWireRuntimePayment)
  }

  listRecentPayments(limit = 20): Promise<AgentPaymentRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ControlApiError('recent payment limit must be an integer from 1 to 50', 400)
    }
    return this.request<{ data: WireRuntimePayment[] }>(
      `/v1/agent-payments/runtime/payments?limit=${limit}`,
      { method: 'GET' },
    ).then((response) => response.data.map(fromWireRuntimePayment))
  }

  async reportX402Result(intentId: string, input: ReportX402ResultInput): Promise<void> {
    await this.request(
      `/v1/agent-payments/runtime/intents/${encodeURIComponent(intentId)}/result`,
      {
        method: 'POST',
        body: {
          authorization_id: input.authorizationId,
          request_outcome: input.requestOutcome,
          http_status: input.httpStatus,
          payment_response: input.paymentResponse,
          resource_body_hash: input.resourceBodyHash,
          signature_hash: input.signatureHash,
          reported_at: input.reportedAt,
        },
      },
    )
  }

  private async request<T>(
    path: string,
    options: {
      method: 'POST' | 'GET'
      headers?: Record<string, string>
      body?: unknown
    },
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.options.agentKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (error) {
      throw new ControlApiError(
        `StableOps Control API request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
      )
    }

    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      const error = extractApiError(payload)
      throw new ControlApiError(error.message, response.status, error.code)
    }
    return payload as T
  }
}

function toWireRequirements(requirements: CreateX402IntentInput['requirements']) {
  return {
    x402_version: 2,
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    pay_to: requirements.payTo,
    max_amount_atomic: requirements.amount,
    max_timeout_seconds: requirements.maxTimeoutSeconds,
    extra: requirements.extra,
  }
}

type WireIntentResult = {
  intent_id?: string
  intentId?: string
  status: CreateX402IntentResult['status']
  approval_id?: string
  approvalId?: string
  approval_expires_at?: string
  approvalExpiresAt?: string
}

type WireAuthorizationResult = {
  intent_id?: string
  intentId?: string
  authorization_id?: string
  authorizationId?: string
  grant: string
}

type WireRequirement = {
  scheme: string
  network: `${string}:${string}`
  asset: string
  amount?: string
  max_amount_atomic?: string
  pay_to?: string
  payTo?: string
  max_timeout_seconds?: number
  maxTimeoutSeconds?: number
  extra: Record<string, unknown>
}

type WireIntentDetail = WireIntentResult & {
  requirements: WireRequirement
}

type WireBudgetBalance = {
  limit_atomic: string
  reserved_atomic: string
  committed_atomic: string
  settled_atomic: string
  available_atomic: string
}

type WireRuntimeBudget = {
  asset: 'USDC'
  decimals: 6
  window_start: string
  window_end: string
  organization: WireBudgetBalance
  agent: WireBudgetBalance
}

type WireRuntimePayment = WireIntentResult & {
  resource_status: AgentPaymentRecord['resourceStatus']
  method: 'GET'
  resource_url: string
  origin: string
  pay_to: string
  network: string
  asset: 'USDC'
  asset_contract: string
  asset_decimals: number
  max_amount_atomic: string
  created_at: string
  updated_at: string
  settled_at: string | null
  requirements?: WireRequirement
}

function fromWireIntent(wire: WireIntentResult): CreateX402IntentResult {
  const intentId = wire.intent_id ?? wire.intentId
  if (!intentId || !wire.status) {
    throw new ControlApiError('Control API returned an invalid intent', 502)
  }
  return {
    intentId,
    status: wire.status,
    approvalId: wire.approval_id ?? wire.approvalId,
    approvalExpiresAt: wire.approval_expires_at ?? wire.approvalExpiresAt,
  }
}

function fromWireAuthorization(wire: WireAuthorizationResult): CreateAuthorizationResult {
  const intentId = wire.intent_id ?? wire.intentId
  const authorizationId = wire.authorization_id ?? wire.authorizationId
  if (!intentId || !authorizationId || !wire.grant) {
    throw new ControlApiError('Control API returned an invalid authorization', 502)
  }
  return { intentId, authorizationId, grant: wire.grant }
}

function fromWireIntentDetail(wire: WireIntentDetail): GetX402IntentResult {
  const intent = fromWireIntent(wire)
  return {
    intentId: intent.intentId,
    status: intent.status,
    requirements: fromWireRequirement(wire.requirements),
  }
}

function fromWireRequirement(requirement: WireRequirement) {
  const amount = requirement?.max_amount_atomic ?? requirement?.amount
  const payTo = requirement?.pay_to ?? requirement?.payTo
  const maxTimeoutSeconds = requirement?.max_timeout_seconds ?? requirement?.maxTimeoutSeconds
  if (!requirement || !amount || !payTo || maxTimeoutSeconds === undefined) {
    throw new ControlApiError('Control API returned invalid intent requirements', 502)
  }
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amount,
    payTo,
    maxTimeoutSeconds,
    extra: requirement.extra,
  }
}

function fromWireRuntimeBudget(wire: WireRuntimeBudget): AgentPaymentRuntimeBudget {
  if (wire.asset !== 'USDC' || wire.decimals !== 6 || !wire.window_start || !wire.window_end) {
    throw new ControlApiError('Control API returned an invalid budget', 502)
  }
  return {
    asset: wire.asset,
    decimals: wire.decimals,
    windowStart: wire.window_start,
    windowEnd: wire.window_end,
    organization: fromWireBudgetBalance(wire.organization),
    agent: fromWireBudgetBalance(wire.agent),
  }
}

function fromWireBudgetBalance(wire: WireBudgetBalance) {
  if (
    !wire ||
    typeof wire.limit_atomic !== 'string' ||
    typeof wire.reserved_atomic !== 'string' ||
    typeof wire.committed_atomic !== 'string' ||
    typeof wire.settled_atomic !== 'string' ||
    typeof wire.available_atomic !== 'string'
  ) {
    throw new ControlApiError('Control API returned invalid budget balances', 502)
  }
  return {
    limitAtomic: wire.limit_atomic,
    reservedAtomic: wire.reserved_atomic,
    committedAtomic: wire.committed_atomic,
    settledAtomic: wire.settled_atomic,
    availableAtomic: wire.available_atomic,
  }
}

function fromWireRuntimePayment(wire: WireRuntimePayment): AgentPaymentRecord {
  const intent = fromWireIntent(wire)
  if (
    !wire.resource_status ||
    wire.method !== 'GET' ||
    !wire.resource_url ||
    !wire.origin ||
    !wire.pay_to ||
    !wire.network ||
    wire.asset !== 'USDC' ||
    (wire.asset_decimals !== 6 && wire.asset_decimals !== 18) ||
    !wire.asset_contract ||
    typeof wire.max_amount_atomic !== 'string' ||
    !wire.created_at ||
    !wire.updated_at
  ) {
    throw new ControlApiError('Control API returned an invalid payment', 502)
  }
  return {
    intentId: intent.intentId,
    status: intent.status,
    resourceStatus: wire.resource_status,
    method: wire.method,
    resourceUrl: wire.resource_url,
    origin: wire.origin,
    payTo: wire.pay_to,
    network: wire.network,
    asset: wire.asset,
    assetContract: wire.asset_contract,
    assetDecimals: wire.asset_decimals,
    maxAmountAtomic: wire.max_amount_atomic,
    approvalId: intent.approvalId,
    approvalExpiresAt: intent.approvalExpiresAt,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    settledAt: wire.settled_at,
    requirements: wire.requirements ? fromWireRequirement(wire.requirements) : undefined,
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ControlApiError('Control API returned invalid JSON', response.status)
  }
}

function extractApiError(value: unknown): { code?: string; message: string } {
  if (value && typeof value === 'object') {
    const error = (value as { error?: unknown }).error
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') {
        return { code: typeof code === 'string' ? code : undefined, message }
      }
    }
  }
  return { message: 'Control API request was rejected' }
}
