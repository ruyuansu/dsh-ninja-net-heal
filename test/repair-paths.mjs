/**
 * Verifies the two repair actions actually flip a disabled state back on.
 * Each phase leaves the machine in the desired state (proxy + TUN enabled).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { controllerCall, ensureSystemProxy, ensureTun, readController, resolveConfig } from '../index.js'

const cfg = resolveConfig()
const { secret } = readController(cfg.dataDir)
assert.ok(secret, 'controller secret required')

const setTun = (enable) =>
  controllerCall(cfg, secret, { method: 'PATCH', path: '/configs', body: { tun: { enable } } })
const tunEnabled = async () => {
  const r = await controllerCall(cfg, secret, { path: '/configs' })
  return Boolean(r.ok && r.json && r.json.tun && r.json.tun.enable === true)
}

const registryEnable = () => {
  const out = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { encoding: 'utf8' })
  const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.stdout || '')
  return m ? parseInt(m[1], 16) : -1
}

try {
  console.log('=== phase 1: TUN off -> ensureTun() ===')
  await setTun(false)
  console.log('tun after disable :', await tunEnabled())
  assert.equal(await tunEnabled(), false, 'TUN should be off before the test')

  const tun = await ensureTun(cfg, secret)
  console.log('ensureTun result  :', JSON.stringify(tun))
  assert.equal(tun.ok, true)
  assert.equal(await tunEnabled(), true, 'TUN must be back on')
  console.log('TUN restored      :', await tunEnabled())

  console.log('\n=== phase 2: system proxy off -> ensureSystemProxy() ===')
  spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'])
  console.log('proxy before      :', registryEnable())
  assert.equal(registryEnable(), 0, 'proxy should be off before the test')

  const proxy = await ensureSystemProxy(cfg, true)
  console.log('ensureSystemProxy :', JSON.stringify({ ok: proxy.ok, changed: proxy.changed, detail: proxy.detail, state: proxy.state }))
  assert.equal(proxy.ok, true)
  assert.equal(proxy.changed, true, 'proxy should have been flipped on')
  assert.equal(registryEnable(), 1, 'proxy must be back on')
  console.log('proxy restored    :', registryEnable())

  console.log('\nREPAIR PATHS OK')
} catch (error) {
  console.error('FAILED:', error.message)
  console.error('restoring desired state...')
  await setTun(true)
  spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'])
  console.error('tun enabled:', await tunEnabled(), 'proxy enable:', registryEnable())
  process.exitCode = 1
}
