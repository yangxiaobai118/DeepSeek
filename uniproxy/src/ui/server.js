import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applyDefaults, validateConfig } from '../config.js';
import { analyzePorts } from '../ports.js';
import { resolveUsers, deriveUuid, derivePassword } from '../users.js';
import { collectStats, combineStats, mergeUsage } from '../stats.js';
import { collectLogs, logSources } from '../logs.js';
import { generateNginx } from '../generators/nginx.js';
import { collectAlerts, notify, loadState } from '../alerts.js';
import { certStatus, normalizeCerts, buildCommand, issue, validDomain } from '../certs.js';
import { normalizeNodes, probe, deploy, probeBatch, deployBatch } from '../nodes.js';
import { protocolList } from '../protocols.js';
import { hashPassword, verifyPassword, accountsOf, USERNAME_RE } from '../auth.js';
import { listBackups, createBackup, readBackup, deleteBackup, restoreBackup, pruneBackups } from '../backups.js';
import { buildSubscriptions } from '../subscribe.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { buildPlan, formatPlan, applyPlan } from '../apply.js';
import { normalizeBasePath } from '../util.js';
import { readTextAsset } from '../assets.js';

const SESSION_COOKIE = 'uui_session';
const CSRF_COOKIE = 'uui_csrf';
const SESSION_TTL = 8 * 3600 * 1000;

export function startUi(cfgPath, port = 8788, options = {}) {
  const abs = path.resolve(cfgPath);
  const legacy = {
    admin: options.password || process.env.UNIPROXY_UI_PASSWORD || readPassword(abs, 'password'),
    viewer: options.viewerPassword || process.env.UNIPROXY_UI_VIEWER_PASSWORD || readPassword(abs, 'viewerPassword'),
  };
  const host = options.host || '127.0.0.1';
  const attempts = new Map();
  let basePath = '/';
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    basePath = normalizeBasePath(raw.ui && raw.ui.basePath);
  } catch (e) { /* config unreadable: root path */ }
  const BASE = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const cookiePath = BASE ? BASE + '/' : '/';

  function pageHtml() {
    const html = readTextAsset('page.html', 'ui/page.html');
    if (!BASE) return html;
    return html
      .replace(/(["'])\/api/g, '$1api')
      .replace(/(["'])\/login/g, '$1login')
      .replace(/(["'])\/logout/g, '$1logout');
  }

  function accounts() {
    return accountsOf(JSON.parse(fs.readFileSync(abs, 'utf8')), legacy);
  }

  if (!accounts().length) {
    throw new Error('u-ui has no account: set UNIPROXY_UI_PASSWORD, add "ui": { "password": "..." }, or run "uniproxy setup"');
  }

  function secret() {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const material = (raw.server && raw.server.secret) || legacy.admin || 'uniproxy';
    return crypto.createHash('sha256').update('u-ui|' + material).digest();
  }

  const server = http.createServer(function (req, res) {
    Promise.resolve()
      .then(function () { return handle(req, res); })
      .catch(function (e) {
        try { send(res, 500, { 'content-type': 'text/plain' }, 'error: ' + e.message); } catch (ignored) { /* socket gone */ }
      });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (BASE) {
      if (url.pathname === '/' || url.pathname === BASE) {
        return send(res, 303, { location: BASE + '/' }, '');
      }
      if (!url.pathname.startsWith(BASE + '/')) {
        return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
      }
      url.pathname = url.pathname.slice(BASE.length);
    }
    const cookies = parseCookies(req.headers.cookie || '');

    if (url.pathname === '/login') {
      if (req.method === 'POST') return doLogin(req, res, cookies);
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, loginPage('', BASE ? BASE + '/login' : '/login'));
    }
    if (url.pathname === '/logout') {
      return send(res, 303, { location: BASE + '/login', 'set-cookie': clearCookies(cookiePath) }, '');
    }

    const session = verifySession(cookies[SESSION_COOKIE], secret());
    const authed = Boolean(session);
    if (!authed && url.pathname !== '/login') {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      return send(res, 303, { location: BASE + '/login' }, '');
    }

    if (url.pathname === '/') {
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, pageHtml());
    }

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && cookies[CSRF_COOKIE]) {
      if (req.headers['x-uui-csrf'] !== cookies[CSRF_COOKIE]) return json(res, 403, { error: 'bad csrf token' });
    }
    if (mutating && session.role !== 'admin') return json(res, 403, { error: 'read-only role: viewer cannot modify' });

    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state(abs, cookies[CSRF_COOKIE], session.role, session.username));
    if (url.pathname === '/api/system' && req.method === 'GET') return json(res, 200, systemStats());
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return json(res, 200, { json: fs.readFileSync(abs, 'utf8') });
      if (req.method === 'PUT') return saveConfig(req, res, abs);
    }
    if (url.pathname === '/api/users' && req.method === 'POST') return createUser(req, res, abs);
    const userMatch = url.pathname.match(/^\/api\/users\/(.+)$/);
    if (userMatch && req.method === 'PUT') return updateUser(req, res, abs, decodeURIComponent(userMatch[1]));
    if (userMatch && req.method === 'DELETE') return deleteUser(res, abs, decodeURIComponent(userMatch[1]));
    const actionMatch = url.pathname.match(/^\/api\/actions\/([a-z]+)$/);
    if (actionMatch && req.method === 'POST') return runAction(req, res, abs, actionMatch[1]);

    if (url.pathname === '/api/inbounds' && req.method === 'GET') return listInbounds(res, abs);
    if (url.pathname === '/api/inbounds' && req.method === 'POST') return createInbound(req, res, abs);
    const clientsMatch = url.pathname.match(/^\/api\/inbounds\/([a-z]+)\/([^/]+)\/clients(?:\/(.+))?$/);
    if (clientsMatch) {
      const ckind = clientsMatch[1];
      const ctag = decodeURIComponent(clientsMatch[2]);
      if (req.method === 'GET' && !clientsMatch[3]) return listClients(res, abs, ckind, ctag);
      if (req.method === 'POST' && !clientsMatch[3]) return addClient(req, res, abs, ckind, ctag);
      if (req.method === 'DELETE' && clientsMatch[3]) return removeClient(res, abs, ckind, ctag, decodeURIComponent(clientsMatch[3]));
    }
    const ibMatch = url.pathname.match(/^\/api\/inbounds\/([a-z]+)\/([^/]+)$/);
    if (ibMatch && req.method === 'PUT') return updateInbound(req, res, abs, ibMatch[1], decodeURIComponent(ibMatch[2]));
    if (ibMatch && req.method === 'DELETE') return deleteInbound(res, abs, ibMatch[1], decodeURIComponent(ibMatch[2]));

    if (url.pathname === '/api/cores' && req.method === 'GET') return listCores(res, abs);
    const coreMatch = url.pathname.match(/^\/api\/cores\/([a-z]+)\/(start|stop|restart)$/);
    if (coreMatch && req.method === 'POST') return coreAction(res, abs, coreMatch[1], coreMatch[2]);
    const corePut = url.pathname.match(/^\/api\/cores\/([a-z]+)$/);
    if (corePut && req.method === 'PUT') return setCoreEnabled(req, res, abs, corePut[1]);

    if (url.pathname === '/api/stats' && req.method === 'GET') return await statsState(res, abs);
    if (url.pathname === '/api/stats/sync' && req.method === 'POST') return await syncStats(res, abs);
    if (url.pathname === '/api/logs' && req.method === 'GET') return logView(res, url);
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') return getSettings(res, abs);
      if (req.method === 'PUT') return putSettings(req, res, abs);
    }

    if (url.pathname === '/api/nginx') {
      if (req.method === 'GET') return getNginx(res, abs);
      if (req.method === 'PUT') return putNginx(req, res, abs);
    }
    if (url.pathname === '/api/nginx/test' && req.method === 'POST') return nginxTest(res, abs);
    if (url.pathname === '/api/nginx/reload' && req.method === 'POST') return nginxReload(res, abs);

    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' });
      return json(res, 200, accountsPayload(abs));
    }
    if (url.pathname === '/api/accounts' && req.method === 'POST') return saveAccount(req, res, abs, 'POST', '');
    const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch && req.method === 'PUT') return saveAccount(req, res, abs, 'PUT', decodeURIComponent(accountMatch[1]));
    if (accountMatch && req.method === 'DELETE') return deleteAccount(res, abs, decodeURIComponent(accountMatch[1]));

    if (url.pathname === '/api/backups' && req.method === 'GET') return json(res, 200, { backups: listBackups(abs), keep: backupKeep(abs) });
    if (url.pathname === '/api/backups' && req.method === 'POST') return createBackupHandler(res, abs);
    const backupRestore = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (backupRestore && req.method === 'POST') return restoreBackupHandler(res, abs, decodeURIComponent(backupRestore[1]));
    const backupDownload = url.pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
    if (backupDownload && req.method === 'GET') return downloadBackup(res, abs, decodeURIComponent(backupDownload[1]));
    const backupOne = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
    if (backupOne && req.method === 'DELETE') return removeBackup(res, abs, decodeURIComponent(backupOne[1]));

    if (url.pathname === '/api/nodes' && req.method === 'GET') return getNodes(res, abs);
    if (url.pathname === '/api/nodes' && req.method === 'POST') return saveNode(req, res, abs, null);
    const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
    if (nodeMatch && req.method === 'PUT') return saveNode(req, res, abs, decodeURIComponent(nodeMatch[1]));
    if (nodeMatch && req.method === 'DELETE') return deleteNode(res, abs, decodeURIComponent(nodeMatch[1]));
    if (url.pathname === '/api/nodes/probe-all' && req.method === 'POST') return nodeBatch(res, abs, 'probe');
    if (url.pathname === '/api/nodes/deploy-all' && req.method === 'POST') return await nodeBatchDeploy(req, res, abs);
    const nodeAction = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(probe|deploy)$/);
    if (nodeAction && req.method === 'POST') return nodeAct(req, res, abs, decodeURIComponent(nodeAction[1]), nodeAction[2]);

    if (url.pathname === '/api/certs') {
      if (req.method === 'GET') return getCerts(res, abs);
      if (req.method === 'PUT') return putCerts(req, res, abs);
    }
    if (url.pathname === '/api/certs/issue' && req.method === 'POST') return certAction(res, abs, 'issue');
    if (url.pathname === '/api/certs/renew' && req.method === 'POST') return certAction(res, abs, 'renew');

    if (url.pathname === '/api/alerts' && req.method === 'GET') return getAlerts(res, abs);
    if (url.pathname === '/api/alerts/notify' && req.method === 'POST') return await notifyAlerts(res, abs);

    if (url.pathname === '/api/audit' && req.method === 'GET') {
      return json(res, 200, { entries: readAudit(abs, Number(url.searchParams.get('limit') || 200)) });
    }

    return json(res, 404, { error: 'not found' });
  }

  function doLogin(req, res, cookies) {
    readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: err.message });
      const ip = req.socket.remoteAddress || 'unknown';
      const gate = attempts.get(ip) || { count: 0, until: 0 };
      if (gate.until > Date.now()) return send(res, 429, { 'content-type': 'text/plain' }, 'too many attempts, wait a minute');
      const form = new URLSearchParams(body);
      const supplied = form.get('password') || '';
      const typedName = String(form.get('username') || '').trim();
      let role = '';
      let matched = '';
      for (const acc of accounts()) {
        const ok = acc.plain !== undefined
          ? safeEqual(supplied, acc.plain)
          : (verifyPassword(supplied, acc.hash) && (!typedName || typedName === acc.username));
        if (ok) { role = acc.role; matched = acc.username; break; }
      }
      if (!role) {
        gate.count += 1;
        if (gate.count >= 5) { gate.count = 0; gate.until = Date.now() + 60000; }
        attempts.set(ip, gate);
        return send(res, 401, { 'content-type': 'text/html; charset=utf-8' }, loginPage('wrong password'));
      }
      attempts.delete(ip);
      const exp = Date.now() + SESSION_TTL;
      const csrf = crypto.randomBytes(16).toString('hex');
      const cookie = [
        SESSION_COOKIE + '=' + encodeURIComponent(sign(exp + '.' + matched + '.' + role, secret())) + '; HttpOnly; SameSite=Strict; Path=' + cookiePath + '; Max-Age=' + Math.floor(SESSION_TTL / 1000),
        CSRF_COOKIE + '=' + csrf + '; SameSite=Strict; Path=' + cookiePath + '; Max-Age=' + Math.floor(SESSION_TTL / 1000),
      ];
      return send(res, 303, { location: BASE + '/', 'set-cookie': cookie }, '');
    });
  }

  return new Promise(function (resolve) {
    server.listen(port, host, function () {
      resolve({
        server,
        url: 'http://' + host + ':' + server.address().port,
        close: function () { return new Promise(function (done) { server.close(done); }); },
      });
    });
  });
}

function readPassword(cfgPath, key) {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return raw.ui && raw.ui[key] ? String(raw.ui[key]) : '';
  } catch (e) { return ''; }
}

function systemStats() {
  const cpus = os.cpus() || [];
  const cores = cpus.length || 1;
  const load1 = (os.loadavg && os.loadavg()[0]) || 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const st = fs.statfsSync('/');
    diskTotal = st.blocks * st.bsize;
    diskFree = st.bavail * st.bsize;
  } catch (e) { /* non-POSIX */ }
  const usedDisk = Math.max(0, diskTotal - diskFree);
  let swapTotal = 0;
  let swapFree = 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/^SwapTotal:\s+(\d+)\s+kB/m);
    const freeMatch = meminfo.match(/^SwapFree:\s+(\d+)\s+kB/m);
    if (totalMatch) swapTotal = Number(totalMatch[1]) * 1024;
    if (freeMatch) swapFree = Number(freeMatch[1]) * 1024;
  } catch (e) { /* non-Linux */ }
  const usedSwap = Math.max(0, swapTotal - swapFree);
  function countSockets(file) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      return Math.max(0, lines.length - 1);
    } catch (e) { return 0; }
  }
  const net = {
    tcp: countSockets('/proc/net/tcp') + countSockets('/proc/net/tcp6'),
    udp: countSockets('/proc/net/udp') + countSockets('/proc/net/udp6'),
  };
  net.total = net.tcp + net.udp;
  const xray = { pid: 0, rss: 0, threads: 0 };
  try {
    const found = spawnSync('pgrep', ['-x', 'xray'], { encoding: 'utf8', timeout: 5000 });
    const pid = String(found.stdout || '').trim().split(/\s+/)[0];
    if (pid) {
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      const threadsMatch = status.match(/^Threads:\s+(\d+)/m);
      xray.pid = Number(pid);
      xray.rss = rssMatch ? Number(rssMatch[1]) * 1024 : 0;
      xray.threads = threadsMatch ? Number(threadsMatch[1]) : 0;
    }
  } catch (e) { /* xray not running or non-Linux */ }
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cores: cores,
    cpuModel: (cpus[0] && cpus[0].model) || '',
    load1: load1,
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)),
    mem: { total: totalMem, free: freeMem, used: usedMem, usedPct: totalMem ? Math.round((usedMem / totalMem) * 100) : 0 },
    swap: { total: swapTotal, free: swapFree, used: usedSwap, usedPct: swapTotal ? Math.round((usedSwap / swapTotal) * 100) : 0 },
    disk: { total: diskTotal, free: diskFree, used: usedDisk, usedPct: diskTotal ? Math.round((usedDisk / diskTotal) * 100) : 0 },
    net: net,
    xray: xray,
    uptime: os.uptime(),
  };
}

function state(cfgPath, csrf, role, username) {
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const c = derive(raw);
  const report = analyzePorts(c);
  const users = resolveUsers(c);
  const subs = c.subscription.enabled ? buildSubscriptions(c) : [];
  return {
    configPath: cfgPath,
    nginxMode: c.nginx.mode,
    publicIp: c.server.publicIp || '',
    domains: c.server.domains || {},
    ports: report.entries,
    errors: report.errors,
    warnings: report.warnings,
    users: users.map(function (u) {
      return { name: u.name, status: u.status, enabled: u.enabled, note: u.note, token: u.token,
        expireAt: u.expireAt ? u.expireAt.toISOString().slice(0, 10) : '',
        dataLimitBytes: u.dataLimitBytes, usedBytes: u.usedBytes,
        inbounds: u.inbounds.map(function (i) { return i.tag; }) };
    }),
    inbounds: allInbounds(c),
    subscriptions: subs.map(function (s) { return { name: s.name, token: s.token }; }),
    csrf: csrf || '',
    role: role || 'viewer',
    user: username || 'admin',
    protocols: protocolList(),
    sni: sniRoutes(c),
  };
}

function allInbounds(c) {
  const out = [];
  for (const kind of ['xray', 'singbox']) {
    for (const ib of c[kind].inbounds || []) {
      out.push({
        kind: kind,
        tag: ib.tag,
        protocol: ib.protocol,
        listen: ib.listen,
        port: ib.port,
        network: ib.network || 'tcp',
        security: ib.security || 'none',
        sni: ib.sni || '',
        wsPath: ib.wsPath || '',
        reality: ib.reality || null,
      });
    }
  }
  return out;
}

function derive(raw) {
  return applyDefaults(JSON.parse(JSON.stringify(raw)));
}

function saveRaw(cfgPath, raw) {
  const text = JSON.stringify(raw, null, 2) + '\n';
  if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, cfgPath + '.bak-' + stamp());
  const tmp = cfgPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, cfgPath);
  pruneBackups(cfgPath, raw && raw.backups ? raw.backups.keep : 20);
  record(cfgPath, 'config.write', 'config.json updated');
}

function saveConfig(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    let raw;
    try { raw = JSON.parse(body.json); } catch (e) { return json(res, 400, { error: 'invalid JSON: ' + e.message }); }
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, warnings: check.warnings });
  });
}

function createUser(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const users = Array.isArray(raw.users) ? raw.users : (raw.users = []);
    const user = normalizeUser(body);
    if (!user.name) return json(res, 400, { error: 'name is required' });
    if (users.some(function (u) { return u.name === user.name; })) return json(res, 409, { error: 'user already exists' });
    users.push(user);
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, user: user, warnings: check.warnings });
  });
}

function updateUser(req, res, cfgPath, name) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const users = Array.isArray(raw.users) ? raw.users : [];
    const idx = users.findIndex(function (u) { return u.name === name; });
    if (idx < 0) return json(res, 404, { error: 'user not found' });
    const merged = normalizeUser(Object.assign({}, users[idx], body));
    if (merged.name !== name && users.some(function (u) { return u.name === merged.name; })) {
      return json(res, 409, { error: 'target name already exists' });
    }
    users[idx] = merged;
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, user: merged, warnings: check.warnings });
  });
}

function deleteUser(res, cfgPath, name) {
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const users = Array.isArray(raw.users) ? raw.users : [];
  const next = users.filter(function (u) { return u.name !== name; });
  if (next.length === users.length) return json(res, 404, { error: 'user not found' });
  raw.users = next;
  saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true });
}

function runAction(req, res, cfgPath, action) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const c = derive(raw);
    if (action === 'validate') {
      const check = validateConfig(c);
      const ports = analyzePorts(c);
      return json(res, 200, { ok: check.errors.length === 0 && ports.errors.length === 0, errors: check.errors.concat(ports.errors), warnings: check.warnings.concat(ports.warnings) });
    }
    if (action === 'doctor') {
      const report = runDoctor(c, cfgPath);
      return json(res, 200, { ok: report.failed === 0, failed: report.failed, warned: report.warned, output: formatDoctor(report) });
    }
    if (action === 'plan') {
      if (!c.apply) return json(res, 400, { error: 'no apply block in config' });
      const targets = buildPlan(c);
      return json(res, 200, { ok: true, output: formatPlan(targets), targets: targets.map(function (t) { return { kind: t.kind, file: t.file, changed: t.changed }; }) });
    }
    if (action === 'apply') {
      if (!body || body.confirm !== 'APPLY') return json(res, 400, { error: 'send {"confirm":"APPLY"} to apply' });
      if (!c.apply) return json(res, 400, { error: 'no apply block in config' });
      const targets = buildPlan(c);
      const result = applyPlan(c, targets, {});
      record(cfgPath, 'apply', result.failed ? 'failed' : 'ok');
      return json(res, 200, { ok: !result.failed, output: result.actions.map(function (a) { return a.level.toUpperCase() + '  ' + a.text; }).join('\n') });
    }
    return json(res, 404, { error: 'unknown action' });
  });
}

function normalizeUser(input) {
  const out = { name: String(input.name || '').trim() };
  if (Array.isArray(input.inbounds)) out.inbounds = input.inbounds.map(String);
  if (input.expireAt) out.expireAt = String(input.expireAt);
  const limit = Number(input.dataLimitBytes || 0);
  if (limit > 0) out.dataLimitBytes = limit; else delete out.dataLimitBytes;
  out.enabled = input.enabled !== false;
  if (input.note) out.note = String(input.note);
  return out;
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', function (chunk) {
    size += chunk.length;
    if (size > 1024 * 1024) { cb(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', cb);
}

function readJson(req, cb) {
  readBody(req, function (err, text) {
    if (err) return cb(err);
    if (!text) return cb(null, {});
    try { cb(null, JSON.parse(text)); } catch (e) { cb(new Error('invalid JSON body')); }
  });
}

const UNITS = { xray: 'xray', singbox: 'sing-box', nginx: 'nginx' };
const KINDS = ['xray', 'singbox'];

function runCmd(command) {
  const res = spawnSync(command, { shell: true, timeout: 15000, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? res.error.code : null,
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
  };
}

function readRaw(cfgPath) {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function listInbounds(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  return json(res, 200, { inbounds: allInbounds(c) });
}

function normalizeInbound(body) {
  const out = {
    tag: String(body.tag || '').trim(),
    protocol: body.protocol || 'vless',
    listen: body.listen || '127.0.0.1',
    port: Number(body.port),
    network: body.network || 'tcp',
    security: body.security || 'none',
  };
  if (body.sni) out.sni = String(body.sni);
  if (out.network === 'ws') out.wsPath = body.wsPath || '/ws';
  if (out.network === 'grpc') out.grpcService = body.grpcService || 'grpc';
  if (out.security === 'reality') {
    out.reality = {
      dest: String(body.realityDest || ''),
      serverNames: String(body.realityServerNames || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      privateKey: String(body.realityPrivateKey || ''),
      shortIds: String(body.realityShortIds || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    };
  }
  return out;
}

function inboundList(raw, kind) {
  raw[kind] = raw[kind] || {};
  if (!Array.isArray(raw[kind].inbounds)) raw[kind].inbounds = [];
  return raw[kind].inbounds;
}

function createInbound(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const kind = KINDS.includes(body.kind) ? body.kind : 'xray';
    const raw = readRaw(cfgPath);
    const inbound = normalizeInbound(body);
    if (!inbound.tag) return json(res, 400, { error: 'tag is required' });
    if (!Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) return json(res, 400, { error: 'port must be 1..65535' });
    const list = inboundList(raw, kind);
    if (list.some(function (ib) { return ib.tag === inbound.tag; })) return json(res, 409, { error: 'inbound tag already exists' });
    list.push(inbound);
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, kind: kind, inbound: inbound, warnings: check.warnings });
  });
}

function updateInbound(req, res, cfgPath, kind, tag) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    if (!KINDS.includes(kind)) return json(res, 400, { error: 'unknown kind' });
    const raw = readRaw(cfgPath);
    const list = inboundList(raw, kind);
    const idx = list.findIndex(function (ib) { return ib.tag === tag; });
    if (idx < 0) return json(res, 404, { error: 'inbound not found' });
    // keep fields the form does not manage (e.g. explicit clients) across edits
    const merged = Object.assign({}, list[idx], normalizeInbound(Object.assign({}, list[idx], body)));
    if (merged.tag !== tag && list.some(function (ib) { return ib.tag === merged.tag; })) return json(res, 409, { error: 'target tag already exists' });
    list[idx] = merged;
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, kind: kind, inbound: merged, warnings: check.warnings });
  });
}

function deleteInbound(res, cfgPath, kind, tag) {
  if (!KINDS.includes(kind)) return json(res, 400, { error: 'unknown kind' });
  const raw = readRaw(cfgPath);
  const list = inboundList(raw, kind);
  const next = list.filter(function (ib) { return ib.tag !== tag; });
  if (next.length === list.length) return json(res, 404, { error: 'inbound not found' });
  raw[kind].inbounds = next;
  saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true });
}

function listCores(res, cfgPath) {
  const raw = readRaw(cfgPath);
  const cores = KINDS.map(function (kind) {
    const probe = runCmd('systemctl is-active ' + UNITS[kind]);
    const enabled = raw[kind] ? raw[kind].enabled !== false : true;
    return {
      kind: kind,
      unit: UNITS[kind],
      enabled: enabled,
      active: probe.output === 'active',
      probe: probe.output || (probe.error || ''),
    };
  });
  cores.push({ kind: 'nginx', unit: 'nginx', enabled: true, active: runCmd('systemctl is-active nginx').output === 'active', probe: '' });
  return json(res, 200, { cores: cores });
}

function coreAction(res, cfgPath, kind, action) {
  const unit = UNITS[kind];
  if (!unit) return json(res, 400, { error: 'unknown core' });
  const result = runCmd('systemctl ' + action + ' ' + unit);
  record(cfgPath, 'core.' + action, unit);
  return json(res, result.ok ? 200 : 500, { ok: result.ok, unit: unit, action: action, output: result.output, error: result.error });
}

function setCoreEnabled(req, res, cfgPath, kind) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    if (!KINDS.includes(kind)) return json(res, 400, { error: 'unknown core' });
    const raw = readRaw(cfgPath);
    raw[kind] = raw[kind] || {};
    raw[kind].enabled = body.enabled !== false;
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, kind: kind, enabled: raw[kind].enabled });
  });
}

async function statsState(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const stats = await collectStats(c);
  return json(res, 200, { rows: combineStats(stats), errors: stats.errors });
}

async function syncStats(res, cfgPath) {
  const raw = readRaw(cfgPath);
  const c = derive(raw);
  const stats = await collectStats(c);
  const changed = mergeUsage(raw.users || [], stats);
  if (changed) saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true, changed: changed, rows: combineStats(stats), errors: stats.errors });
}

function logView(res, url) {
  const unit = url.searchParams.get('unit') || 'xray';
  const lines = Number(url.searchParams.get('lines') || 200);
  try {
    return json(res, 200, collectLogs(unit, lines));
  } catch (e) {
    return json(res, 400, { error: e.message, sources: logSources() });
  }
}

function getSettings(res, cfgPath) {
  const raw = readRaw(cfgPath);
  const server = raw.server || {};
  return json(res, 200, {
    server: {
      publicIp: server.publicIp || '',
      email: server.email || '',
      hasSecret: Boolean(server.secret),
      domains: server.domains || {},
      cert: server.cert || {},
    },
    ports: raw.ports || {},
    nginx: { mode: (raw.nginx && raw.nginx.mode) || 'http' },
    backups: { keep: raw.backups && raw.backups.keep != null ? raw.backups.keep : 20 },
    panels: raw.panels || {},
    apply: raw.apply || {},
  });
}

function putSettings(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    raw.server = raw.server || {};
    raw.server.domains = raw.server.domains || {};
    raw.server.cert = raw.server.cert || {};
    raw.ports = raw.ports || {};
    raw.nginx = raw.nginx || {};
    raw.panels = raw.panels || {};

    if (body.publicIp !== undefined) raw.server.publicIp = String(body.publicIp).trim();
    if (body.email !== undefined) raw.server.email = String(body.email).trim();
    if (body.webDomain !== undefined) raw.server.domains.web = String(body.webDomain).trim();
    if (body.certFile !== undefined) raw.server.cert.certFile = String(body.certFile).trim();
    if (body.keyFile !== undefined) raw.server.cert.keyFile = String(body.keyFile).trim();
    for (const key of ['http', 'https', 'nginxInternalTls']) {
      if (body[key] !== undefined) raw.ports[key] = Number(body[key]);
    }
    if (body.nginxMode !== undefined) raw.nginx.mode = String(body.nginxMode);
    if (body.backupKeep !== undefined) { raw.backups = raw.backups || {}; raw.backups.keep = Number(body.backupKeep); }
    if (body.xui) raw.panels.xui = Object.assign({}, raw.panels.xui, body.xui);
    if (body.sui) raw.panels.sui = Object.assign({}, raw.panels.sui, body.sui);

    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, warnings: check.warnings });
  });
}

function clientArray(kind, ib) {
  if (kind === 'singbox') {
    if (!Array.isArray(ib.users)) ib.users = [];
    return ib.users;
  }
  if (!Array.isArray(ib.clients)) ib.clients = [];
  return ib.clients;
}

function findInboundRaw(raw, kind, tag) {
  if (KINDS.indexOf(kind) < 0) return null;
  const list = (raw[kind] && raw[kind].inbounds) || [];
  return list.find(function (x) { return x.tag === tag; }) || null;
}

function listClients(res, cfgPath, kind, tag) {
  const raw = readRaw(cfgPath);
  const ib = findInboundRaw(raw, kind, tag);
  if (!ib) return json(res, 404, { error: 'inbound not found' });
  const clients = clientArray(kind, ib).map(function (c) {
    return { name: c.name || c.email || '', credential: c.id || c.uuid || c.password || '' };
  });
  return json(res, 200, { kind: kind, tag: tag, clients: clients });
}

function addClient(req, res, cfgPath, kind, tag) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    const ib = findInboundRaw(raw, kind, tag);
    if (!ib) return json(res, 404, { error: 'inbound not found' });
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'client name is required' });
    const list = clientArray(kind, ib);
    if (list.some(function (c) { return (c.name || c.email) === name; })) return json(res, 409, { error: 'client already exists' });
    const secret = (raw.server && raw.server.secret) || '';
    const protocol = ib.protocol || 'vless';
    let client;
    if (protocol === 'trojan') {
      client = { name: name, password: body.credential || derivePassword(secret, 'trojan', name, tag) };
    } else {
      const credential = body.credential || deriveUuid(secret, protocol, name, tag);
      client = { name: name };
      if (kind === 'singbox') client.uuid = credential;
      else { client.id = credential; client.email = name; if (body.flow) client.flow = body.flow; }
    }
    list.push(client);
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, client: client });
  });
}

function removeClient(res, cfgPath, kind, tag, name) {
  const raw = readRaw(cfgPath);
  const ib = findInboundRaw(raw, kind, tag);
  if (!ib) return json(res, 404, { error: 'inbound not found' });
  const list = clientArray(kind, ib);
  const next = list.filter(function (c) { return (c.name || c.email) !== name; });
  if (next.length === list.length) return json(res, 404, { error: 'client not found' });
  if (kind === 'singbox') ib.users = next;
  else ib.clients = next;
  saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true });
}

function sniRoutes(c) {
  const routes = [];
  if (c.nginx.mode !== 'stream') return routes;
  const internal = '127.0.0.1:' + (c.ports.nginxInternalTls || 8443);
  for (const s of c.nginx.sites || []) routes.push({ sni: s.serverName, backend: internal, kind: 'site' });
  for (const key of ['xui', 'sui']) {
    const p = c.panels[key];
    if (p && p.enabled && p.domain) routes.push({ sni: p.domain, backend: internal, kind: 'panel' });
  }
  for (const kind of ['xray', 'singbox']) {
    for (const ib of c[kind].inbounds || []) {
      if (!ib.sni) continue;
      const host = ib.listen && ib.listen !== '0.0.0.0' ? ib.listen : '127.0.0.1';
      routes.push({ sni: ib.sni, backend: host + ':' + ib.port, kind: kind });
    }
  }
  return routes;
}

function getNginx(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  return json(res, 200, {
    mode: c.nginx.mode,
    sites: c.nginx.sites || [],
    extraSites: c.nginx.extraSites || [],
    locations: c.nginx.locations || [],
    fallback: c.nginx.fallback || { upstream: '', root: '' },
    preview: generateNginx(c),
    sni: sniRoutes(c),
  });
}

function putNginx(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    raw.nginx = raw.nginx || {};
    if (body.mode) raw.nginx.mode = String(body.mode);
    if (Array.isArray(body.sites)) {
      raw.nginx.sites = body.sites.map(function (s) {
        const site = { serverName: String(s.serverName || '').trim(), index: String(s.index || 'index.html') };
        const upstream = String(s.upstream || '').trim();
        if (upstream) {
          site.upstream = upstream;
          if (s.subFilter) site.subFilter = true;
        } else {
          site.root = String(s.root || '/var/www/html');
        }
        return site;
      }).filter(function (s) { return s.serverName; });
    }
    if (Array.isArray(body.locations)) {
      raw.nginx.locations = body.locations.map(function (l) {
        return {
          serverName: String(l.serverName || '').trim(),
          path: String(l.path || '').trim(),
          upstream: String(l.upstream || '').trim(),
          exact: Boolean(l.exact),
          websocket: Boolean(l.websocket),
        };
      }).filter(function (l) { return l.serverName && l.path && l.upstream; });
    }
    if (body.fallback && typeof body.fallback === 'object') {
      raw.nginx.fallback = {
        upstream: String(body.fallback.upstream || '').trim(),
        root: String(body.fallback.root || '').trim(),
      };
    }
    if (Array.isArray(body.extraSites)) {
      raw.nginx.extraSites = body.extraSites.map(function (s) {
        return { serverName: String(s.serverName || '').trim(), upstream: String(s.upstream || '').trim() };
      }).filter(function (s) { return s.serverName && s.upstream; });
    }
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    record(cfgPath, 'nginx.update', 'mode=' + raw.nginx.mode);
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, warnings: check.warnings });
  });
}

function nginxTest(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const cmd = (c.apply && c.apply.validate && c.apply.validate.nginx) || 'nginx -t -c {file}';
  const tmp = cfgPath + '.nginx-test-' + process.pid + '.conf';
  try {
    fs.writeFileSync(tmp, generateNginx(c));
    const result = runCmd(cmd.split('{file}').join(tmp));
    record(cfgPath, 'nginx.test', result.ok ? 'ok' : 'failed');
    return json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output, error: result.error });
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function nginxReload(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const cmd = (c.apply && c.apply.reload && c.apply.reload.nginx) || 'systemctl reload nginx';
  const result = runCmd(cmd);
  record(cfgPath, 'nginx.reload', result.ok ? 'ok' : 'failed');
  return json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output, error: result.error });
}

function nodeBatch(res, cfgPath, action) {
  const c = derive(readRaw(cfgPath));
  const nodes = normalizeNodes(c);
  const result = probeBatch(nodes);
  const state = readNodeState(cfgPath);
  for (const row of result.results) {
    state[row.id] = { ok: row.ok, status: row.status, output: row.output, at: new Date().toISOString() };
  }
  writeNodeState(cfgPath, state);
  record(cfgPath, 'nodes.' + action + '-all', result.results.length + ' node(s)');
  return json(res, 200, result);
}

async function nodeBatchDeploy(req, res, cfgPath) {
  let body = {};
  try { body = await readJsonAsync(req); } catch (e) { body = {}; }
  const c = derive(readRaw(cfgPath));
  let nodes = normalizeNodes(c);
  if (body.group) nodes = nodes.filter(function (n) { return n.group === body.group; });
  if (Array.isArray(body.ids) && body.ids.length) nodes = nodes.filter(function (n) { return body.ids.includes(n.id); });
  const result = deployBatch(cfgPath, nodes, { force: body.force === true });
  record(cfgPath, 'nodes.deploy-all', nodes.length + ' node(s), ok=' + result.ok);
  return json(res, 200, result);
}

function readJsonAsync(req) {
  return new Promise(function (resolve, reject) {
    readJson(req, function (err, body) { if (err) reject(err); else resolve(body); });
  });
}

function backupKeep(cfgPath) {
  const raw = readRaw(cfgPath);
  return raw && raw.backups && raw.backups.keep != null ? Number(raw.backups.keep) : 20;
}

function accountsPayload(cfgPath) {
  const raw = readRaw(cfgPath);
  return { users: accountsOf(raw, {}).map(function (u) { return { username: u.username, role: u.role }; }) };
}

function saveAccount(req, res, cfgPath, method, pathName) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    raw.ui = raw.ui || {};
    if (!Array.isArray(raw.ui.users)) raw.ui.users = [];
    const users = raw.ui.users;
    const username = String(pathName || body.username || '').trim();
    if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'username must be 3-32 chars of A-Z a-z 0-9 _ -' });
    const role = body.role === 'viewer' ? 'viewer' : 'admin';
    const idx = users.findIndex(function (u) { return String(u.username) === username; });
    if (method === 'POST') {
      if (idx >= 0) return json(res, 400, { error: 'username already exists' });
      if (!body.password) return json(res, 400, { error: 'password is required' });
      users.push({ username: username, role: role, hash: hashPassword(String(body.password)), addedAt: new Date().toISOString() });
    } else {
      if (idx < 0) return json(res, 404, { error: 'account not found' });
      const admins = users.filter(function (u) { return u.role !== 'viewer'; });
      if (users[idx].role !== 'viewer' && role === 'viewer' && admins.length <= 1) {
        return json(res, 400, { error: 'cannot demote the last admin' });
      }
      users[idx].role = role;
      if (body.password) users[idx].hash = hashPassword(String(body.password));
    }
    record(cfgPath, 'account.' + (method === 'POST' ? 'add' : 'update'), username + ' role=' + role);
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, users: accountsPayload(cfgPath).users });
  });
}

function deleteAccount(res, cfgPath, username) {
  const raw = readRaw(cfgPath);
  const users = raw.ui && Array.isArray(raw.ui.users) ? raw.ui.users : [];
  const idx = users.findIndex(function (u) { return String(u.username) === username; });
  if (idx < 0) return json(res, 404, { error: 'account not found' });
  const admins = users.filter(function (u) { return u.role !== 'viewer'; });
  if (users[idx].role !== 'viewer' && admins.length <= 1) return json(res, 400, { error: 'cannot delete the last admin' });
  users.splice(idx, 1);
  record(cfgPath, 'account.delete', username);
  saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true, users: accountsPayload(cfgPath).users });
}

function createBackupHandler(res, cfgPath) {
  try {
    const name = createBackup(cfgPath, 'manual');
    pruneBackups(cfgPath, backupKeep(cfgPath));
    record(cfgPath, 'backup.create', name);
    return json(res, 200, { ok: true, name: name, backups: listBackups(cfgPath) });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

function downloadBackup(res, cfgPath, name) {
  try {
    const text = readBackup(cfgPath, name);
    return send(res, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="' + name + '"',
      'cache-control': 'no-store',
    }, text);
  } catch (e) {
    return json(res, 404, { error: e.message });
  }
}

function restoreBackupHandler(res, cfgPath, name) {
  try {
    const text = readBackup(cfgPath, name);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return json(res, 400, { error: 'backup is not valid JSON' }); }
    const check = validateConfig(derive(parsed));
    if (check.errors.length) return json(res, 400, { error: 'backup fails validation', errors: check.errors });
    const result = restoreBackup(cfgPath, name);
    record(cfgPath, 'backup.restore', name);
    return json(res, 200, { ok: true, restored: name, safety: result.safety, warnings: check.warnings });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

function removeBackup(res, cfgPath, name) {
  try {
    deleteBackup(cfgPath, name);
    record(cfgPath, 'backup.delete', name);
    return json(res, 200, { ok: true, backups: listBackups(cfgPath) });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

function nodeStatePath(cfgPath) { return cfgPath + '.nodes-state.json'; }

function readNodeState(cfgPath) {
  try { return JSON.parse(fs.readFileSync(nodeStatePath(cfgPath), 'utf8')); } catch (e) { return {}; }
}

function writeNodeState(cfgPath, state) {
  try { fs.writeFileSync(nodeStatePath(cfgPath), JSON.stringify(state, null, 2) + '\n'); } catch (e) { /* best effort */ }
}

function getNodes(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const state = readNodeState(cfgPath);
  const nodes = normalizeNodes(c).map(function (n) {
    return Object.assign({}, n, { last: state[n.id] || null });
  });
  return json(res, 200, { nodes: nodes });
}

function saveNode(req, res, cfgPath, id) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    if (!Array.isArray(raw.nodes)) raw.nodes = [];
    const node = {
      id: String(body.id || body.name || body.host || '').trim(),
      name: String(body.name || body.host || '').trim(),
      host: String(body.host || '').trim(),
      user: String(body.user || 'root').trim(),
      port: Number(body.port || 22),
      key: String(body.key || '').trim(),
      group: String(body.group || 'default').trim() || 'default',
      configPath: String(body.configPath || '/etc/uniproxy/config.json').trim(),
    };
    if (!node.id || !node.host) return json(res, 400, { error: 'id and host are required' });
    if (!node.configPath.startsWith('/')) return json(res, 400, { error: 'configPath must be absolute' });
    const idx = id ? raw.nodes.findIndex(function (n) { return String(n.id || n.name || n.host) === id; }) : -1;
    if (id && idx < 0) return json(res, 404, { error: 'node not found' });
    if (idx >= 0) raw.nodes[idx] = node; else raw.nodes.push(node);
    record(cfgPath, 'node.' + (idx >= 0 ? 'update' : 'add'), node.id + ' ' + node.host);
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, node: node });
  });
}

function deleteNode(res, cfgPath, id) {
  const raw = readRaw(cfgPath);
  const list = Array.isArray(raw.nodes) ? raw.nodes : [];
  const next = list.filter(function (n) { return String(n.id || n.name || n.host) !== id; });
  if (next.length === list.length) return json(res, 404, { error: 'node not found' });
  raw.nodes = next;
  record(cfgPath, 'node.delete', id);
  saveRaw(cfgPath, raw);
  return json(res, 200, { ok: true });
}

async function nodeAct(req, res, cfgPath, id, action) {
  const c = derive(readRaw(cfgPath));
  const node = normalizeNodes(c).find(function (n) { return n.id === id; });
  if (!node) return json(res, 404, { error: 'node not found' });
  const state = readNodeState(cfgPath);
  if (action === 'probe') {
    const result = probe(node);
    state[id] = { ok: result.ok, status: result.status, output: result.output, at: new Date().toISOString() };
    writeNodeState(cfgPath, state);
    record(cfgPath, 'node.probe', id + ' ' + (result.ok ? 'ok' : 'failed'));
    return json(res, result.ok ? 200 : 500, result);
  }
  const result = deploy(cfgPath, node);
  record(cfgPath, 'node.deploy', id + ' ' + (result.ok ? 'ok' : 'failed'));
  return json(res, result.ok ? 200 : 500, result);
}

function getCerts(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  let plan = '';
  let planError = '';
  try { plan = buildCommand(c, 'issue').argv.join(' '); } catch (e) { planError = e.message; }
  return json(res, 200, { status: certStatus(c), config: normalizeCerts(c), plan: plan, planError: planError });
}

function putCerts(req, res, cfgPath) {
  readJson(req, function (err, body) {
    if (err) return json(res, 400, { error: err.message });
    const raw = readRaw(cfgPath);
    raw.certs = raw.certs || {};
    if (body.provider) raw.certs.provider = String(body.provider);
    if (body.challenge) raw.certs.challenge = String(body.challenge);
    if (body.webroot !== undefined) raw.certs.webroot = String(body.webroot);
    if (body.email !== undefined) raw.certs.email = String(body.email);
    if (body.staging !== undefined) raw.certs.staging = Boolean(body.staging);
    if (body.domains !== undefined) {
      const list = String(body.domains).split(',').map(function (d) { return d.trim(); }).filter(Boolean);
      const bad = list.filter(function (d) { return !validDomain(d); });
      if (bad.length) return json(res, 400, { error: 'invalid domain(s): ' + bad.join(', ') });
      raw.certs.domains = list;
    }
    const check = validateConfig(derive(raw));
    if (check.errors.length) return json(res, 400, { error: 'validation failed', errors: check.errors });
    record(cfgPath, 'certs.update', 'provider=' + raw.certs.provider);
    saveRaw(cfgPath, raw);
    return json(res, 200, { ok: true, warnings: check.warnings });
  });
}

function certAction(res, cfgPath, mode) {
  const c = derive(readRaw(cfgPath));
  const result = issue(c, { mode: mode });
  record(cfgPath, 'certs.' + mode, result.ok ? 'ok' : 'failed');
  return json(res, result.ok ? 200 : 500, result);
}

function getAlerts(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const alerts = collectAlerts(c, cfgPath);
  return json(res, 200, {
    alerts: alerts,
    channels: { webhook: Boolean(c.alerts && c.alerts.webhook), command: Boolean(c.alerts && c.alerts.command) },
    cooldownHours: (c.alerts && c.alerts.cooldownHours) || 12,
  });
}

async function notifyAlerts(res, cfgPath) {
  const c = derive(readRaw(cfgPath));
  const alerts = collectAlerts(c, cfgPath);
  const stateFile = cfgPath + '.alerts-state.json';
  const result = await notify(c, alerts, { state: loadState(stateFile), stateFile: stateFile });
  record(cfgPath, 'alerts.notify', 'sent=' + result.sent + ' skipped=' + result.skipped);
  return json(res, 200, Object.assign({ alerts: alerts }, result));
}

function record(cfgPath, action, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), action: action, detail: detail || '' }) + '\n';
  try { fs.appendFileSync(cfgPath + '.audit.log', line); } catch (e) { /* audit is best effort */ }
}

function readAudit(cfgPath, limit) {
  try {
    const text = fs.readFileSync(cfgPath + '.audit.log', 'utf8').trim();
    if (!text) return [];
    const lines = text.split('\n').slice(-Math.min(Math.max(limit, 1), 500));
    return lines.map(function (l) { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  } catch (e) { return []; }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

function json(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj, null, 2));
}

function parseCookies(header) {
  const out = {};
  header.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sign(exp, key) {
  const mac = crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  return exp + '.' + mac;
}

function verifySession(value, key) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const exp = Number(parts[0]);
  const username = parts[1];
  const role = parts[2];
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  if (role !== 'admin' && role !== 'viewer') return null;
  if (!USERNAME_RE.test(username)) return null;
  const payload = exp + '.' + username + '.' + role;
  return safeEqual(parts[3], sign(payload, key).split('.').pop()) ? { role: role, username: username, exp: exp } : null;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function clearCookies(cookiePath) {
  const p = cookiePath || '/';
  return [SESSION_COOKIE + '=; Max-Age=0; Path=' + p, CSRF_COOKIE + '=; Max-Age=0; Path=' + p];
}

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function loginPage(message, action) {
  const css = '*{box-sizing:border-box}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;background:radial-gradient(at 25% 20%,#152038 0%,#0d1117 60%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans","PingFang SC","Microsoft YaHei",sans-serif;color:#ffffffeb}' +
    'body.light{background:linear-gradient(135deg,#eef2ff 0%,#fdf2f8 50%,#ecfeff 100%);color:#1f2430}' +
    'body.ultra{background:radial-gradient(at 25% 20%,#0a0a1a 0%,#000 60%);color:#f2f2f3}' +
    '.bg-blobs,.bg-grid{position:fixed;inset:0;pointer-events:none;overflow:hidden}' +
    '.bg-blobs::before,.bg-blobs::after{content:"";position:absolute;border-radius:50%;filter:blur(100px);will-change:transform}' +
    '.bg-blobs::before{width:70vw;height:70vw;max-width:900px;max-height:900px;background:radial-gradient(circle,rgba(96,165,250,.42),transparent 65%);top:-25vw;left:-20vw;animation:blobA 24s ease-in-out infinite alternate}' +
    '.bg-blobs::after{width:70vw;height:70vw;max-width:900px;max-height:900px;background:radial-gradient(circle,rgba(236,72,153,.32),transparent 65%);bottom:-25vw;right:-20vw;animation:blobB 30s ease-in-out infinite alternate}' +
    'body.light .bg-blobs::before{background:radial-gradient(circle,rgba(99,102,241,.45),transparent 65%)}' +
    'body.light .bg-blobs::after{background:radial-gradient(circle,rgba(236,72,153,.35),transparent 65%)}' +
    'body.ultra .bg-blobs::before{background:radial-gradient(circle,rgba(99,102,241,.28),transparent 65%)}' +
    '@keyframes blobA{0%{transform:translate(0) scale(1)}50%{transform:translate(18vw,10vh) scale(1.15)}100%{transform:translate(34vw,22vh) scale(1.25)}}' +
    '@keyframes blobB{0%{transform:translate(0) scale(1)}50%{transform:translate(-16vw,-10vh) scale(1.12)}100%{transform:translate(-30vw,-22vh) scale(1.2)}}' +
    '.bg-grid{background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:48px 48px;background-position:50%;-webkit-mask-image:radial-gradient(#000 30%,transparent 75%);mask-image:radial-gradient(#000 30%,transparent 75%)}' +
    'body.light .bg-grid{background-image:linear-gradient(rgba(99,102,241,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.08) 1px,transparent 1px)}' +
    '.card{position:relative;z-index:2;width:100%;max-width:400px;background:rgba(28,30,34,.55);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:40px 32px 28px;box-shadow:0 1px 3px rgba(0,0,0,.4),0 20px 60px rgba(59,130,246,.22);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%)}' +
    'body.light .card{background:rgba(255,255,255,.72);border-color:rgba(255,255,255,.6);box-shadow:0 1px 3px rgba(0,0,0,.04),0 18px 50px rgba(99,102,241,.18)}' +
    'body.ultra .card{background:rgba(15,17,28,.6);border-color:rgba(255,255,255,.06)}' +
    '.tools{position:fixed;top:16px;right:16px;display:flex;gap:8px;z-index:10}' +
    '.tools button{width:38px;height:38px;border-radius:50%;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.1);color:#ffffffb3;font-size:12px;cursor:pointer}' +
    'body.light .tools button{background:rgba(255,255,255,.8);border-color:rgba(0,0,0,.08);color:#4b5563}' +
    '.logo{display:block;text-align:center;font-size:28px;font-weight:700;letter-spacing:1.5px;background:linear-gradient(135deg,#60a5fa,#1d4ed8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;box-shadow:none;padding:0;height:auto;border-radius:0}' +
    '.logo::after{content:"";display:block;width:40px;height:3px;margin:8px auto 0;border-radius:2px;background:linear-gradient(90deg,#60a5fa,#1d4ed8)}' +
    'body.light .logo{background:linear-gradient(135deg,#6366f1,#ec4899);-webkit-background-clip:text;background-clip:text}' +
    'h1{font-size:32px;line-height:1.2;font-weight:700;text-align:center;margin:12px 0 6px;letter-spacing:.3px}' +
    '.sub{text-align:center;font-size:13px;color:#ffffff8c;margin:0 0 22px}' +
    'body.light .sub{color:#0000008c}body.ultra .sub{color:#ffffff70}' +
    'label{display:block;font-size:13px;font-weight:500;color:#ffffffd9;margin:16px 0 7px}' +
    'body.light label{color:#1f2430}' +
    'input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:#1c1e22;color:#ffffffeb;font-size:14px;outline:none}' +
    'body.light input{background:#fff;border-color:#d7dce7;color:#1f2430}' +
    'body.ultra input{background:#101013;border-color:rgba(255,255,255,.06)}' +
    'input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.18)}' +
    'button.submit{width:100%;margin-top:22px;padding:11px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}' +
    'button.submit:hover{filter:brightness(1.08)}.err{color:#ff7b72;background:rgba(255,123,114,.1);border:1px solid rgba(255,123,114,.25);padding:8px 10px;border-radius:8px;font-size:12px;margin:0 0 8px}' +
    'body.light .err{background:#fff1f0;border-color:#ffccc7;color:#b42318}' +
    '@media (max-width:480px){.card{padding:32px 20px 24px}.tools{top:10px;right:10px}}';
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>U-UI login</title><style>' + css + '</style></head><body>' +
    '<div class="bg-blobs"></div><div class="bg-grid"></div>' +
    '<form class="card" method="post" action="' + (action || '/login') + '">' +
    '<div class="tools"><button type="button" id="langBtn">EN</button><button type="button" id="themeBtn">☀</button></div>' +
    '<div class="logo">U-UI</div><h1 id="title">欢迎回来</h1><p class="sub" id="subtitle">登录 U-UI 控制面板</p>' +
    (message ? '<p class="err">' + message + '</p>' : '') +
    '<label id="userLabel">用户名</label><input type="text" name="username" id="username" placeholder="请输入用户名" autofocus>' +
    '<label id="passLabel">密码</label><input type="password" name="password" id="password" placeholder="请输入密码">' +
    '<button class="submit" type="submit" id="submitBtn">登录</button></form>' +
    '<scr' + 'ipt>(function(){' +
    'var lang="zh";try{if(localStorage.getItem("uui-lang")==="en")lang="en";}catch(e){}' +
    'var theme="dark";try{var tv=localStorage.getItem("uui-theme");if(tv==="light"||tv==="ultra")theme=tv;}catch(e){}' +
    'var dict={zh:{title:"欢迎回来",subtitle:"登录 u-ui 控制面板",user:"用户名",userPh:"请输入用户名",pass:"密码",passPh:"请输入密码",submit:"登录"},' +
    'en:{title:"Welcome back",subtitle:"Sign in to u-ui",user:"Username",userPh:"Enter your username",pass:"Password",passPh:"Enter your password",submit:"Sign in"}};' +
    'function apply(){var d=dict[lang];document.getElementById("title").textContent=d.title;document.getElementById("subtitle").textContent=d.subtitle;' +
    'document.getElementById("userLabel").textContent=d.user;document.getElementById("username").placeholder=d.userPh;document.getElementById("passLabel").textContent=d.pass;' +
    'document.getElementById("password").placeholder=d.passPh;document.getElementById("submitBtn").textContent=d.submit;' +
    'document.getElementById("langBtn").textContent=lang==="zh"?"EN":"中文";document.documentElement.lang=lang;' +
    'document.body.classList.toggle("light",theme==="light");document.body.classList.toggle("ultra",theme==="ultra");document.getElementById("themeBtn").textContent=theme==="light"?"☀":(theme==="ultra"?"🌑":"☾");}' +
    'document.getElementById("langBtn").onclick=function(){lang=lang==="zh"?"en":"zh";try{localStorage.setItem("uui-lang",lang);}catch(e){}apply();};' +
    'document.getElementById("themeBtn").onclick=function(){theme=theme==="dark"?"light":(theme==="light"?"ultra":"dark");try{localStorage.setItem("uui-theme",theme);}catch(e){}apply();};' +
    'apply();})();</scr' + 'ipt></body></html>';
}