/**
 * dsh-llm-probe — Client 半部（预构建 bundle，浏览器端直接加载）
 *
 * 交付：
 *   1. 侧边栏入口 `sidebar.panellist`（id: llm-probe）+ 状态角标 `llm-probe-status`；
 *   2. 主区全幅面板 `main`（key: llm-probe）：原生 React 工具条 + 同源 iframe 看板；
 *   3. 四层皮肤适配：令牌采样桥 → 皮肤身份热切换 → 画像 registry → 透明画布透出；
 *   4. 「打开 Web UI」按钮（window.open 优先，被拦则降级到 host 半白名单路由）。
 *
 * 数据只走同源 /plugins/llm-probe/*（由 Host 半部提供），与看板首页共用同一份 /api/stats。
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-probe',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PREFIX = '/plugins/llm-probe'
    const POLL_VISIBLE_MS = 30000
    const POLL_HIDDEN_MS = 300000

    /* ───────────────────────── 文案 ───────────────────────── */

    const TEXT = {
      title: '巡检看板',
      openWebUI: '打开 Web UI',
      openAria: '打开 Web UI（新标签页）',
      runNow: '立即巡检',
      retry: '重试',
      copy: '复制地址',
      copied: '已复制',
      loading: '正在连巡检服务…',
      offlineTitle: '巡检服务未连接',
      offlineHint: '插件负责托管 server.mjs。可以点「重试」重新拉起，或检查 8787 端口是否被占用。',
      errorTitle: '面板加载失败',
      badgeFail: (n) => n + ' 个模型不可用',
      badgeRunning: '巡检进行中',
      badgeStale: (m) => '数据已过期（最后更新 ' + m + ' 分钟前）',
      badgeOffline: '巡检服务未连接',
      hover: (fail, total, ago) => '不可用 ' + fail + ' / 共 ' + total + ' · 最近巡检 ' + ago,
      justNow: '刚刚',
      minutesAgo: (n) => n + ' 分钟前',
      hoursAgo: (n) => n + ' 小时前',
      mode: { light: '浅色', auto: '跟随皮肤', dsn: '只跟亮暗', classic: '经典样式' },
      appearance: '外观：',
      opened: '已交给系统浏览器打开',
      openFailed: '打开失败，请手动访问下面的地址',
      runStarted: '已启动一轮巡检',
      runRunning: '已有巡检在跑，未重复启动',
      runThrottled: '刚跑过，稍后再试',
      runFailed: '启动失败',
      setupHint: '还没填 API Key：在看板「密钥」页填一个密钥后即可开始巡检。',
    }

    /* ─────────────────── 第 1 层：令牌采样桥 ─────────────────── */

    // 令牌名已用 cordis_inspect_query(Theme.listTokens) + 现有插件 CSS 核对：
    // bg-elevated / fg-primary 并不存在，对应 bg-layer-1 / label-primary。
    const TOKEN_MAP = [
      ['--p-bg-base', ['--dsw-alias-bg-base']],
      ['--p-bg-card', ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-elevated']],
      ['--p-bg-card2', ['--dsw-alias-bg-layer-2']],
      ['--p-border', ['--dsw-alias-border-l1']],
      ['--p-border-strong', ['--dsw-alias-border-l2', '--dsw-alias-border-l4']],
      ['--p-fg', ['--dsw-alias-label-primary', '--dsw-alias-fg-primary']],
      ['--p-fg-muted', ['--dsw-alias-label-secondary', '--dsw-alias-fg-secondary']],
      ['--p-accent', ['--dsw-alias-brand-primary']],
      ['--p-accent-2', ['--dsw-alias-brand-primary']],
      ['--p-font-family', ['--dsw-font-family', '--ds-font-family']],
      ['--p-font-size', ['--dsh-content-font-size', '--dsw-font-size-body']],
      ['--p-hover', ['--dsw-alias-interactive-bg-hover']],
      ['--p-mask', ['--dsw-alias-bg-mask-1']],
    ]

    function readVar(el, name) {
      try {
        const value = getComputedStyle(el).getPropertyValue(name)
        return value ? value.trim() : ''
      } catch {
        return ''
      }
    }

    function sampleTokens() {
      const body = document.body
      const root = document.documentElement
      const out = { mode: isDark() ? 'dark' : 'light' }
      for (const [target, sources] of TOKEN_MAP) {
        let value = ''
        for (const source of sources) {
          value = readVar(body, source) || readVar(root, source)
          if (value) break
        }
        out[target] = value
      }
      if (!out['--p-font-family']) out['--p-font-family'] = 'system-ui, "Segoe UI", sans-serif'
      if (!out['--p-font-size']) out['--p-font-size'] = '13px'
      return out
    }

    function isDark() {
      const body = document.body
      const root = document.documentElement
      if (body && body.hasAttribute('data-ds-dark-theme')) return true
      if (root && (root.hasAttribute('data-ds-dark-theme') || root.classList.contains('dark'))) return true
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      } catch {
        return true
      }
    }

    /* 工具条与外壳的配色不依赖主题令牌一定存在：先采样，再逐个做对比度校验，
       不合格就用亮/暗两套固定兜底色。这样任何主题下文字都不会和底色糊在一起。 */

    function parseColor(value) {
      if (!value) return null
      const text = String(value).trim().toLowerCase()
      if (!text || text === 'transparent' || text === 'none' || text.indexOf('var(') >= 0) return null
      if (text.indexOf('color-mix') >= 0) return null
      let m = /^#([0-9a-f]{3,8})$/.exec(text)
      if (m) {
        const hex = m[1]
        if (hex.length === 3) {
          return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 }
        }
        if (hex.length === 6 || hex.length === 8) {
          return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
          }
        }
        return null
      }
      m = /^rgba?\(([^)]+)\)$/.exec(text)
      if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
      }
      return null
    }

    function relativeLuminance(c) {
      const channel = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    function contrastRatio(foreground, background) {
      const a = relativeLuminance(foreground)
      const b = relativeLuminance(background)
      const light = Math.max(a, b)
      const dark = Math.min(a, b)
      return (light + 0.05) / (dark + 0.05)
    }

    function pickReadable(candidate, background, minimum, fallback) {
      const fg = parseColor(candidate)
      const bg = parseColor(background)
      if (!fg || !bg) return fallback
      if (fg.a < 0.6) return fallback
      return contrastRatio(fg, bg) >= minimum ? candidate : fallback
    }

    const CHROME_FALLBACK = {
      dark: {
        panelBg: '#0f1115',
        barBg: '#171a1f',
        fg: '#eceef2',
        fgMuted: '#a7aeba',
        border: '#2b3038',
        borderStrong: '#3a414c',
        accent: '#4a8cf7',
        accentFg: '#0b111c',
        mask: 'rgba(3,7,18,.6)',
      },
      light: {
        panelBg: '#ffffff',
        barBg: '#f4f5f7',
        fg: '#1b1f27',
        fgMuted: '#596270',
        border: '#dde1e7',
        borderStrong: '#c3c9d2',
        accent: '#2f6fe4',
        accentFg: '#ffffff',
        mask: 'rgba(15,23,42,.35)',
      },
    }

    /* 默认外观：固定浅色。与宿主令牌无关，保证任何皮肤下看板都是同一套浅色。 */
    const LIGHT_PALETTE = {
      '--p-bg-base': '#f6f7f9',
      '--p-bg-card': '#ffffff',
      '--p-bg-card2': '#eef1f5',
      '--p-border': '#e2e6ec',
      '--p-border-strong': '#c9d0da',
      '--p-fg': '#1b1f27',
      '--p-fg-muted': '#5b6472',
      '--p-accent': '#2f6fe4',
      '--p-accent-2': '#7b61ff',
      '--p-hover': 'rgba(17,24,39,.05)',
      '--p-mask': 'rgba(15,23,42,.35)',
      '--p-radius': '10px',
    }

    function sampleChrome(appearance) {
      if (appearance === 'light') {
        const base = CHROME_FALLBACK.light
        return Object.assign({ dark: false }, base)
      }
      const tokens = sampleTokens()
      // 亮/暗优先用宿主真实底色判定（令牌可能来自任何第三方皮肤），判定不了才退回 mode
      const rawPanel = parseColor(tokens['--p-bg-base'])
      const dark = rawPanel ? relativeLuminance(rawPanel) < 0.35 : tokens.mode === 'dark'
      const base = dark ? CHROME_FALLBACK.dark : CHROME_FALLBACK.light

      const panelBg = pickReadable(tokens['--p-bg-base'], base.fg, 1.05, base.panelBg)
      const barBg = pickReadable(tokens['--p-bg-card'], base.fg, 1.02, base.barBg)
      const fg = pickReadable(tokens['--p-fg'], barBg, 4.5, base.fg)
      const fgMuted = pickReadable(tokens['--p-fg-muted'], barBg, 4.5, base.fgMuted)
      const accent = pickReadable(tokens['--p-accent'], barBg, 1.3, base.accent)
      const accentFg = contrastRatio(parseColor(base.panelBg), parseColor(accent) || parseColor(base.accent)) >= 4.5
        ? base.panelBg
        : base.accentFg

      return {
        dark,
        panelBg,
        barBg,
        fg,
        fgMuted,
        border: pickReadable(tokens['--p-border'], barBg, 1.05, base.border),
        borderStrong: pickReadable(tokens['--p-border-strong'], barBg, 1.15, base.borderStrong),
        accent,
        accentFg,
        mask: pickReadable(tokens['--p-mask'], base.fg, 1.2, base.mask),
      }
    }

    function chromeStyleVars(chrome) {
      return {
        '--lp-panel-bg': chrome.panelBg,
        '--lp-bar': chrome.barBg,
        '--lp-fg': chrome.fg,
        '--lp-fg-muted': chrome.fgMuted,
        '--lp-border': chrome.border,
        '--lp-border-strong': chrome.borderStrong,
        '--lp-accent': chrome.accent,
        '--lp-accent-fg': chrome.accentFg,
        '--lp-mask': chrome.mask,
        colorScheme: chrome.dark ? 'dark' : 'light',
      }
    }

    /* ─────────────────── 第 2 层：皮肤身份与热切换 ─────────────────── */

    function detectSkin(themeService) {
      let themeId = ''
      try {
        const snapshot = themeService && typeof themeService.getTheme === 'function' ? themeService.getTheme() : null
        themeId = (snapshot && (snapshot.id || snapshot.name)) || ''
      } catch {
        themeId = ''
      }
      const hasAttr = (name) =>
        !!(document.body && document.body.hasAttribute(name)) ||
        !!(document.documentElement && document.documentElement.hasAttribute(name)) ||
        !!document.querySelector('[' + name + ']')

      let skinId = 'unknown'
      if (hasAttr('data-dsh-maid-atelier')) skinId = 'maid-atelier'
      else if (hasAttr('data-dsh-orca-link')) skinId = 'orca-link'
      else if (themeId) skinId = String(themeId)
      else {
        const ds = document.documentElement && document.documentElement.dataset
        if (ds && ds.skin) skinId = String(ds.skin)
      }

      const kind = skinId === 'maid-atelier' || skinId === 'orca-link' ? 'overlay' : skinId === 'unknown' ? 'unknown' : 'token'
      return { skinId, kind, dark: isDark(), hasBackgroundLayer: kind === 'overlay' }
    }

    /* ─────────────────── 第 3 层：皮肤画像 registry ─────────────────── */

    const SKIN_PROFILES = {
      default: { radius: 8 },
      'maid-atelier': {
        accent: '#c5a468',
        surfaceAlpha: 0.82,
        backdropBlur: 10,
        borderStyle: '1px solid color-mix(in srgb, #c5a468 38%, transparent)',
        titleFont: 'serif',
        radius: 14,
        decorations: 'minimal',
      },
      'orca-link': {
        accent: '#3ea0ff',
        radius: 2,
        borderStyle: '1px solid rgba(255,255,255,.14)',
        decorations: 'tech',
      },
    }

    // 状态语义色固定，不被皮肤污染；深色提亮、浅色压深，正文对比度 ≥ 4.5:1
    const STATE_COLORS = {
      dark: { ok: '#3ddc97', fail: '#ff6b6b', warn: '#f5c451' },
      light: { ok: '#0f7b4f', fail: '#c92a2a', warn: '#8a5a00' },
    }

    function profileFor(skinId) {
      return SKIN_PROFILES[skinId] || SKIN_PROFILES.default
    }

    /* ─────────────────── 第 4 层：注入到 iframe 的样式 ─────────────────── */

    function buildFrameCss(tokens, skin, mode, appearance) {
      if (appearance === 'classic') return ''
      const profile = profileFor(skin.skinId)
      const state = STATE_COLORS[appearance === 'light' ? 'light' : skin.dark ? 'dark' : 'light']
      const lines = []
      const vars = []
      const push = (name, value) => {
        if (value) vars.push(name + ':' + value + ';')
      }

      // auto：中性层跟随令牌 + 皮肤画像；dsn：只跟亮暗（用看板自带暗/亮两套）
      if (appearance === 'light') {
        for (const [name, value] of Object.entries(LIGHT_PALETTE)) push(name, value)
        push('--p-font-family', tokens['--p-font-family'])
        push('--p-font-size', tokens['--p-font-size'])
      }

      if (appearance === 'auto') {
        push('--p-bg-base', tokens['--p-bg-base'])
        push('--p-bg-card', tokens['--p-bg-card'])
        push('--p-bg-card2', tokens['--p-bg-card2'])
        push('--p-border', tokens['--p-border'])
        push('--p-border-strong', tokens['--p-border-strong'])
        push('--p-fg', tokens['--p-fg'])
        push('--p-fg-muted', tokens['--p-fg-muted'])
        push('--p-accent', profile.accent || tokens['--p-accent'])
        push('--p-accent-2', profile.accent || tokens['--p-accent-2'])
        push('--p-font-family', tokens['--p-font-family'])
        push('--p-font-size', tokens['--p-font-size'])
        push('--p-hover', tokens['--p-hover'])
        push('--p-mask', tokens['--p-mask'])
        push('--p-radius', (profile.radius || 8) + 'px')
      }

      push('--p-ok', state.ok)
      push('--p-bad', state.fail)
      push('--p-warn', state.warn)

      if (vars.length) lines.push(':root{' + vars.join('') + '}')

      // 装饰型皮肤：透明画布 + 半透明卡片 + 背景透出
      if (appearance === 'auto' && profile.surfaceAlpha) {
        const alpha = profile.surfaceAlpha
        const blur = profile.backdropBlur || 0
        lines.push(
          'body{background:transparent!important}',
          'html{background:transparent!important}',
          '#sidebar,.card,.panel,.stat,.item,#modal .dialog{' +
            'backdrop-filter:blur(' +
            blur +
            'px) saturate(1.05);-webkit-backdrop-filter:blur(' +
            blur +
            'px) saturate(1.05);}',
          '.card,.panel,.stat{background:color-mix(in srgb, var(--p-bg-card) ' +
            Math.round(alpha * 100) +
            '%, transparent)!important}',
          '#sidebar{background:color-mix(in srgb, var(--p-bg-card) ' +
            Math.round(Math.min(0.95, alpha + 0.1) * 100) +
            '%, transparent)!important}',
          '#modal{background:color-mix(in srgb, var(--p-bg-base) 55%, transparent)!important;backdrop-filter:blur(3px)}',
          'tr:hover td{background:color-mix(in srgb, var(--p-fg) 6%, transparent)!important}',
        )
      }

      if (appearance === 'auto' && profile.titleFont) {
        lines.push('#sidebar .brand{font-family:' + profile.titleFont + ';letter-spacing:.4px}')
      }

      if (profile.borderStyle && appearance === 'auto') {
        lines.push('.card,.panel{border-color:color-mix(in srgb, ' + (profile.accent || 'currentColor') + ' 35%, transparent)}')
      }

      // 圆角跟画像
      lines.push(
        '.card,.panel,.stat,.btn,.badge,#sidebar nav button{border-radius:var(--p-radius,8px)}',
        '.badge{border-radius:999px}',
      )

      return lines.join('\n')
    }

    function applyFrameStyle(frame, css) {
      const doc = frame && frame.contentDocument
      if (!doc || !doc.head) return
      let tag = doc.getElementById('dsh-llm-probe-skin')
      if (!css) {
        if (tag) tag.remove()
        return
      }
      if (!tag) {
        tag = doc.createElement('style')
        tag.id = 'dsh-llm-probe-skin'
        doc.head.appendChild(tag)
      }
      if (tag.textContent !== css) tag.textContent = css
    }

    /* ─────────────────── 数据源：同源快照（单一数据源） ─────────────────── */

    async function getJson(path, options) {
      const response = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}))
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!response.ok) throw new Error((data && (data.message || data.error)) || 'HTTP ' + response.status)
      return data
    }

    const store = {
      stats: null,
      info: null,
      error: null,
      loading: true,
      updatedAt: 0,
      subs: new Set(),
      timer: null,
      inFlight: null,
      refs: 0,
    }

    function emit() {
      for (const fn of Array.from(store.subs)) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }

    function refreshSnapshot() {
      if (store.inFlight) return store.inFlight
      store.inFlight = (async () => {
        try {
          const info = await getJson(PREFIX + '/info')
          let stats = null
          if (info && info.healthy) {
            try {
              stats = await getJson(PREFIX + '/stats')
            } catch {
              stats = null
            }
          }
          store.info = info
          store.stats = stats
          store.error = stats ? null : '巡检服务未连接'
          store.updatedAt = Date.now()
        } catch (error) {
          store.error = String((error && error.message) || error)
          store.info = null
          store.stats = null
        } finally {
          store.loading = false
          store.inFlight = null
          emit()
        }
      })()
      return store.inFlight
    }

    function schedulePoll() {
      if (store.timer) clearTimeout(store.timer)
      const hidden = document.visibilityState === 'hidden'
      const delay = hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS
      store.timer = setTimeout(async () => {
        if (document.visibilityState !== 'hidden') await refreshSnapshot()
        schedulePoll()
      }, delay)
    }

    function useSnapshot() {
      const [, force] = useState(0)
      useEffect(() => {
        const fn = () => force((n) => n + 1)
        store.subs.add(fn)
        store.refs += 1
        if (store.refs === 1) {
          refreshSnapshot()
          schedulePoll()
          if (!store.visibilityBound) {
            store.visibilityBound = true
            document.addEventListener('visibilitychange', onVisibility)
            window.addEventListener('online', onOnline)
          }
        } else {
          refreshSnapshot()
        }
        return () => {
          store.subs.delete(fn)
          store.refs -= 1
          if (store.refs <= 0) {
            store.refs = 0
            if (store.timer) {
              clearTimeout(store.timer)
              store.timer = null
            }
            if (store.visibilityBound) {
              store.visibilityBound = false
              document.removeEventListener('visibilitychange', onVisibility)
              window.removeEventListener('online', onOnline)
            }
          }
        }
      }, [])
      return store
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') refreshSnapshot()
    }
    function onOnline() {
      refreshSnapshot()
    }

    /* ─────────────────── 角标状态机 ─────────────────── */

    function intervalMinutes(info) {
      const n = info && Number(info.intervalMinutes)
      return Number.isFinite(n) && n > 0 ? n : 60
    }

    function badgeState(snap) {
      const info = snap.info
      if (!info || info.healthy === false) return { kind: 'offline', count: 0, tooltip: TEXT.badgeOffline, aria: TEXT.badgeOffline }
      const stats = snap.stats
      const failed = stats && Array.isArray(stats.unavailable) ? stats.unavailable.length : 0
      const total = stats && Number.isFinite(stats.totalEntries) ? stats.totalEntries : 0
      const roundAgeMin = stats && Number.isFinite(stats.roundAgeMin) ? stats.roundAgeMin : null
      const limit = intervalMinutes(info) * 2
      const stale = info.stale || (roundAgeMin !== null && roundAgeMin > limit)

      if (info.running) return { kind: 'running', count: failed, tooltip: TEXT.badgeRunning, aria: TEXT.badgeRunning }
      if (stale) {
        const mins = roundAgeMin !== null ? roundAgeMin : 0
        return { kind: 'stale', count: failed, tooltip: TEXT.badgeStale(mins), aria: TEXT.badgeStale(mins) }
      }
      if (failed > 0) {
        return {
          kind: 'fail',
          count: failed,
          total,
          failed,
          tooltip: TEXT.hover(failed, total, agoText(roundAgeMin)),
          aria: TEXT.badgeFail(failed),
        }
      }
      return { kind: 'ok', count: 0, total, failed: 0, tooltip: TEXT.hover(0, total, agoText(roundAgeMin)), aria: '全部模型可用' }
    }

    function agoText(minutes) {
      if (minutes === null || minutes === undefined) return '—'
      if (minutes < 1) return TEXT.justNow
      if (minutes < 60) return TEXT.minutesAgo(Math.round(minutes))
      return TEXT.hoursAgo(Math.round(minutes / 60))
    }

    function badgeText(state) {
      if (state.kind === 'fail') return state.count > 99 ? '99+' : String(state.count)
      return ''
    }

    /* ─────────────────── 图标 ─────────────────── */

    function ProbeGlyph(props) {
      const size = props.size || 18
      return h(
        'svg',
        {
          className: 'lp-glyph' + (props.active ? ' is-active' : ''),
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          // 皮肤契约（L2）通过该属性把侧栏行归属到插件，shell 自身不提供 per-entry 钩子
          'data-dsh-panel-entry': 'llm-probe',
        },
        h('rect', { x: '2.75', y: '3.75', width: '18.5', height: '16.5', rx: '4.25', stroke: 'currentColor', strokeWidth: '1.85' }),
        h('path', {
          d: 'M5.4 14.6h2.1l1.5-4.3 2.05 7 1.95-9.1 1.8 6.4h3.8',
          stroke: 'currentColor',
          strokeWidth: '1.95',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: '18.1', cy: '8.1', r: '1.9', fill: 'currentColor' }),
      )
    }

    /* ─────────────────── 侧边栏入口 + 角标 ─────────────────── */

    function SidebarEntry(props) {
      const snap = useSnapshot()
      const state = badgeState(snap)
      const text = badgeText(state)
      const size = props.size || 20
      const open = useCallback(() => {
        try {
          const layout = ctxRef.current && ctxRef.current.get ? ctxRef.current.get('layout') : null
          if (layout && typeof layout.selectPanel === 'function') {
            layout.selectPanel('llm-probe')
            return
          }
        } catch {
          /* ignore */
        }
      }, [])

      // shell 拥有按钮、label、tooltip 与 active 高亮；这里只画 glyph 与角标
      return h(
        'span',
        {
          className: 'lp-sidebar ' + (props.active ? 'is-active' : ''),
          style: { width: size + 'px', height: size + 'px' },
          title: state.tooltip,
          onClick: open,
          'aria-label': state.aria,
        },
        h(ProbeGlyph, { size, active: props.active }),
        text
          ? h('i', { className: 'lp-badge lp-badge-' + state.kind, 'aria-hidden': 'true' }, text)
          : state.kind === 'running'
            ? h('i', { className: 'lp-badge lp-badge-running', 'aria-hidden': 'true' })
            : state.kind === 'offline'
              ? h('i', { className: 'lp-badge lp-badge-offline', 'aria-hidden': 'true' })
              : state.kind === 'stale'
                ? h('i', { className: 'lp-badge lp-badge-stale', 'aria-hidden': 'true' })
                : null,
      )
    }

    /* ─────────────────── 工具条按钮 ─────────────────── */

    function ToolButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'lp-btn' + (props.secondary ? ' is-secondary' : '') + (props.disabled ? ' is-disabled' : ''),
          disabled: !!props.disabled,
          title: props.title || props.children,
          'aria-label': props.ariaLabel || undefined,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /* ─────────────────── 主面板 ─────────────────── */

    function Panel() {
      const snap = useSnapshot()
      const [appearance, setAppearance] = useState('light')
      const [frameKey, setFrameKey] = useState(0)
      const [toast, setToast] = useState('')
      const [frameLoaded, setFrameLoaded] = useState(false)
      const [chromeTick, setChromeTick] = useState(0)
      const frameRef = useRef(null)
      const ctxRefLocal = useRef(null)
      const toastTimer = useRef(null)

      const info = snap.info
      const healthy = !!(info && info.healthy)
      const baseUrl = (info && info.baseUrl) || 'http://127.0.0.1:8787'
      const state = badgeState(snap)

      const flash = useCallback((text) => {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2200)
      }, [])

      useEffect(() => {
        refreshSnapshot()
        getJson(PREFIX + '/appearance')
          .then((data) => {
            if (data && data.mode) setAppearance(data.mode)
          })
          .catch(() => {})
        return () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        }
      }, [])

      // 外壳（工具条/按钮）跟着主题走：属性或亮暗变化时重算一次配色
      useEffect(() => {
        let alive = true
        const bump = () => {
          if (alive) setChromeTick((n) => n + 1)
        }
        const observer = new MutationObserver(bump)
        const filter = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style', 'data-dsh-maid-atelier', 'data-dsh-orca-link'] }
        observer.observe(document.documentElement, filter)
        if (document.body) observer.observe(document.body, filter)
        const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        if (mq && mq.addEventListener) mq.addEventListener('change', bump)
        return () => {
          alive = false
          observer.disconnect()
          if (mq && mq.removeEventListener) mq.removeEventListener('change', bump)
        }
      }, [])

      // 第 1+2 层：采样 + 注入；皮肤热切换 1 帧内跟上
      const syncFrame = useCallback(() => {
        const frame = frameRef.current
        if (!frame || !frame.contentDocument) return
        const themeService = (() => {
          try {
            return ctxRef.current && ctxRef.current.get ? ctxRef.current.get('theme') : null
          } catch {
            return null
          }
        })()
        const tokens = sampleTokens()
        const skin = detectSkin(themeService)
        applyFrameStyle(frame, buildFrameCss(tokens, skin, skin.kind, appearance))
      }, [appearance])

      useEffect(() => {
        if (!frameLoaded) return
        syncFrame()
        const observer = new MutationObserver(() => syncFrame())
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style', 'data-dsh-maid-atelier', 'data-dsh-orca-link'] })
        if (document.body) {
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style', 'data-dsh-maid-atelier', 'data-dsh-orca-link'] })
        }
        const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        const onMq = () => syncFrame()
        if (mq && mq.addEventListener) mq.addEventListener('change', onMq)
        return () => {
          observer.disconnect()
          if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq)
        }
      }, [frameLoaded, syncFrame])

      const copyAddress = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(baseUrl)
          flash(TEXT.copied)
        } catch {
          flash(baseUrl)
        }
      }, [baseUrl, flash])

      const openWebUI = useCallback(async () => {
        const url = baseUrl
        let opened = null
        try {
          opened = window.open(url, '_blank', 'noopener,noreferrer')
        } catch {
          opened = null
        }
        if (opened && !opened.closed) {
          flash(TEXT.opened)
          return
        }
        // 降级：交给 host 半的白名单路由，用系统浏览器打开
        try {
          await getJson(PREFIX + '/open-web-ui', { method: 'POST', body: JSON.stringify({ url }) })
          flash(TEXT.opened)
        } catch (error) {
          flash(TEXT.openFailed + '：' + baseUrl)
        }
      }, [baseUrl, flash])

      const runNow = useCallback(async () => {
        if (info && info.running) {
          flash(TEXT.runRunning)
          return
        }
        try {
          const result = await getJson(PREFIX + '/run', { method: 'POST', body: JSON.stringify({ reason: 'panel-button' }) })
          flash(result && result.started ? TEXT.runStarted : (result && result.reason) || TEXT.runThrottled)
          refreshSnapshot()
        } catch (error) {
          flash(TEXT.runFailed + '：' + String((error && error.message) || error))
        }
      }, [info, flash])

      const cycleAppearance = useCallback(async () => {
        const order = ['light', 'auto', 'classic']
        const next = order[(order.indexOf(appearance) + 1) % order.length]
        setAppearance(next)
        try {
          await getJson(PREFIX + '/appearance', { method: 'POST', body: JSON.stringify({ mode: next }) })
        } catch {
          /* 持久化失败不影响本次生效 */
        }
      }, [appearance])

      const src = PREFIX + '/dashboard/' + '?embed=1&v=' + frameKey

      const chrome = useMemo(() => sampleChrome(appearance), [chromeTick, appearance])

      return h(
        'div',
        { className: 'lp-panel', style: chromeStyleVars(chrome), 'data-lp-theme': chrome.dark ? 'dark' : 'light' },
        h(
          'div',
          { className: 'lp-toolbar' },
          h(
            'div',
            { className: 'lp-toolbar-left' },
            h(ProbeGlyph, { size: 16 }),
            h('span', { className: 'lp-title' }, TEXT.title),
            h('i', { className: 'lp-dot lp-dot-' + state.kind, title: state.tooltip, 'aria-hidden': 'true' }),
            h(
              'button',
              { type: 'button', className: 'lp-addr', onClick: copyAddress, title: TEXT.copy },
              baseUrl.replace(/^https?:\/\//, ''),
            ),
          ),
          h(
            'div',
            { className: 'lp-toolbar-right' },
            h(
              'button',
              { type: 'button', className: 'lp-mode', onClick: cycleAppearance, title: TEXT.appearance + TEXT.mode[appearance] },
              TEXT.mode[appearance],
            ),
            h(ToolButton, { secondary: true, onClick: runNow, disabled: !healthy, title: TEXT.runNow }, TEXT.runNow),
            h(
              'button',
              {
                type: 'button',
                className: 'lp-btn is-secondary lp-open',
                onClick: openWebUI,
                disabled: !healthy,
                title: healthy ? TEXT.openAria : '巡检服务未启动，点击重试',
                'aria-label': TEXT.openAria,
              },
              TEXT.openWebUI,
              h(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M14 4h6v6M20 4l-8.5 8.5', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
                h('path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round' }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'lp-body' },
          healthy && info && info.keysConfigured === false
            ? h(
                'div',
                { className: 'lp-setup', role: 'status' },
                h('span', { className: 'lp-setup-text' }, TEXT.setupHint),
                h('span', { className: 'lp-setup-path' }, info.dataDir || ''),
              )
            : null,
          healthy
            ? h('iframe', {
                key: frameKey,
                ref: frameRef,
                className: 'lp-frame',
                src,
                title: TEXT.title,
                onLoad: () => {
                  setFrameLoaded(true)
                  requestAnimationFrame(() => {
                    try {
                      syncFrame()
                    } catch {
                      /* ignore */
                    }
                  })
                },
              })
            : h(
                'div',
                { className: 'lp-error' },
                h('div', { className: 'lp-error-title' }, TEXT.offlineTitle),
                h('div', { className: 'lp-error-hint' }, (snap.info && (snap.info.setupHint || snap.info.errorHint)) || TEXT.offlineHint),
                h('div', { className: 'lp-error-url' }, snap.info && snap.info.dataDir ? snap.info.dataDir : baseUrl),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'lp-btn',
                    onClick: () => {
                      setFrameKey((n) => n + 1)
                      refreshSnapshot()
                    },
                  },
                  TEXT.retry,
                ),
              ),
          snap.loading ? h('div', { className: 'lp-loading' }, TEXT.loading) : null,
          toast ? h('div', { className: 'lp-toast', role: 'status' }, toast) : null,
        ),
      )
    }

    /* ─────────────────── 样式（随插件卸载一起移除） ─────────────────── */

    const CSS = `
.lp-sidebar{position:relative;display:block;color:inherit;cursor:pointer;opacity:1}
.lp-sidebar.is-active{color:var(--dsw-alias-label-primary,#eceef2)}
.lp-glyph{display:block;opacity:1}
.lp-badge{position:absolute;top:-3px;right:-5px;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;
  display:inline-flex;align-items:center;justify-content:center;border-radius:999px;
  font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;
  color:#fff;background:var(--dsw-alias-state-error-primary,#e5484d);
  box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,transparent);
  transition:opacity .15s ease}
.lp-badge-fail{background:var(--dsw-alias-state-error-primary,#e5484d)}
.lp-badge-running{width:8px;height:8px;min-width:8px;padding:0;background:var(--dsw-alias-brand-primary,#3b82f6);animation:lp-pulse 1.6s ease-in-out infinite}
.lp-badge-stale{width:8px;height:8px;min-width:8px;padding:0;background:var(--dsw-alias-state-idle-primary,#8b949e)}
.lp-badge-offline{width:8px;height:8px;min-width:8px;padding:0;background:transparent;border:1.5px solid var(--dsw-alias-state-idle-primary,#8b949e)}
@keyframes lp-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
@media (prefers-reduced-motion: reduce){.lp-badge-running{animation:none}}

.lp-panel{display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--lp-panel-bg,#0f1115);color:var(--lp-fg,#eceef2);font-size:13px}
.lp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;
  height:46px;min-height:46px;padding:0 10px 0 12px;box-sizing:border-box;
  border-bottom:1px solid var(--lp-border,#2b3038);background:var(--lp-bar,#171a1f);color:var(--lp-fg,#eceef2)}
.lp-toolbar-left,.lp-toolbar-right{display:flex;align-items:center;gap:8px;min-width:0}
.lp-toolbar-left{color:var(--lp-fg-muted,#a7aeba)}
.lp-title{font-size:13px;font-weight:600;color:var(--lp-fg,#eceef2);white-space:nowrap}
.lp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8b949e);flex:none}
.lp-dot-ok{background:var(--dsw-alias-state-success-primary,#2ea44f)}
.lp-dot-fail{background:var(--dsw-alias-state-error-primary,#e5484d)}
.lp-dot-running{background:var(--lp-accent,#4a8cf7);animation:lp-pulse 1.6s ease-in-out infinite}
.lp-dot-stale{background:var(--dsw-alias-state-warn-primary,#b8860b)}
.lp-dot-offline{background:transparent;border:1.5px solid var(--dsw-alias-state-idle-primary,#8b949e)}
.lp-addr{appearance:none;border:0;background:none;padding:2px 5px;border-radius:5px;cursor:copy;
  font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;font-weight:500;
  color:var(--lp-fg-muted,#a7aeba);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.lp-addr:hover{background:color-mix(in srgb,var(--lp-fg,#eceef2) 10%,transparent);color:var(--lp-fg,#eceef2)}
.lp-addr:focus-visible{outline:2px solid var(--lp-accent,#4a8cf7);outline-offset:1px}
.lp-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--lp-accent,#4a8cf7);background:var(--lp-accent,#4a8cf7);color:var(--lp-accent-fg,#0b111c);
  font-size:12px;font-weight:600;line-height:1.4;border-radius:8px;padding:5px 11px;cursor:pointer;
  transition:filter .15s ease,background-color .15s ease}
.lp-btn:hover:not(:disabled){filter:brightness(1.08)}
.lp-btn:focus-visible{outline:2px solid var(--lp-accent,#4a8cf7);outline-offset:2px}
.lp-btn:disabled{opacity:.55;cursor:not-allowed}
.lp-btn.is-secondary{background:transparent;border:1px solid var(--lp-border-strong,#3a414c);
  color:var(--lp-fg,#eceef2);font-weight:500}
.lp-btn.is-secondary:hover:not(:disabled){background:color-mix(in srgb,var(--lp-fg,#eceef2) 10%,transparent);
  border-color:var(--lp-fg-muted,#a7aeba)}
.lp-mode{appearance:none;border:1px dashed var(--lp-border-strong,#3a414c);background:transparent;border-radius:999px;
  color:var(--lp-fg-muted,#a7aeba);font-size:11px;font-weight:500;padding:3px 9px;cursor:pointer;white-space:nowrap}
.lp-mode:hover{color:var(--lp-fg,#eceef2);border-color:var(--lp-fg-muted,#a7aeba)}
.lp-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.lp-setup{flex:none;display:flex;gap:10px;align-items:center;padding:8px 12px;font-size:12px;
  background:color-mix(in srgb, var(--lp-accent) 14%, var(--lp-bar));color:var(--lp-fg);
  border-bottom:1px solid var(--lp-border)}
.lp-setup-text{flex:1;line-height:1.5}
.lp-setup-path{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;
  color:var(--lp-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%}
.lp-frame{flex:1;width:100%;min-height:0;border:0;display:block;background:var(--lp-panel-bg,#0f1115)}
.lp-error{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}
.lp-error-title{font-size:14px;font-weight:600;color:var(--lp-fg,#eceef2)}
.lp-error-hint{font-size:12px;line-height:1.6;color:var(--lp-fg-muted,#a7aeba);max-width:460px}
.lp-error-url{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;color:var(--lp-fg-muted,#a7aeba)}
.lp-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:var(--lp-fg-muted,#a7aeba);font-size:12px;pointer-events:none}
.lp-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);max-width:80%;
  background:var(--lp-bar,#171a1f);border:1px solid var(--lp-border-strong,#3a414c);
  color:var(--lp-fg,#eceef2);font-size:12px;padding:6px 12px;border-radius:8px;
  box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:5}
`

    /* ─────────────────── 插件装配 ─────────────────── */

    const ctxRef = { current: null }

    const inject = ['slots']

    function apply(ctx) {
      ctxRef.current = ctx

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-llm-probe'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-llm-probe: styles')

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'llm-probe', order: 30, label: TEXT.title },
              SidebarEntry,
            ),
          ),
        'dsh-llm-probe: sidebar entry',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'llm-probe', id: 'llm-probe' }, Panel),
          ),
        'dsh-llm-probe: main panel',
      )

      const dispose = () => {
        if (store.timer) clearTimeout(store.timer)
        store.timer = null
        store.subs.clear()
        store.refs = 0
      }
      ctx.effect(() => dispose, 'dsh-llm-probe: poll cleanup')
    }

    return { apply, inject }
  },
})
