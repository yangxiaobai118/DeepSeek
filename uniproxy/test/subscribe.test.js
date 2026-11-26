import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './helpers.js';
import { buildSubscriptions } from '../src/subscribe.js';
import { genUuid } from '../src/util.js';

test('one subscription per client identity', () => {
  const c = makeConfig();
  const subs = buildSubscriptions(c);
  assert.equal(subs.length, 3);
  assert.deepEqual(subs.map((s) => s.name).sort(), ['alice', 'bob', 'carol']);
  for (const sub of subs) {
    assert.match(sub.token, /^[0-9a-f]{24}$/);
    assert.equal(Buffer.from(sub.base64, 'base64').toString('utf8').trim().split('\n').length, 1);
  }
});

test('the same user across cores shares one subscription', () => {
  const c = makeConfig();
  const uuid = genUuid();
  c.singbox.inbounds[0].users = [{ uuid, name: 'alice' }];
  c.xray.inbounds[0].clients = [{ id: uuid, name: 'alice', flow: 'xtls-rprx-vision' }];
  const subs = buildSubscriptions(c);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].links.length, 2);
});

test('sing-box profile carries reality keys and transports', () => {
  const c = makeConfig();
  const alice = buildSubscriptions(c).find((s) => s.name === 'alice');
  const out = alice.singbox.outbounds[0];
  assert.equal(out.type, 'vless');
  assert.equal(out.flow, 'xtls-rprx-vision');
  assert.equal(out.tls.reality.enabled, true);
  assert.match(out.tls.reality.public_key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(out.server_port, 443);
});

test('clash profile is YAML-ish and keeps reality options', () => {
  const c = makeConfig();
  const sub = buildSubscriptions(c).find((s) => s.name === 'alice');
  assert.match(sub.clash, /^proxies:/m);
  assert.match(sub.clash, /reality-opts:/);
  assert.match(sub.clash, /public-key:/);
  assert.match(sub.clash, /MATCH,PROXY/);
  assert.doesNotMatch(sub.clash, /\t/);
});

test('clash skips transports it cannot express', () => {
  const c = makeConfig();
  const ib = c.xray.inbounds[0];
  ib.network = 'xhttp';
  ib.path = '/x';
  ib.security = 'tls';
  const sub = buildSubscriptions(c).find((s) => s.name === 'alice');
  assert.match(sub.clash, /skipped \(Clash has no client for this transport\)/);
  assert.doesNotMatch(sub.clash, /type: vless/);
});
