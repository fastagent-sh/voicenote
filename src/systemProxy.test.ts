import { describe, expect, it } from 'bun:test'
import { macProxyFromScutil, windowsProxyFromRegistry } from './core.ts'

// A GUI launched from Finder or the Start menu inherits no shell environment,
// so whatever the OS is configured with is the only proxy it can discover.
// Both parsers are pure so either platform's format can be checked anywhere.

describe('macProxyFromScutil', () => {
  const scutil = (body: string) => `<dictionary> {\n${body}\n}`

  it('prefers the HTTPS entry', () => {
    expect(macProxyFromScutil(scutil(`
      HTTPEnable : 1
      HTTPPort : 7897
      HTTPProxy : 127.0.0.1
      HTTPSEnable : 1
      HTTPSPort : 7898
      HTTPSProxy : 10.0.0.2
    `))).toBe('http://10.0.0.2:7898')
  })

  it('takes SOCKS when no HTTP proxy is enabled', () => {
    expect(macProxyFromScutil(scutil(`
      HTTPEnable : 0
      HTTPSEnable : 0
      SOCKSEnable : 1
      SOCKSPort : 7897
      SOCKSProxy : 127.0.0.1
    `))).toBe('socks5://127.0.0.1:7897')
  })

  it('ignores a proxy that is configured but switched off', () => {
    expect(macProxyFromScutil(scutil(`
      HTTPEnable : 0
      HTTPPort : 7897
      HTTPProxy : 127.0.0.1
      SOCKSEnable : 0
      ProxyAutoConfigEnable : 1
    `))).toBeNull()
  })
})

describe('windowsProxyFromRegistry', () => {
  const reg = (body: string) => `\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n${body}\n`

  it('reads a bare host:port', () => {
    expect(windowsProxyFromRegistry(reg(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    `))).toBe('http://127.0.0.1:7890')
  })

  it('picks HTTPS out of a per-protocol setting, over plain HTTP to the proxy', () => {
    expect(windowsProxyFromRegistry(reg(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892
    `))).toBe('http://127.0.0.1:7891')
  })

  it('falls back to SOCKS when that is all there is', () => {
    expect(windowsProxyFromRegistry(reg(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    socks=127.0.0.1:7892
    `))).toBe('socks5://127.0.0.1:7892')
  })

  it('ignores a proxy that is configured but switched off', () => {
    expect(windowsProxyFromRegistry(reg(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
    `))).toBeNull()
  })
})
