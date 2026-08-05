import { describe, expect, it } from 'vitest'

import {
  agentPaymentTools,
  stableOpsGetBudgetTool,
  stableOpsGetPaymentTool,
  stableOpsListRecentPaymentsTool,
  stableOpsX402FetchTool,
} from './tools'

describe('Agent Payments 工具定义', () => {
  it('只导出计划内四个最小权限工具', () => {
    expect(agentPaymentTools).toEqual([
      stableOpsGetBudgetTool,
      stableOpsX402FetchTool,
      stableOpsGetPaymentTool,
      stableOpsListRecentPaymentsTool,
    ])
    expect(agentPaymentTools.map((tool) => tool.name)).toEqual([
      'stableops_get_budget',
      'stableops_x402_fetch',
      'stableops_get_payment',
      'stableops_list_recent_payments',
    ])
  })

  it('只读工具不暴露签名、策略或钱包参数', () => {
    expect(stableOpsGetBudgetTool.inputSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
    expect(stableOpsGetPaymentTool.inputSchema.required).toEqual(['intentId'])
    expect(stableOpsListRecentPaymentsTool.inputSchema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    })
  })
})
