import { SidecarError } from './errors'
import type { AgentSignerSidecar, SidecarAuthorizationResult } from './types'
import { isAddress, isHex } from 'viem'

export type HttpAgentSignerSidecarOptions = {
  url: string
  authToken?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class HttpAgentSignerSidecar implements AgentSignerSidecar {
  private readonly url: string
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(private readonly options: HttpAgentSignerSidecarOptions) {
    const url = validateSidecarUrl(options.url)
    this.url = new URL('/v1/sign', url).toString()
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async sign(grant: string): Promise<SidecarAuthorizationResult> {
    let response: Response
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.options.authToken ? { authorization: `Bearer ${this.options.authToken}` } : {}),
        },
        body: JSON.stringify({ grant }),
      })
    } catch (error) {
      throw new SidecarError('signer sidecar request failed', error)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new SidecarError('signer sidecar returned invalid JSON', error)
    }
    if (!response.ok) {
      const message = extractSidecarMessage(payload)
      throw new SidecarError(message)
    }
    assertSidecarResult(payload)
    return payload
  }
}

function validateSidecarUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SidecarError('signer sidecar URL is invalid')
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SidecarError('plain HTTP sidecar URLs are only allowed on loopback')
  }
  if (url.username || url.password) {
    throw new SidecarError('signer sidecar URL must not contain user information')
  }
  return url
}

function assertSidecarResult(value: unknown): asserts value is SidecarAuthorizationResult {
  const result = value as SidecarAuthorizationResult
  if (
    !value ||
    typeof value !== 'object' ||
    typeof result.grantId !== 'string' ||
    result.grantId.length === 0 ||
    typeof result.authorizationId !== 'string' ||
    result.authorizationId.length === 0 ||
    !isAddress(result.walletAddress, { strict: false }) ||
    !isHex(result.typedDataHash, { strict: true }) ||
    result.typedDataHash.length !== 66 ||
    !isHex(result.signature, { strict: true }) ||
    result.signature.length !== 132 ||
    !result.authorization ||
    !isAddress(result.authorization.from, { strict: false }) ||
    !isAddress(result.authorization.to, { strict: false }) ||
    !/^[1-9]\d*$/u.test(result.authorization.value) ||
    !/^\d+$/u.test(result.authorization.validAfter) ||
    !/^[1-9]\d*$/u.test(result.authorization.validBefore) ||
    !isHex(result.authorization.nonce, { strict: true }) ||
    result.authorization.nonce.length !== 66
  ) {
    throw new SidecarError('signer sidecar returned an invalid authorization')
  }
}

function extractSidecarMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const error = (value as { error?: unknown }).error
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
  }
  return 'signer sidecar rejected the execution grant'
}
