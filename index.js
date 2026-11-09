/**
 * dsh-ninja-net-heal — automatic proxy/TUN window around web access.
 *
 * Behaviour (per user request):
 *   Before a web tool runs, turn the NinjaDesktop system proxy and TUN ON.
 *   After web access finishes, turn them back OFF.
 *
 * Why the application's own API is used
 *   NinjaDesktop owns both switches. Writing the WinINet registry key or the
 *   mihomo tun flag directly is not enough: the application keeps its own
 *   state and re-asserts it, which made the system proxy appear "stuck off".
 *   The authoritative calls are:
 *     POST /api/sysproxy/enable | disable | GET /api/sysproxy/status
 *     PUT  /api/config   { system_proxy: true|false, tun_mode: true|false }
 *   The registry write is kept only as a verified fallback.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

const PLUGIN_ID = 'dsh-ninja-net-heal'
const USER_AGENT = `${PLUGIN_ID}/2.0`
const WEB_TOOLS = new Set(['web_fetch', 'web_search', 'read_page', 'fetch'])

const DEFAULT_CONFIG = {
  /** NinjaDesktop executable, launched when its backend is not reachable. */
  exePath: 'C:\\Program Files\\NinjaDesktop\\NinjaDesktop.exe',
  /** Directory holding NinjaDesktop's kernel_session.json / appconfig.yaml. */
  dataDir: '',
  /** Application backend (web server + privileged helper). */
  appBaseUrl: 'http://127.0.0.1:9190',
  /** mihomo external controller port, used to read the real TUN state. */
  controllerPort: 9799,
  /** Mixed proxy port (system proxy target, proxy probe target). */
  proxyPort: 7897,
  /** Turn proxy + TUN on before web tools and off after them. */
  manageOnWebAccess: true,
  /** Keep them on this long after the last web call, to avoid flapping. */
  idleGraceMs: 15000,
  /** 'disable' always ends off; 'restore' returns to the state from before. */
  releaseMode: 'disable',
  /** URL used when a caller gives none. */
  probeUrl: 'https://github.com',
  probeTimeoutMs: 8000,
  /** How long to wait for the backend after launching the application. */
  launchTimeoutMs: 45000,
  /** Verification polling after a switch. */
  verifyAttempts: 8,
  verifyDelayMs: 500,
  /** Probe a failed web call and repair it in the background. */
  autoHeal: true,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

export function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }
  if (!merged.dataDir) merged.dataDir = path.join(localAppData(), 'NinjaDesktop')
  for (const key of ['controllerPort', 'proxyPort', 'probeTimeoutMs', 'launchTimeoutMs', 'verifyAttempts', 'verifyDelayMs', 'idleGraceMs']) {
    merged[key] = Number(merged[key]) || DEFAULT_CONFIG[key]
  }
  merged.appBaseUrl = String(merged.appBaseUrl || DEFAULT_CONFIG.appBaseUrl).replace(/\/+$/, '')
  return merged
}

/* --------------------------------------------------------------- transports */

function httpJson({ baseUrl, port, host = '127.0.0.1', method = 'GET', route, body, timeout = 8000, headers = {} }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const requestHeaders = { ...headers }
    if (payload) {
      requestHeaders['Content-Type'] = 'application/json'
      requestHeaders['Content-Length'] = String(payload.length)
    }
    let options
    if (baseUrl) {
      const url = new URL(baseUrl)
      options = { hostname: url.hostname, port: url.port || 80, method, path: route, headers: requestHeaders, timeout }
    } else {
      options = { hostname: host, port, method, path: route, headers: requestHeaders, timeout }
    }
    const request = http.request(options, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        const status = response.statusCode || 0
        resolve({ ok: status >= 200 && status < 300, status, json, text })
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.code || error.message }))
    if (payload) request.write(payload)
    request.end()
  })
}

/* ------------------------------------------------------ application backend */

export function readController(dataDir) {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(dataDir, 'kernel_session.json'), 'utf8'))
    if (session && session.secret) return { secret: String(session.secret), addr: session.controller_addr || '' }
  } catch {
    /* fall through */
  }
  try {
    const bootstrap = fs.readFileSync(path.join(dataDir, 'bootstrap.yaml'), 'utf8')
    const match = /^\s*secret:\s*(\S+)\s*$/m.exec(bootstrap)
    if (match) return { secret: match[1], addr: '' }
  } catch {
    /* no secret on disk */
  }
  return { secret: '', addr: '' }
}

export async function sysProxyStatus(config) {
  const response = await httpJson({ baseUrl: config.appBaseUrl, route: '/api/sysproxy/status', timeout: 5000 })
  const enabled = Boolean(response.ok && response.json && response.json.enabled === true)
  return { ok: response.ok, enabled, json: response.json, error: response.error, status: response.status }
}

export async function readAppConfig(config) {
  return httpJson({ baseUrl: config.appBaseUrl, route: '/api/config', timeout: 6000 })
}

/** Merge-and-write: the endpoint expects a full config object. */
export async function writeAppConfig(config, patch) {
  const current = await readAppConfig(config)
  if (!current.ok || !current.json) return { ok: false, error: current.error || `HTTP ${current.status}` }
  const next = { ...current.json, ...patch }
  const written = await httpJson({ baseUrl: config.appBaseUrl, method: 'PUT', route: '/api/config', body: next, timeout: 25000 })
  return { ok: written.ok, error: written.error || (written.ok ? undefined : `HTTP ${written.status}`), json: written.json }
}

export async function setSysProxy(config, enable) {
  const route = enable ? '/api/sysproxy/enable' : '/api/sysproxy/disable'
  const response = await httpJson({ baseUrl: config.appBaseUrl, method: 'POST', route, timeout: 25000 })
  return { ok: response.ok, error: response.error || (response.ok ? undefined : `HTTP ${response.status}`), json: response.json }
}

export async function kernelTunEnabled(config, secret) {
  const response = await httpJson({
    port: config.controllerPort,
    route: '/configs',
    timeout: 5000,
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  })
  if (!response.ok || !response.json || !response.json.tun) return null
  return response.json.tun.enable === true
}

function isAppRunning() {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq NinjaDesktop.exe', '/NH'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('close', () => resolve(/ninjadesktop\.exe/i.test(out)))
    child.on('error', () => resolve(false))
  })
}

export function launchApp(exePath) {
  if (!fs.existsSync(exePath)) return { ok: false, detail: `可执行文件不存在：${exePath}` }
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return { ok: true, detail: `已启动 ${exePath}` }
  } catch (error) {
    return { ok: false, detail: `启动失败：${error.message || error}` }
  }
}

async function waitForBackend(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await sysProxyStatus(config)
    if (status.ok) return true
    await sleep(800)
  }
  return false
}

/* ------------------------------------------------- registry fallback (rare) */

function runPowerShell(script, timeoutMs = 20000) {
  const shell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  return new Promise((resolve) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: error.message || String(error) })
    })
  })
}

/**
 * Last-resort WinINet write. Only used when the application's own endpoint
 * reports success but the registry still shows the proxy off.
 */
export async function registryProxy(config, enable) {
  const server = `http=127.0.0.1:${config.proxyPort};https=127.0.0.1:${config.proxyPort};socks=127.0.0.1:${config.proxyPort}`
  const script = `
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $key -Name ProxyEnable -Value ${enable ? 1 : 0} -Type DWord
Set-ItemProperty -Path $key -Name ProxyServer -Value '${server}' -Type String
Add-Type -Namespace NinjaSelfHeal -Name WinINet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);'
[NinjaSelfHeal.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[NinjaSelfHeal.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
$after = Get-ItemProperty -Path $key
Write-Output ('[state]' + (ConvertTo-Json -Compress -InputObject @{ enable = $after.ProxyEnable }))
`.trim()
  const result = await runPowerShell(script)
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('[state]'))
  let enableValue = null
  if (line) {
    try {
      enableValue = Number(JSON.parse(line.slice('[state]'.length)).enable)
    } catch {
      enableValue = null
    }
  }
  return { ok: result.code === 0 && enableValue === (enable ? 1 : 0), detail: result.stderr || `registry enable=${enableValue}` }
}

/* ------------------------------------------------------------ probe helpers */

export function probeDirect(url, timeoutMs = 8000) {
  const started = Date.now()
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve({ ok: false, status: 0, error: 'invalid url', ms: 0 })
      return
    }
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(
      {
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Connection: 'close' },
      },
      (response) => {
        const status = response.statusCode || 0
        response.resume()
        resolve({ ok: status > 0 && status < 500, status, ms: Date.now() - started })
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.code || error.message, ms: Date.now() - started }))
    request.end()
  })
}

export function probeViaProxy(url, proxyPort = 7897, timeoutMs = 8000) {
  const started = Date.now()
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve({ ok: false, status: 0, error: 'invalid url', ms: 0 })
      return
    }
    if (target.protocol !== 'https:') {
      resolve({ ok: false, status: 0, error: 'proxy probe needs https', ms: 0 })
      return
    }
    const port = Number(target.port || 443)
    const authority = `${target.hostname}:${port}`
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      timeout: timeoutMs,
      headers: { Host: authority },
    })
    const fail = (error, status = 0) => resolve({ ok: false, status, error, ms: Date.now() - started })
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(`proxy connect ${response.statusCode}`, response.statusCode)
        return
      }
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'], timeout: timeoutMs })
      secure.on('error', (error) => fail(error.code || error.message))
      secure.on('timeout', () => secure.destroy(new Error('timeout')))
      secure.on('secureConnect', () => {
        const inner = https.request(
          {
            host: target.hostname,
            port,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            createConnection: () => secure,
            headers: { Host: target.hostname, 'User-Agent': USER_AGENT, Connection: 'close' },
          },
          (reply) => {
            const status = reply.statusCode || 0
            reply.resume()
            resolve({ ok: status > 0 && status < 500, status, ms: Date.now() - started })
          },
        )
        inner.on('error', (error) => fail(error.code || error.message))
        inner.end()
      })
    })
    connect.on('timeout', () => connect.destroy(new Error('timeout')))
    connect.on('error', (error) => fail(error.code || error.message))
    connect.end()
  })
}

/* ---------------------------------------------------------------- switching */

async function verify(config, expect) {
  const { secret } = readController(config.dataDir)
  let last = { proxy: null, tun: null }
  for (let attempt = 1; attempt <= config.verifyAttempts; attempt += 1) {
    const status = await sysProxyStatus(config)
    const tun = await kernelTunEnabled(config, secret)
    last = { proxy: status.enabled, tun, rawProxy: status }
    if (status.enabled === expect && tun === expect) return { ok: true, attempts: attempt, ...last }
    await sleep(config.verifyDelayMs)
  }
  return { ok: false, attempts: config.verifyAttempts, ...last }
}

async function switchOn(config, steps) {
  let backend = await sysProxyStatus(config)
  if (!backend.ok) {
    const running = await isAppRunning()
    if (!running) {
      const launched = launchApp(config.exePath)
      steps.push({ step: 'launch', ok: launched.ok, detail: launched.detail })
    }
    const ready = await waitForBackend(config, config.launchTimeoutMs)
    steps.push({ step: 'backend', ok: ready, detail: ready ? 'NinjaDesktop 后端已就绪' : '等待后端超时' })
    if (!ready) return { ok: false, steps }
  }

  const configWrite = await writeAppConfig(config, { system_proxy: true, tun_mode: true })
  steps.push({ step: 'config', ok: configWrite.ok, detail: configWrite.ok ? 'tun_mode/system_proxy = true' : `写配置失败：${configWrite.error}` })

  const proxyToggle = await setSysProxy(config, true)
  steps.push({ step: 'sysproxy', ok: proxyToggle.ok, detail: proxyToggle.ok ? '已请求开启系统代理' : `开启失败：${proxyToggle.error}` })

  let result = await verify(config, true)
  if (!result.ok && result.proxy === false) {
    const fallback = await registryProxy(config, true)
    steps.push({ step: 'sysproxy-fallback', ok: fallback.ok, detail: `应用接口未生效，改用注册表直写：${fallback.detail}` })
    result = await verify(config, true)
  }
  steps.push({ step: 'verify-on', ok: result.ok, detail: `proxy=${result.proxy} tun=${result.tun}` })
  return { ok: result.ok, steps }
}

async function switchOff(config, steps) {
  const backend = await sysProxyStatus(config)
  if (!backend.ok) {
    steps.push({ step: 'backend', ok: false, detail: 'NinjaDesktop 后端不可用，跳过关闭' })
    return { ok: false, steps }
  }
  const configWrite = await writeAppConfig(config, { system_proxy: false, tun_mode: false })
  steps.push({ step: 'config', ok: configWrite.ok, detail: configWrite.ok ? 'tun_mode/system_proxy = false' : `写配置失败：${configWrite.error}` })

  const proxyToggle = await setSysProxy(config, false)
  steps.push({ step: 'sysproxy', ok: proxyToggle.ok, detail: proxyToggle.ok ? '已请求关闭系统代理' : `关闭失败：${proxyToggle.error}` })

  let result = await verify(config, false)
  if (!result.ok && result.proxy === true) {
    const fallback = await registryProxy(config, false)
    steps.push({ step: 'sysproxy-fallback', ok: fallback.ok, detail: `应用接口未生效，改用注册表直写：${fallback.detail}` })
    result = await verify(config, false)
  }
  steps.push({ step: 'verify-off', ok: result.ok, detail: `proxy=${result.proxy} tun=${result.tun}` })
  return { ok: result.ok, steps }
}

/** Current state, used by releaseMode 'restore'. */
export async function snapshot(config) {
  const status = await sysProxyStatus(config)
  const { secret } = readController(config.dataDir)
  const tun = await kernelTunEnabled(config, secret)
  return { proxy: status.enabled === true, tun: tun === true, available: status.ok }
}

/* -------------------------------------------------------------- public heal */

export async function enableAccess(config, steps = []) {
  return switchOn(config, steps)
}

export async function disableAccess(config, steps = []) {
  return switchOff(config, steps)
}

function brief(probe) {
  return { ok: probe.ok, status: probe.status || 0, ...(probe.error ? { error: probe.error } : {}), ms: probe.ms || 0 }
}

/**
 * Probe, switch access on, re-probe. Used by the net_self_heal tool and by the
 * automatic repair after a failed web call.
 */
export async function heal(config, options = {}) {
  const cfg = resolveConfig(config)
  const target = typeof options.url === 'string' && options.url ? options.url : cfg.probeUrl
  const startedAt = Date.now()
  const steps = []

  const direct = await probeDirect(target, cfg.probeTimeoutMs)
  const proxy = await probeViaProxy(target, cfg.proxyPort, cfg.probeTimeoutMs)
  steps.push({ step: 'probe', ok: direct.ok || proxy.ok, detail: `直连 ${direct.ok ? 'OK' : direct.error || direct.status}；代理 ${proxy.ok ? 'OK' : proxy.error || proxy.status}` })

  if (direct.ok || proxy.ok) {
    const report = { healed: true, needed: false, target, probes: { direct: brief(direct), proxy: brief(proxy) }, steps, elapsedMs: Date.now() - startedAt }
    report.summary = `外网可访问，无需修复：${target}`
    return report
  }

  const switched = await switchOn(cfg, steps)
  await sleep(1000)
  const directAfter = await probeDirect(target, cfg.probeTimeoutMs)
  const proxyAfter = await probeViaProxy(target, cfg.proxyPort, cfg.probeTimeoutMs)
  steps.push({ step: 'retry', ok: directAfter.ok || proxyAfter.ok, detail: `重试：直连 ${directAfter.ok ? 'OK' : directAfter.error || directAfter.status}；代理 ${proxyAfter.ok ? 'OK' : proxyAfter.error || proxyAfter.status}` })

  const healed = directAfter.ok || proxyAfter.ok
  const report = {
    healed,
    needed: true,
    target,
    switched: switched.ok,
    probes: { direct: brief(directAfter), proxy: brief(proxyAfter) },
    steps,
    elapsedMs: Date.now() - startedAt,
  }
  report.summary = healed
    ? `已恢复外网访问：${target}（代理与 TUN 已开启，离开网页后会自动关闭）`
    : `修复未能恢复访问：${target}；${steps.filter((step) => step.ok === false).map((step) => step.detail).join('；') || '原因未知'}`
  return report
}

/* ------------------------------------------------------------ plugin entry */

const PROMPT_TEXT = [
  '网络规则：访问网页前，插件会自动开启 NinjaDesktop 的系统代理与 TUN，访问结束后恢复到访问前的状态',
  '（原来关着就关闭，原来开着就保持开启）；这是正常现象，不要为此提示用户或手动改设置。',
  '如果网页仍然失败，调用 net_self_heal 并传入失败的 URL 做一次修复；',
  '只有在 net_self_heal 返回 healed: false 之后，才改用其他办法（检查 DNS、换镜像源、换备用站点等），',
  '并如实说明哪一步失败，不要假装访问成功。',
].join('')

export async function apply(ctx, config) {
  const cfg = resolveConfig(config)

  // Lease state: web tools hold a lease while they run; when the last lease is
  // released the switches are turned back off after idleGraceMs.
  const state = { count: 0, timer: null, switching: null, on: false, baseline: null, lastReport: null }
  const log = (message) => ctx.logger?.info?.(`${PLUGIN_ID}: ${message}`)

  const runExclusive = async (fn) => {
    while (state.switching) await state.switching.catch(() => {})
    const current = fn().finally(() => {
      state.switching = null
    })
    state.switching = current
    return current
  }

  const turnOn = async () => {
    if (state.on) return { ok: true, steps: [{ step: 'cached', ok: true, detail: '代理与 TUN 已开启' }] }
    const steps = []
    const result = await runExclusive(async () => {
      if (!state.baseline) state.baseline = await snapshot(cfg)
      return switchOn(cfg, steps)
    })
    state.on = result.ok
    state.lastReport = result
    if (!result.ok) log(`启用失败: ${steps.map((step) => step.detail).join(' | ')}`)
    return result
  }

  const turnOff = async () => {
    if (!state.on) {
      state.baseline = null
      return { ok: true, steps: [{ step: 'cached', ok: true, detail: '代理与 TUN 本来就关着' }] }
    }
    const baseline = state.baseline
    state.baseline = null
    // restore: the switches were already on before this window, so leave them
    // exactly as they are instead of forcing either state. state.on drops to
    // false so the next window captures a fresh baseline (which may be off by
    // then, e.g. because the user switched it off meanwhile).
    const wasOnBefore = cfg.releaseMode === 'restore' && baseline && baseline.available && (baseline.proxy || baseline.tun)
    if (wasOnBefore) {
      state.on = false
      const report = { ok: true, steps: [{ step: 'restore', ok: true, detail: '访问前即为开启，保持原样' }] }
      state.lastReport = report
      log('restore: 保持原状（访问前即为开启）')
      return report
    }
    const steps = []
    const result = await runExclusive(() => switchOff(cfg, steps))
    state.on = result.ok ? false : true
    state.lastReport = result
    log(`已关闭代理与 TUN: ${result.ok}`)
    return result
  }

  const scheduleRelease = () => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (state.count === 0) void turnOff().catch(() => {})
    }, cfg.idleGraceMs)
  }

  const acquire = async () => {
    state.count += 1
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    return turnOn()
  }

  const release = () => {
    state.count = Math.max(0, state.count - 1)
    if (state.count === 0) scheduleRelease()
  }

  // 1) Before a web tool: turn the switches on.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!cfg.manageOnWebAccess || !WEB_TOOLS.has(exec?.name)) return next()
    try {
      const lease = await acquire()
      if (!lease.ok && lease.steps) log(`web 前启用未完全成功: ${lease.steps.map((step) => step.detail).join(' | ')}`)
    } catch (error) {
      log(`web 前启用异常: ${error.message || error}`)
    }
    return next()
  })

  // 2) After a web tool: release the lease (the idle timer turns things off).
  ctx.on('tools/result', (exec, result) => {
    if (!cfg.manageOnWebAccess || !WEB_TOOLS.has(exec?.name)) return
    release()
    if (cfg.autoHeal && result && result.isError) {
      const args = exec?.arguments
      const url = args && typeof args === 'object' && typeof args.url === 'string' ? args.url : cfg.probeUrl
      void heal(cfg, { url }).catch(() => {})
    }
  })

  // 3) End of a turn: no browsing is coming, so close immediately. Resetting
  // the counter also recovers from a lease whose tool call never settled.
  ctx.on('turn/end', () => {
    if (!cfg.manageOnWebAccess) return
    state.count = 0
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    void turnOff().catch(() => {})
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'net_self_heal',
      description:
        'Repair broken access to an external website. Turns the NinjaDesktop system proxy and TUN on, probes the URL directly and through the local proxy, and reports every step. Use it when a web request fails (for example github.com) before trying other workarounds.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to test and repair access for. Defaults to the plugin probeUrl.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            healed: { type: 'boolean', description: 'Whether the target is reachable now.' },
            needed: { type: 'boolean', description: 'Whether a repair was attempted.' },
            target: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['healed', 'needed', 'target', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => {
          const text = value && typeof value.summary === 'string' ? value.summary : '网络自愈已执行'
          return [{ type: 'text', text }]
        },
      },
      presentCall: (args) => ({ card: 'generic', title: 'Repairing network access', kind: 'execute', rawInput: args }),
      timeoutMs: 180000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        const url = args && typeof args.url === 'string' && args.url.trim() ? args.url.trim() : cfg.probeUrl
        // Capture the pre-repair state so releaseMode 'restore' can honour it.
        if (!state.baseline) state.baseline = await snapshot(cfg)
        const report = await heal(cfg, { url })
        // heal() switched access on outside a lease; hold one so the idle
        // timer turns it back off instead of leaving it on forever.
        if (report.needed) {
          state.on = true
          state.count += 1
          release()
        }
        return report
      },
    }),
  )

  ctx.effect(() =>
    ctx.systemPrompt.section({ name: PLUGIN_ID, order: 55, text: PROMPT_TEXT }),
  )

  ctx.effect(() => () => {
    if (state.timer) clearTimeout(state.timer)
  })

  log(`ready (backend ${cfg.appBaseUrl}, grace ${cfg.idleGraceMs}ms, release ${cfg.releaseMode})`)
}

export { DEFAULT_CONFIG }
export const inject = ['tools', 'systemPrompt']
