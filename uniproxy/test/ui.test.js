import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUi } from '../src/ui/server.js';
import { parseXrayStatNames, parseClashConnections, mergeUsage } from '../src/stats.js';
import { shouldSend, markSent, alertsFromDoctor, alertsFromPorts } from '../src/alerts.js';
import { buildCommand, validDomain, certStatus } from '../src/certs.js';
import { normalizeNodes, probeCommand, deployCommands, deploy, deployBatch, probeBatch, localChecksum } from '../src/nodes.js';
import { protocolList, validateChoice, defaultCore } from '../src/protocols.js';
import { listBackups, createBackup, restoreBackup, readBackup, deleteBackup, pruneBackups } from '../src/backups.js';
import { runMenu, renderMenu, box, buildMenu, unitFiles, installSystem, installPlan, uninstallSystem } from '../src/menu.js';
import { randomPassword, randomPort, runSetup } from '../src/setup.js';
import { verifyPassword } from '../src/auth.js';
import { syncUnitPorts } from '../src/units.js';

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

test('certs: command building, domain validation and status', function () {
  const base = { server: { email: 'a@b.co', domains: { web: 'example.com' }, cert: { certFile: '/nope/full.pem', keyFile: '/nope/key.pem' } }, certs: { domains: ['example.com'] } };
  const webroot = buildCommand(base, 'issue');
  assert.equal(webroot.argv[0], 'certbot');
  assert.ok(webroot.argv.includes('--webroot'));
  assert.ok(webroot.argv.includes('-d'));
  assert.ok(webroot.argv.includes('example.com'));
  assert.equal(webroot.shell, false);

  const dns = buildCommand({ server: base.server, certs: { domains: ['example.com'], challenge: 'dns-01' } }, 'issue');
  assert.ok(dns.argv.includes('--manual'));

  const renew = buildCommand(base, 'renew');
  assert.deepEqual(renew.argv.slice(0, 2), ['certbot', 'renew']);

  const custom = buildCommand({ server: base.server, certs: { domains: ['example.com'], command: 'echo hi' } }, 'issue');
  assert.equal(custom.shell, true);

  assert.equal(validDomain('example.com'), true);
  assert.equal(validDomain('*.example.com'), true);
  assert.equal(validDomain('bad domain'), false);
  assert.equal(validDomain('a;rm -rf /'), false);

  const missing = certStatus(base);
  assert.equal(missing.ok, false);
  assert.ok(missing.error);
});

test('u-ui: certificate endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const got = await fetch(inst.url + '/api/certs', { headers: { cookie: auth.cookie } });
    assert.equal(got.status, 200);
    const gotJson = await got.json();
    assert.ok(gotJson.config);
    assert.equal(gotJson.status.ok, false);

    const saved = await fetch(inst.url + '/api/certs', { method: 'PUT', headers: headers, body: JSON.stringify({ domains: 'a.example.com,b.example.com', challenge: 'dns-01', email: 'ops@example.com' }) });
    assert.equal(saved.status, 200);
    const raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.deepEqual(raw.certs.domains, ['a.example.com', 'b.example.com']);
    assert.equal(raw.certs.challenge, 'dns-01');

    const badDomain = await fetch(inst.url + '/api/certs', { method: 'PUT', headers: headers, body: JSON.stringify({ domains: 'ok.example.com,a;rm -rf /' }) });
    assert.equal(badDomain.status, 400);

    const issued = await fetch(inst.url + '/api/certs/issue', { method: 'POST', headers: headers, body: '{}' });
    assert.ok([200, 500].includes(issued.status));
    const issuedJson = await issued.json();
    assert.ok(issuedJson.command.includes('certbot'));
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('protocols: one matrix for both cores', function () {
  const list = protocolList();
  assert.ok(list.some(function (p) { return p.name === 'hysteria2' && p.cores.length === 1 && p.cores[0] === 'singbox'; }));
  assert.equal(defaultCore('hysteria2'), 'singbox');
  assert.equal(defaultCore('vless'), 'xray');
  assert.deepEqual(validateChoice('hysteria2', 'xray', 'quic', 'tls'), ['hysteria2 is not supported by the xray core (use singbox)']);
  assert.ok(validateChoice('vless', 'singbox', 'ws', 'tls').length === 0);
  assert.ok(validateChoice('vless', 'xray', 'xhttp', 'none').length === 1);
});

test('nodes: command building never goes through a shell', function () {
  const c = { nodes: [
    { id: 'a', host: '10.0.0.1', user: 'root', port: 2222, key: '/k' },
    { id: 'b', host: '10.0.0.2' },
    { host: '' },
  ] };
  const nodes = normalizeNodes(c);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].port, 2222);
  assert.equal(nodes[1].user, 'root');

  const probeArgv = probeCommand(nodes[0]);
  assert.equal(probeArgv[0], 'ssh');
  assert.ok(probeArgv.includes('root@10.0.0.1'));
  assert.ok(probeArgv.includes('-i'));

  const [scpArgv, sshArgv] = deployCommands('/tmp/config.json', nodes[0]);
  assert.equal(scpArgv[0], 'scp');
  assert.ok(scpArgv.includes('/tmp/config.json'));
  assert.ok(scpArgv.includes('root@10.0.0.1:/etc/uniproxy/config.json'));
  assert.equal(sshArgv[0], 'ssh');
  assert.ok(sshArgv[sshArgv.length - 1].includes('uniproxy apply'));

  assert.throws(function () { deployCommands('/tmp/c.json', { host: 'h', configPath: 'relative.json' }); }, /absolute/);
});

test('u-ui: node registry endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const state = await fetch(inst.url + '/api/state', { headers: { cookie: auth.cookie } });
    assert.ok(Array.isArray((await state.json()).protocols));

    const empty = await fetch(inst.url + '/api/nodes', { headers: { cookie: auth.cookie } });
    assert.deepEqual((await empty.json()).nodes, []);

    const added = await fetch(inst.url + '/api/nodes', { method: 'POST', headers: headers, body: JSON.stringify({ id: 'n1', host: '203.0.113.9', user: 'root', port: 22 }) });
    assert.equal(added.status, 200);
    const raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.nodes.length, 1);
    assert.equal(raw.nodes[0].host, '203.0.113.9');

    const badPath = await fetch(inst.url + '/api/nodes', { method: 'POST', headers: headers, body: JSON.stringify({ id: 'n2', host: 'h', configPath: 'relative.json' }) });
    assert.equal(badPath.status, 400);

    const probed = await fetch(inst.url + '/api/nodes/n1/probe', { method: 'POST', headers: headers });
    assert.ok([200, 500].includes(probed.status));

    const removed = await fetch(inst.url + '/api/nodes/n1', { method: 'DELETE', headers: headers });
    assert.equal(removed.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).nodes.length, 0);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('nodes: incremental sync skips unchanged targets and batches aggregate', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, '{"a":1}\n');
  const hash = localChecksum(cfgPath);
  const node = normalizeNodes({ nodes: [{ id: 'n1', host: 'h1', group: 'g1' }] })[0];

  const calls = [];
  const run = function (argv) {
    calls.push(argv[0] + ' ' + argv[argv.length - 1].slice(0, 40));
    return { ok: true, output: hash, error: null };
  };
  const skipped = deploy(cfgPath, node, { run });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, true);
  assert.equal(calls.length, 1); // only the checksum probe ran

  const forced = deploy(cfgPath, node, { run, force: true });
  assert.equal(forced.skipped, undefined);

  const batch = deployBatch(cfgPath, [node, node], { run });
  assert.equal(batch.results.length, 2);
  assert.equal(batch.ok, true);
  assert.equal(batch.results[0].skipped, true);

  const probed = probeBatch([node], { run: function () { return { ok: true, output: 'xray=active', error: null }; } });
  assert.equal(probed.results[0].status.xray, 'active');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('u-ui: batch node endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };
    const probed = await fetch(inst.url + '/api/nodes/probe-all', { method: 'POST', headers: headers });
    assert.equal(probed.status, 200);
    assert.deepEqual((await probed.json()).results, []);

    const deployed = await fetch(inst.url + '/api/nodes/deploy-all', { method: 'POST', headers: headers, body: JSON.stringify({ group: 'nope' }) });
    assert.equal(deployed.status, 200);
    assert.deepEqual((await deployed.json()).results, []);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('backups: create, read, restore and delete', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, '{"v":1}\n');

  const name = createBackup(cfgPath, 'manual');
  assert.ok(name.startsWith('config.json.bak-manual-'));
  assert.equal(readBackup(cfgPath, name), '{"v":1}\n');
  assert.equal(listBackups(cfgPath).length, 1);

  fs.writeFileSync(cfgPath, '{"v":2}\n');
  const result = restoreBackup(cfgPath, name);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).v, 1);
  assert.ok(result.safety.startsWith('config.json.bak-pre-restore-'));

  assert.throws(function () { readBackup(cfgPath, '../etc/passwd'); }, /invalid backup name/);
  assert.throws(function () { readBackup(cfgPath, 'config.json'); }, /invalid backup name/);

  deleteBackup(cfgPath, name);
  assert.equal(listBackups(cfgPath).some(function (b) { return b.name === name; }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('u-ui: backup endpoints', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const created = await fetch(inst.url + '/api/backups', { method: 'POST', headers: headers });
    assert.equal(created.status, 200);
    const createdJson = await created.json();
    assert.ok(createdJson.name.startsWith('config.json.bak-manual-'));

    const listed = await fetch(inst.url + '/api/backups', { headers: { cookie: auth.cookie } });
    const listedJson = await listed.json();
    assert.ok(listedJson.backups.length >= 1);

    const download = await fetch(inst.url + '/api/backups/' + encodeURIComponent(createdJson.name) + '/download', { headers: { cookie: auth.cookie } });
    assert.equal(download.status, 200);
    assert.ok((await download.text()).includes('server'));

    const before = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    before.server.publicIp = '198.51.100.99';
    fs.writeFileSync(ctx.cfgPath, JSON.stringify(before, null, 2));

    const restored = await fetch(inst.url + '/api/backups/' + encodeURIComponent(createdJson.name) + '/restore', { method: 'POST', headers: headers });
    assert.equal(restored.status, 200);
    assert.notEqual(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).server.publicIp, '198.51.100.99');

    const bad = await fetch(inst.url + '/api/backups/..%2Fetc%2Fpasswd/restore', { method: 'POST', headers: headers });
    assert.equal(bad.status, 400);

    const removed = await fetch(inst.url + '/api/backups/' + encodeURIComponent(createdJson.name), { method: 'DELETE', headers: headers });
    assert.equal(removed.status, 200);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('backups: retention keeps the newest N and never overwrites', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak2-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, '{"v":1}\n');

  const names = [];
  for (let i = 0; i < 4; i++) names.push(createBackup(cfgPath, 'manual'));
  assert.equal(new Set(names).size, 4);
  assert.equal(listBackups(cfgPath).length, 4);

  const removed = pruneBackups(cfgPath, 2);
  assert.equal(removed.length, 2);
  assert.equal(listBackups(cfgPath).length, 2);

  assert.deepEqual(pruneBackups(cfgPath, 0), []);
  assert.equal(listBackups(cfgPath).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('u-ui: backup retention is configurable and enforced on write', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const initial = await fetch(inst.url + '/api/backups', { headers: { cookie: auth.cookie } });
    assert.equal((await initial.json()).keep, 20);

    const saved = await fetch(inst.url + '/api/settings', { method: 'PUT', headers: headers, body: JSON.stringify({ backupKeep: 1 }) });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).backups.keep, 1);

    await fetch(inst.url + '/api/backups', { method: 'POST', headers: headers });
    await fetch(inst.url + '/api/backups', { method: 'POST', headers: headers });
    const listed = await fetch(inst.url + '/api/backups', { headers: { cookie: auth.cookie } });
    const listedJson = await listed.json();
    assert.equal(listedJson.keep, 1);
    assert.equal(listedJson.backups.length, 1);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('menu: renders the boxed sections and exits cleanly', async function () {
  const ctx = setup();
  const printed = [];
  const answers = ['1', '8', '99', '0'];
  const io = {
    print: function (s) { printed.push(String(s)); },
    question: async function () { return answers.length ? answers.shift() : '0'; },
  };
  await runMenu({ configPath: ctx.cfgPath, io: io, pause: false });
  const text = printed.join('\n');
  assert.ok(text.includes('u-ui · uniproxy'));
  assert.ok(text.includes('U. 更新到最新版本'));
  assert.ok(text.includes('0. 退出菜单'));
  assert.ok(text.includes('17. 校验配置 (Validate Config)'));
  assert.ok(text.includes('32. 申请 / 续期证书 (Issue / Renew Cert)'));
  assert.ok(text.includes('25. 停止 xray (Stop Xray)'));
  assert.ok(text.includes('28. 启动 xray (Start Xray)'));
  assert.ok(text.includes('无效选项: 99'));
  assert.ok(text.includes('已退出'));
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('menu: settings flags a placeholder public IP', async function () {
  const ctx = setup();
  const printed = [];
  const answers = ['4', '', '0'];
  const io = {
    print: function (s) { printed.push(String(s)); },
    question: async function () { return answers.length ? answers.shift() : '0'; },
  };
  await runMenu({ configPath: ctx.cfgPath, io: io });
  assert.ok(printed.join('\n').includes('占位符'));
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('menu: box helper and section count', function () {
  const ctx = { configPath: 'config.json', io: { print: function () {}, question: async function () { return '0'; } } };
  const sections = buildMenu(ctx);
  assert.equal(sections.length, 6);
  assert.equal(sections.reduce(function (n, s) { return n + s.items.length; }, 0), 35);
  const rendered = box('面板', ['0. 退出菜单']);
  assert.ok(rendered.startsWith('┌─ 面板'));
  assert.ok(rendered.includes('│ 0. 退出菜单'));
  assert.ok(rendered.trimEnd().endsWith('┘'));
});

test('menu: service unit files point at the right command', function () {
  const files = unitFiles({ configPath: '/etc/uniproxy/config.json', exe: 'node /opt/u/src/index.js', uiPort: 8788, subPort: 8787 });
  assert.deepEqual(Object.keys(files).sort(), ['uniproxy-sub.service', 'uniproxy-ui.service']);
  assert.ok(files['uniproxy-ui.service'].includes('ExecStart=node /opt/u/src/index.js ui -c /etc/uniproxy/config.json -p 8788'));
  assert.ok(files['uniproxy-ui.service'].includes('WorkingDirectory=/etc/uniproxy'));
  assert.ok(files['uniproxy-ui.service'].includes('WantedBy=multi-user.target'));
  assert.ok(files['uniproxy-sub.service'].includes('serve -c /etc/uniproxy/config.json -p 8787'));
});

test('units: syncUnitPorts rewrites the installed command', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'units-'));
  try {
    fs.writeFileSync(path.join(dir, 'uniproxy-ui.service'), '[Service]\nExecStart=/opt/uniproxy ui -c /etc/uniproxy/config.json -p 8788\n');
    const result = syncUnitPorts({ unitDir: dir, uiPort: 9000, subPort: 9001 });
    assert.equal(result.updated.length, 1);
    assert.ok(fs.readFileSync(path.join(dir, 'uniproxy-ui.service'), 'utf8').includes('-p 9000'));
    const again = syncUnitPorts({ unitDir: dir, uiPort: 9000 });
    assert.equal(again.updated.length, 0);
    assert.equal(again.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('menu: installPlan describes a 3x-ui style layout', function () {
  const plan = installPlan({ prefix: '/usr/local/uniproxy', binDir: '/usr/local/bin', etcDir: '/etc/uniproxy', unitDir: '/etc/systemd/system', sourceDir: '/src', exe: 'node /usr/local/uniproxy/src/index.js' });
  assert.equal(plan.prefix, '/usr/local/uniproxy');
  assert.ok(plan.copy.includes('src'));
  assert.ok(plan.launchers['/usr/local/bin/uniproxy'].includes('/usr/local/uniproxy/src/index.js'));
  assert.ok(plan.launchers['/usr/local/bin/u-ui'].includes('/usr/local/uniproxy/src/u-ui.js'));
  assert.ok(plan.units['uniproxy-ui.service'].includes('ExecStart=node /usr/local/uniproxy/src/index.js ui -c /etc/uniproxy/config.json'));
});

test('menu: pauses after an action until Enter', async function () {
  const ctx = setup();
  const printed = [];
  const answers = ['13', '', '0'];
  const io = {
    print: function (s) { printed.push(String(s)); },
    question: async function () { return answers.length ? answers.shift() : '0'; },
  };
  await runMenu({ configPath: ctx.cfgPath, io: io });
  assert.ok(printed.join('\n').includes('按回车返回主菜单'));
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('menu: uninstall exits instead of pausing', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-exit-'));
  const keys = ['UNIPROXY_PREFIX', 'UNIPROXY_BIN_DIR', 'UNIPROXY_ETC_DIR', 'UNIPROXY_UNIT_DIR'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  process.env.UNIPROXY_PREFIX = path.join(dir, 'prefix');
  process.env.UNIPROXY_BIN_DIR = path.join(dir, 'bin');
  process.env.UNIPROXY_ETC_DIR = path.join(dir, 'etc');
  process.env.UNIPROXY_UNIT_DIR = path.join(dir, 'units');
  const printed = [];
  const answers = ['2'];
  try {
    fs.mkdirSync(path.join(dir, 'prefix'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'uniproxy'), 'x');
    fs.writeFileSync(path.join(dir, 'bin', 'u-ui'), 'x');
    fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
    await runMenu({
      configPath: path.join(dir, 'etc', 'config.json'),
      io: { print: function (s) { printed.push(String(s)); }, question: async function () { return answers.length ? answers.shift() : '0'; } },
    });
    const text = printed.join('\n');
    assert.ok(text.includes('菜单退出'));
    assert.ok(!text.includes('按回车返回主菜单'));
    assert.equal(fs.existsSync(path.join(dir, 'prefix')), false);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('menu: installPlan for a SEA binary ships the executable, not the source tree', function () {
  const plan = installPlan({ prefix: '/opt/uniproxy', binDir: '/usr/local/bin', etcDir: '/etc/uniproxy', unitDir: '/etc/systemd/system', sea: true });
  assert.equal(plan.binary, process.execPath);
  assert.deepEqual(plan.copy, []);
  assert.ok(plan.launchers['/usr/local/bin/uniproxy'].includes('exec "/opt/uniproxy/uniproxy"'));
  assert.ok(plan.launchers['/usr/local/bin/u-ui'].includes('menu'));
  assert.ok(plan.units['uniproxy-ui.service'].includes('ExecStart=/opt/uniproxy/uniproxy ui'));
});

test('menu: install lays out prefix, launchers, config and units', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  const keys = ['UNIPROXY_PREFIX', 'UNIPROXY_BIN_DIR', 'UNIPROXY_ETC_DIR', 'UNIPROXY_UNIT_DIR'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  process.env.UNIPROXY_PREFIX = path.join(dir, 'prefix');
  process.env.UNIPROXY_BIN_DIR = path.join(dir, 'bin');
  process.env.UNIPROXY_ETC_DIR = path.join(dir, 'etc');
  process.env.UNIPROXY_UNIT_DIR = path.join(dir, 'units');
  const printed = [];
  try {
    await installSystem({ configPath: path.join(dir, 'etc', 'config.json'), io: { print: function (s) { printed.push(String(s)); } } });
    assert.ok(fs.existsSync(path.join(dir, 'prefix', 'src', 'index.js')));
    assert.ok(fs.existsSync(path.join(dir, 'prefix', 'src', 'u-ui.js')));
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'uniproxy')));
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'u-ui')));
    assert.ok(fs.existsSync(path.join(dir, 'etc', 'config.json')));
    assert.ok(fs.existsSync(path.join(dir, 'units', 'uniproxy-ui.service')));
    assert.ok(printed.join('\n').includes('安装完成'));
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('menu: uninstall removes prefix, launchers and units', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
  const keys = ['UNIPROXY_PREFIX', 'UNIPROXY_BIN_DIR', 'UNIPROXY_ETC_DIR', 'UNIPROXY_UNIT_DIR'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  process.env.UNIPROXY_PREFIX = path.join(dir, 'prefix');
  process.env.UNIPROXY_BIN_DIR = path.join(dir, 'bin');
  process.env.UNIPROXY_ETC_DIR = path.join(dir, 'etc');
  process.env.UNIPROXY_UNIT_DIR = path.join(dir, 'units');
  try {
    fs.mkdirSync(path.join(dir, 'prefix', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prefix', 'uniproxy'), 'binary');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'uniproxy'), 'x');
    fs.writeFileSync(path.join(dir, 'bin', 'u-ui'), 'x');
    fs.mkdirSync(path.join(dir, 'units'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'units', 'uniproxy-ui.service'), 'unit');
    await uninstallSystem({ configPath: path.join(dir, 'etc', 'config.json'), io: { print: function () {} } });
    assert.equal(fs.existsSync(path.join(dir, 'prefix')), false);
    assert.equal(fs.existsSync(path.join(dir, 'bin', 'uniproxy')), false);
    assert.equal(fs.existsSync(path.join(dir, 'bin', 'u-ui')), false);
    assert.equal(fs.existsSync(path.join(dir, 'units', 'uniproxy-ui.service')), false);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: derives panel hostnames into certificate SANs', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dom-'));
  const cfgPath = path.join(dir, 'config.json');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify(example, null, 2));
  try {
    await runSetup({ configPath: cfgPath, yes: true, detectIp: false, flags: { domain: 'example.com' }, io: { print: function () {}, question: async function () { return ''; } } });
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.panels.xui.domain, 'xui.example.com');
    assert.equal(cfg.panels.sui.domain, 'sui.example.com');
    assert.equal(cfg.panels.sui.sub.domain, 'sub.example.com');
    for (const host of ['example.com', 'xui.example.com', 'sui.example.com', 'sub.example.com', 'sb.example.com']) {
      assert.ok(cfg.certs.domains.includes(host), host);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: random password and port generators', function () {
  const a = randomPassword();
  const b = randomPassword();
  assert.equal(a.length, 16);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9]+$/);
  const p = randomPort();
  assert.ok(p >= 40000 && p < 60000);
});

test('setup: asks for the domain, randomises the rest', async function () {
  const ctx = setup();
  const raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
  raw.ui = {};
  fs.writeFileSync(ctx.cfgPath, JSON.stringify(raw, null, 2));

  const answers = ['example.org', '', '', '', '203.0.113.7', 'r', 'r', 'admin', '', 'ops@example.org'];
  const printed = [];
  const io = {
    print: function (s) { printed.push(String(s)); },
    question: async function () { return answers.length ? answers.shift() : ''; },
  };
  const res = await runSetup({ configPath: ctx.cfgPath, io: io, detectIp: false });
  assert.equal(res.ok, true);

  const cfg = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
  assert.equal(cfg.server.domains.web, 'example.org');
  assert.equal(cfg.panels.xui.domain, 'xui.example.org');
  assert.equal(cfg.panels.sui.domain, 'sui.example.org');
  assert.equal(cfg.panels.sui.sub.domain, 'sub.example.org');
  assert.ok(cfg.certs.domains.includes('xui.example.org'));
  assert.equal(cfg.server.publicIp, '203.0.113.7');
  assert.ok(cfg.ui.port >= 40000 && cfg.ui.port < 60000);
  assert.ok(cfg.subscription.port >= 40000 && cfg.subscription.port < 60000);
  assert.equal(cfg.ui.users.length, 1);
  assert.equal(cfg.ui.users[0].username, 'admin');
  assert.equal(cfg.ui.users[0].role, 'admin');
  assert.equal(cfg.ui.password, undefined);
  assert.equal(cfg.server.email, 'ops@example.org');
  assert.ok(printed.join('\n').includes('管理员密码'));
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('u-ui: accounts can be added, updated and deleted', async function () {
  const ctx = setup();
  const inst = await startUi(ctx.cfgPath, 0, { password: 'secret' });
  try {
    const auth = await login(inst);
    const headers = { cookie: auth.cookie, 'x-uui-csrf': auth.csrf, 'content-type': 'application/json' };

    const added = await fetch(inst.url + '/api/accounts', { method: 'POST', headers: headers, body: JSON.stringify({ username: 'boss', password: 'p1', role: 'admin' }) });
    assert.equal(added.status, 200);
    const raw = JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8'));
    assert.equal(raw.ui.users.length, 1);
    assert.equal(raw.ui.users[0].username, 'boss');
    assert.ok(verifyPassword('p1', raw.ui.users[0].hash));
    assert.equal(raw.ui.users[0].hash.indexOf('p1'), -1);

    const list = await fetch(inst.url + '/api/accounts', { headers: { cookie: auth.cookie } });
    assert.deepEqual((await list.json()).users, [{ username: 'boss', role: 'admin' }]);

    const badName = await fetch(inst.url + '/api/accounts', { method: 'POST', headers: headers, body: JSON.stringify({ username: 'a b', password: 'x' }) });
    assert.equal(badName.status, 400);

    const dup = await fetch(inst.url + '/api/accounts', { method: 'POST', headers: headers, body: JSON.stringify({ username: 'boss', password: 'x' }) });
    assert.equal(dup.status, 400);

    const lastAdmin = await fetch(inst.url + '/api/accounts/boss', { method: 'DELETE', headers: headers });
    assert.equal(lastAdmin.status, 400);

    const viewer = await fetch(inst.url + '/api/accounts', { method: 'POST', headers: headers, body: JSON.stringify({ username: 'look', password: 'p2', role: 'viewer' }) });
    assert.equal(viewer.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).ui.users.length, 2);

    const removed = await fetch(inst.url + '/api/accounts/look', { method: 'DELETE', headers: headers });
    assert.equal(removed.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(ctx.cfgPath, 'utf8')).ui.users.length, 1);
  } finally {
    await inst.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});