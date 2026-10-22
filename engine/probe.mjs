#!/usr/bin/env node
/**
 * probe.mjs — 大模型接口巡检引擎（零第三方依赖，Node >= 20）
 *
 * 用法:
 *   node probe.mjs [--catalog work/catalog.json] [--out work] [--keys work/keys.json]
 *                  [--concurrency 8] [--timeout 15000] [--max-tokens 64]
 *
 * 指标定义:
 *   TTFT  = 请求发出 → 首个内容 token 到达（仅 chat 且为流式时有效）
 *   TPOT  = (末 token - 首 token) / (输出 token 数 - 1)   单位 ms/token
 *   TPS   = 输出 token 数 / (末 token - 首 token) 秒      单位 token/s（生成速度，不含首包）
 *
 * 通知不在此实现：结果只落盘（probes.jsonl / status.json），由看板读取。
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync, unlinkSync, statSync, renameSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runAlerts } from './alert.mjs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const HERE = import.meta.dirname ?? process.cwd();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CATALOG = args.catalog ?? 'work/catalog.json';
const OVERRIDES_FILE = args.overrides ?? 'overrides.json';
const OUTDIR = args.out ?? 'work';
const KEYS_FILE = args.keys ?? path.join(OUTDIR, 'keys.json');
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 8));
// 超时优先级：命令行 --timeout > overrides.settings.timeoutMs > 15000
// 实际值在 main() 读取 overrides 后确定，这里先给默认值
let TIMEOUT_MS = 15000;
const MAX_TOKENS = Math.max(8, Number(args['max-tokens'] ?? 64));
const HISTORY_KEEP = 30;

// 日志同时写控制台与 out/probe.log（计划任务不经过 shell 重定向，靠这个落盘）
// 每行带本地时间戳（Asia/Shanghai），格式：[2026-10-21 17:01:37.123]
let LOG_PATH = null;
const pad2 = (n, w = 2) => String(n).padStart(w, '0');
function nowStamp() {
  const d = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}.${pad2(d.getMilliseconds(), 3)}`;
  } catch {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad2(d.getMilliseconds(), 3)}`;
  }
}
const log = (...a) => {
  const line = `[${nowStamp()}] [probe] ` + a.map((x) => (x instanceof Error ? x.stack || x.message : String(x))).join(' ');
  console.error(line);
  if (LOG_PATH) {
    try { appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch { /* 日志失败不影响巡检 */ }
  }
};

async function loadKeys() {
  if (!existsSync(KEYS_FILE)) return {};
  try {
    const raw = JSON.parse(await readFile(KEYS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    log('keys.json 解析失败，按无鉴权处理:', e.message);
    return {};
  }
}

/** 每个子表一套请求头；支持两种写法:
 *   "子表": "sk-xxx"                          → Authorization: Bearer sk-xxx
 *   "子表": { "headers": { "X-Api-Key": "..." } }
 */
function headersFor(sheet, keys) {
  const base = { 'content-type': 'application/json' };
  const conf = keys[sheet];
  if (!conf) return base;
  if (typeof conf === 'string') return { ...base, authorization: `Bearer ${conf}` };
  if (conf.headers && typeof conf.headers === 'object') return { ...base, ...conf.headers };
  return base;
}

function parseExample(entry) {
  const raw = (entry.requestExample ?? '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { __raw: raw }; }
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout ${ms}ms`)), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/** 从一段 SSE 文本里抽出内容增量与 usage。 */
function scanSSE(text, state) {
  let idx;
  while ((idx = text.indexOf('\n')) >= 0) {
    const line = text.slice(0, idx).trim();
    text = text.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (obj.usage && typeof obj.usage === 'object') state.usage = obj.usage;
    const ch = obj.choices?.[0];
    const delta = ch?.delta?.content ?? ch?.delta?.reasoning_content ?? ch?.text ?? '';
    if (typeof delta === 'string' && delta.length > 0) {
      const now = performance.now();
      if (!state.firstTokenAt) state.firstTokenAt = now;
      state.chunkCount++;
      state.chars += delta.length;
      state.lastTokenAt = now;
    }
  }
  return text;
}

async function probeChat(entry, headers) {
  const example = parseExample(entry) ?? {};
  // 「模型名称」即请求体的 model（entry.name）；缺失时回退到示例里的 model
  const model = entry.name || entry.exampleModel || example.model;
  const messages = example.messages ?? [{ role: 'user', content: '请回复"ok"' }];

  const richBody = { ...example, model, messages, stream: true, max_tokens: MAX_TOKENS, stream_options: { include_usage: true } };
  const leanBody = { model, messages, stream: true, max_tokens: MAX_TOKENS };

  const attempt = async (body) => {
    const t0 = performance.now();
    const guard = withTimeout(TIMEOUT_MS);
    try {
      const res = await fetch(entry.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: guard.signal,
      });
      const state = { usage: null, firstTokenAt: 0, lastTokenAt: 0, chunkCount: 0, chars: 0 };
      const ctype = res.headers.get('content-type') ?? '';

      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        const total = performance.now() - t0;
        return { ok: false, status: res.status, latencyMs: Math.round(total), error: text || `HTTP ${res.status}` };
      }

      if (ctype.includes('event-stream')) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          buf = scanSSE(buf, state);
        }
        buf += dec.decode();
        scanSSE(buf + '\n', state);
      } else {
        const text = await res.text();
        try {
          const obj = JSON.parse(text);
          if (obj.usage) state.usage = obj.usage;
          const content = obj.choices?.[0]?.message?.content ?? '';
          if (content) {
            const now = performance.now();
            state.firstTokenAt = now; state.lastTokenAt = now;
            state.chunkCount = 1; state.chars = content.length;
          }
        } catch { /* 非 JSON，按失败处理 */ }
      }

      const totalMs = performance.now() - t0;
      const usage = state.usage;
      let outTokens = usage?.completion_tokens ?? 0;
      let tokensSource = 'usage';
      if (!outTokens) {
        outTokens = Math.max(state.chunkCount, 1);
        tokensSource = 'chunks';
      }

      const streamed = state.firstTokenAt > 0 && state.chunkCount > 0;
      const ttftMs = streamed ? Math.round(state.firstTokenAt - t0) : Math.round(totalMs);
      const genMs = streamed ? state.lastTokenAt - state.firstTokenAt : totalMs;
      const tpotMs = outTokens > 1 && genMs > 0 ? +(genMs / (outTokens - 1)).toFixed(2) : null;
      const tps = genMs > 0 ? +(outTokens / (genMs / 1000)).toFixed(2) : null;
      const ok = outTokens >= 1 && (state.chunkCount > 0 || totalMs > 0);

      return {
        ok,
        status: res.status,
        latencyMs: Math.round(totalMs),
        ttftMs,
        tpotMs,
        tps,
        outTokens,
        tokensSource,
        streamed,
        error: ok ? undefined : (streamed ? '无内容返回' : '空响应'),
      };
    } catch (e) {
      const total = performance.now() - t0;
      const msg = e?.name === 'AbortError' || /timeout/i.test(String(e?.message))
        ? `超时 ${TIMEOUT_MS}ms` : String(e?.message ?? e);
      return { ok: false, latencyMs: Math.round(total), error: msg };
    } finally {
      guard.done();
    }
  };

  let r = await attempt(richBody);
  // 网关可能不认识 stream_options / 强制非流式：退化为最小报文重试一次
  if (!r.ok && (r.status === 400 || r.status === 422)) {
    const r2 = await attempt(leanBody);
    if (r2.ok) return { ...r2, fallback: 'lean-body' };
    return { ...r2, fallback: 'lean-body' };
  }
  return r;
}

function mimeByExt(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.webm': 'audio/webm', '.aac': 'audio/aac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
  }[ext] || 'application/octet-stream';
}

function resolveMediaPath(p) {
  if (!p) return null;
  // 内嵌模式下数据目录与脚本目录分离，相对路径（media/xxx.wav）按数据目录解析
  const root = path.resolve(process.env.PROBE_DATA_DIR || HERE);
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function buildMultipartBody(fields, fileField, fileName, fileBuf) {
  const boundary = '----dsh' + randomBytes(8).toString('hex');
  const chunks = [];
  for (const [k, v] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeByExt(fileName)}\r\n\r\n`, 'utf8'));
  chunks.push(fileBuf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), boundary };
}

/** multipart 上传探测（音频文件等） */
async function probeMultipart(entry, headers) {
  const mp = entry.multipart || {};
  const fileField = mp.fileField || 'file';
  const src = mp.uploadedFile || mp.filePath;
  if (!src) return { ok: false, error: '未配置音频文件（请上传或填写文件路径）', latencyMs: 0 };
  const filePath = resolveMediaPath(src);
  if (!existsSync(filePath)) return { ok: false, error: `音频文件不存在: ${src}`, latencyMs: 0 };
  let fileBuf;
  try { fileBuf = readFileSync(filePath); } catch (e) {
    return { ok: false, error: `读取音频文件失败: ${e.message}`, latencyMs: 0 };
  }
  const { body, boundary } = buildMultipartBody(mp.fields, fileField, path.basename(filePath), fileBuf);
  const h = { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` };
  const t0 = performance.now();
  const guard = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(entry.url, { method: 'POST', headers: h, body, signal: guard.signal });
    const text = await res.text();
    const total = performance.now() - t0;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Math.round(total),
      error: res.ok ? undefined : (text.slice(0, 300) || `HTTP ${res.status}`),
    };
  } catch (e) {
    const total = performance.now() - t0;
    const msg = e?.name === 'AbortError' || /timeout/i.test(String(e?.message))
      ? `超时 ${TIMEOUT_MS}ms` : String(e?.message ?? e);
    return { ok: false, latencyMs: Math.round(total), error: msg };
  } finally {
    guard.done();
  }
}

async function probeOther(entry, headers) {
  if (entry.requestType === 'multipart') return probeMultipart(entry, headers);
  const example = parseExample(entry);
  if (!example) {
    return { ok: false, error: '无请求示例，无法构造探测请求', latencyMs: 0 };
  }
  let body;
  if (example.__raw !== undefined) {
    body = example.__raw;
  } else {
    // 「模型名称」即请求体的 model：示例里本来就有 model 字段时用 entry.name 覆盖，
    // 没有 model 字段的接口（如 ner 的 {"text": ...}）保持原样，不强行添加。
    if (entry.name && Object.prototype.hasOwnProperty.call(example, 'model')) {
      example.model = entry.name;
    }
    body = JSON.stringify(example);
  }
  const t0 = performance.now();
  const guard = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(entry.url, { method: 'POST', headers, body, signal: guard.signal });
    const text = await res.text();
    const total = performance.now() - t0;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Math.round(total),
      error: res.ok ? undefined : (text.slice(0, 300) || `HTTP ${res.status}`),
    };
  } catch (e) {
    const total = performance.now() - t0;
    const msg = e?.name === 'AbortError' || /timeout/i.test(String(e?.message))
      ? `超时 ${TIMEOUT_MS}ms` : String(e?.message ?? e);
    return { ok: false, latencyMs: Math.round(total), error: msg };
  } finally {
    guard.done();
  }
}

async function main() {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  await mkdir(OUTDIR, { recursive: true });
  // 日志轮转：超过 20MB 时把旧日志改名为 probe.log.1，避免无限增长
  const logPath = path.join(OUTDIR, 'probe.log');
  try {
    if (statSync(logPath).size > 20 * 1024 * 1024) renameSync(logPath, logPath + '.1');
  } catch { /* 文件不存在或无法轮转，忽略 */ }
  LOG_PATH = logPath;
  // 运行状态标记：看板据此判断“是否已有巡检在跑”（含定时任务启动的）。
  // 退出时删除；异常残留由看板用 pid 存活检测识别为已结束。
  const statePath = path.join(OUTDIR, 'probe.state.json');
  await writeFile(statePath, JSON.stringify({
    pid: process.pid,
    runId,
    startedAt: startedAt.toISOString(),
    source: process.env.PROBE_SOURCE || 'scheduled',
  }, null, 2), 'utf8');
  process.on('exit', () => { try { unlinkSync(statePath); } catch { /* ignore */ } });
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const keys = await loadKeys();

  // 应用看板配置页维护的覆盖项（overrides.json）：id -> "include" | "exclude"
  let overrides = {};
  let customModels = [];
  let entryEdits = {}; // 清单模型编辑覆盖（entryEdits[id] = { name, url, apiKey, ... }）
  let removedModels = []; // 看板里"真正删除"的清单模型 id
  let settingsDoc = {}; // overrides.settings（超时 / 邮件告警等）
  if (existsSync(OVERRIDES_FILE)) {
    try {
      const doc = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8'));
      overrides = doc?.overrides ?? {};
      customModels = Array.isArray(doc?.customModels) ? doc.customModels : [];
      entryEdits = (doc?.entryEdits && typeof doc.entryEdits === 'object') ? doc.entryEdits : {};
      removedModels = Array.isArray(doc?.removedModels) ? doc.removedModels : [];
      settingsDoc = (doc?.settings && typeof doc.settings === 'object') ? doc.settings : {};
      const interval = doc?.settings?.probeInterval;
      if (interval) log(`巡检间隔配置: ${interval} 分钟`);
      // 超时：命令行 --timeout 优先，否则用 overrides.settings.timeoutMs，最后 15000
      const cliTimeout = args['timeout'] != null ? Number(args['timeout']) : NaN;
      const cfgTimeout = Number(doc?.settings?.timeoutMs);
      if (Number.isFinite(cliTimeout) && cliTimeout >= 1000) {
        TIMEOUT_MS = Math.min(cliTimeout, 300000);
      } else if (Number.isFinite(cfgTimeout) && cfgTimeout >= 1000) {
        TIMEOUT_MS = Math.min(cfgTimeout, 300000);
      }
      log(`模型超时: ${TIMEOUT_MS}ms`);
    } catch (e) {
      log(`overrides 解析失败，忽略: ${e.message}`);
    }
  }
  const overridden = Object.keys(overrides).filter((id) => overrides[id] === 'include' || overrides[id] === 'exclude').length;
  if (overridden) log(`应用 overrides: ${overridden} 条手动维护项（${OVERRIDES_FILE}）`);
  if (customModels.length) log(`自定义模型: ${customModels.length} 条`);
  if (Object.keys(entryEdits).length) log(`清单编辑覆盖: ${Object.keys(entryEdits).length} 条`);
  if (removedModels.length) log(`已删除清单模型: ${removedModels.length} 条（跳过巡检）`);

  // 合并清单 + 自定义模型，然后应用覆盖（被删除的清单模型直接跳过）
  const removedSet = new Set(removedModels);
  const allEntries = [
    ...catalog.entries.filter((e) => !removedSet.has(e.id)).map((e) => {
      // 先应用 entryEdits（编辑覆盖字段）
      const edits = entryEdits[e.id];
      const withEdits = edits ? { ...e, ...edits } : { ...e };
      // 再应用 include/exclude 覆盖
      if (Object.prototype.hasOwnProperty.call(overrides, e.id)) {
        return { ...withEdits, include: overrides[e.id], includeReason: `手动维护:${overrides[e.id]}` };
      }
      return withEdits;
    }),
    ...customModels.map((e) => {
      if (Object.prototype.hasOwnProperty.call(overrides, e.id)) {
        return { ...e, include: overrides[e.id], includeReason: `手动维护:${overrides[e.id]}` };
      }
      return { ...e };
    }),
  ];
  const targets = allEntries.filter((e) => e.include === 'include' && e.url);
  log(`========== 巡检开始 ${startedAt.toISOString()}  runId=${runId}  纳入 ${targets.length} 条 ==========`);
  log(`清单: ${CATALOG}  纳入 ${targets.length} 条  并发 ${CONCURRENCY}  超时 ${TIMEOUT_MS}ms`);
  if (targets.length === 0) { log('没有可巡检条目，退出'); return; }

  const missingKey = [...new Set(
    targets.filter((t) => !t.apiKey).map((t) => t.sheet),
  )].filter((s) => !keys[s]);
  if (missingKey.length) log(`注意: 以下子表无 key，将不带鉴权探测 -> ${missingKey.join(', ')}`);

  const results = new Array(targets.length);
  let cursor = 0;
  const t0 = performance.now();
  let doneCount = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const entry = targets[i];
      // 模型级 apiKey 优先（自定义模型可单独指定）；否则回退到所属子表 key
      const headers = entry.apiKey
        ? { 'content-type': 'application/json', authorization: `Bearer ${entry.apiKey}` }
        : headersFor(entry.sheet, keys);
      const r = entry.kind === 'chat'
        ? await probeChat(entry, headers)
        : await probeOther(entry, headers);
      results[i] = {
        id: entry.id,
        sheet: entry.sheet,
        service: entry.service || entry.name,
        name: entry.name,
        exampleModel: entry.exampleModel,
        kind: entry.kind,
        url: entry.url,
        at: new Date().toISOString(),
        ...r,
      };
      // 每个模型的可用情况与报错写入 probe.log（错误过长时截断，完整内容见 status.json）
      const rr = results[i];
      const errText = rr.error ? ' | ' + String(rr.error).replace(/\s+/g, ' ').slice(0, 500) : '';
      log(`${rr.ok ? '[OK]  ' : '[FAIL]'} ${rr.service || rr.name} | 模型:${rr.name} | 状态:${rr.status ?? '-'} | 延迟:${rr.latencyMs ?? '-'}ms${errText}`);
      doneCount++;
      if (doneCount % 10 === 0 || doneCount === targets.length) {
        log(`进度 ${doneCount}/${targets.length}  已用 ${Math.round(performance.now() - t0)}ms`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const durationMs = Math.round(performance.now() - t0);

  const okCount = results.filter((r) => r.ok).length;
  const summary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
  };

  await mkdir(OUTDIR, { recursive: true });

  // 1) 只追加流水
  await appendFile(
    path.join(OUTDIR, 'probes.jsonl'),
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  // 1.5) 追加轮次汇总（供看板统计"今日巡检轮次"）
  await appendFile(
    path.join(OUTDIR, 'rounds.jsonl'),
    JSON.stringify(summary) + '\n',
    'utf8',
  );

  // 2) 汇总状态 + 每条的历史窗口
  const statusPath = path.join(OUTDIR, 'status.json');
  let prev = {};
  if (existsSync(statusPath)) {
    try {
      const doc = JSON.parse(await readFile(statusPath, 'utf8'));
      for (const e of doc.entries ?? []) prev[e.id] = e.history ?? [];
    } catch { /* 忽略损坏的旧状态 */ }
  }

  const entries = results.map((r) => {
    const hist = [...(prev[r.id] ?? []), {
      at: r.at, ok: r.ok, status: r.status ?? null,
      latencyMs: r.latencyMs ?? null, ttftMs: r.ttftMs ?? null,
      tpotMs: r.tpotMs ?? null, tps: r.tps ?? null,
    }].slice(-HISTORY_KEEP);
    const okN = hist.filter((h) => h.ok).length;
    return {
      ...r,
      history: hist,
      availability: hist.length ? +(okN / hist.length).toFixed(4) : null,
    };
  });

  await writeFile(statusPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    catalogGeneratedAt: catalog.generatedAt ?? null,
    summary,
    entries,
  }, null, 2), 'utf8');

  log(`完成: ${summary.ok}/${summary.total} 正常, 用时 ${durationMs}ms`);
  log(`========== 巡检结束 ${new Date().toISOString()}  ${summary.ok}/${summary.total} 正常  用时 ${durationMs}ms ==========`);
  log(`输出: ${path.join(OUTDIR, 'probes.jsonl')}  ${statusPath}`);

  // 邮件告警（连续失败 N 次告警 / 连续成功 N 次恢复）
  if (settingsDoc.alert) {
    try {
      const ar = await runAlerts({
        entries,
        alertCfg: settingsDoc.alert,
        statePath: path.join(OUTDIR, 'alert-state.json'),
        log,
      });
      if (ar.alerts || ar.recovers) log(`邮件告警: 告警 ${ar.alerts} 条, 恢复 ${ar.recovers} 条`);
      else if (ar.skipped) log(`邮件告警跳过: ${ar.skipped}`);
    } catch (e) {
      log('邮件告警处理失败:', e.message);
    }
  }

  process.exitCode = summary.failed > 0 ? 1 : 0;
}

main().catch((e) => { log('致命错误:', e); process.exit(2); });
