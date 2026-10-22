/**
 * mailer.mjs — 极简 SMTP 客户端（零第三方依赖）
 *
 * 支持：
 *   - 465 等端口：隐式 TLS（secure=true 且 port≠587）
 *   - 587 端口：明文连接后 STARTTLS（secure=true 且 port=587）
 *   - secure=false：明文（通常 25 端口，或内网 relay）
 *   - AUTH LOGIN / AUTH PLAIN
 *   - HTML 邮件（UTF-8，base64 正文）
 *
 * 用法：
 *   import { sendHtmlMail } from './mailer.mjs';
 *   await sendHtmlMail({ host, port, secure, auth:{user,pass} }, { to:['a@b.c'], subject, html });
 */
import net from 'node:net';
import tls from 'node:tls';

const CONNECT_TIMEOUT = 20000;
const COMMAND_TIMEOUT = 20000;

function encodeHeader(s) {
  const str = String(s ?? '');
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function buildMessage({ from, fromName, to, subject, html }) {
  const headers = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const b64 = Buffer.from(html, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + b64;
}

class SmtpSession {
  constructor(sock, host) {
    this.sock = sock;
    this.host = host;
    this.buf = '';
    this.pending = null;
    this._attach();
  }

  _attach() {
    this.sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      this._drain();
    });
    this.sock.on('error', (e) => {
      if (this.pending) { const p = this.pending; this.pending = null; p.reject(e); }
    });
    this.sock.on('close', () => {
      if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Error('SMTP 连接已关闭')); }
    });
  }

  _drain() {
    if (!this.pending) return;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, idx + 1);
      this.buf = this.buf.slice(idx + 1);
      const line = raw.replace(/\r?\n$/, '');
      this.pending.lines.push(line);
      // 以 "250 " / "334 " 形式结尾的行表示响应结束（"250-" 是续行）
      if (/^\d{3}[ ]/.test(line)) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(p.lines);
        return;
      }
    }
  }

  expect(timeout = COMMAND_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const p = { lines: [], resolve, reject, timer: null };
      p.timer = setTimeout(() => {
        if (this.pending === p) this.pending = null;
        reject(new Error('SMTP 响应超时'));
      }, timeout);
      this.pending = p;
      this._drain();
    });
  }

  async send(line, timeout) {
    this.sock.write(line + '\r\n');
    const lines = await this.expect(timeout);
    return this._result(lines);
  }

  _result(lines) {
    const last = lines[lines.length - 1] || '';
    const code = Number(last.slice(0, 3));
    const text = lines.join('\n');
    return { code, text, lines };
  }

  async cmd(line, timeout) {
    const r = await this.send(line, timeout);
    if (r.code >= 400) throw new Error(`SMTP ${r.code}: ${r.text}`);
    return r;
  }

  async startTls() {
    // 解绑旧 socket 监听，升级为 TLS
    this.sock.removeAllListeners('data');
    this.sock.removeAllListeners('error');
    this.sock.removeAllListeners('close');
    const t = tls.connect({ socket: this.sock, servername: this.host, rejectUnauthorized: false });
    await new Promise((resolve, reject) => {
      t.once('secureConnect', resolve);
      t.once('error', reject);
    });
    this.sock = t;
    this.buf = '';
    this._attach();
  }

  destroy() {
    try { this.sock.destroy(); } catch { /* ignore */ }
  }
}

function connect(host, port, useTls) {
  return new Promise((resolve, reject) => {
    const sock = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT })
      : net.connect({ host, port, timeout: CONNECT_TIMEOUT });
    const onError = (e) => { try { sock.destroy(); } catch { /* ignore */ } reject(e); };
    sock.once('error', onError);
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      sock.removeListener('error', onError);
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.setTimeout(CONNECT_TIMEOUT, () => {
      try { sock.destroy(); } catch { /* ignore */ }
      reject(new Error('SMTP 连接超时'));
    });
  });
}

function parseReceivers(receivers) {
  if (Array.isArray(receivers)) return receivers.map((s) => String(s).trim()).filter(Boolean);
  return String(receivers ?? '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 发送 HTML 邮件。
 * @param {{host:string, port:number, secure:boolean, auth?:{user?:string, pass?:string}, fromName?:string}} smtp
 * @param {{to:string[]|string, subject:string, html:string}} mail
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendHtmlMail(smtp, mail) {
  const host = String(smtp?.host || '').trim();
  const port = Number(smtp?.port || (smtp?.secure ? 465 : 25));
  const secure = !!smtp?.secure;
  const user = String(smtp?.auth?.user || '').trim();
  const pass = String(smtp?.auth?.pass || '');
  const from = user;
  const fromName = smtp?.fromName || '大模型接口巡检';
  const to = parseReceivers(mail.to);

  if (!host) return { ok: false, error: '未配置 SMTP 服务器地址' };
  if (!from) return { ok: false, error: '未配置发件人邮箱账号' };
  if (!to.length) return { ok: false, error: '未配置告警收件人' };

  // 465 走隐式 TLS；587 走 STARTTLS；其余按 secure 决定
  const implicitTls = secure && port !== 587;
  const useStartTls = secure && port === 587;

  let sess = null;
  try {
    const sock = await connect(host, port, implicitTls);
    sess = new SmtpSession(sock, host);

    // 220 问候
    const greet = await sess.expect();
    if (greet[greet.length - 1].slice(0, 3) !== '220') {
      throw new Error('SMTP 未返回 220 问候: ' + greet.join(' '));
    }

    // EHLO
    await sess.cmd('EHLO localhost');

    if (useStartTls) {
      await sess.cmd('STARTTLS');
      await sess.startTls();
      await sess.cmd('EHLO localhost');
    }

    // 认证
    if (user) {
      const auth = await sess.send('AUTH LOGIN');
      if (auth.code === 334) {
        await sess.cmd(Buffer.from(user, 'utf8').toString('base64'));
        await sess.cmd(Buffer.from(pass, 'utf8').toString('base64'));
      } else {
        // 回退 AUTH PLAIN
        const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await sess.cmd('AUTH PLAIN ' + plain);
      }
    }

    // 信封
    await sess.cmd(`MAIL FROM:<${from}>`);
    for (const r of to) await sess.cmd(`RCPT TO:<${r}>`);

    // 正文
    await sess.cmd('DATA');
    const msg = buildMessage({ from, fromName, to, subject: mail.subject, html: mail.html });
    const r = await sess.send(msg + '\r\n.');
    if (r.code !== 250) throw new Error(`邮件发送失败 SMTP ${r.code}: ${r.text}`);

    // 退出（失败不影响结果）
    try { await sess.send('QUIT'); } catch { /* ignore */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if (sess) sess.destroy();
  }
}

export { parseReceivers, buildMessage };
