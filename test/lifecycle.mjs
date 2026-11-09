/**
 * Lifecycle test: access must go ON before web work and OFF afterwards.
 * Leaves the machine with proxy/TUN off (the requested default).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { disableAccess, enableAccess, heal, kernelTunEnabled, readController, resolveConfig, sysProxyStatus } from '../index.js'

const cfg = resolveConfig()
const { secret } = readController(cfg.dataDir)

const registryEnable = () => {
  const out = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { encoding: 'utf8' })
  const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.stdout || '')
  return m ? parseInt(m[1], 16) : -1
}
const state = async () => {
  const proxy = await sysProxyStatus(cfg)
  const tun = await kernelTunEnabled(cfg, secret)
  return { appProxy: proxy.enabled, registry: registryEnable(), tun }
}
const show = (label, s) => console.log(`${label.padEnd(22)} app=${s.appProxy} registry=${s.registry} tun=${s.tun}`)

console.log('=== 0. clean slate ===')
await disableAccess(cfg, [])
let s0 = await state()
show('after disableAccess', s0)
assert.equal(s0.appProxy, false)
assert.equal(s0.registry, 0)
assert.equal(s0.tun, false)

console.log('\n=== 1. enableAccess() ===')
await enableAccess(cfg, [])
let s1 = await state()
show('after enableAccess', s1)
assert.equal(s1.appProxy, true, 'app must report the system proxy on')
assert.equal(s1.registry, 1, 'registry must really be on')
assert.equal(s1.tun, true, 'kernel TUN must be on')

console.log('\n=== 2. stability (5s) ===')
await new Promise((r) => setTimeout(r, 5000))
let s2 = await state()
show('after 5s', s2)
assert.equal(s2.appProxy, true, 'system proxy must stay on')
assert.equal(s2.registry, 1, 'registry must stay on')
assert.equal(s2.tun, true, 'TUN must stay on')

console.log('\n=== 3. disableAccess() ===')
await disableAccess(cfg, [])
let s3 = await state()
show('after disableAccess', s3)
assert.equal(s3.appProxy, false)
assert.equal(s3.registry, 0, 'registry must really be off')
assert.equal(s3.tun, false, 'TUN must be off')

console.log('\n=== 4. heal() from the off state ===')
// github is directly reachable on this machine, so it must NOT trigger a repair.
const healthy = await heal(cfg, { url: 'https://github.com' })
console.log('healthy target:', healthy.summary)
assert.equal(healthy.needed, false, 'a reachable target must not trigger a repair')

// An unresolvable host must run the full repair path and turn access on.
const report = await heal(cfg, { url: 'https://dsh-net-heal-probe.invalid' })
console.log('broken target :', report.summary)
console.log('steps         :', report.steps.map((x) => `${x.step}:${x.ok}`).join(' '))
assert.equal(report.needed, true, 'an unreachable target must trigger a repair')
assert.equal(report.healed, false, 'an unresolvable host cannot be healed')
let s4 = await state()
show('after heal', s4)
assert.equal(s4.appProxy, true, 'heal must turn the system proxy on')
assert.equal(s4.tun, true, 'heal must turn TUN on')

console.log('\n=== 5. back to off ===')
await disableAccess(cfg, [])
let s5 = await state()
show('final', s5)
assert.equal(s5.appProxy, false)
assert.equal(s5.registry, 0)
assert.equal(s5.tun, false)

console.log('\nLIFECYCLE OK')
