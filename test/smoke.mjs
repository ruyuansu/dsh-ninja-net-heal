import assert from 'node:assert/strict'
import { heal, probeDirect, probeViaProxy, readController, resolveConfig } from '../index.js'

const cfg = resolveConfig()

console.log('config:', JSON.stringify(cfg, null, 2))
const controller = readController(cfg.dataDir)
console.log('controller secret found:', Boolean(controller.secret))

const reachable = await probeDirect('https://github.com', 10000)
const proxied = await probeViaProxy('https://github.com', cfg.proxyPort, 10000)
console.log('probe github direct :', JSON.stringify(reachable))
console.log('probe github proxy  :', JSON.stringify(proxied))
assert.equal(typeof reachable.ok, 'boolean')

console.log('\n--- healthy target: no repair expected ---')
const healthy = await heal(cfg, { url: 'https://github.com' })
console.log(JSON.stringify(healthy, null, 2))
assert.equal(healthy.needed, false, 'github.com should already be reachable')

console.log('\n--- broken target: full repair path expected ---')
const broken = await heal(cfg, { url: 'https://dsh-net-heal-probe.invalid' })
console.log(JSON.stringify(broken, null, 2))
assert.equal(broken.needed, true, 'an unresolvable host must trigger repair')
assert.ok(Array.isArray(broken.steps) && broken.steps.length >= 3)
const tunStep = broken.steps.find((step) => step.step === 'tun')
const proxyStep = broken.steps.find((step) => step.step === 'system-proxy')
console.log('\nTUN step   :', JSON.stringify(tunStep))
console.log('proxy step :', JSON.stringify(proxyStep))
assert.ok(tunStep && tunStep.ok, 'TUN must be reported as enabled')
assert.ok(proxyStep && proxyStep.ok, 'system proxy must be reported as enabled')

console.log('\nSMOKE OK')
