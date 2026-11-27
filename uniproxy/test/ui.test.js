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

test('u-ui: requires auth, manages users and rejects bad input', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uui-'));
  const cfgPath = path.join(dir, 'config.json');
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify(example, null, 2));

  const inst = await startUi(cfgPath, 0, { password: 'secret' });
  try {
    const base = inst.url;

    const unauth = await fetch(base + '/api/state');
    assert.equal(unauth.status, 401);

    const bad = await fetch(base + '/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope', redirect: 'manual',
    });
    assert.equal(bad.status, 401);

    const login = await fetch(base + '/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=secret', redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = cookieHeader(login);
    assert.match(cookie, /uui_session=/);
    assert.match(cookie, /uui_csrf=/);
    const csrf = /uui_csrf=([^;]+)/.exec(cookie)[1];

    const state = await fetch(base + '/api/state', { headers: { cookie: cookie } });
    assert.equal(state.status, 200);
    const stateJson = await state.json();
    assert.ok(Array.isArray(stateJson.ports));
    assert.equal(stateJson.csrf, csrf);

    const created = await fetch(base + '/api/users', {
      method: 'POST',
      headers: { cookie: cookie, 'x-uui-csrf': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice', inbounds: ['xray-vless-reality'], expireAt: '2027-01-01T00:00:00Z', dataLimitBytes: 1073741824, enabled: true }),
    });
    assert.equal(created.status, 200);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(saved.users.length, 1);
    assert.equal(saved.users[0].name, 'alice');

    const noCsrf = await fetch(base + '/api/users', {
      method: 'POST', headers: { cookie: cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noCsrf.status, 403);

    const badJson = await fetch(base + '/api/config', {
      method: 'PUT',
      headers: { cookie: cookie, 'x-uui-csrf': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ json: '{' }),
    });
    assert.equal(badJson.status, 400);

    const dup = await fetch(base + '/api/users', {
      method: 'POST',
      headers: { cookie: cookie, 'x-uui-csrf': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice' }),
    });
    assert.equal(dup.status, 409);

    const removed = await fetch(base + '/api/users/alice', { method: 'DELETE', headers: { cookie: cookie, 'x-uui-csrf': csrf } });
    assert.equal(removed.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).users.length, 0);
  } finally {
    await inst.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
