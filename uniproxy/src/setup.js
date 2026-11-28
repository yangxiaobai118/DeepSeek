import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hashPassword, USERNAME_RE } from './auth.js';
import { syncUnitPorts } from './units.js';
import { validDomain } from './certs.js';
import { normalizeBasePath, isPlaceholderAddress } from './util.js';
import { scaffold } from './scaffold.js';

/**
 * First-run wizard.
 *
 * Everything that CAN be random is: secrets, UUIDs, Reality keys and the panel
 * passwords (press Enter). Everything that CANNOT be random is asked for: the
 * domain (or an explicit IP-only mode), the public IP (auto-detected, overridable)
 * and the ACME e-mail. Ports default to sane values and accept `r` for random.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function basePathInputOk(value) {
  if (!value) return true;
  let s = String(value);
  if (s === '/') return true;
  if (s[0] !== '/') s = '/' + s;
  if (!s.endsWith('/')) s += '/';
  s = s.replace(/\/+/g, '/');
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+\/$/.test(s) && !/^\/(api|login|logout)\//.test(s);
}

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomPassword(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

export function randomPort() {
  return 40000 + (crypto.randomBytes(2).readUInt16BE(0) % 20000);
}

async function detectPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000) });
    const text = (await res.text()).trim();
    return /^[0-9a-f.:]+$/i.test(text) ? text : '';
  } catch (e) {
    return '';
  }
}

function applyDomain(cfg, domain) {
  cfg.server.domains = cfg.server.domains || {};
  cfg.server.domains.web = domain;
  cfg.nginx = cfg.nginx || {};
  cfg.nginx.sites = cfg.nginx.sites || [];
  if (cfg.nginx.sites[0]) cfg.nginx.sites[0].serverName = domain;
  else cfg.nginx.sites.push({ serverName: domain, root: '/var/www/html', index: 'index.html' });
  for (const ib of (cfg.singbox && cfg.singbox.inbounds) || []) {
    if (ib.security === 'tls' && (!ib.sni || ib.sni.endsWith('.example.com'))) ib.sni = 'singbox.' + domain;
  }
}

export async function runSetup(opts = {}) {
  const cfgPath = opts.configPath || 'config.json';
  const io = opts.io || { question: async function () { return ''; }, print: function (s) { process.stdout.write(String(s) + '\n'); } };
  const yes = opts.yes === true;
  const flags = opts.flags || {};

  if (!fs.existsSync(cfgPath)) {
    fs.mkdirSync(path.dirname(path.resolve(cfgPath)), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(scaffold(), null, 2) + '\n');
    io.print('未找到配置，已生成默认配置 ' + cfgPath);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const original = JSON.parse(JSON.stringify(cfg));
  cfg.ui = cfg.ui || {};
  cfg.subscription = cfg.subscription || {};

  const rawAsk = async function (question, fallback) {
    if (yes) return fallback;
    const shown = question + (fallback ? ' [' + fallback + ']' : '') + ': ';
    const answer = String((await io.question(shown)) || '').trim();
    return answer === '' ? (fallback || '') : answer;
  };

  const ask = async function (question, fallback, validate, hint) {
    if (yes) return fallback;
    for (;;) {
      const value = await rawAsk(question, fallback);
      if (!validate || validate(value)) return value;
      io.print('输入不合法：' + (hint || '请检查后重新输入'));
    }
  };

  if (!yes) io.print('回车 = 保留当前值 / 使用默认值；r = 随机；只有你重新输入的项会被修改。');

  // 1. domain: cannot be random
  const currentDomain = (cfg.server.domains && cfg.server.domains.web) || '';
  const domainHint = currentDomain && !currentDomain.endsWith('.example.com') ? currentDomain : '';
  const domain = flags.domain != null ? flags.domain : await ask(
    '域名（如 example.com；回车=仅 IP，不使用域名）',
    domainHint,
    function (v) { return v === '' || validDomain(v); },
    '域名格式不正确，例如 example.com',
  );
  const domainChanged = domain !== currentDomain;
  if (domain && domainChanged) applyDomain(cfg, domain);

  // 2. u-ui hostname; x-ui / s-ui panel proxying is no longer configured here
  if (domain) {
    cfg.panels = cfg.panels || {};
    cfg.panels.xui = cfg.panels.xui || {};
    cfg.panels.sui = cfg.panels.sui || {};
    cfg.panels.sui.sub = cfg.panels.sui.sub || {};
    cfg.panels.xui.enabled = false;
    cfg.panels.sui.enabled = false;
    cfg.panels.sui.sub.enabled = false;

    let tagRenamed = false;
    let sniRenamed = false;
    for (const ib of (cfg.singbox && cfg.singbox.inbounds) || []) {
      if (ib.tag === 'sb-vless-ws-tls') { ib.tag = 'singbox-vless-ws-tls'; tagRenamed = true; }
      if (ib.security === 'tls' && typeof ib.sni === 'string' && ib.sni.startsWith('sb.')) {
        ib.sni = 'singbox.' + ib.sni.slice(3);
        sniRenamed = true;
      }
    }
    if (tagRenamed) {
      for (const user of cfg.users || []) {
        if (Array.isArray(user.inbounds)) {
          user.inbounds = user.inbounds.map(function (tag) { return tag === 'sb-vless-ws-tls' ? 'singbox-vless-ws-tls' : tag; });
        }
      }
    }
    if (sniRenamed || tagRenamed) {
      io.print('已把默认名称 sb 改为 singbox（入站 tag / SNI）。');
    }

    const hostDefault = function (current, prefix) {
      return current && validDomain(current) && current.endsWith('.' + domain) && current !== domain
        ? current
        : prefix + '.' + domain;
    };
    const originalUiDomain = cfg.ui.domain || '';
    const uiFallback = hostDefault(cfg.ui.domain, 'uui');
    let uiDomain = cfg.ui.domain || '';
    if (!yes) {
      for (;;) {
        const value = String(await rawAsk('u-ui 面板域名（- = 仅 SSH 隧道；r = 随机前缀）', uiFallback)).trim();
        if (value === '-' || value.toLowerCase() === 'none') { uiDomain = ''; break; }
        if (value.toLowerCase() === 'r') { uiDomain = 'uui-' + crypto.randomBytes(2).toString('hex') + '.' + domain; break; }
        if (validDomain(value)) { uiDomain = value; break; }
        io.print('域名不合法，请重新输入（- = 仅 SSH 隧道，r = 随机前缀）');
      }
    } else if (!validDomain(uiDomain)) {
      uiDomain = '';
    }
    cfg.ui.domain = uiDomain;

    const baseFallback = (cfg.ui.basePath && cfg.ui.basePath !== '/') ? cfg.ui.basePath : '/';
    let basePath = normalizeBasePath(cfg.ui.basePath);
    if (!yes) {
      for (;;) {
        const value = String(await rawAsk('u-ui 访问路径（如 /uui/；回车=/；r = 随机）', baseFallback)).trim();
        if (value.toLowerCase() === 'r') { basePath = normalizeBasePath('/uui-' + crypto.randomBytes(2).toString('hex') + '/'); break; }
        if (basePathInputOk(value)) { basePath = normalizeBasePath(value); break; }
        io.print('路径不合法：需以 / 开头和结尾，且不能使用 /api/、/login/、/logout/ 前缀');
      }
    }
    cfg.ui.basePath = basePath;

    const hosts = [domain];
    if (uiDomain) hosts.push(uiDomain);
    for (const ib of (cfg.singbox && cfg.singbox.inbounds) || []) {
      if (ib.security === 'tls' && ib.sni && (ib.sni === domain || ib.sni.endsWith('.' + domain))) hosts.push(ib.sni);
    }
    const existingCerts = (cfg.certs && Array.isArray(cfg.certs.domains)) ? cfg.certs.domains : [];
    if (domainChanged || uiDomain !== originalUiDomain || sniRenamed || !existingCerts.length) {
      cfg.certs = cfg.certs || {};
      cfg.certs.domains = Array.from(new Set(hosts));
    }

    if (!yes) io.print('已关闭 x-ui / s-ui 面板反代：只用 u-ui');
  }

  // 3. public IP: auto-detected, overridable
  let detected = '';
  if (!yes && opts.detectIp !== false) detected = await detectPublicIp();
  const oldIp = cfg.server.publicIp || '';
  const ipFallback = isPlaceholderAddress(oldIp) ? (detected || oldIp) : oldIp;
  let ip = flags.ip;
  if (ip == null) {
    ip = await ask(
      detected && isPlaceholderAddress(oldIp) ? '公网 IP（已自动探测，回车使用）' : '公网 IP（回车保留当前）',
      ipFallback,
      function (v) { return v === '' || net.isIP(v) !== 0; },
      'IP 地址格式不正确（IPv4 或 IPv6）',
    );
  }
  if (ip) cfg.server.publicIp = ip;

  // 4. panel port
  const currentUiPort = String(cfg.ui.port || 8788);
  const uiPort = flags.panelPort != null ? String(flags.panelPort) : await ask(
    '面板端口（r = 随机）',
    currentUiPort,
    function (v) { return v === 'r' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535); },
    '端口必须是 1-65535 的整数，或输入 r 随机',
  );
  cfg.ui.port = uiPort === 'r' ? randomPort() : Number(uiPort) || 8788;

  // 5. subscription port
  const currentSubPort = String(cfg.subscription.port || 8787);
  const subPort = flags.subPort != null ? String(flags.subPort) : await ask(
    '订阅服务端口（r = 随机）',
    currentSubPort,
    function (v) { return v === 'r' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535); },
    '端口必须是 1-65535 的整数，或输入 r 随机',
  );
  cfg.subscription.port = subPort === 'r' ? randomPort() : Number(subPort) || 8787;

  // 6. public subscription address (optional; empty means http://<ip>:<port>)
  const currentBase = String(cfg.subscription.publicBase || '');
  let subBase = currentBase;
  if (!yes) {
    for (;;) {
      const input = String(await rawAsk('订阅公开地址（如 https://sub.example.com；只填域名会自动补 https://；回车=' + (currentBase || '自动') + '；- = 自动）', currentBase)).trim();
      if (input === '-') { subBase = ''; break; }
      if (input === '') { subBase = currentBase; break; }
      let candidate = input;
      if (!/^https?:\/\//i.test(candidate) && /^[A-Za-z0-9.-]+(:\d+)?$/.test(candidate)) {
        candidate = 'https://' + candidate;
        io.print('已按 HTTPS 补全为 ' + candidate);
      }
      if (/^https?:\/\/[^\s/]+$/i.test(candidate)) { subBase = candidate.replace(/\/+$/, ''); break; }
      io.print('输入不合法：订阅地址只填域名（会自动补 https://）或完整的 http(s):// 地址，不要带路径；请重新输入');
    }
  }
  cfg.subscription.publicBase = subBase;
  if (subBase && subBase !== currentBase) {
    try {
      const parsed = new URL(subBase);
      const host = parsed.hostname;
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') >= 0;
      if (parsed.protocol === 'https:' && !isIp && validDomain(host)) {
        cfg.certs = cfg.certs || {};
        cfg.certs.domains = Array.from(new Set((cfg.certs.domains || []).concat([host])));
      }
    } catch (e) { /* invalid URL was rejected above */ }
  }

  // 7. the only account created here: an admin. Others are added in the panel.
  const existingAdmin = (cfg.ui.users || []).find(function (u) { return u.role !== 'viewer'; });
  const username = flags.username != null ? flags.username : await ask(
    '管理员用户名',
    existingAdmin ? existingAdmin.username : 'admin',
    function (v) { return USERNAME_RE.test(v); },
    '用户名只能使用 A-Z a-z 0-9 _ -，长度 3-32',
  );
  if (!USERNAME_RE.test(username)) {
    io.print('用户名只能用 A-Z a-z 0-9 _ -，3-32 位');
    return { ok: false, error: 'invalid username' };
  }
  let adminPassword = flags.password || '';
  let passwordChanged = Boolean(flags.password);
  if (!adminPassword && !yes) {
    const question = existingAdmin ? '管理员密码（回车 = 保持不变；r = 随机）' : '管理员密码（回车 = 随机生成）';
    const pw = String(await ask(question, '')).trim();
    if (pw === 'r') {
      adminPassword = randomPassword();
      passwordChanged = true;
    } else if (pw) {
      adminPassword = pw;
      passwordChanged = true;
    }
  }
  let adminChanged = false;
  if (!existingAdmin) {
    if (!adminPassword) {
      adminPassword = randomPassword();
      passwordChanged = true;
    }
    cfg.ui.users = (cfg.ui.users || []).filter(function (u) { return String(u.username) !== username; });
    cfg.ui.users.unshift({ username: username, role: 'admin', hash: hashPassword(adminPassword), addedAt: new Date().toISOString() });
    adminChanged = true;
  } else if (username !== existingAdmin.username) {
    cfg.ui.users = (cfg.ui.users || []).filter(function (u) { return String(u.username) !== existingAdmin.username && String(u.username) !== username; });
    cfg.ui.users.unshift({
      username: username,
      role: 'admin',
      hash: passwordChanged ? hashPassword(adminPassword) : existingAdmin.hash,
      addedAt: existingAdmin.addedAt || new Date().toISOString(),
    });
    adminChanged = true;
  } else if (passwordChanged) {
    existingAdmin.hash = hashPassword(adminPassword);
    adminChanged = true;
  }
  if (adminChanged) {
    delete cfg.ui.password;
    delete cfg.ui.viewerPassword;
  }

  // 8. e-mail for ACME
  const email = flags.email != null ? flags.email : await ask(
    '邮箱（申请证书用，回车 = 跳过）',
    cfg.server.email || '',
    function (v) { return v === '' || EMAIL_RE.test(v); },
    '邮箱格式不正确，例如 name@example.com',
  );
  if (email) cfg.server.email = email;

  if (flags.dryRun) {
    io.print('(dry run) 未写入任何内容');
    return { ok: true, dryRun: true, config: cfg };
  }

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const synced = syncUnitPorts({ uiPort: cfg.ui.port, subPort: cfg.subscription.port });
  let panelState = '未安装 systemd 单元（菜单 10 安装）';
  const unitFile = path.join(process.env.UNIPROXY_UNIT_DIR || '/etc/systemd/system', 'uniproxy-ui.service');
  if (fs.existsSync(unitFile) && (typeof process.getuid !== 'function' || process.getuid() === 0)) {
    const restarted = spawnSync('systemctl', ['restart', 'uniproxy-ui'], { timeout: 30000, encoding: 'utf8' });
    panelState = restarted.status === 0
      ? '已启动/重启'
      : ('启动失败: ' + String(restarted.stderr || restarted.stdout || '').trim().split('\n')[0]);
  }

  const top6 = Object.keys(cfg).slice(0, 6);
  const lines = [
    '',
    '已写入 ' + cfgPath,
    '  域名:       ' + (domain || '(仅 IP)'),
    '  证书域名:   ' + ((cfg.certs && cfg.certs.domains && cfg.certs.domains.length) ? cfg.certs.domains.join(', ') : '(未设置)'),
    '  公网 IP:    ' + cfg.server.publicIp,
    '  面板端口:   ' + cfg.ui.port,
    '  订阅端口:   ' + cfg.subscription.port,
    '  订阅地址:   ' + (cfg.subscription.publicBase || '自动（http://公网IP:端口）'),
    '  访问路径:   ' + (cfg.ui.basePath || '/'),
    '  面板服务:   ' + panelState,
    '  管理员账号: ' + username,
    '  管理员密码: ' + (adminChanged && passwordChanged ? adminPassword : '保持不变'),
    '  其他账号:   稍后在面板「账号」页添加',
    '  邮箱:       ' + (cfg.server.email || '(未设置)'),
    ...(synced.updated.length ? ['  服务单元:   已同步端口 -> ' + synced.updated.join(', ')] : []),
    ...(synced.errors.length ? ['  服务单元:   未能同步（需要 root）: ' + synced.errors.join('; ')] : []),
    '',
    '以下已自动随机生成，无需填写：server.secret、VLESS UUID、Reality 密钥对与 shortId、用户 UUID。',
    '下一步：u-ui → 17 validate → 19 apply（或 uniproxy validate / apply）',
    '',
  ];
  io.print(lines.join('\n'));
  return { ok: true, config: cfg };
}