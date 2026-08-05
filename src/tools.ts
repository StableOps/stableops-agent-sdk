export type AgentPaymentToolDefinition = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: false
  }
}

export const stableOpsX402FetchTool = {
  name: 'stableops_x402_fetch',
  description:
    'Purchase one HTTPS resource through StableOps x402 controls. Only use this when the task requires the named resource and the user has authorized paid API access.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The exact HTTPS resource URL to request.',
      },
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'A stable task-scoped key reused for retries of the same purchase.',
      },
      resumeIntentId: {
        type: 'string',
        minLength: 1,
        description: 'An approved StableOps payment intent to resume.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
} as const satisfies AgentPaymentToolDefinition

export const stableOpsGetBudgetTool = {
  name: 'stableops_get_budget',
  description:
    'Read the authenticated payment agent and organization UTC daily budget balances before deciding whether a paid request is affordable.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const satisfies AgentPaymentToolDefinition

export const stableOpsGetPaymentTool = {
  name: 'stableops_get_payment',
  description:
    'Read one payment intent owned by the authenticated payment agent. Use the original intent ID when recovering an approval or uncertain settlement.',
  inputSchema: {
    type: 'object',
    properties: {
      intentId: {
        type: 'string',
        minLength: 1,
        description: 'The StableOps payment intent ID returned by a previous request.',
      },
    },
    required: ['intentId'],
    additionalProperties: false,
  },
} as const satisfies AgentPaymentToolDefinition

export const stableOpsListRecentPaymentsTool = {
  name: 'stableops_list_recent_payments',
  description:
    'List recent payment intents owned by the authenticated payment agent for task recovery and status checks.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Maximum number of recent payments to return.',
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const satisfies AgentPaymentToolDefinition

export const agentPaymentTools = [
  stableOpsGetBudgetTool,
  stableOpsX402FetchTool,
  stableOpsGetPaymentTool,
  stableOpsListRecentPaymentsTool,
] as const
