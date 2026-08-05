import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'

import {
  CrossOriginRedirectError,
  PaidRequestRedirectError,
  ResourceRequestTimeoutError,
  ResourceResponseTooLargeError,
  UnsafeResourceUrlError,
} from './errors'
import type { SafeHttpResponse, SafeResourceRequester } from './types'

export type ResolvedAddress = {
  address: string
  family: 4 | 6
}

export type SafeHttpsRequesterOptions = {
  resolver?: (hostname: string) => Promise<ResolvedAddress[]>
  timeoutMs?: number
  maxBodyBytes?: number
  maxRedirects?: number
  maxHeaderBytes?: number
}

const blockedAddresses = createBlockedAddressLists()
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class SafeHttpsRequester implements SafeResourceRequester {
  private readonly resolver: NonNullable<SafeHttpsRequesterOptions['resolver']>
  private readonly timeoutMs: number
  private readonly maxBodyBytes: number
  private readonly maxRedirects: number
  private readonly maxHeaderBytes: number

  constructor(options: SafeHttpsRequesterOptions = {}) {
    this.resolver = options.resolver ?? defaultResolver
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024
    this.maxRedirects = options.maxRedirects ?? 3
    this.maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024
  }

  async get(
    input: string,
    options: {
      headers?: Readonly<Record<string, string>>
      allowRedirects?: boolean
    } = {},
  ): Promise<SafeHttpResponse> {
    const initial = parseSafeUrl(input)
    const origin = initial.origin
    let current = initial

    for (let redirect = 0; ; redirect += 1) {
      const response = await this.requestOnce(current, options.headers)
      if (!REDIRECT_STATUSES.has(response.status)) return response
      if (options.allowRedirects === false) throw new PaidRequestRedirectError()
      if (redirect >= this.maxRedirects) {
        throw new UnsafeResourceUrlError('resource exceeded the redirect limit')
      }

      const location = response.headers.get('location')
      if (!location) {
        throw new UnsafeResourceUrlError('redirect response is missing Location')
      }
      const next = parseSafeUrl(new URL(location, current).toString())
      if (next.origin !== origin) throw new CrossOriginRedirectError()
      current = next
    }
  }

  private async requestOnce(
    url: URL,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<SafeHttpResponse> {
    const certificateHostname = stripIpv6Brackets(url.hostname)
    const addresses = await this.resolver(certificateHostname)
    if (addresses.length === 0) {
      throw new UnsafeResourceUrlError('resource hostname did not resolve')
    }
    for (const address of addresses) assertPublicAddress(address)
    const selected = addresses[0]

    return new Promise<SafeHttpResponse>((resolve, reject) => {
      const request = httpsRequest({
        protocol: 'https:',
        hostname: selected.address,
        family: selected.family,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: isIP(certificateHostname) === 0 ? certificateHostname : undefined,
        maxHeaderSize: this.maxHeaderBytes,
        headers: {
          accept: '*/*',
          ...headers,
          host: url.host,
        },
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(certificateHostname, certificate),
      })

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new ResourceRequestTimeoutError())
      })
      request.once('error', reject)
      request.once('response', (response) => {
        const remoteAddress = response.socket.remoteAddress
        if (!remoteAddress || !sameAddress(remoteAddress, selected.address)) {
          response.destroy()
          reject(
            new UnsafeResourceUrlError('connected address differs from the validated DNS result'),
          )
          return
        }

        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > this.maxBodyBytes) {
            response.destroy(new ResourceResponseTooLargeError())
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item)
            } else if (value !== undefined) {
              responseHeaders.set(name, value)
            }
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            url: url.toString(),
          })
        })
      })
      request.end()
    })
  }
}

export function assertPublicAddress(value: ResolvedAddress): void {
  const detectedFamily = isIP(value.address)
  if (detectedFamily !== value.family) {
    throw new UnsafeResourceUrlError('DNS resolver returned an invalid IP address')
  }
  const family = value.family === 4 ? 'ipv4' : 'ipv6'
  const blockList = value.family === 4 ? blockedAddresses.ipv4 : blockedAddresses.ipv6
  if (blockList.check(value.address, family)) {
    throw new UnsafeResourceUrlError('resource resolved to a non-public IP address')
  }
}

function parseSafeUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new UnsafeResourceUrlError('resource URL is invalid')
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeResourceUrlError('resource URL must use HTTPS')
  }
  if (url.username || url.password) {
    throw new UnsafeResourceUrlError('resource URL must not contain user information')
  }
  if (!url.hostname) {
    throw new UnsafeResourceUrlError('resource URL must contain a hostname')
  }
  return url
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const directFamily = isIP(hostname)
  if (directFamily === 4 || directFamily === 6) {
    return [{ address: hostname, family: directFamily }]
  }
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new UnsafeResourceUrlError('DNS resolver returned an unsupported address family')
    }
    return {
      address: answer.address,
      family: answer.family,
    }
  })
}

function createBlockedAddressLists(): { ipv4: BlockList; ipv6: BlockList } {
  const ipv4 = new BlockList()
  const ipv6 = new BlockList()
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    ipv4.addSubnet(address, prefix, 'ipv4')
  }
  for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    ipv6.addSubnet(address, prefix, 'ipv6')
  }
  return { ipv4, ipv6 }
}

function sameAddress(actual: string, expected: string): boolean {
  const family = isIP(expected)
  if ((family !== 4 && family !== 6) || isIP(actual) !== family) return false
  const blockList = new BlockList()
  const type = family === 4 ? 'ipv4' : 'ipv6'
  blockList.addAddress(expected, type)
  return blockList.check(actual, type)
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
