/**
 * dsh-ninja-net-heal — repair broken external web access.
 *
 * Rule implemented by this plugin:
 *   When a web request fails (for example github.com is unreachable), start
 *   NinjaDesktop, enable its system proxy and TUN mode, then retry the
 *   original URL; only then look for other workarounds.
 *
 * The plugin is Host-only: it registers one tool for the model, a short
 * system-prompt section stating the rule, and an automatic repair that runs
 * after a failed web tool call.
 *
 * Control surface: NinjaDesktop bundles a mihomo kernel. Its external
 * controller (127.0.0.1:9799 by default) exposes GET/PATCH /configs, which is
 * how TUN is switched. The system proxy is the WinINet registry setting that
 * the application's own toggle writes.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

const PLUGIN_ID = 'dsh-ninja-net-heal'
const USER_AGENT = `${PLUGIN_ID}/1.0`
const WEB_TOOLS = new Set(['web_fetch', 'web_search', 'read_page', 'fetch'])

const DEFAULT_CONFIG = {
  /** NinjaDesktop executable, launched when the kernel is not reachable. */
  exePath: 'C:\\Program Files\\NinjaDesktop\\NinjaDesktop.exe',
  /** Directory holding NinjaDesktop's kernel_session.json / appconfig.yaml. */
  dataDir: '',
  /** mihomo external controller port. */
  controllerPort: 9799,
  /** Mixed proxy port used for the system proxy setting and the proxy probe. */
  proxyPort: 7897,
  /** URL used when the caller gives none. */
  probeUrl: 'https://github.com',
  probeTimeoutMs: 8000,
  /** How long to wait for the controller after launching the application. */
  launchTimeoutMs: 45000,
  /** Try to repair automatically after a failed web tool call. */
  autoHeal: true,
  /** Minimum gap between two automatic repairs. */
  healCooldownMs: 60000,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

export function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }
  if (!merged.dataDir) merged.dataDir = path.join(localAppData(), 'NinjaDesktop')
  merged.controllerPort = Number(merged.controllerPort) || DEFAULT_CONFIG.controllerPort
  merged.proxyPort = Number(merged.proxyPort) || DEFAULT_CONFIG.proxyPort
  merged.probeTimeoutMs = Number(merged.probeTimeoutMs) || DEFAULT_CONFIG.probeTimeoutMs
  merged.launchTimeoutMs = Number(merged.launchTimeoutMs) || DEFAULT_CONFIG.launchTimeoutMs
  merged.healCooldownMs = Number(merged.healCooldownMs) || DEFAULT_CONFIG.healCooldownMs
  return merged
}

/* ------------------------------------------------------------------ probes */

function requestOnce(url, timeoutMs) {
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
    request.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error.code || error.message, ms: Date.now() - started })
    })
    request.end()
  })
}

/** Direct fetch, bypassing the system proxy (Node ignores WinINet settings). */
export function probeDirect(url, timeoutMs = 8000) {
  return requestOnce(url, timeoutMs)
}

/** HTTPS through the local mixed proxy, i.e. the path a browser uses. */
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
    const fail = (error, status = 0) =>
      resolve({ ok: false, status, error, ms: Date.now() - started })

    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(`proxy connect ${response.statusCode}`, response.statusCode)
        return
      }
      const secure = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
        timeout: timeoutMs,
      })
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

/* -------------------------------------------------------------- controller */

export function readController(dataDir) {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(dataDir, 'kernel_session.json'), 'utf8'))
    if (session && session.secret) {
      return { secret: String(session.secret), addr: session.controller_addr || '' }
    }
  } catch {
    /* fall through to bootstrap.yaml */
  }
  try {
    const bootstrap = fs.readFileSync(path.join(dataDir, 'bootstrap.yaml'), 'utf8')
    const match = /^\s*secret:\s*(\S+)\s*$/m.exec(bootstrap)
    if (match) return { secret: match[1], addr: '' }
  } catch {
    /* no controller secret on disk */
  }
  return { secret: '', addr: '' }
}

export function controllerCall(config, secret, { method = 'GET', path: route = '/configs', body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers = {}
    if (secret) headers.Authorization = `Bearer ${secret}`
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    const request = http.request(
      { host: '127.0.0.1', port: config.controllerPort, method, path: route, headers, timeout: 8000 },
      (response) => {
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
          const ok = (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300
          resolve({ ok, status: response.statusCode || 0, json, text })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.code || error.message }))
    if (payload) request.write(payload)
    request.end()
  })
}

/* ------------------------------------------------------------ repair steps */

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
  if (!fs.existsSync(exePath)) {
    return { ok: false, detail: `可执行文件不存在：${exePath}` }
  }
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return { ok: true, detail: `已启动 ${exePath}` }
  } catch (error) {
    return { ok: false, detail: `启动失败：${error.message || error}` }
  }
}

async function waitForController(config, secret, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await controllerCall(config, secret, { path: '/version' })
    if (version.ok) return true
    await sleep(700)
  }
  return false
}

export async function ensureTun(config, secret) {
  const before = await controllerCall(config, secret, { path: '/configs' })
  if (!before.ok) {
    return { ok: false, changed: false, detail: `控制器不可用：${before.error || before.status}` }
  }
  const tun = before.json && typeof before.json.tun === 'object' && before.json.tun ? before.json.tun : null
  if (tun && tun.enable === true) {
    return { ok: true, changed: false, detail: 'TUN 已处于开启状态' }
  }
  const patched = await controllerCall(config, secret, {
    method: 'PATCH',
    path: '/configs',
    body: { tun: { ...(tun || {}), enable: true } },
  })
  const after = await controllerCall(config, secret, { path: '/configs' })
  const enabled = Boolean(after.ok && after.json && after.json.tun && after.json.tun.enable === true)
  return {
    ok: enabled,
    changed: true,
    detail: enabled
      ? 'TUN 已开启'
      : `TUN 开启失败（HTTP ${patched.status || patched.error || 'unknown'}）`,
  }
}

function runPowerShell(script, timeoutMs = 15000) {
  const shell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  return new Promise((resolve) => {
    const child = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
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
        /* already gone */
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

export async function ensureSystemProxy(config, enable = true) {
  const server = [config.proxyPort]
    .map((port) => `http=127.0.0.1:${port};https=127.0.0.1:${port};socks=127.0.0.1:${port}`)
    .join('')
  const script = `
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$current = Get-ItemProperty -Path $key
Set-ItemProperty -Path $key -Name ProxyEnable -Value ${enable ? 1 : 0} -Type DWord
Set-ItemProperty -Path $key -Name ProxyServer -Value '${server}' -Type String
Add-Type -Namespace NinjaSelfHeal -Name WinINet -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);'
[NinjaSelfHeal.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[NinjaSelfHeal.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
$after = Get-ItemProperty -Path $key
Write-Output ('[state]' + (ConvertTo-Json -Compress -InputObject @{ before = @{ enable = $current.ProxyEnable; server = $current.ProxyServer }; after = @{ enable = $after.ProxyEnable; server = $after.ProxyServer } }))
`.trim()

  const result = await runPowerShell(script)
  if (result.code !== 0) {
    return { ok: false, changed: false, detail: `设置系统代理失败：${result.stderr || 'powershell error'}` }
  }
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('[state]'))
  let state = null
  if (line) {
    try {
      state = JSON.parse(line.slice('[state]'.length))
    } catch {
      state = null
    }
  }
  const applied = Boolean(state && state.after && Number(state.after.enable) === 1)
  const already = Boolean(state && state.before && Number(state.before.enable) === 1 && state.before.server === server)
  return {
    ok: applied,
    changed: applied && !already,
    detail: applied ? (already ? '系统代理已是开启状态' : '系统代理已开启') : '系统代理写入后校验失败',
    state,
  }
}

/** Keep the application's own saved settings consistent across restarts. */
export function persistAppConfig(config) {
  const file = path.join(config.dataDir, 'appconfig.yaml')
  try {
    const before = fs.readFileSync(file, 'utf8')
    const after = before
      .replace(/^(\s*system_proxy\s*:).*$/m, '$1 true')
      .replace(/^(\s*tun_mode\s*:).*$/m, '$1 true')
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8')
      return { ok: true, changed: true, detail: 'appconfig.yaml 已记录 system_proxy/tun_mode = true' }
    }
    return { ok: true, changed: false, detail: 'appconfig.yaml 无需修改' }
  } catch (error) {
    return { ok: false, changed: false, detail: `写入 appconfig.yaml 失败：${error.message || error}` }
  }
}

/* ---------------------------------------------------------------- healing  */

function brief(probe) {
  return {
    ok: probe.ok,
    status: probe.status || 0,
    ...(probe.error ? { error: probe.error } : {}),
    ms: probe.ms || 0,
  }
}

function summarize(report) {
  const { target, needed, healed, probes, steps } = report
  const lines = []
  if (!needed) {
    lines.push(`外网可访问，无需修复：${target}（直连 ${probes.direct.ok ? '正常' : '失败'}，代理 ${probes.proxy.ok ? '正常' : '失败'}）`)
    return lines.join('')
  }
  lines.push(healed ? `已修复外网访问：${target}` : `修复未能恢复访问：${target}`)
  const failed = steps.filter((step) => step && step.ok === false)
  if (failed.length > 0) lines.push(`未完成的步骤：${failed.map((step) => step.detail).join('；')}`)
  else lines.push(`直连：${probes.direct.ok ? '正常' : probes.direct.error || '失败'}；代理：${probes.proxy.ok ? '正常' : probes.proxy.error || '失败'}`)
  return lines.join('。')
}

/**
 * Probe, repair, re-probe.
 * @param {object} config plugin config
 * @param {{url?: string}} options
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
    const report = {
      healed: false,
      needed: false,
      target,
      probes: { direct: brief(direct), proxy: brief(proxy) },
      steps,
      elapsedMs: Date.now() - startedAt,
    }
    report.summary = summarize(report)
    return report
  }

  if (!fs.existsSync(cfg.exePath) && !fs.existsSync(path.join(cfg.dataDir, 'kernel_session.json'))) {
    const report = {
      healed: false,
      needed: true,
      target,
      probes: { direct: brief(direct), proxy: brief(proxy) },
      steps: [...steps, { step: 'locate', ok: false, detail: `未找到 NinjaDesktop（${cfg.exePath}），请在插件配置里设置 exePath/dataDir` }],
      elapsedMs: Date.now() - startedAt,
    }
    report.summary = summarize(report)
    return report
  }

  let { secret } = readController(cfg.dataDir)
  let controller = await controllerCall(cfg, secret, { path: '/version' })

  if (!controller.ok) {
    const running = await isAppRunning()
    if (running) {
      steps.push({ step: 'app', ok: true, detail: 'NinjaDesktop 已在运行，等待内核就绪' })
    } else {
      const launched = launchApp(cfg.exePath)
      steps.push({ step: 'launch', ok: launched.ok, detail: launched.detail })
    }
    const ready = await waitForController(cfg, secret, cfg.launchTimeoutMs)
    steps.push({ step: 'controller', ok: ready, detail: ready ? '内核控制器已就绪' : '等待内核控制器超时' })
    ;({ secret } = readController(cfg.dataDir))
    controller = await controllerCall(cfg, secret, { path: '/version' })
  } else {
    steps.push({ step: 'app', ok: true, detail: 'NinjaDesktop 内核已在运行' })
  }

  if (controller.ok) {
    const profile = await controllerCall(cfg, secret, { path: '/configs' })
    if (profile.ok && profile.json && profile.json['mixed-port']) {
      cfg.proxyPort = Number(profile.json['mixed-port']) || cfg.proxyPort
    }
    const tun = await ensureTun(cfg, secret)
    steps.push({ step: 'tun', ok: tun.ok, detail: tun.detail })

    const proxyStep = await ensureSystemProxy(cfg, true)
    steps.push({ step: 'system-proxy', ok: proxyStep.ok, detail: proxyStep.detail })

    const persisted = persistAppConfig(cfg)
    steps.push({ step: 'persist', ok: persisted.ok, detail: persisted.detail })
  } else {
    steps.push({ step: 'controller', ok: false, detail: '内核控制器仍不可用，无法开启 TUN' })
  }

  await sleep(1200)
  const directAfter = await probeDirect(target, cfg.probeTimeoutMs)
  const proxyAfter = await probeViaProxy(target, cfg.proxyPort, cfg.probeTimeoutMs)
  steps.push({ step: 'retry', ok: directAfter.ok || proxyAfter.ok, detail: `重试：直连 ${directAfter.ok ? 'OK' : directAfter.error || directAfter.status}；代理 ${proxyAfter.ok ? 'OK' : proxyAfter.error || proxyAfter.status}` })

  const report = {
    healed: directAfter.ok || proxyAfter.ok,
    needed: true,
    target,
    controller: { port: cfg.controllerPort, reachable: controller.ok },
    probes: { direct: brief(directAfter), proxy: brief(proxyAfter) },
    steps,
    elapsedMs: Date.now() - startedAt,
  }
  report.summary = summarize(report)
  return report
}

/* ------------------------------------------------------------ plugin entry */

const PROMPT_TEXT = [
  '网络自愈规则：当访问外部网站（例如 github.com）失败时，先调用 net_self_heal 工具并传入失败的 URL；',
  '该工具会启动 NinjaDesktop、开启其系统代理与 TUN，然后重试该地址。',
  '只有在 net_self_heal 返回 healed: false 之后，才改用其他办法（检查 DNS、换镜像源、换备用站点等），',
  '并如实说明哪一步失败，不要假装访问成功。',
].join('')

export async function apply(ctx, config) {
  const cfg = resolveConfig(config)

  ctx.effect(() =>
    ctx.tools.register(
      {
        name: 'net_self_heal',
        description:
          'Repair broken access to an external website. Probes the URL directly and through the local proxy, starts NinjaDesktop when its kernel is down, enables the application\'s system proxy and TUN mode, then re-probes the same URL. Use this when a web request fails (for example github.com) before trying other workarounds.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Absolute http(s) URL to test and repair access for. Defaults to the plugin probeUrl (https://github.com).',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              healed: { type: 'boolean', description: 'Whether the target became reachable.' },
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
        presentCall: (args) => ({
          card: 'generic',
          title: 'Repairing network access',
          kind: 'execute',
          rawInput: args,
        }),
        timeoutMs: 120000,
        isConcurrencySafe: () => false,
        execute: async (args) => {
          const url = args && typeof args.url === 'string' && args.url.trim() ? args.url.trim() : cfg.probeUrl
          return heal(cfg, { url })
        },
      },
      { when: () => process.platform === 'win32' },
    ),
  )

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: PLUGIN_ID,
      order: 55,
      text: PROMPT_TEXT,
    }),
  )

  // Automatic repair after a failed web tool call. Silent by design: it only
  // restores connectivity so the model's own retry can succeed.
  let lastRunAt = 0
  let inFlight = null
  ctx.on('tools/result', (exec, result) => {
    if (!cfg.autoHeal) return
    if (!result || !result.isError) return
    const name = exec && exec.name
    if (!WEB_TOOLS.has(name)) return
    if (inFlight) return
    if (Date.now() - lastRunAt < cfg.healCooldownMs) return
    lastRunAt = Date.now()
    let url = cfg.probeUrl
    const args = exec && exec.arguments
    if (args && typeof args === 'object' && typeof args.url === 'string' && /^https?:\/\//i.test(args.url)) {
      url = args.url
    }
    inFlight = heal(cfg, { url })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null
      })
  })

  ctx.logger?.info?.(`${PLUGIN_ID} ready (controller ${cfg.controllerPort}, proxy ${cfg.proxyPort})`)
}

export { DEFAULT_CONFIG }
export const inject = ['tools', 'systemPrompt']
