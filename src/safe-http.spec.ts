import { describe, expect, it } from 'vitest'

import { UnsafeResourceUrlError } from './errors'
import { SafeHttpsRequester, assertPublicAddress } from './safe-http'

describe('SafeHttpsRequester', () => {
  it.each([
    ['127.0.0.1', 4],
    ['10.0.0.1', 4],
    ['169.254.169.254', 4],
    ['192.168.1.1', 4],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['::ffff:127.0.0.1', 6],
  ] as const)('拒绝非公网地址 %s', (address, family) => {
    expect(() => assertPublicAddress({ address, family })).toThrow(UnsafeResourceUrlError)
  })

  it('接受公网地址', () => {
    expect(() => assertPublicAddress({ address: '93.184.216.34', family: 4 })).not.toThrow()
    expect(() =>
      assertPublicAddress({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }),
    ).not.toThrow()
  })

  it('连接前拒绝解析结果中混入的私网地址', async () => {
    const requester = new SafeHttpsRequester({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })
    await expect(requester.get('https://example.com')).rejects.toBeInstanceOf(
      UnsafeResourceUrlError,
    )
  })

  it('拒绝 HTTP 和 URL 用户信息', async () => {
    const requester = new SafeHttpsRequester()
    await expect(requester.get('http://example.com')).rejects.toBeInstanceOf(UnsafeResourceUrlError)
    await expect(requester.get('https://user@example.com')).rejects.toBeInstanceOf(
      UnsafeResourceUrlError,
    )
  })
})
