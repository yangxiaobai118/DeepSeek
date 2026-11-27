import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUi } from '../src/ui/server.js';

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
