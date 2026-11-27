import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUi } from '../src/ui/server.js';
import { parseXrayStatNames, parseClashConnections, mergeUsage } from '../src/stats.js';
import { shouldSend, markSent, alertsFromDoctor, alertsFromPorts } from '../src/alerts.js';

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map(function (c) { return c.split(';')[0]; }).join('; ');
}

async function login(inst) {
  const res = await fetch(inst.url + '/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=secret', redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const cookie = cookieHeader(res);
  return { cookie: cookie, csrf: /uui_csrf=([^;]+)/.exec(cookie)[1] };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uui-'));
  const cfgPath = path.join(dir, 'config.json');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify(example, null, 2));
  return { dir: dir, cfgPath: cfgPath };
}

test('u-ui: auth, users, config and csrf', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const base = inst.url;
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const bad = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nope', redirect: 'manual' });
    assert.equal(bad.status, 401);

    const auth = await login(inst);
    const state = await fetch(base + '/api/state', { headers: { cookie: auth.cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).csrf, auth.csrf);

    const created = await fetch(base + '/api/users', {
      method: 'POST', headers: { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice', inbounds: ['xray-vless-reality'], dataLimitBytes: 1073741824 }),
    });
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).users.length, 1);

    const noCsrf = await fetch(base + '/api/users', { method: 'POST', headers: { cookie: auth.cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403);

    const badJson = await fetch(base + '/api/config', { method: 'PUT', headers: { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ json: '{' }) });
    assert.equal(badJson.status, 400);

    const removed = await fetch(base + '/api/users/alice', { method: 'DELETE', headers: { cookie: auth.cookie, 'x-uui-csrf': auth.csrf } });
    assert.equal(removed.status, 200);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('u-ui: inbound CRUD across both cores and core control', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const base = inst.url;
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const created = await fetch(base + '/api/inbounds', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ kind: 'singbox', tag: 'sb-test', protocol: 'vless', listen: '127.0.0.1', port: 2053, network: 'ws', security: 'tls', sni: 'sb.example.com', wsPath: '/sb' }),
    });
    assert.equal(created.status, 200);
    let raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.ok(raw.singbox.inbounds.some(function (ib) { return ib.tag === 'sb-test'; }));

    const listed = await fetch(base + '/api/state', { headers: { cookie: auth.cookie } });
    const listedJson = await listed.json();
    const found = listedJson.inbounds.find(function (ib) { return ib.tag === 'sb-test'; });
    assert.equal(found.kind, 'singbox');
    assert.equal(found.network, 'ws');

    const updated = await fetch(base + '/api/inbounds/singbox/sb-test', { method: 'PUT', headers: headers, body: JSON.stringify({ port: 2054 }) });
    assert.equal(updated.status, 200);
    raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.singbox.inbounds.find(function (ib) { return ib.tag === 'sb-test'; }).port, 2054);

    const dup = await fetch(base + '/api/inbounds', { method: 'POST', headers: headers, body: JSON.stringify({ kind: 'singbox', tag: 'sb-test', port: 2055 }) });
    assert.equal(dup.status, 409);

    const badPort = await fetch(base + '/api/inbounds', { method: 'POST', headers: headers, body: JSON.stringify({ kind: 'xray', tag: 'x-test', port: 99999 }) });
    assert.equal(badPort.status, 400);

    const cores = await fetch(base + '/api/cores', { headers: { cookie: auth.cookie } });
    assert.equal(cores.status, 200);
    const coresJson = await cores.json();
    assert.equal(coresJson.cores.length, 3);

    const toggle = await fetch(base + '/api/cores/singbox', { method: 'PUT', headers: headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(toggle.status, 200);
    raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.singbox.enabled, false);

    const deleted = await fetch(base + '/api/inbounds/singbox/sb-test', { method: 'DELETE', headers: headers });
    assert.equal(deleted.status, 200);
    raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.singbox.inbounds.some(function (ib) { return ib.tag === 'sb-test'; }), false);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('stats: parse xray and clash counters, merge usage', function () {
  const xray = parseXrayStatNames([
    { name: 'user>>>alice>>>traffic>>>uplink', value: '100' },
    { name: 'user>>>alice>>>traffic>>>downlink', value: '250' },
    { name: 'user>>>bob>>>traffic>>>uplink', value: '7' },
    { name: 'inbound>>>x>>>traffic>>>uplink', value: '999' },
  ]);
  assert.equal(xray.alice.upload, 100);
  assert.equal(xray.alice.download, 250);
  assert.equal(xray.bob.upload, 7);
  assert.equal(xray.inbound, undefined);

  const clash = parseClashConnections({ connections: [
    { metadata: { user: 'alice' }, upload: 10, download: 20 },
    { metadata: { email: 'bob' }, upload: 1, download: 2 },
    { metadata: {}, upload: 5, download: 5 },
  ] });
  assert.equal(clash.alice.upload, 10);
  assert.equal(clash.bob.download, 2);
  assert.equal(Object.keys(clash).length, 2);

  const users = [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }];
  const changed = mergeUsage(users, { xray: { alice: { upload: 100, download: 250 } }, singbox: { alice: { upload: 10, download: 20 } } });
  // users with no counters are left untouched rather than written as 0/0
  assert.equal(changed, 1);
  assert.deepEqual(users[0].usage, { upload: 110, download: 270 });
  assert.equal(users[1].usage, undefined);
  assert.equal(users[2].usage, undefined);
});

test('u-ui: clients, settings, stats and logs endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const base = inst.url;
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const settings = await fetch(base + '/api/settings', { headers: { cookie: auth.cookie } });
    assert.equal(settings.status, 200);

    const putSettings = await fetch(base + '/api/settings', { method: 'PUT', headers: headers, body: JSON.stringify({ publicIp: '198.51.100.7', nginxMode: 'http' }) });
    assert.equal(putSettings.status, 200);
    let raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.server.publicIp, '198.51.100.7');
    assert.equal(raw.nginx.mode, 'http');

    const added = await fetch(base + '/api/inbounds/xray/xray-vless-reality/clients', { method: 'POST', headers: headers, body: JSON.stringify({ name: 'dave' }) });
    assert.equal(added.status, 200);
    raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    const ib = raw.xray.inbounds.find(function (x) { return x.tag === 'xray-vless-reality'; });
    assert.ok(ib.clients.some(function (c) { return c.name === 'dave' && c.id; }));

    const listed = await fetch(base + '/api/inbounds/xray/xray-vless-reality/clients', { headers: { cookie: auth.cookie } });
    const listedJson = await listed.json();
    assert.ok(listedJson.clients.some(function (c) { return c.name === 'dave'; }));

    const removed = await fetch(base + '/api/inbounds/xray/xray-vless-reality/clients/dave', { method: 'DELETE', headers: headers });
    assert.equal(removed.status, 200);

    const stats = await fetch(base + '/api/stats', { headers: { cookie: auth.cookie } });
    assert.equal(stats.status, 200);
    assert.ok(Array.isArray((await stats.json()).rows));

    const logs = await fetch(base + '/api/logs?unit=xray', { headers: { cookie: auth.cookie } });
    assert.equal(logs.status, 200);

    const badLogs = await fetch(base + '/api/logs?unit=nope', { headers: { cookie: auth.cookie } });
    assert.equal(badLogs.status, 400);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('u-ui: nginx management and viewer role', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret', viewerPassword: 'look' });
  try {
    const base = inst.url;

    const viewerLogin = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=look', redirect: 'manual' });
    assert.equal(viewerLogin.status, 303);
    const viewerCookie = cookieHeader(viewerLogin);
    const viewerState = await fetch(base + '/api/state', { headers: { cookie: viewerCookie } });
    assert.equal((await viewerState.json()).role, 'viewer');
    const viewerWrite = await fetch(base + '/api/users', { method: 'POST', headers: { cookie: viewerCookie, 'x-uui-csrf': /uui_csrf=([^;]+)/.exec(viewerCookie)[1], 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    assert.equal(viewerWrite.status, 403);

    const auth = await login(inst);
    const adminState = await fetch(base + '/api/state', { headers: { cookie: auth.cookie } });
    assert.equal((await adminState.json()).role, 'admin');

    const nginx = await fetch(base + '/api/nginx', { headers: { cookie: auth.cookie } });
    assert.equal(nginx.status, 200);
    const nginxJson = await nginx.json();
    assert.ok(nginxJson.preview.includes('server {') || nginxJson.preview.includes('server{'));

    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };
    const saved = await fetch(base + '/api/nginx', { method: 'PUT', headers: headers, body: JSON.stringify({ mode: 'http', sites: [{ serverName: 'a.example.com', root: '/srv/www' }], extraSites: [{ serverName: 'b.example.com', upstream: '127.0.0.1:8787' }] }) });
    assert.equal(saved.status, 200);
    const raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.nginx.mode, 'http');
    assert.equal(raw.nginx.sites[0].serverName, 'a.example.com');
    assert.equal(raw.nginx.extraSites[0].upstream, '127.0.0.1:8787');

    const tested = await fetch(base + '/api/nginx/test', { method: 'POST', headers: headers });
    assert.ok([200, 500].includes(tested.status));
    const reloaded = await fetch(base + '/api/nginx/reload', { method: 'POST', headers: headers });
    assert.ok([200, 500].includes(reloaded.status));

    const audit = await fetch(base + '/api/audit?limit=50', { headers: { cookie: auth.cookie } });
    assert.equal(audit.status, 200);
    const auditJson = await audit.json();
    assert.ok(auditJson.entries.length > 0);
    assert.ok(auditJson.entries.some(function (e) { return e.action === 'nginx.update'; }));
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('alerts: cooldown, doctor findings and port conflicts', function () {
  const now = Date.parse('2027-01-01T00:00:00Z');
  const state = {};
  assert.equal(shouldSend(state, 'k', now, 3600000), true);
  markSent(state, 'k', now);
  assert.equal(shouldSend(state, 'k', now + 1000, 3600000), false);
  assert.equal(shouldSend(state, 'k', now + 3600000, 3600000), true);

  const report = { results: [
    { level: 'ok', title: 'config', detail: '' },
    { level: 'warn', title: 'domains', detail: 'still example' },
    { level: 'fail', title: 'server.publicIp', detail: 'placeholder' },
  ] };
  const fromDoctor = alertsFromDoctor(report);
  assert.equal(fromDoctor.length, 2);
  assert.equal(fromDoctor[1].level, 'fail');

  const ports = alertsFromPorts({ ports: {}, panels: {}, nginx: { mode: 'http', sites: [] }, xray: { inbounds: [], stats: false }, singbox: { inbounds: [], clashApi: false } });
  assert.ok(Array.isArray(ports));
});

test('u-ui: alerts endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const list = await fetch(inst.url + '/api/alerts', { headers: { cookie: auth.cookie } });
    assert.equal(list.status, 200);
    const listJson = await list.json();
    assert.ok(Array.isArray(listJson.alerts));
    assert.equal(typeof listJson.channels.webhook, 'boolean');

    const sent = await fetch(inst.url + '/api/alerts/notify', { method: 'POST', headers: { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sent.status, 200);
    const sentJson = await sent.json();
    assert.equal(typeof sentJson.sent, 'number');
    assert.equal(typeof sentJson.skipped, 'number');
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});
