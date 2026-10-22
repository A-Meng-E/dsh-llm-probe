/**
 * dsh-llm-probe — Host 半部
 *
 * 职责（只做托管、代理与能力暴露，不重写巡检引擎）：
 *   1. 生命周期托管：以子进程拉起/复用 `node server.mjs`（127.0.0.1:8787），卸载时干净回收；
 *   2. 同源反代：`/plugins/llm-probe/dashboard/*` → 127.0.0.1:8787，iframe 与宿主同源，
 *      可直接注入主题变量，也不必改 server.mjs 的 CORS / X-Frame-Options；
 *   3. 白名单路由 `/plugins/llm-probe/open-web-ui`：只允许本机回环地址，用系统默认浏览器打开；
 *   4. 服务 `llmProbe`：getStatus / getModels / getModelDetail / runProbe / getLogs，单一数据源；
 *   5. agent 工具：llm_probe_status / llm_probe_run / llm_probe_model_detail / llm_probe_logs。
 *
 * 数据与配置全部沿用现有结构：catalog.json / keys.json / overrides.json / out/*，不改路径语义。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import http from 'node:http'

export const name = 'llm-probe'
export const inject = ['webServer', 'tools']

const PREFIX = '/plugins/llm-probe'
/** 插件包根目录（lib/index.js 的上一级）。engine/ 随包分发，巡检引擎就在里面。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENGINE_DIR = join(PACKAGE_ROOT, 'engine')
const ERROR_LIMIT = 300
const LOG_LINE_LIMIT = 500
const RUN_THROTTLE_MS = 60 * 1000

/**
 * 数据目录（catalog / keys / overrides / out / media 都在这里）。
 * 优先级：config.dataDir > 环境变量 LLM_PROBE_DATA > $DSH_HOME/llm-probe > ~/.dsh/llm-probe。
 * 用户不需要拥有任何巡检工具脚本——引擎随插件分发。
 */
function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured) return resolve(configured)
  const fromEnv = typeof process.env.LLM_PROBE_DATA === 'string' ? process.env.LLM_PROBE_DATA.trim() : ''
  if (fromEnv) return resolve(fromEnv)
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return resolve(join(dshHome, 'llm-probe'))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/** 脱敏：sk- 只留后 4 位；Authorization 里的令牌同样打码。 */
function mask(text) {
  if (typeof text !== 'string' || text === '') return text
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, (all) => 'sk-***' + all.slice(-4))
    .replace(/\b(Bearer\s+)([A-Za-z0-9._-]{8,})/gi, (_all, head, token) => head + '***' + token.slice(-4))
}

function truncate(text, limit = ERROR_LIMIT) {
  if (text === null || text === undefined) return text
  const raw = String(text)
  return raw.length > limit ? raw.slice(0, limit) + '…(' + raw.length + ' chars)' : raw
}

function ageMinutes(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 60000))
}

/* ─────────────────────────── apply ─────────────────────────── */

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const engineOk = existsSync(join(ENGINE_DIR, 'server.mjs')) && existsSync(join(ENGINE_DIR, 'probe.mjs'))
  const setupHint = engineOk
    ? null
    : '插件包内缺少 engine/server.mjs 或 engine/probe.mjs，安装包可能不完整：' + ENGINE_DIR
  const port = Number(config.port) || 8787
  const base = 'http://127.0.0.1:' + port
  const autoStart = config.autoStart !== false

  const OUT = join(dataDir, 'out')
  const STATUS_FILE = join(OUT, 'status.json')
  const STATE_FILE = join(OUT, 'probe.state.json')
  const LOG_FILE = join(OUT, 'probe.log')
  const OVERRIDES_FILE = join(dataDir, 'overrides.json')
  const CATALOG_FILE = join(dataDir, 'catalog.json')
  const KEYS_FILE = join(dataDir, 'keys.json')
  const MEDIA_DIR = join(dataDir, 'media')

  let child = null // 只记录“本插件拉起的”子进程
  let starting = null
  let lastRunAt = 0

  const log = (level, message, extra) => {
    const line = '[llm-probe] ' + message + (extra === undefined ? '' : ' ' + JSON.stringify(extra))
    try {
      if (typeof ctx.logger?.info === 'function' && level === 'info') ctx.logger.info(line)
      else if (typeof ctx.logger?.warn === 'function' && level === 'warn') ctx.logger.warn(line)
      else if (typeof ctx.logger?.error === 'function') ctx.logger.error(line)
      else console.log(line)
    } catch {
      console.log(line)
    }
  }

  /* ── 首次启动的数据目录准备 ── */

  /** 建目录并从 engine 模板种下 catalog / keys / overrides；已存在的文件绝不覆盖。 */
  function ensureDataDir() {
    try {
      mkdirSync(OUT, { recursive: true })
      mkdirSync(MEDIA_DIR, { recursive: true })
      if (!existsSync(CATALOG_FILE)) copyFileSync(join(ENGINE_DIR, 'catalog.template.json'), CATALOG_FILE)
      if (!existsSync(KEYS_FILE)) copyFileSync(join(ENGINE_DIR, 'keys.template.json'), KEYS_FILE)
      if (!existsSync(OVERRIDES_FILE)) {
        writeFileSync(
          OVERRIDES_FILE,
          JSON.stringify(
            {
              updatedAt: new Date().toISOString(),
              overrides: {},
              customModels: [],
              entryEdits: {},
              removedModels: [],
              settings: { probeInterval: 10, timeoutMs: 120000, alert: { enabled: false } },
              appearance: { mode: 'auto' },
            },
            null,
            2,
          ) + '\n',
        )
      }
      return true
    } catch (error) {
      log('error', 'ensureDataDir failed', { dir: dataDir, error: String((error && error.message) || error) })
      return false
    }
  }

  /** 是否至少填了一个真实密钥（keys.json 里去掉 `_` 开头的说明键后，任一非空字符串）。 */
  function keysConfigured() {
    const doc = readJson(KEYS_FILE, null)
    if (!doc || typeof doc !== 'object') return false
    return Object.keys(doc).some((key) => {
      if (key.startsWith('_')) return false
      const value = doc[key]
      const token = typeof value === 'string' ? value : value && typeof value === 'object' ? value.apiKey || value.key : ''
      return typeof token === 'string' && token.trim().length > 0
    })
  }

  /* ── 本机 HTTP 客户端（只走 loopback，不用 0.0.0.0） ── */

  function request(path, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: Object.assign(
            { accept: 'application/json, text/plain, */*' },
            payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
            headers,
          ),
          timeout,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = text ? JSON.parse(text) : null
            } catch {
              json = null
            }
            resolve({ status: res.statusCode || 0, text, json })
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('timeout after ' + timeout + 'ms')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async function isHealthy() {
    try {
      const res = await request('/api/stats', { timeout: 1500 })
      return res.status === 200 && !!res.json
    } catch {
      return false
    }
  }

  function spawnServer() {
    if (!engineOk) throw new Error(setupHint)
    ensureDataDir()
    const proc = spawn(
      process.execPath,
      [join(ENGINE_DIR, 'server.mjs'), '--port', String(port), '--data', dataDir],
      {
        cwd: dataDir,
        detached: false,
        windowsHide: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { PROBE_SOURCE: 'plugin', PROBE_DATA_DIR: dataDir }),
      },
    )
    proc.on('exit', (code) => {
      if (child === proc) child = null
      log('warn', 'server.mjs exited', { code })
    })
    proc.on('error', (error) => log('warn', 'server.mjs spawn error', { error: String(error) }))
    child = proc
    log('info', 'server.mjs spawned', { pid: proc.pid, port, dataDir })
    return proc
  }

  async function waitHealthy(ms, startedAt) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await isHealthy()) return true
      if (startedAt && child && child.exitCode !== null) return false
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return false
  }

  /** 8787 已有健康实例则复用，不重复拉起。 */
  async function ensureServer() {
    if (!engineOk) return false
    if (await isHealthy()) return true
    if (!autoStart) return false
    if (starting) return starting
    starting = (async () => {
      try {
        if (child && child.exitCode === null) {
          // 已经有一个我们拉起的进程在跑，只等它变健康
        } else {
          spawnServer()
        }
        const ok = await waitHealthy(20000)
        if (!ok) log('warn', 'server.mjs did not become healthy in 20s', { port })
        return ok
      } catch (error) {
        log('error', 'ensureServer failed', { error: String((error && error.message) || error) })
        return false
      } finally {
        starting = null
      }
    })()
    return starting
  }

  function stopServer() {
    if (!child) return
    const proc = child
    child = null
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
      log('info', 'server.mjs stopped', { pid: proc.pid })
    } catch (error) {
      log('warn', 'stopServer failed', { error: String(error) })
    }
  }

  /* ── 直接读文件（服务的唯一数据源） ── */

  function readStatus() {
    const status = readJson(STATUS_FILE, null)
    if (!status || !Array.isArray(status.entries)) return null
    return status
  }

  function readProbeState() {
    const state = readJson(STATE_FILE, null)
    if (!state) return { running: false }
    if (state.pid && !pidAlive(state.pid)) return { running: false, stalePid: state.pid }
    return Object.assign({ running: !!state.pid }, state)
  }

  function settingsOf() {
    const ov = readJson(OVERRIDES_FILE, {})
    return (ov && ov.settings) || {}
  }

  function intervalMinutes() {
    const raw = settingsOf().probeInterval
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 60
  }

  /** 一轮总览：时间、纳入数、可用率、失败数、耗时，外加新鲜度标注。 */
  function buildStatus() {
    const status = readStatus()
    const state = readProbeState()
    const interval = intervalMinutes()
    const generatedAt = status ? status.generatedAt : null
    const ageMin = ageMinutes(generatedAt)
    const entries = status ? status.entries : []
    const total = entries.length
    const ok = entries.filter((entry) => entry && entry.ok).length
    const failed = total - ok
    const stale = ageMin === null ? true : ageMin > interval * 2

    return {
      generatedAt,
      catalogGeneratedAt: status ? status.catalogGeneratedAt : null,
      ageMinutes: ageMin,
      stale,
      staleReason: stale
        ? '超过 2 个巡检间隔（' + interval * 2 + ' 分钟）未更新'
        : null,
      intervalMinutes: interval,
      running: !!state.running,
      runningSince: state.running ? state.startedAt || null : null,
      runId: state.running ? state.runId || null : null,
      total,
      ok,
      failed,
      availableRate: total ? Math.round((ok / total) * 1000) / 10 : 0,
      durationMs: status && status.summary ? status.summary.durationMs : null,
      lastRound: status && status.summary ? status.summary : null,
      baseUrl: base,
      serviceReachable: undefined,
    }
  }

  /* ── 反向代理：/plugins/llm-probe/dashboard/* → 127.0.0.1:8787 ── */

  const DROP_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  const DROP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-frame-options',
    'content-security-policy',
    'content-security-policy-report-only',
  ])

  /**
   * 看板是用绝对路径写死 `/api/*` 的单文件应用；iframe 与宿主同源后这些请求会打到宿主根，
   * 所以在 HTML 出站时把 `/api/` 与 `/media/` 改写到插件前缀下，保持同源且不改 dashboard.html。
   */
  function rewriteDashboardHtml(buffer) {
    const html = buffer.toString('utf8')
    if (!/\/api\//.test(html) && !/\/media\//.test(html)) return buffer
    const next = html
      .replace(/\/api\//g, PREFIX + '/dashboard/api/')
      .replace(/\/media\//g, PREFIX + '/dashboard/media/')
    return Buffer.from(next, 'utf8')
  }

  async function proxy(req, res, upstreamPath) {
    // 自愈：上游没起来时先尝试拉起一次（ensureServer 内部单飞），再转发
    if (autoStart) {
      try {
        if (!(await isHealthy())) await ensureServer()
      } catch {
        /* 交给下面的 upstream error 分支回 503 */
      }
    }
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(key.toLowerCase()) && value !== undefined) headers[key] = value
    }
    headers.host = '127.0.0.1:' + port

    const upstream = http.request(
      { host: '127.0.0.1', port, path: upstreamPath, method: req.method, headers },
      (upstreamRes) => {
        const out = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value
        }
        if (String(upstreamPath).startsWith('/api/') || String(upstreamPath) === '/api') {
          out['cache-control'] = 'no-store'
        }

        const isHtml = /text\/html/i.test(String(out['content-type'] || ''))
        if (!isHtml) {
          res.writeHead(upstreamRes.statusCode || 502, out)
          upstreamRes.pipe(res)
          upstreamRes.on('error', () => {
            try {
              res.destroy()
            } catch {
              /* ignore */
            }
          })
          return
        }

        const chunks = []
        upstreamRes.on('data', (chunk) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          const body = rewriteDashboardHtml(Buffer.concat(chunks))
          out['content-length'] = String(body.length)
          delete out['transfer-encoding']
          res.writeHead(upstreamRes.statusCode || 502, out)
          res.end(body)
        })
        upstreamRes.on('error', () => {
          try {
            res.destroy()
          } catch {
            /* ignore */
          }
        })
      },
    )
    upstream.on('error', (error) => {
      if (res.headersSent) {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      const status = error && error.code === 'ECONNREFUSED' ? 503 : 502
      const body = JSON.stringify(
        {
          error: status === 503 ? 'probe_service_unavailable' : 'proxy_failed',
          message: String((error && error.message) || error),
          hint: '巡检服务未运行。插件会尝试自动拉起 server.mjs。',
        },
        null,
        2,
      )
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    })
    req.pipe(upstream)
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ text, json })
      })
      req.on('error', () => resolve({ text: '', json: null }))
    })
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /* ── 外观跟随模式：持久化到 overrides.json 的新字段（向前兼容） ── */

  const APPEARANCE_MODES = ['auto', 'dsn', 'classic']

  function readAppearance() {
    const doc = readJson(OVERRIDES_FILE, {}) || {}
    const mode = doc.appearance && APPEARANCE_MODES.includes(doc.appearance.mode) ? doc.appearance.mode : 'auto'
    return { mode }
  }

  function writeAppearance(mode) {
    if (!APPEARANCE_MODES.includes(mode)) throw new Error('unsupported mode: ' + mode)
    const doc = readJson(OVERRIDES_FILE, {}) || {}
    doc.appearance = Object.assign({}, doc.appearance, { mode, updatedAt: new Date().toISOString() })
    // 只增键，不动任何既有字段，保持 server.mjs 的结构语义
    writeFileSync(OVERRIDES_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    return { mode }
  }

  /* ── 路由 ── */

  function route(kind, path, handler) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind,
          path,
          handler: (req, res) => {
            Promise.resolve(handler(req, res)).catch((error) => {
              log('error', 'route failed', { path, error: String((error && error.message) || error) })
              if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: String(error) })
              else {
                try {
                  res.destroy()
                } catch {
                  /* ignore */
                }
              }
            })
          },
        }),
      'llm-probe route ' + path,
    )
  }

  // 1) 同源反代：/plugins/llm-probe/dashboard/* → 上游同名路径（去掉插件前缀）
  route('prefix', PREFIX + '/dashboard', (req, res) => {
    const raw = String(req.url || '/')
    const query = raw.indexOf('?') >= 0 ? raw.slice(raw.indexOf('?')) : ''
    let rest = raw.split('?')[0].slice((PREFIX + '/dashboard').length)
    if (!rest.startsWith('/')) rest = '/' + rest
    if (rest === '/') rest = '/'
    return proxy(req, res, rest + query)
  })

  // 2) 面板信息：地址、端口、数据目录、版本、运行态
  route('exact', PREFIX + '/info', async (req, res) => {
    const healthy = await isHealthy()
    const status = buildStatus()
    sendJson(res, 200, {
      ok: true,
      port,
      baseUrl: base,
      dataDir,
      setupHint,
      proxyBase: PREFIX + '/dashboard/',
      healthy,
      version: readJson(join(PACKAGE_ROOT, 'package.json'), {}).version || null,
      engineVersion: readJson(join(ENGINE_DIR, 'package.json'), {}).version || 'embedded',
      keysConfigured: keysConfigured(),
      models: (() => {
        const catalog = readJson(join(dataDir, 'catalog.json'), null)
        const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : []
        return entries.length
      })(),
      running: status.running,
      generatedAt: status.generatedAt,
      stale: status.stale,
    })
  })

  // 3) 角标数据源：直接回源 /api/stats（与看板首页同一份数据）
  route('exact', PREFIX + '/stats', (req, res) => proxy(req, res, '/api/stats'))

  // 4) 外观跟随模式
  route('exact', PREFIX + '/appearance', async (req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, readAppearance())
    if (req.method === 'POST') {
      const body = await readBody(req)
      const mode = body.json && body.json.mode
      try {
        return sendJson(res, 200, writeAppearance(mode))
      } catch (error) {
        return sendJson(res, 400, { error: 'invalid_mode', message: String((error && error.message) || error) })
      }
    }
    return sendJson(res, 405, { error: 'method_not_allowed' })
  })

  // 5) 打开 Web UI（白名单校验 + 系统浏览器）
  route('exact', PREFIX + '/open-web-ui', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const body = await readBody(req)
    const requested = body.json && body.json.url
    const url = String(requested || base)
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return sendJson(res, 403, { error: 'forbidden_url', message: 'URL 无法解析' })
    }
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    const portOk = String(parsed.port || '80') === String(port)
    const protoOk = parsed.protocol === 'http:'
    if (!hostOk || !portOk || !protoOk) {
      log('warn', 'open-web-ui rejected', { url, hostOk, portOk, protoOk })
      return sendJson(res, 403, {
        error: 'forbidden_url',
        message: '只允许 http://127.0.0.1:' + port + ' 或 http://localhost:' + port,
      })
    }
    const target = 'http://' + parsed.hostname + ':' + port + (parsed.pathname === '/' ? '/' : parsed.pathname)
    try {
      await ensureServer()
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
      }
      log('info', 'opened Web UI', { target, platform: process.platform })
      return sendJson(res, 200, { ok: true, opened: true, url: target })
    } catch (error) {
      log('error', 'open Web UI failed', { target, error: String(error) })
      return sendJson(res, 500, { ok: false, error: 'open_failed', message: String((error && error.message) || error) })
    }
  })

  // 6) 立即巡检（等价看板的「立即测试」，带节流与并发保护）
  route('exact', PREFIX + '/run', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const result = await runProbe({ reason: 'panel-button' })
    return sendJson(res, result.started ? 202 : 200, result)
  })

  route('exact', PREFIX + '/health', async (req, res) => {
    let healthy = await isHealthy()
    if (!healthy && autoStart) healthy = await ensureServer().catch(() => false)
    if (!healthy) healthy = await isHealthy()
    sendJson(res, healthy ? 200 : 503, { ok: healthy, port, baseUrl: base })
  })

  /* ── 服务实现 ── */

  function readTextSafe(path) {
    try {
      return readFileSync(path, 'utf8').trim()
    } catch {
      return null
    }
  }

  async function getStatus() {
    const summary = buildStatus()
    summary.serviceReachable = await isHealthy()
    return summary
  }

  function getModels({ status } = {}) {
    const data = readStatus()
    if (!data) return { generatedAt: null, stale: true, entries: [], note: '尚无巡检数据（out/status.json 不存在）' }
    const generatedAt = data.generatedAt
    const ageMin = ageMinutes(generatedAt)
    const stale = ageMin === null ? true : ageMin > intervalMinutes() * 2
    const filter = status && status !== 'all' ? String(status) : null
    const entries = data.entries
      .filter((entry) => {
        if (!filter) return true
        if (filter === 'failed' || filter === 'fail' || filter === 'unavailable') return !entry.ok
        if (filter === 'ok' || filter === 'available') return !!entry.ok
        return String(entry.status || '').toLowerCase() === filter.toLowerCase()
      })
      .map((entry) => ({
        id: entry.id,
        service: entry.service,
        name: entry.name,
        model: entry.exampleModel || entry.model || null,
        ok: !!entry.ok,
        status: entry.status || null,
        latencyMs: entry.latencyMs ?? null,
        ttftMs: entry.ttftMs ?? null,
        tps: entry.tps ?? null,
        at: entry.at || null,
        error: entry.error ? truncate(mask(String(entry.error))) : null,
      }))
    return { generatedAt, ageMinutes: ageMin, stale, total: data.entries.length, returned: entries.length, entries }
  }

  function getModelDetail(id) {
    const data = readStatus()
    if (!data) return { generatedAt: null, stale: true, found: false, id, note: '尚无巡检数据' }
    const key = String(id || '').trim()
    const lower = key.toLowerCase()
    const fields = ['name', 'exampleModel', 'service']
    const exact = data.entries.find(
      (item) => item && (item.id === key || item.name === key || item.exampleModel === key),
    )
    // 宽松匹配：模型名 / 示例模型 / 服务名的大小写不敏感包含（用户通常只记得大致名字）
    let entry = exact
    let candidates = null
    if (!entry && lower) {
      const hits = data.entries.filter(
        (item) => item && fields.some((field) => String(item[field] || '').toLowerCase().includes(lower)),
      )
      if (hits.length === 1) entry = hits[0]
      else if (hits.length > 1) candidates = hits.slice(0, 8).map((item) => ({ id: item.id, name: item.name, service: item.service }))
    }
    if (!entry) {
      return {
        generatedAt: data.generatedAt,
        found: false,
        id: key,
        ambiguous: !!candidates,
        candidates,
      }
    }
    const history = Array.isArray(entry.history) ? entry.history.slice(-30) : []
    const latencies = history.map((item) => item && item.latencyMs).filter((n) => Number.isFinite(n))
    const tpsList = history.map((item) => item && item.tps).filter((n) => Number.isFinite(n))
    const stat = (list) =>
      list.length
        ? {
            min: Math.min(...list),
            max: Math.max(...list),
            avg: Math.round((list.reduce((sum, n) => sum + n, 0) / list.length) * 10) / 10,
          }
        : null
    const ageMin = ageMinutes(data.generatedAt)
    return {
      generatedAt: data.generatedAt,
      ageMinutes: ageMin,
      stale: ageMin === null ? true : ageMin > intervalMinutes() * 2,
      found: true,
      id: entry.id,
      service: entry.service,
      name: entry.name,
      model: entry.exampleModel || null,
      ok: !!entry.ok,
      status: entry.status || null,
      last: {
        at: entry.at || null,
        latencyMs: entry.latencyMs ?? null,
        ttftMs: entry.ttftMs ?? null,
        tpotMs: entry.tpotMs ?? null,
        tps: entry.tps ?? null,
        error: entry.error ? truncate(mask(String(entry.error))) : null,
      },
      trend: { rounds: history.length, latency: stat(latencies), tps: stat(tpsList) },
      history,
    }
  }

  async function runProbe({ reason } = {}) {
    const state = readProbeState()
    if (state.running) {
      return { started: false, running: true, runId: state.runId || null, since: state.startedAt || null, reason: '已有巡检在跑' }
    }
    const sinceLast = Date.now() - lastRunAt
    if (lastRunAt && sinceLast < RUN_THROTTLE_MS) {
      return {
        started: false,
        running: false,
        reason: '节流中，请稍后再试',
        nextInMs: RUN_THROTTLE_MS - sinceLast,
      }
    }
    const healthy = await ensureServer()
    if (!healthy) return { started: false, running: false, reason: '巡检服务不可达（server.mjs 未就绪）' }
    try {
      const res = await request('/api/probe', { method: 'POST', body: { source: 'plugin', reason: reason || null }, timeout: 15000 })
      lastRunAt = Date.now()
      const payload = res.json || {}
      return {
        started: !!payload.started,
        running: !!payload.running,
        runId: payload.runId || readProbeState().runId || null,
        reason: payload.reason || null,
        status: res.status,
      }
    } catch (error) {
      return { started: false, running: false, reason: String((error && error.message) || error) }
    }
  }

  function getLogs({ lines } = {}) {
    const want = Math.min(Math.max(Number(lines) || 50, 1), LOG_LINE_LIMIT)
    if (!existsSync(LOG_FILE)) return { lines: 0, tail: [], note: 'probe.log 不存在' }
    let text = ''
    try {
      const size = statSync(LOG_FILE).size
      const start = Math.max(0, size - Math.min(size, want * 400))
      const fd = readFileSync(LOG_FILE)
      text = fd.subarray(start).toString('utf8')
    } catch (error) {
      return { lines: 0, tail: [], error: String((error && error.message) || error) }
    }
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-want).map((line) => truncate(mask(line), 500))
    return { lines: tail.length, tail, generatedAt: new Date().toISOString() }
  }

  /* ── 提供给其它插件的服务（单一数据源） ── */

  const api = {
    getStatus,
    getModels,
    getModelDetail,
    runProbe,
    getLogs,
    getLogsTail: getLogs,
    baseUrl: base,
    dataDir,
  }

  try {
    if (typeof ctx.provide === 'function') {
      ctx.effect(() => ctx.provide('llmProbe', api), 'llm-probe service')
    }
  } catch (error) {
    log('warn', 'provide llmProbe failed', { error: String(error) })
  }

  /* ── agent 工具 ── */

  const okSchema = { type: 'object', additionalProperties: true }
  const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  function toMarkdownStatus(status, detail) {
    const lines = []
    lines.push('## 巡检结果摘要')
    lines.push('')
    lines.push('- 最近一轮：' + (status.generatedAt || '—') + (status.ageMinutes !== null ? '（' + status.ageMinutes + ' 分钟前）' : ''))
    lines.push('- 纳入模型：' + status.total + ' 个，可用 ' + status.ok + ' 个，不可用 ' + status.failed + ' 个，可用率 ' + status.availableRate + '%')
    if (status.durationMs) lines.push('- 本轮耗时：' + Math.round(status.durationMs / 1000) + ' 秒')
    lines.push('- 巡检状态：' + (status.running ? '进行中' : '空闲'))
    if (status.stale) lines.push('- ⚠️ **数据已过期**：' + (status.staleReason || '超过 2 个巡检间隔未更新'))
    if (detail === 'failed' && status.failed > 0) {
      const models = getModels({ status: 'failed' })
      lines.push('')
      lines.push('### 不可用模型')
      for (const entry of models.entries.slice(0, 40)) {
        lines.push('- `' + (entry.model || entry.id) + '`（' + (entry.service || '—') + '）：' + (entry.error || entry.status || '未知'))
      }
      if (models.entries.length > 40) lines.push('- …还有 ' + (models.entries.length - 40) + ' 个')
    }
    lines.push('')
    lines.push('> generatedAt=' + (status.generatedAt || 'null') + '，服务地址 ' + status.baseUrl)
    return lines.join('\n')
  }

  function registerTools() {
    if (!ctx.tools) {
      log('warn', 'tools service 不可用，跳过 agent 工具注册')
      return
    }

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'llm_probe_status',
          description:
            '只读。读取本地「大模型接口可用性巡检」最近一轮结果摘要：纳入模型数、可用率、不可用数量、耗时、数据新鲜度（stale）。当用户问"现在哪些模型不可用/巡检结果怎么样/服务正常吗"时调用。detail=failed 时附带不可用模型清单与错误原因（密钥已脱敏、错误截断）。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              detail: {
                type: 'string',
                enum: ['summary', 'failed'],
                description: 'summary=仅摘要（默认）；failed=摘要 + 不可用模型清单',
              },
            },
          },
          output: { schema: okSchema, render: textRender },
          timeoutMs: 20000,
          isConcurrencySafe: () => true,
          async execute(args) {
            const status = await getStatus()
            if (!status.total) {
              return {
                markdown: '巡检还没有数据：out/status.json 不存在或为空。可以先调用 llm_probe_run 触发一轮，或在看板里点「立即测试」。',
                generatedAt: status.generatedAt,
                stale: true,
              }
            }
            const detail = args && args.detail
            return {
              markdown: toMarkdownStatus(status, detail),
              generatedAt: status.generatedAt,
              stale: status.stale,
              running: status.running,
              total: status.total,
              ok: status.ok,
              failed: status.failed,
              availableRate: status.availableRate,
            }
          },
        }),
      'llm-probe tool llm_probe_status',
    )

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'llm_probe_run',
          description:
            '有副作用：触发一轮「大模型接口可用性巡检」（并发 8，逐个模型发真实请求，会产生模型调用开销）。需要用户审批后才执行。幂等：已有巡检在跑时返回 running=true 不重复启动；1 分钟内重复触发会被节流。当用户明确说"跑一轮巡检/重新测一遍"时调用。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reason: { type: 'string', description: '触发原因（可选，用于日志）' },
            },
          },
          output: { schema: okSchema, render: textRender },
          timeoutMs: 180000,
          isConcurrencySafe: () => false,
          async execute(args, exec) {
            const approval = (() => {
              try {
                return typeof ctx.get === 'function' ? ctx.get('approval') : undefined
              } catch {
                return undefined
              }
            })()
            if (approval && typeof approval.request === 'function' && exec && exec.agent) {
              try {
                const outcome = await approval.request({
                  agent: exec.agent,
                  toolName: 'llm_probe_run',
                  callId: exec.callId,
                  reason: '触发一轮大模型接口可用性巡检（会向所有纳入模型发真实请求）',
                  signal: exec.signal,
                })
                if (outcome !== 'allowed-once') {
                  return { markdown: '用户未批准本次巡检（审批结果：' + outcome + '）。', started: false, approval: outcome }
                }
              } catch (error) {
                log('warn', 'approval request failed, proceeding', { error: String((error && error.message) || error) })
              }
            }

            const started = await runProbe({ reason: (args && args.reason) || 'agent' })
            if (!started.started) {
              const status = await getStatus()
              return {
                markdown:
                  '未启动新一轮巡检：' +
                  (started.reason || '未知原因') +
                  (started.running ? '（当前已有巡检在跑，runId=' + (started.runId || '—') + '）' : '') +
                  '\n\n' +
                  (status.total ? toMarkdownStatus(status, 'summary') : ''),
                started: false,
                running: !!started.running,
              }
            }

            // 等到本轮结束（上限 150s），拿真实结果而不是空承诺
            const deadline = Date.now() + 150000
            while (Date.now() < deadline) {
              const state = readProbeState()
              if (!state.running) break
              await new Promise((resolve) => setTimeout(resolve, 2000))
            }
            const status = await getStatus()
            const finished = !status.running && status.generatedAt
            return {
              markdown:
                (finished ? '本轮巡检已完成。\n\n' : '本轮巡检仍在进行中（超过 150s），先给出当前快照。\n\n') +
                toMarkdownStatus(status, status.failed > 0 ? 'failed' : 'summary'),
              started: true,
              runId: started.runId || null,
              finished: !!finished,
              generatedAt: status.generatedAt,
              failed: status.failed,
              total: status.total,
            }
          },
        }),
      'llm-probe tool llm_probe_run',
    )

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'llm_probe_model_detail',
          description:
            '只读。查询单个模型最近 30 轮巡检的趋势：延迟 min/avg/max、TPS 均值、最近一次状态与错误原因（密钥已脱敏）。当用户问"某个模型最近延迟怎么样/为什么失败"时调用。model_id 可以是模型名、exampleModel 或条目 id。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['model_id'],
            properties: {
              model_id: { type: 'string', description: '模型标识：条目 id、模型名（name）或示例模型（exampleModel）' },
            },
          },
          output: { schema: okSchema, render: textRender },
          timeoutMs: 20000,
          isConcurrencySafe: () => true,
          async execute(args) {
            const id = args && args.model_id
            const detail = getModelDetail(id)
            if (!detail.found) {
              const candidates = Array.isArray(detail.candidates) ? detail.candidates : []
              const head = candidates.length
                ? '`' + String(id || '') + '` 匹配到多个模型，请用更精确的 model_id（建议直接用 id）：\n\n' +
                  candidates.map((item) => '- `' + item.id + '`（' + (item.service || '—') + ' / ' + (item.name || '—') + '）').join('\n')
                : '没有找到模型 `' + String(id || '') + '`。可以先用 llm_probe_status({detail:"failed"}) 看有哪些不可用模型，或 llm_probe_status 概览。'
              return {
                markdown: head,
                found: false,
                id: String(id || ''),
                ambiguous: !!detail.ambiguous,
                candidates,
                generatedAt: detail.generatedAt,
              }
            }
            const lines = []
            lines.push('## ' + (detail.model || detail.name || detail.id))
            lines.push('')
            lines.push('- 服务：' + (detail.service || '—') + '，当前状态：' + (detail.ok ? '可用' : '不可用') + '（' + (detail.status || '—') + '）')
            lines.push('- 最近一次：' + (detail.last.at || '—') + '，延迟 ' + (detail.last.latencyMs ?? '—') + ' ms，TTFT ' + (detail.last.ttftMs ?? '—') + ' ms，TPS ' + (detail.last.tps ?? '—'))
            if (detail.trend.latency) {
              lines.push(
                '- 近 ' +
                  detail.trend.rounds +
                  ' 轮延迟：min ' +
                  detail.trend.latency.min +
                  ' / avg ' +
                  detail.trend.latency.avg +
                  ' / max ' +
                  detail.trend.latency.max +
                  ' ms',
              )
            }
            if (detail.trend.tps) {
              lines.push('- 近 ' + detail.trend.rounds + ' 轮 TPS 均值：' + detail.trend.tps.avg)
            }
            if (detail.last.error) lines.push('- 最后错误：' + detail.last.error)
            if (detail.stale) lines.push('')
            if (detail.stale) lines.push('> ⚠️ 数据已过期（' + (detail.ageMinutes ?? '?') + ' 分钟前）')
            // history 数组很长（每轮一条），工具结果只给趋势统计，避免刷屏
            const payload = Object.assign({}, detail)
            delete payload.history
            return Object.assign({ markdown: lines.join('\n') }, payload)
          },
        }),
      'llm-probe tool llm_probe_model_detail',
    )

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'llm_probe_logs',
          description:
            '只读。返回巡检日志 out/probe.log 的尾部若干行（默认 50，上限 500），用于排查失败原因。日志中的 sk- 密钥会被打码、单行截断。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              lines: { type: 'number', description: '要返回的行数，默认 50，上限 500' },
            },
          },
          output: { schema: okSchema, render: textRender },
          timeoutMs: 20000,
          isConcurrencySafe: () => true,
          async execute(args) {
            const result = getLogs({ lines: args && args.lines })
            return { markdown: '```\n' + (result.tail || []).join('\n') + '\n```', lines: result.lines, tail: result.tail }
          },
        }),
      'llm-probe tool llm_probe_logs',
    )
  }

  try {
    registerTools()
  } catch (error) {
    log('error', 'registerTools failed', { error: String((error && error.message) || error) })
  }

  /* ── 生命周期：首次需要时拉起；卸载时回收 ── */

  ctx.effect(() => {
    const prepared = engineOk && ensureDataDir()
    const timer = setTimeout(() => {
      if (!prepared) return // 包不完整时不反复 spawn，错误通过 /info 与面板错误页暴露
      ensureServer().catch(() => {})
    }, 1500)
    return () => {
      clearTimeout(timer)
      stopServer()
    }
  }, 'llm-probe server lifecycle')

  if (engineOk) {
    log('info', 'llm-probe ready', { dataDir, port, autoStart, keysConfigured: keysConfigured() })
  } else {
    log('warn', 'llm-probe 未就绪：' + setupHint, { dataDir, port })
  }
}
