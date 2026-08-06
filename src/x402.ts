import { decodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { getAddress, isAddress } from 'viem'

import { X402ProtocolError } from './errors'
import type { ParsedX402Requirement, SafeHttpResponse } from './types'

export const BASE_SEPOLIA_NETWORK = 'eip155:84532' as const
export const PAYMENT_REQUIRED_HEADER = 'payment-required'
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature'
export const PAYMENT_RESPONSE_HEADER = 'payment-response'
const MAX_PAYMENT_HEADER_LENGTH = 32 * 1024
const EVM_EXTRA_KEYS = new Set(['name', 'version', 'assetTransferMethod'])
const SVM_EXTRA_KEYS = new Set(['feePayer', 'recentBlockhash', 'lastValidBlockHeight', 'memo'])
const SVM_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u

const SUPPORTED_NETWORKS = new Map<string, { asset: string; method: 'eip3009' | 'permit2' | 'svm' }>([
  ['eip155:1', { asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', method: 'eip3009' }],
  ['eip155:8453', { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', method: 'eip3009' }],
  ['eip155:42161', { asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', method: 'eip3009' }],
  ['eip155:137', { asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', method: 'eip3009' }],
  ['eip155:10', { asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', method: 'eip3009' }],
  ['eip155:56', { asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', method: 'permit2' }],
  ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', method: 'svm' }],
  ['eip155:11155111', { asset: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', method: 'eip3009' }],
  [BASE_SEPOLIA_NETWORK, { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', method: 'eip3009' }],
  ['eip155:421614', { asset: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', method: 'eip3009' }],
  ['eip155:80002', { asset: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', method: 'eip3009' }],
  ['eip155:11155420', { asset: '0x5fD84259d66Cd46123540766Be93DFE6D43130D7', method: 'eip3009' }],
  ['eip155:97', { asset: '0x64544969ed7EBf5f083679233325356EbE738930', method: 'permit2' }],
  ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', { asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', method: 'svm' }],
])

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
    throw new X402ProtocolError('402 response does not offer a supported USDC exact payment')
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
    !sameAddress(original.network, original.asset, refreshed.asset) ||
    !sameAddress(original.network, original.payTo, refreshed.payTo)
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
    throw new X402ProtocolError('x402 extensions are not supported in the current release')
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
  const config = SUPPORTED_NETWORKS.get(requirement.network)
  if (!config) return false
  const evm = requirement.network.startsWith('eip155:')
  if (
    !requirement ||
    requirement.scheme !== 'exact' ||
    !(evm ? isAddress(requirement.asset) && isAddress(requirement.payTo) : SVM_ADDRESS_PATTERN.test(requirement.asset) && SVM_ADDRESS_PATTERN.test(requirement.payTo)) ||
    !sameAddress(requirement.network, requirement.asset, config.asset) ||
    !/^[1-9]\d*$/u.test(requirement.amount) ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0 ||
    requirement.maxTimeoutSeconds > 3600 ||
    !requirement.extra
  ) {
    return false
  }
  if (config.method === 'eip3009') {
    return (
      typeof requirement.extra.name === 'string' &&
      typeof requirement.extra.version === 'string' &&
      (requirement.extra.assetTransferMethod === undefined || requirement.extra.assetTransferMethod === 'eip3009') &&
      Object.keys(requirement.extra).every((key) => EVM_EXTRA_KEYS.has(key))
    )
  }
  if (config.method === 'permit2') {
    return requirement.extra.assetTransferMethod === 'permit2' && Object.keys(requirement.extra).every((key) => EVM_EXTRA_KEYS.has(key))
  }
  return typeof requirement.extra.feePayer === 'string' && SVM_ADDRESS_PATTERN.test(requirement.extra.feePayer) && Object.keys(requirement.extra).every((key) => SVM_EXTRA_KEYS.has(key))
}

function normalizeRequirement(requirement: PaymentRequirements): PaymentRequirements {
  return {
    ...requirement,
    asset: requirement.network.startsWith('eip155:') ? getAddress(requirement.asset) : requirement.asset,
    payTo: requirement.network.startsWith('eip155:') ? getAddress(requirement.payTo) : requirement.payTo,
    extra: { ...requirement.extra },
  }
}

function sameAddress(network: string, left: string, right: string): boolean {
  return network.startsWith('eip155:')
    ? isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right)
    : left === right
}

function compareAtomicAmounts(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function stableRequirementKey(requirement: PaymentRequirements): string {
  const evm = requirement.network.startsWith('eip155:')
  return JSON.stringify({
    scheme: requirement.scheme,
    network: requirement.network,
    asset: evm ? requirement.asset.toLowerCase() : requirement.asset,
    amount: requirement.amount,
    payTo: evm ? requirement.payTo.toLowerCase() : requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    extra: Object.fromEntries(
      Object.entries(requirement.extra).sort(([a], [b]) => a.localeCompare(b)),
    ),
  })
}
