import fs from 'node:fs';
import crypto from 'node:crypto';

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
  cfg.certs = cfg.certs || {};
  cfg.certs.domains = [domain];
  cfg.nginx = cfg.nginx || {};
  cfg.nginx.sites = cfg.nginx.sites || [];
  if (cfg.nginx.sites[0]) cfg.nginx.sites[0].serverName = domain;
  else cfg.nginx.sites.push({ serverName: domain, root: '/var/www/html', index: 'index.html' });
  cfg.panels = cfg.panels || {};
  if (cfg.panels.xui) cfg.panels.xui.domain = 'xui.' + domain;
  if (cfg.panels.sui) {
    cfg.panels.sui.domain = 'sui.' + domain;
    if (cfg.panels.sui.sub) cfg.panels.sui.sub.domain = 'sub.' + domain;
  }
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

  // 2. public IP: auto-detected, overridable
  let detected = '';
  if (!yes && opts.detectIp !== false) detected = await detectPublicIp();
  let ip = flags.ip;
  if (ip == null) {
    ip = await ask(detected ? '公网 IP（已自动探测，回车使用）' : '公网 IP', detected || cfg.server.publicIp || '');
  }
  if (ip) cfg.server.publicIp = ip;

  // 3. panel port
  const currentUiPort = String(cfg.ui.port || 8788);
  const uiPort = flags.panelPort != null ? String(flags.panelPort) : await ask('面板端口（r = 随机）', currentUiPort);
  cfg.ui.port = uiPort === 'r' ? randomPort() : Number(uiPort) || 8788;

  // 4. subscription port
  const currentSubPort = String(cfg.subscription.port || 8787);
  const subPort = flags.subPort != null ? String(flags.subPort) : await ask('订阅服务端口（r = 随机）', currentSubPort);
  cfg.subscription.port = subPort === 'r' ? randomPort() : Number(subPort) || 8787;

  // 5. admin password: Enter = random
  let adminPassword = flags.password || '';
  if (!adminPassword) {
    if (yes) adminPassword = randomPassword();
    else {
      const pw = await ask('管理员密码（回车 = 随机生成）', '');
      adminPassword = pw && pw !== 'r' ? pw : randomPassword();
    }
  }
  cfg.ui.password = adminPassword;

  // 6. viewer password: Enter = not set
  let viewerPassword = cfg.ui.viewerPassword || '';
  if (flags.viewer === false) viewerPassword = '';
  else if (!yes) {
    const vp = await ask('只读密码（回车 = 不设置，r = 随机）', viewerPassword ? 'r' : '');
    viewerPassword = vp === 'r' ? randomPassword() : vp;
  } else if (viewerPassword) {
    viewerPassword = viewerPassword || randomPassword();
  }
  if (viewerPassword) cfg.ui.viewerPassword = viewerPassword;
  else delete cfg.ui.viewerPassword;

  // 7. e-mail for ACME
  const email = flags.email != null ? flags.email : await ask('邮箱（申请证书用，回车 = 跳过）', cfg.server.email || '');
  if (email) cfg.server.email = email;

  if (flags.dryRun) {
    io.print('(dry run) 未写入任何内容');
    return { ok: true, dryRun: true, config: cfg };
  }

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  const top6 = Object.keys(cfg).slice(0, 6);
  const lines = [
    '',
    '已写入 ' + cfgPath,
    '  域名:       ' + (domain || '(仅 IP)'),
    '  公网 IP:    ' + cfg.server.publicIp,
    '  面板端口:   ' + cfg.ui.port,
    '  订阅端口:   ' + cfg.subscription.port,
    '  管理员密码: ' + cfg.ui.password,
    '  只读密码:   ' + (cfg.ui.viewerPassword || '(未设置)'),
    '  邮箱:       ' + (cfg.server.email || '(未设置)'),
    '',
    '以下已自动随机生成，无需填写：server.secret、VLESS UUID、Reality 密钥对与 shortId、用户 UUID。',
    '下一步：u-ui → 17 validate → 19 apply（或 uniproxy validate / apply）',
    '',
  ];
  io.print(lines.join('\n'));
  return { ok: true, config: cfg };
}
