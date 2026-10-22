/**
 * alert.mjs — 邮件告警判定与发送（零依赖）
 *
 * 规则：
 *   - 某接口连续失败 >= threshold.failTimes 次 → 发送一次告警（已告警不重复发）
 *   - 已告警的接口连续成功 >= threshold.recoverTimes 次 → 发送恢复通知
 * 状态保存在 out/alert-state.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sendHtmlMail, parseReceivers } from './mailer.mjs';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtLocal(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function layout({ title, color, rows, footer }) {
  const body = rows
    .map(([k, v]) => `<tr>
      <td style="padding:10px 20px;color:#6b7280;border-bottom:1px solid #f3f4f6;vertical-align:top;white-space:nowrap;width:120px">${k}</td>
      <td style="padding:10px 20px;color:#111827;border-bottom:1px solid #f3f4f6;word-break:break-all">${v}</td>
    </tr>`)
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="background:${color};color:#fff;padding:16px 20px;font-size:18px;font-weight:600">${title}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${body}</table>
    <div style="padding:14px 20px;color:#6b7280;font-size:12px;background:#f9fafb">${footer}</div>
  </div>`;
}

function buildAlertMail({ entry, m }) {
  const name = entry.service || entry.name;
  const errDetail = entry.status
    ? `HTTP ${entry.status}${entry.error ? '：' + String(entry.error) : ''}`
    : (entry.error ? String(entry.error) : '未知错误');
  const html = layout({
    title: '🔴 故障告警',
    color: '#dc2626',
    rows: [
      ['告警状态', '🔴 故障告警'],
      ['接口名称', esc(name)],
      ['接口地址', esc(entry.url || '')],
      ['检测时间', fmtLocal(entry.at)],
      ['连续失败次数', `${m.failStreak} 次`],
      ['错误详情', esc(errDetail)],
      ['响应摘要', esc(String(entry.error || '').slice(0, 200) || '（无响应内容）')],
    ],
    footer: '可访问监控面板查看详细数据。此邮件由大模型接口巡检自动发送，请勿直接回复。',
  });
  return { subject: `【大模型接口告警】${name} 检测异常`, html };
}

function buildRecoverMail({ entry, m }) {
  const name = entry.service || entry.name;
  const start = m.firstFailAt ? Date.parse(m.firstFailAt) : NaN;
  const mins = Number.isFinite(start) ? Math.max(0, Math.round((Date.now() - start) / 60000)) : null;
  const html = layout({
    title: '🟢 故障恢复',
    color: '#059669',
    rows: [
      ['告警状态', '🟢 故障恢复'],
      ['接口名称', esc(name)],
      ['恢复时间', fmtLocal(new Date().toISOString())],
      ['故障持续时长', mins == null ? '未知' : `${mins} 分钟`],
      ['当前响应延迟', entry.latencyMs == null ? '—' : `${entry.latencyMs} ms`],
    ],
    footer: '接口已恢复正常运行。可访问监控面板查看详细数据。此邮件由大模型接口巡检自动发送。',
  });
  return { subject: `【大模型接口恢复】${name} 已恢复正常`, html };
}

/**
 * 处理一轮巡检的告警。
 * @param {{entries:Array, alertCfg:object, statePath:string, log:Function}} opts
 * @returns {Promise<{alerts:number, recovers:number, skipped?:string}>}
 */
export async function runAlerts({ entries, alertCfg, statePath, log = () => {} }) {
  const cfg = alertCfg || {};
  if (!cfg.enable) return { alerts: 0, recovers: 0, skipped: 'disabled' };

  const receivers = parseReceivers(cfg.receivers);
  if (!receivers.length) {
    log('邮件告警已启用，但未配置收件人，跳过');
    return { alerts: 0, recovers: 0, skipped: 'no-receivers' };
  }
  const smtp = cfg.smtp || {};
  if (!smtp.host || !smtp.auth?.user) {
    log('邮件告警已启用，但 SMTP 配置不完整，跳过');
    return { alerts: 0, recovers: 0, skipped: 'no-smtp' };
  }

  const failTimes = Math.max(1, Number(cfg.threshold?.failTimes ?? 3));
  const recoverTimes = Math.max(1, Number(cfg.threshold?.recoverTimes ?? 3));

  let state = { models: {} };
  try {
    if (existsSync(statePath)) {
      const doc = JSON.parse(await readFile(statePath, 'utf8'));
      if (doc && typeof doc === 'object' && doc.models) state = doc;
    }
  } catch (e) {
    log(`告警状态文件解析失败，按空状态处理: ${e.message}`);
  }
  const models = state.models || {};
  let alerts = 0;
  let recovers = 0;
  let smtpBroken = false;

  for (const e of entries) {
    const m = models[e.id] || { failStreak: 0, okStreak: 0, alerted: false };

    if (!e.ok) {
      m.failStreak = (Number(m.failStreak) || 0) + 1;
      m.okStreak = 0;
      m.lastError = String(e.error || '').slice(0, 500);
      m.lastStatus = e.status ?? null;
      if (!m.firstFailAt) m.firstFailAt = e.at || new Date().toISOString();

      if (!m.alerted && m.failStreak >= failTimes && !smtpBroken) {
        const r = await sendHtmlMail(smtp, { to: receivers, ...buildAlertMail({ entry: e, m }) });
        if (r.ok) {
          m.alerted = true;
          m.alertedAt = new Date().toISOString();
          alerts++;
          log(`告警邮件已发送: ${e.service || e.name}（连续失败 ${m.failStreak} 次）`);
        } else {
          smtpBroken = true;
          log(`告警邮件发送失败（本轮不再尝试）: ${r.error}`);
        }
      }
    } else {
      m.okStreak = (Number(m.okStreak) || 0) + 1;
      m.failStreak = 0;
      if (m.alerted && m.okStreak >= recoverTimes && !smtpBroken) {
        const r = await sendHtmlMail(smtp, { to: receivers, ...buildRecoverMail({ entry: e, m }) });
        if (r.ok) {
          m.alerted = false;
          m.recoveredAt = new Date().toISOString();
          m.firstFailAt = null;
          recovers++;
          log(`恢复邮件已发送: ${e.service || e.name}（连续成功 ${m.okStreak} 次）`);
        } else {
          smtpBroken = true;
          log(`恢复邮件发送失败（本轮不再尝试）: ${r.error}`);
        }
      }
    }
    models[e.id] = m;
  }

  try {
    await writeFile(statePath, JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 2), 'utf8');
  } catch (e) {
    log(`告警状态写入失败: ${e.message}`);
  }
  return { alerts, recovers };
}

export { buildAlertMail, buildRecoverMail };
