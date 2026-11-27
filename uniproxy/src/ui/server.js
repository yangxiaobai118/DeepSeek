import http from 'node:http';
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
import { listBackups, createBackup, readBackup, deleteBackup, restoreBackup, pruneBackups } from '../backups.js';
import { buildSubscriptions } from '../subscribe.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { buildPlan, formatPlan, applyPlan } from '../apply.js';

const PAGE = new URL('./page.html', import.meta.url);
const SESSION_COOKIE = 'uui_session';
const CSRF_COOKIE = 'uui_csrf';
const SESSION_TTL = 8 * 3600 * 1000;

export function startUi(cfgPath, port = 8788, options = {}) {
  const abs = path.resolve(cfgPath);
  const password = options.password || process.env.UNIPROXY_UI_PASSWORD || readPassword(abs, 'password');
  const viewerPassword = options.viewerPassword || process.env.UNIPROXY_UI_VIEWER_PASSWORD || readPassword(abs, 'viewerPassword');
  if (!password) {
    throw new Error(
      'u-ui needs a password: set UNIPROXY_UI_PASSWORD or add "ui": { "password": "..." } to the config'
    );
  }
  const host = options.host || '127.0.0.1';
  const attempts = new Map();

  function secret() {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return crypto.createHash('sha256').update(password + '|' + (raw.server && raw.server.secret ? raw.server.secret : '')).digest();
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
    const cookies = parseCookies(req.headers.cookie || '');

    if (url.pathname === '/login') {
      if (req.method === 'POST') return doLogin(req, res, cookies);
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, loginPage(''));
    }
    if (url.pathname === '/logout') {
      return send(res, 303, { location: '/login', 'set-cookie': clearCookies() }, '');
    }

    const session = verifySession(cookies[SESSION_COOKIE], secret());
    const authed = Boolean(session);
    if (!authed && url.pathname !== '/login') {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      return send(res, 303, { location: '/login' }, '');
    }

    if (url.pathname === '/') {
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, fs.readFileSync(PAGE, 'utf8'));
    }

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && cookies[CSRF_COOKIE]) {
      if (req.headers['x-uui-csrf'] !== cookies[CSRF_COOKIE]) return json(res, 403, { error: 'bad csrf token' });
    }
    if (mutating && session.role !== 'admin') return json(res, 403, { error: 'read-only role: viewer cannot modify' });

    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state(abs, cookies[CSRF_COOKIE], session.role));
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
      const role = safeEqual(supplied, password) ? 'admin' : (viewerPassword && safeEqual(supplied, viewerPassword) ? 'viewer' : '');
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
        SESSION_COOKIE + '=' + encodeURIComponent(sign(exp + '.' + role, secret())) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL / 1000),
        CSRF_COOKIE + '=' + csrf + '; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL / 1000),
      ];
      return send(res, 303, { location: '/', 'set-cookie': cookie }, '');
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

function state(cfgPath, csrf, role) {
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
        return { serverName: String(s.serverName || '').trim(), root: String(s.root || '/var/www/html'), index: String(s.index || 'index.html') };
      }).filter(function (s) { return s.serverName; });
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
  if (parts.length < 3) return null;
  const role = parts[1];
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  if (role !== 'admin' && role !== 'viewer') return null;
  const payload = parts[0] + '.' + role;
  const mac = parts.slice(2).join('.');
  return safeEqual(mac, sign(payload, key).split('.').pop()) ? { role: role, exp: exp } : null;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function clearCookies() {
  return [SESSION_COOKIE + '=; Max-Age=0; Path=/', CSRF_COOKIE + '=; Max-Age=0; Path=/'];
}

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function loginPage(message) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>u-ui login</title>' +
    '<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    'form{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:28px;width:300px}' +
    'h1{font-size:16px;margin:0 0 16px}input{width:100%;padding:10px;margin:0 0 12px;border-radius:6px;border:1px solid #2a2f3a;background:#0b0d12;color:#e6e6e6;box-sizing:border-box}' +
    'button{width:100%;padding:10px;border:0;border-radius:6px;background:#3b6cf6;color:#fff;font-size:14px;cursor:pointer}.err{color:#ff6b6b;font-size:12px;margin:0 0 12px}</style></head><body>' +
    '<form method="post" action="/login"><h1>u-ui</h1>' +
    (message ? '<p class="err">' + message + '</p>' : '') +
    '<input type="password" name="password" placeholder="panel password" autofocus>' +
    '<button type="submit">Sign in</button></form></body></html>';
}
