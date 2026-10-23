#!/usr/bin/env node
/**
 * server.mjs — 巡检看板（零依赖，SPA）
 * 用法: node server.mjs [--port 8787] [--out out] [--catalog catalog.json] [--overrides overrides.json] [--web dashboard.html]
 *
 * API:
 *   GET  /                 页面（dashboard.html）
 *   GET  /api/status       最近一轮完整明细（status.json）
 *   GET  /api/stats        首页汇总（机房可用率 / 今日轮次 / 不可用模型）
 *   GET  /api/catalog      清单 + 手动模型 + 覆盖项 + 设置
 *   POST /api/config       {overrides} | {addModel} | {deleteModel} | {settings}
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { sendHtmlMail } from './mailer.mjs';

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const HERE = import.meta.dirname ?? process.cwd();
// 数据目录（catalog / keys / overrides / out / media）可搬到插件数据目录：--data <dir>
const DATA = path.resolve(getArg('data', HERE));
const PORT = Number(getArg('port', 8787));
const OUTDIR = path.resolve(getArg('out', path.join(DATA, 'out')));
const STATUS = path.join(OUTDIR, 'status.json');
const ROUNDS = path.join(OUTDIR, 'rounds.jsonl');
const CATALOG = path.resolve(getArg('catalog', path.join(DATA, 'catalog.json')));
const OVERRIDES = path.resolve(getArg('overrides', path.join(DATA, 'overrides.json')));
const KEYS = path.resolve(getArg('keys', path.join(DATA, 'keys.json')));
const WEB = path.resolve(getArg('web', path.join(HERE, 'dashboard.html')));

// 计划任务名与启动命令（ASCII 任务名，避免 cmd 中文编码问题）
const TASK_NAME = 'DSH-Probe';
const VBS_PROBE = path.join(HERE, 'run-probe-hidden.vbs');
const TASK_TR = `wscript.exe //B //Nologo ${VBS_PROBE}`;

async function readJSON(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}
async function readText(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadOverridesDoc() {
  const doc = await readJSON(OVERRIDES);
  return {
    updatedAt: doc?.updatedAt ?? null,
    overrides: (doc && typeof doc.overrides === 'object' && doc.overrides) || {},
    customModels: Array.isArray(doc?.customModels) ? doc.customModels : [],
    entryEdits: (doc && typeof doc.entryEdits === 'object' && doc.entryEdits) || {},
    removedModels: Array.isArray(doc?.removedModels) ? doc.removedModels : [],
    settings: (doc && typeof doc.settings === 'object' && doc.settings) || {},
  };
}

async function saveOverridesDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  await writeFile(OVERRIDES, JSON.stringify(doc, null, 2), 'utf8');
}

// ── keys.json 管理：形如 { "电信机房部署": "sk-...", ... }（下划线开头的键是说明注释） ──
async function loadKeysDoc() {
  const doc = await readJSON(KEYS);
  const keys = {};
  if (doc && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      if (k.startsWith('_')) continue;
      // 兼容 string 或 { headers: {...} } 写法，管理页只展示原始配置
      keys[k] = v;
    }
  }
  return { doc: doc && typeof doc === 'object' ? doc : {}, keys };
}

async function saveKeysDoc(doc) {
  await writeFile(KEYS, JSON.stringify(doc, null, 2), 'utf8');
}

// ── 巡检运行状态：读 out/probe.state.json 并校验 pid 存活 ──
// 同时覆盖看板启动与定时任务启动的巡检（二者都写同一 state 文件）。
let localProbePid = 0; // 本 server 最近启动的 probe（state 尚未落盘时兜底）
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function readProbeState() {
  const st = await readJSON(path.join(OUTDIR, 'probe.state.json'));
  if (st && st.pid && pidAlive(st.pid)) {
    return {
      running: true,
      pid: st.pid,
      startedAt: st.startedAt,
      runId: st.runId,
      source: st.source || null,
      elapsedMs: st.startedAt ? Date.now() - Date.parse(st.startedAt) : null,
    };
  }
  // state 未落盘（刚 spawn）或已删除（已完成）：用本 server 启动的 pid 精准判断
  if (localProbePid && pidAlive(localProbePid)) {
    return { running: true, pid: localProbePid, launching: true };
  }
  return { running: false, ...(st && st.pid ? { stalePid: st.pid } : {}) };
}

// ── 触发一轮巡检（立即测试）：在后台跑 probe，不阻塞请求、不影响计划任务 ──
function runProbeNow() {
  const args = [
    path.join(HERE, 'probe.mjs'),
    '--catalog', CATALOG,
    '--keys', KEYS,
    '--overrides', OVERRIDES,
    '--out', OUTDIR,
    '--concurrency', '8',
    // 不传 --timeout，让 probe 读取 overrides.settings.timeoutMs（与计划任务一致）
  ];
  const child = spawn(process.execPath, args, {
    cwd: DATA,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PROBE_SOURCE: 'dashboard', PROBE_DATA_DIR: DATA },
  });
  child.unref();
  const startedAt = new Date().toISOString();
  localProbePid = child.pid;
  // 立即落盘 state，消除“刚启动但状态未写”的重复触发竞态（probe 会用同一 pid 覆盖）
  writeFile(path.join(OUTDIR, 'probe.state.json'),
    JSON.stringify({ pid: child.pid, startedAt, source: 'dashboard' }, null, 2), 'utf8').catch(() => {});
  return { pid: child.pid, startedAt };
}

/** 从 multipart body 中取出第一个带 filename 的文件段 */
function parseMultipartFile(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next < 0) break;
    let dataEnd = next;
    if (buf[dataEnd - 2] === 0x0d && buf[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const fn = headers.match(/filename="([^"]*)"/i);
    const nm = headers.match(/name="([^"]*)"/i);
    if (fn && nm) {
      return { field: nm[1], filename: fn[1], data: buf.slice(headerEnd + 4, dataEnd) };
    }
    pos = next;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  try {
    // ── 页面 ──
    if ((url === '/' || url === '/index.html' || url === '/dashboard.html') && method === 'GET') {
      const html = await readText(WEB);
      if (html == null) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('缺少 dashboard.html: ' + WEB);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    // ── 最近一轮明细 ──
    if (url === '/api/status' && method === 'GET') {
      const raw = await readText(STATUS);
      if (raw == null) return json(200, {});
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(raw);
    }

    // ── 首页汇总 ──
    if (url === '/api/stats' && method === 'GET') {
      const status = await readJSON(STATUS);
      const entries = status?.entries ?? [];

      // 机房维度：本轮可用率
      const sheetStats = {};
      for (const e of entries) {
        const s = sheetStats[e.sheet] ?? (sheetStats[e.sheet] = { total: 0, ok: 0 });
        s.total++;
        if (e.ok) s.ok++;
      }
      for (const s of Object.values(sheetStats)) {
        s.availability = s.total ? +(s.ok / s.total).toFixed(4) : null;
      }

      // 今日巡检轮次：读 rounds.jsonl，统计本地日期为今天的轮次
      let roundsToday = 0;
      let lastRound = null;
      const rraw = await readText(ROUNDS);
      if (rraw) {
        const today = localISO();
        for (const line of rraw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            const at = r.startedAt || r.finishedAt;
            if (at && localISO(new Date(at)) === today) roundsToday++;
            lastRound = r;
          } catch { /* 跳过坏行 */ }
        }
      }

      const catalog = await readJSON(CATALOG);
      const ov = await loadOverridesDoc();
      const catAge = catalog?.generatedAt
        ? Math.floor((Date.now() - Date.parse(catalog.generatedAt)) / 86400000) : null;
      const roundAgeMin = status?.generatedAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(status.generatedAt)) / 60000)) : null;
      // 纳入数必须与真正参与巡检的条数一致：套用 overrides（纳入/排除）、removedModels 与 entryEdits
      const removedSet = new Set(ov.removedModels);
      const effInclude = (e) => (Object.prototype.hasOwnProperty.call(ov.overrides, e.id)
        ? ov.overrides[e.id] === 'include'
        : e.include === 'include');
      const effUrl = (e) => {
        const edited = ov.entryEdits?.[e.id];
        return edited && Object.prototype.hasOwnProperty.call(edited, 'url') ? edited.url : e.url;
      };
      const totalEntries = (catalog?.entries ?? [])
        .filter((e) => !removedSet.has(e.id) && effInclude(e) && effUrl(e)).length
        + ov.customModels.filter((e) => effInclude(e) && e.url).length;

      return json(200, {
        roundsToday,
        lastRound,
        roundAgeMin,
        sheetStats,
        unavailable: entries.filter((e) => !e.ok),
        summary: status?.summary ?? {},
        catalogAge: catAge,
        totalEntries,
      });
    }

    // ── 清单 + 手动模型 + 覆盖 + 设置 ──
    if (url === '/api/catalog' && method === 'GET') {
      const catalog = await readJSON(CATALOG);
      const ov = await loadOverridesDoc();

      const decorate = (e, isCustom) => {
        // entryEdits 覆盖清单条目字段（编辑清单模型时写入）
        const edits = ov.entryEdits?.[e.id];
        const merged = edits ? { ...e, ...edits } : e;
        const overridden = Object.prototype.hasOwnProperty.call(ov.overrides, e.id) || !!edits;
        const eff = Object.prototype.hasOwnProperty.call(ov.overrides, e.id)
          ? ov.overrides[e.id] === 'include'
          : e.include === 'include';
        return {
          ...merged,
          effectiveInclude: eff,
          overridden,
          defaultInclude: e.include === 'include',
          _custom: isCustom,
          _edited: !!edits,
        };
      };

      const removed = new Set(ov.removedModels);
      const entries = [
        ...(catalog?.entries ?? []).filter((e) => !removed.has(e.id)).map((e) => decorate(e, false)),
        ...ov.customModels.map((e) => decorate(e, true)),
      ];

      return json(200, {
        catalogGeneratedAt: catalog?.generatedAt ?? null,
        settings: ov.settings,
        overrides: ov.overrides,
        removedModels: ov.removedModels,
        entries,
      });
    }

    // ── 密钥管理：返回各子表 key + 手动模型里单独指定的 apiKey ──
    if (url === '/api/keys' && method === 'GET') {
      const { doc, keys } = await loadKeysDoc();
      const ov = await loadOverridesDoc();
      const customKeys = {};
      for (const m of ov.customModels) {
        if (m && m.name && m.apiKey) customKeys[m.id] = m.apiKey;
      }
      return json(200, { doc, keys, customKeys });
    }

    // ── 密钥写入：{ keys: { 子表: key } }，整体替换子表 key ──
    if (url === '/api/keys' && method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let data = null;
      try { data = JSON.parse(body); } catch { /* fallthrough */ }
      if (!data || !data.keys || typeof data.keys !== 'object') {
        return json(400, { error: '需要 { keys: { 子表: key } }' });
      }
      const { doc } = await loadKeysDoc();
      const safe = typeof doc === 'object' && doc ? doc : {};
      // 保留说明性“_”键，仅更新子表 key
      const clean = {};
      for (const [k, v] of Object.entries(data.keys)) {
        if (k && !k.startsWith('_')) clean[k] = typeof v === 'string' ? v.trim() : '';
      }
      const merged = { ...safe };
      for (const [k, v] of Object.entries(clean)) merged[k] = v;
      await saveKeysDoc(merged);
      return json(200, { ok: true, updated: Object.keys(clean) });
    }

    // ── 巡检运行状态（首页按钮轮询用） ──
    if (url === '/api/probe/status' && method === 'GET') {
      return json(200, await readProbeState());
    }

    // ── 立即测试：已有巡检在跑时不重复启动，返回 running 让前端等待 ──
    if (url === '/api/probe' && method === 'POST') {
      const st = await readProbeState();
      if (st.running) {
        return json(200, {
          ok: true, started: false, running: true, ...st,
          hint: '已有巡检正在运行，等待其完成，不重复启动',
        });
      }
      const info = runProbeNow();
      return json(200, {
        ok: true, started: true, running: true, ...info,
        hint: '已启动一轮巡检（计入今日巡检次数）',
      });
    }

    // ── 上传音频/文件（multipart 模型用） ──
    if (url === '/api/upload' && method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 25 * 1024 * 1024) return json(413, { error: '文件过大（上限 25MB）' });
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!bm) return json(400, { error: '缺少 multipart boundary' });
      const file = parseMultipartFile(buf, bm[1] || bm[2]);
      if (!file) return json(400, { error: '未找到上传文件（字段需为 file）' });
      const mediaDir = path.join(DATA, 'media');
      await mkdir(mediaDir, { recursive: true });
      const base = path.basename(file.filename || 'upload.bin').replace(/[^\w.\-]+/g, '_') || 'upload.bin';
      const name = `${Date.now()}-${base}`;
      await writeFile(path.join(mediaDir, name), file.data);
      return json(200, { ok: true, path: 'media/' + name, name, size: file.data.length });
    }

    // ── 访问已上传文件（便于确认） ──
    if (url.startsWith('/media/') && method === 'GET') {
      const name = path.basename(decodeURIComponent(url.slice('/media/'.length)));
      const p = path.join(DATA, 'media', name);
      if (!existsSync(p)) return json(404, { error: 'not found' });
      const data = await readFile(p);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
      return res.end(data);
    }

    // ── 邮件告警：发送测试邮件 ──
    if (url === '/api/alert/test' && method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let data = null;
      try { data = JSON.parse(body); } catch { /* ignore */ }
      const ov = await loadOverridesDoc();
      // 优先使用请求里携带的（尚未保存的）配置，便于"先测后存"
      const cfg = (data && data.alert) || ov.settings?.alert;
      if (!cfg || !cfg.smtp?.host || !cfg.smtp?.auth?.user) {
        return json(400, { error: '请先填写 SMTP 服务器地址与发件人邮箱账号' });
      }
      if (!cfg.receivers) {
        return json(400, { error: '请先填写告警收件人' });
      }
      const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <div style="background:#2563eb;color:#fff;padding:16px 20px;font-size:18px;font-weight:600">📧 邮件告警测试</div>
        <div style="padding:20px;font-size:14px;color:#111827;line-height:1.8">
          <p>这是一封来自 <b>大模型接口巡检</b> 的测试邮件。</p>
          <p>如果你收到此邮件，说明 SMTP 配置正确，告警功能可以正常工作。</p>
          <p style="color:#6b7280;font-size:12px;margin-top:16px">发送时间：${new Date().toLocaleString('zh-CN')}</p>
        </div>
      </div>`;
      const r = await sendHtmlMail(cfg.smtp, {
        to: cfg.receivers,
        subject: '【大模型接口巡检】邮件告警测试',
        html,
      });
      return json(200, r.ok ? { ok: true } : { ok: false, error: r.error });
    }

    // ── 配置写入 ──
    if (url === '/api/config' && method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      let data = null;
      try { data = JSON.parse(body); } catch { /* fallthrough */ }
      if (!data || typeof data !== 'object') return json(400, { error: '无效请求体' });

      const ov = await loadOverridesDoc();

      // 1) 覆盖项
      if (data.overrides && typeof data.overrides === 'object') {
        const clean = {};
        for (const [id, v] of Object.entries(data.overrides)) {
          if (id && (v === 'include' || v === 'exclude')) clean[id] = v;
        }
        ov.overrides = clean;
        // 可选：同时更新"已删除清单模型"列表（传 [] 即恢复全部被删除的模型）
        if (Array.isArray(data.removedModels)) {
          ov.removedModels = data.removedModels.filter((x) => typeof x === 'string');
        }
        await saveOverridesDoc(ov);
        return json(200, { ok: true, count: Object.keys(clean).length, updatedAt: ov.updatedAt });
      }

      // 2) 添加模型
      if (data.addModel) {
        const m = data.addModel;
        if (!m.name || !m.url) return json(400, { error: 'name 和 url 为必填' });
        const id = `自定义|${m.name}|${m.url}`;
        if (ov.customModels.some((e) => e.id === id)) return json(400, { error: '该模型已存在' });
        const entry = {
          id,
          sheet: m.sheet || '电信机房部署',
          sourceRow: 0,
          service: m.service || m.name,
          name: m.name,
          exampleModel: m.name,
          modelMismatch: false,
          kind: m.kind || 'custom',
          status: '',
          include: 'include',
          includeReason: '手动添加',
          url: m.url,
          requestExample: m.requestExample || '',
          apiKey: (m.apiKey || '').trim(),
          requestType: m.requestType || 'json',
          multipart: m.multipart || null,
        };
        ov.customModels = ov.customModels.concat(entry);
        await saveOverridesDoc(ov);
        return json(200, { ok: true, id, count: ov.customModels.length });
      }

      // 2.5) 编辑模型（清单模型 → entryEdits 覆盖；自定义模型 → 就地更新）
      if (data.updateModel) {
        const u = data.updateModel;
        if (!u || !u.id) return json(400, { error: '缺少模型 id' });

        // 先尝试匹配自定义模型
        const idx = ov.customModels.findIndex((e) => e.id === u.id);
        if (idx >= 0) {
          const cur = ov.customModels[idx];
          const next = {
            ...cur,
            service: (u.service ?? cur.service),
            name: (u.name ?? cur.name),
            exampleModel: (u.name ?? cur.name),
            url: (u.url ?? cur.url),
            kind: (u.kind ?? cur.kind),
            requestExample: (u.requestExample ?? cur.requestExample),
            apiKey: (u.apiKey === undefined ? cur.apiKey : String(u.apiKey || '').trim()),
            requestType: (u.requestType ?? cur.requestType ?? 'json'),
            multipart: (u.multipart === undefined ? (cur.multipart ?? null) : u.multipart),
          };
          next.modelMismatch = next.exampleModel !== next.name;
          // id 含 name|url，改名/改 url 时重建 id 并迁移 override
          const newId = `自定义|${next.name}|${next.url}`;
          if (newId !== cur.id) {
            if (ov.customModels.some((e) => e.id === newId)) {
              return json(400, { error: '修改后的 名称+URL 与现有模型重复' });
            }
            if (Object.prototype.hasOwnProperty.call(ov.overrides, cur.id)) {
              ov.overrides[newId] = ov.overrides[cur.id];
              delete ov.overrides[cur.id];
            }
            next.id = newId;
          }
          ov.customModels[idx] = next;
          await saveOverridesDoc(ov);
          return json(200, { ok: true, id: next.id, from: 'custom' });
        }

        // 清单模型：写入 entryEdits 覆盖
        if (!ov.entryEdits) ov.entryEdits = {};
        ov.entryEdits[u.id] = { ...ov.entryEdits[u.id], ...{
          service: u.service || undefined,
          name: u.name || undefined,
          exampleModel: u.name || undefined,
          url: u.url || undefined,
          kind: u.kind || undefined,
          requestExample: u.requestExample !== undefined ? u.requestExample : undefined,
          apiKey: (u.apiKey || '').trim() || undefined,
          requestType: u.requestType || undefined,
          multipart: u.multipart === undefined ? undefined : u.multipart,
        }};
        await saveOverridesDoc(ov);
        return json(200, { ok: true, id: u.id, from: 'catalog' });
      }

      // 3) 删除模型：自定义模型从 customModels 移除；清单模型记入 removedModels（列表与巡检中彻底移除）
      if (data.deleteModel) {
        const did = data.deleteModel;
        const before = ov.customModels.length;
        ov.customModels = ov.customModels.filter((e) => e.id !== did);
        if (before !== ov.customModels.length) {
          // 自定义模型：真删除
          if (ov.overrides) delete ov.overrides[did];
          if (ov.entryEdits) delete ov.entryEdits[did];
          await saveOverridesDoc(ov);
          return json(200, { ok: true, removed: 1, type: 'custom' });
        }
        // 清单模型：记入 removedModels，从看板列表与巡检中彻底移除
        if (!Array.isArray(ov.removedModels)) ov.removedModels = [];
        if (!ov.removedModels.includes(did)) ov.removedModels.push(did);
        if (ov.overrides) delete ov.overrides[did];
        if (ov.entryEdits) delete ov.entryEdits[did];
        await saveOverridesDoc(ov);
        return json(200, { ok: true, removed: 1, type: 'catalog' });
      }

      // 4) 设置（巡检间隔）
      if (data.settings) {
        const next = { ...ov.settings, ...data.settings };
        // 模型超时：1000–300000 毫秒
        if (next.timeoutMs != null) {
          const t = Number(next.timeoutMs);
          if (!Number.isFinite(t) || t < 1000 || t > 300000) {
            return json(400, { error: '模型超时需在 1000–300000 毫秒之间' });
          }
          next.timeoutMs = Math.round(t);
        }
        // 邮件告警配置校验
        if (next.alert && typeof next.alert === 'object') {
          const a = { ...next.alert };
          const smtp = { ...(a.smtp || {}) };
          if (smtp.port != null && smtp.port !== '') {
            const p = Number(smtp.port);
            if (!Number.isFinite(p) || p < 1 || p > 65535) {
              return json(400, { error: 'SMTP 端口需在 1–65535 之间' });
            }
            smtp.port = Math.round(p);
          }
          const th = { ...(a.threshold || {}) };
          if (th.failTimes != null && th.failTimes !== '') {
            const f = Number(th.failTimes);
            if (!Number.isFinite(f) || f < 1 || f > 100) {
              return json(400, { error: '连续失败阈值需在 1–100 之间' });
            }
            th.failTimes = Math.round(f);
          }
          if (th.recoverTimes != null && th.recoverTimes !== '') {
            const r = Number(th.recoverTimes);
            if (!Number.isFinite(r) || r < 1 || r > 100) {
              return json(400, { error: '恢复阈值需在 1–100 之间' });
            }
            th.recoverTimes = Math.round(r);
          }
          next.alert = { ...a, smtp, threshold: th };
        }
        ov.settings = next;
        await saveOverridesDoc(ov);
        const interval = Number(ov.settings.probeInterval);
        let synced = false;
        // 定时巡检默认由插件内的调度器负责（README「定时巡检」）；只有显式开启
        // PROBE_MANAGE_TASK=1 时这个进程才去创建 Windows 计划任务。
        const manageTask = process.env.PROBE_MANAGE_TASK === '1';
        if (manageTask && Number.isFinite(interval) && interval >= 1 && interval <= 1440) {
          try {
            // /Change 不支持 /MO：改间隔必须用 /Create /F 重建任务
            execSync(
              `schtasks /Create /TN "${TASK_NAME}" /SC MINUTE /MO ${interval} /RL LIMITED /F /TR "${TASK_TR}"`,
              { timeout: 20000, windowsHide: true },
            );
            synced = true;
          } catch (e) {
            console.error('[dashboard] 同步计划任务失败:', e.message);
          }
        }
        return json(200, {
          ok: true, synced,
          probeInterval: ov.settings.probeInterval,
          timeoutMs: ov.settings.timeoutMs ?? null,
        });
      }

      return json(400, { error: '未识别的操作，需 overrides / addModel / updateModel / deleteModel / settings 之一' });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    console.error('[dashboard] 处理请求出错:', e);
    if (!res.headersSent) json(500, { error: String(e) });
  }
});

// 首次启动时把数据目录骨架建好（out / media），避免 probe 写盘时目录不存在
await mkdir(OUTDIR, { recursive: true });
await mkdir(path.join(DATA, 'media'), { recursive: true });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] http://127.0.0.1:${PORT}`);
  console.log(`[dashboard] 页面 ${WEB}`);
  console.log(`[dashboard] 状态 ${STATUS}`);
});
