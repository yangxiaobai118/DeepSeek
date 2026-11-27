import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * Certificate helpers: read the current certificate, build an ACME command
 * and run it.
 *
 * Commands are executed as an argv array (no shell) so a domain or path typed
 * into the panel cannot be turned into shell syntax. A custom `certs.command`
 * is the only shell:true path, and that is opt-in by the operator.
 */

const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validDomain(d) { return DOMAIN_RE.test(String(d || '')); }

export function normalizeCerts(c) {
  const raw = c.certs || {};
  const server = c.server || {};
  const domains = Array.isArray(raw.domains) && raw.domains.length
    ? raw.domains
    : (server.domains && server.domains.web ? [server.domains.web] : []);
  return {
    provider: raw.provider || 'certbot',
    email: raw.email || server.email || '',
    domains: domains.map(String),
    challenge: raw.challenge || 'http-01',
    webroot: raw.webroot || '/var/www/html',
    staging: Boolean(raw.staging),
    certFile: (server.cert && server.cert.certFile) || '/etc/uniproxy/certs/fullchain.pem',
    keyFile: (server.cert && server.cert.keyFile) || '/etc/uniproxy/certs/privkey.pem',
    liveDir: raw.liveDir || '',
    command: raw.command || '',
    reload: raw.reload === '' ? '' : (raw.reload || 'systemctl reload nginx'),
  };
}

function liveDirFor(cfg) {
  if (cfg.liveDir) return cfg.liveDir;
  const first = cfg.domains[0] || '';
  return '/etc/letsencrypt/live/' + first.replace(/^\*\./, '');
}

export function providerAvailable(name) {
  const res = spawnSync('sh', ['-c', 'command -v ' + String(name)], { encoding: 'utf8' });
  return res.status === 0 && String(res.stdout || '').trim() !== '';
}

/** Install certbot with the system package manager (root required). */
export function installCertbot(log) {
  const say = typeof log === 'function' ? log : function () {};
  const managers = [
    { name: 'apt-get', update: ['apt-get', 'update'], install: ['apt-get', 'install', '-y', 'certbot'] },
    { name: 'dnf', install: ['dnf', 'install', '-y', 'certbot'] },
    { name: 'yum', install: ['yum', 'install', '-y', 'certbot'] },
    { name: 'apk', install: ['apk', 'add', 'certbot'] },
    { name: 'zypper', install: ['zypper', '--non-interactive', 'install', 'certbot'] },
  ];
  const manager = managers.find(function (m) { return providerAvailable(m.name); });
  if (!manager) return { ok: false, error: 'no supported package manager (apt/dnf/yum/apk/zypper)' };

  say('使用 ' + manager.name + ' 安装 certbot…');
  const runLive = function (argv) {
    const res = spawnSync(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
    return { ok: res.status === 0, error: res.error ? res.error.message : '', status: res.status };
  };
  if (manager.update) {
    say('更新软件包索引（可能要一会儿）…');
    runLive(manager.update);
  }
  say('安装 certbot…');
  const res = runLive(manager.install);
  if (!res.ok) return { ok: false, error: res.error || ('package manager exit ' + res.status) };
  if (!providerAvailable('certbot')) return { ok: false, error: 'certbot is still not in PATH after installation' };
  say('certbot 安装完成');
  return { ok: true };
}

export function ensureCertbot(log) {
  if (providerAvailable('certbot')) return { ok: true, installed: false };
  return installCertbot(log);
}

export function buildCommand(c, mode) {
  const cfg = normalizeCerts(c);
  if (cfg.command) return { argv: [cfg.command], shell: true, cfg: cfg };

  const domains = cfg.domains.filter(validDomain);
  if (!domains.length) throw new Error('certs.domains is empty or contains invalid names');
  if (cfg.email && !EMAIL_RE.test(cfg.email)) throw new Error('certs.email is not a valid address');

  if (cfg.provider === 'acme.sh') {
    const argv = ['acme.sh', '--issue'];
    if (cfg.challenge === 'dns-01') argv.push('--dns');
    else argv.push('--webroot', cfg.webroot);
    for (const d of domains) argv.push('-d', d);
    if (cfg.staging) argv.push('--staging');
    return { argv: argv, shell: false, cfg: cfg };
  }

  if (mode === 'renew') return { argv: ['certbot', 'renew', '--cert-name', domains[0]], shell: false, cfg: cfg };

  const argv = ['certbot', 'certonly'];
  if (cfg.challenge === 'standalone') argv.push('--standalone');
  else if (cfg.challenge === 'dns-01') argv.push('--manual', '--preferred-challenges', 'dns');
  else argv.push('--webroot', '-w', cfg.webroot);
  for (const d of domains) argv.push('-d', d);
  if (cfg.email) argv.push('--email', cfg.email);
  argv.push('--agree-tos', '--no-eff-email');
  if (cfg.staging) argv.push('--staging');
  return { argv: argv, shell: false, cfg: cfg };
}

export function certStatus(c) {
  const cfg = normalizeCerts(c);
  try {
    const pem = fs.readFileSync(cfg.certFile, 'utf8');
    const x = new crypto.X509Certificate(pem);
    const to = new Date(x.validTo);
    const daysLeft = Math.floor((to.getTime() - Date.now()) / 86400000);
    return {
      ok: daysLeft > 0,
      file: cfg.certFile,
      subject: String(x.subject || '').replace(/\n/g, ', '),
      issuer: String(x.issuer || '').replace(/\n/g, ', '),
      validFrom: x.validFrom,
      validTo: x.validTo,
      daysLeft: daysLeft,
      sans: x.subjectAltName || '',
    };
  } catch (e) {
    return { ok: false, file: cfg.certFile, error: e.message };
  }
}

function defaultRun(plan) {
  const res = plan.shell
    ? spawnSync(plan.argv[0], { shell: true, timeout: 300000, encoding: 'utf8' })
    : spawnSync(plan.argv[0], plan.argv.slice(1), { timeout: 300000, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
    error: res.error ? res.error.code : null,
  };
}

function copyInto(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

export function issue(c, opts = {}) {
  const mode = opts.mode === 'renew' ? 'renew' : 'issue';
  let plan;
  try {
    plan = buildCommand(c, mode);
  } catch (e) {
    return { ok: false, command: '', output: '', error: e.message };
  }
  const run = opts.run || defaultRun;
  const result = run(plan);
  const out = { ok: result.ok, command: plan.argv.join(' '), output: result.output, error: result.error || '', copied: false };
  if (!result.ok) return out;

  const cfg = plan.cfg;
  if (opts.copy !== false && !cfg.command) {
    const live = liveDirFor(cfg);
    const full = path.join(live, 'fullchain.pem');
    const key = path.join(live, 'privkey.pem');
    try {
      if (fs.existsSync(full) && fs.existsSync(key)) {
        copyInto(full, cfg.certFile);
        copyInto(key, cfg.keyFile);
        out.copied = true;
      }
    } catch (e) {
      out.error = 'copy failed: ' + e.message;
    }
  }

  if (out.copied && cfg.reload && opts.reload !== false) {
    const reload = (opts.run || defaultRun)({ argv: [cfg.reload], shell: true });
    out.reloaded = reload.ok;
    if (!reload.ok) out.error = (out.error ? out.error + '; ' : '') + 'reload failed: ' + (reload.output || reload.error);
  }
  return out;
}