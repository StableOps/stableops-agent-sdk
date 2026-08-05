import { decodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { getDefaultAsset } from '@x402/evm'
import { getAddress, isAddress } from 'viem'

import { X402ProtocolError } from './errors'
import type { ParsedX402Requirement, SafeHttpResponse } from './types'

export const BASE_SEPOLIA_NETWORK = 'eip155:84532' as const
export const PAYMENT_REQUIRED_HEADER = 'payment-required'
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature'
export const PAYMENT_RESPONSE_HEADER = 'payment-response'
const MAX_PAYMENT_HEADER_LENGTH = 32 * 1024
const ALLOWED_EXTRA_KEYS = new Set(['name', 'version', 'assetTransferMethod'])

export function parseX402Requirement(response: SafeHttpResponse): ParsedX402Requirement {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER)
  if (!header) {
    throw new X402ProtocolError('402 response is missing PAYMENT-REQUIRED')
  }
  if (header.length > MAX_PAYMENT_HEADER_LENGTH) {
    throw new X402ProtocolError('PAYMENT-REQUIRED exceeds the maximum header length')
  }

  let paymentRequired: PaymentRequired
  try {
    paymentRequired = decodePaymentRequiredHeader(header)
  } catch (error) {
    throw new X402ProtocolError('PAYMENT-REQUIRED is malformed', error)
  }
  validatePaymentRequired(paymentRequired, response.url)

  const supported = paymentRequired.accepts.filter(isSupportedRequirement).map(normalizeRequirement)
  if (supported.length === 0) {
    throw new X402ProtocolError('402 response does not offer Base Sepolia USDC exact payment')
  }

  supported.sort((left, right) => compareAtomicAmounts(left.amount, right.amount))
  const cheapest = supported[0]
  const tied = supported.filter((item) => item.amount === cheapest.amount)
  const unique = new Map(tied.map((item) => [stableRequirementKey(item), item]))
  if (unique.size !== 1) {
    throw new X402ProtocolError('402 response contains ambiguous cheapest payment options')
  }

  return { paymentRequired, selected: cheapest }
}

export function assertRequirementRefreshAllowed(
  original: PaymentRequirements,
  refreshed: PaymentRequirements,
): void {
  if (
    original.scheme !== refreshed.scheme ||
    original.network !== refreshed.network ||
    getAddress(original.asset) !== getAddress(refreshed.asset) ||
    getAddress(original.payTo) !== getAddress(refreshed.payTo)
  ) {
    throw new X402ProtocolError('refreshed payment target differs from the approved requirement')
  }
  if (BigInt(refreshed.amount) > BigInt(original.amount)) {
    throw new X402ProtocolError('refreshed payment amount exceeds the approved maximum')
  }
}

function validatePaymentRequired(paymentRequired: PaymentRequired, responseUrl: string): void {
  if (
    !paymentRequired ||
    typeof paymentRequired !== 'object' ||
    paymentRequired.x402Version !== 2 ||
    !Array.isArray(paymentRequired.accepts)
  ) {
    throw new X402ProtocolError('only x402 v2 payment requirements are supported')
  }
  if (paymentRequired.extensions && Object.keys(paymentRequired.extensions).length > 0) {
    throw new X402ProtocolError('x402 extensions are not supported in Private Alpha')
  }

  let declaredResource: URL
  let actualResource: URL
  try {
    declaredResource = new URL(paymentRequired.resource.url)
    actualResource = new URL(responseUrl)
  } catch {
    throw new X402ProtocolError('x402 resource URL is invalid')
  }
  if (declaredResource.protocol !== 'https:' || declaredResource.origin !== actualResource.origin) {
    throw new X402ProtocolError('x402 resource URL does not match the protected origin')
  }
}

function isSupportedRequirement(requirement: PaymentRequirements): boolean {
  const officialAsset = getDefaultAsset(BASE_SEPOLIA_NETWORK)
  if (
    !requirement ||
    requirement.scheme !== 'exact' ||
    requirement.network !== BASE_SEPOLIA_NETWORK ||
    !isAddress(requirement.asset, { strict: false }) ||
    !isAddress(requirement.payTo, { strict: false }) ||
    getAddress(requirement.asset) !== getAddress(officialAsset.address) ||
    !/^[1-9]\d*$/u.test(requirement.amount) ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0 ||
    requirement.maxTimeoutSeconds > 3600 ||
    !requirement.extra ||
    requirement.extra.name !== officialAsset.name ||
    requirement.extra.version !== officialAsset.version ||
    (requirement.extra.assetTransferMethod !== undefined &&
      requirement.extra.assetTransferMethod !== 'eip3009')
  ) {
    return false
  }
  return Object.keys(requirement.extra).every((key) => ALLOWED_EXTRA_KEYS.has(key))
}

function normalizeRequirement(requirement: PaymentRequirements): PaymentRequirements {
  return {
    ...requirement,
    asset: getAddress(requirement.asset),
    payTo: getAddress(requirement.payTo),
    extra: { ...requirement.extra },
  }
}

function compareAtomicAmounts(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function stableRequirementKey(requirement: PaymentRequirements): string {
  return JSON.stringify({
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset.toLowerCase(),
    amount: requirement.amount,
    payTo: requirement.payTo.toLowerCase(),
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    extra: Object.fromEntries(
      Object.entries(requirement.extra).sort(([a], [b]) => a.localeCompare(b)),
    ),
  })
}
