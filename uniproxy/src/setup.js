import fs from 'node:fs';
import crypto from 'node:crypto';
import { hashPassword, USERNAME_RE } from './auth.js';
import { syncUnitPorts } from './units.js';
import { validDomain } from './certs.js';
import { normalizeBasePath } from './util.js';

/**
 * First-run wizard.
 *
 * Everything that CAN be random is: secrets, UUIDs, Reality keys and the panel
 * passwords (press Enter). Everything that CANNOT be random is asked for: the
 * domain (or an explicit IP-only mode), the public IP (auto-detected, overridable)
 * and the ACME e-mail. Ports default to sane values and accept `r` for random.
 */

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
    if (ib.security === 'tls' && (!ib.sni || ib.sni.endsWith('.example.com'))) ib.sni = 'sb.' + domain;
  }
}

export async function runSetup(opts = {}) {
  const cfgPath = opts.configPath || 'config.json';
  const io = opts.io || { question: async function () { return ''; }, print: function (s) { process.stdout.write(String(s) + '\n'); } };
  const yes = opts.yes === true;
  const flags = opts.flags || {};

  if (!fs.existsSync(cfgPath)) {
    io.print('没有找到 ' + cfgPath + '；请先运行 uniproxy init -c ' + cfgPath + '，或用菜单 1 安装到系统路径');
    return { ok: false, error: 'missing config' };
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.ui = cfg.ui || {};
  cfg.subscription = cfg.subscription || {};

  const ask = async function (question, fallback) {
    if (yes) return fallback;
    const shown = question + (fallback ? ' [' + fallback + ']' : '') + ': ';
    const answer = String((await io.question(shown)) || '').trim();
    return answer === '' ? (fallback || '') : answer;
  };

  if (!yes) io.print('回车 = 使用默认值 / 随机值；r = 随机；无法随机的项会明确提示。');

  // 1. domain: cannot be random
  const currentDomain = (cfg.server.domains && cfg.server.domains.web) || '';
  const domainHint = currentDomain && !currentDomain.endsWith('.example.com') ? currentDomain : '';
  const domain = flags.domain != null ? flags.domain : await ask('域名（如 example.com；回车=仅 IP，不使用域名）', domainHint);
  if (domain) applyDomain(cfg, domain);

  // 2. u-ui hostname; x-ui / s-ui panel proxying is no longer configured here
  if (domain) {
    cfg.panels = cfg.panels || {};
    cfg.panels.xui = cfg.panels.xui || {};
    cfg.panels.sui = cfg.panels.sui || {};
    cfg.panels.sui.sub = cfg.panels.sui.sub || {};
    cfg.panels.xui.enabled = false;
    cfg.panels.sui.enabled = false;
    cfg.panels.sui.sub.enabled = false;

    const hostDefault = function (current, prefix) {
      return current && validDomain(current) && current.endsWith('.' + domain) && current !== domain
        ? current
        : prefix + '.' + domain;
    };
    const uiFallback = hostDefault(cfg.ui.domain, 'uui');
    let uiDomain = cfg.ui.domain || '';
    if (!yes) {
      const value = String(await ask('u-ui 面板域名（- = 仅 SSH 隧道；r = 随机前缀）', uiFallback)).trim();
      if (value === '-' || value.toLowerCase() === 'none') uiDomain = '';
      else if (value.toLowerCase() === 'r') uiDomain = 'uui-' + crypto.randomBytes(2).toString('hex') + '.' + domain;
      else if (!value) uiDomain = uiFallback;
      else if (validDomain(value)) uiDomain = value;
      else {
        io.print('域名不合法，使用 ' + uiFallback);
        uiDomain = uiFallback;
      }
    } else if (!validDomain(uiDomain)) {
      uiDomain = '';
    }
    cfg.ui.domain = uiDomain;

    const baseFallback = (cfg.ui.basePath && cfg.ui.basePath !== '/') ? cfg.ui.basePath : '/';
    let basePath = normalizeBasePath(cfg.ui.basePath);
    if (!yes) {
      const value = String(await ask('u-ui 访问路径（如 /uui/；回车=/）', baseFallback)).trim();
      basePath = normalizeBasePath(value);
    }
    cfg.ui.basePath = basePath;

    const hosts = [domain];
    if (uiDomain) hosts.push(uiDomain);
    for (const ib of (cfg.singbox && cfg.singbox.inbounds) || []) {
      if (ib.security === 'tls' && ib.sni && (ib.sni === domain || ib.sni.endsWith('.' + domain))) hosts.push(ib.sni);
    }
    cfg.certs = cfg.certs || {};
    cfg.certs.domains = Array.from(new Set(hosts));

    if (!yes) io.print('已关闭 x-ui / s-ui 面板反代：只用 u-ui');
  }

  // 3. public IP: auto-detected, overridable
  let detected = '';
  if (!yes && opts.detectIp !== false) detected = await detectPublicIp();
  let ip = flags.ip;
  if (ip == null) {
    ip = await ask(detected ? '公网 IP（已自动探测，回车使用）' : '公网 IP', detected || cfg.server.publicIp || '');
  }
  if (ip) cfg.server.publicIp = ip;

  // 4. panel port
  const currentUiPort = String(cfg.ui.port || 8788);
  const uiPort = flags.panelPort != null ? String(flags.panelPort) : await ask('面板端口（r = 随机）', currentUiPort);
  cfg.ui.port = uiPort === 'r' ? randomPort() : Number(uiPort) || 8788;

  // 5. subscription port
  const currentSubPort = String(cfg.subscription.port || 8787);
  const subPort = flags.subPort != null ? String(flags.subPort) : await ask('订阅服务端口（r = 随机）', currentSubPort);
  cfg.subscription.port = subPort === 'r' ? randomPort() : Number(subPort) || 8787;

  // 6. the only account created here: an admin. Others are added in the panel.
  const existingAdmin = (cfg.ui.users || []).find(function (u) { return u.role !== 'viewer'; });
  const username = flags.username != null ? flags.username : await ask('管理员用户名', existingAdmin ? existingAdmin.username : 'admin');
  if (!USERNAME_RE.test(username)) {
    io.print('用户名只能用 A-Z a-z 0-9 _ -，3-32 位');
    return { ok: false, error: 'invalid username' };
  }
  let adminPassword = flags.password || '';
  if (!adminPassword) {
    if (yes) adminPassword = randomPassword();
    else {
      const pw = await ask('管理员密码（回车 = 随机生成）', '');
      adminPassword = pw && pw !== 'r' ? pw : randomPassword();
    }
  }
  cfg.ui.users = (cfg.ui.users || []).filter(function (u) { return String(u.username) !== username; });
  cfg.ui.users.unshift({ username: username, role: 'admin', hash: hashPassword(adminPassword), addedAt: new Date().toISOString() });
  delete cfg.ui.password;
  delete cfg.ui.viewerPassword;

  // 7. e-mail for ACME
  const email = flags.email != null ? flags.email : await ask('邮箱（申请证书用，回车 = 跳过）', cfg.server.email || '');
  if (email) cfg.server.email = email;

  if (flags.dryRun) {
    io.print('(dry run) 未写入任何内容');
    return { ok: true, dryRun: true, config: cfg };
  }

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const synced = syncUnitPorts({ uiPort: cfg.ui.port, subPort: cfg.subscription.port });

  const top6 = Object.keys(cfg).slice(0, 6);
  const lines = [
    '',
    '已写入 ' + cfgPath,
    '  域名:       ' + (domain || '(仅 IP)'),
    '  证书域名:   ' + ((cfg.certs && cfg.certs.domains && cfg.certs.domains.length) ? cfg.certs.domains.join(', ') : '(未设置)'),
    '  公网 IP:    ' + cfg.server.publicIp,
    '  面板端口:   ' + cfg.ui.port,
    '  订阅端口:   ' + cfg.subscription.port,
    '  访问路径:   ' + (cfg.ui.basePath || '/'),
    '  管理员账号: ' + username,
    '  管理员密码: ' + adminPassword,
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