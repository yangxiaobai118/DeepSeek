import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeConfig } from './helpers.js';
import { applyDefaults, validateConfig } from '../src/config.js';
import { generateXray } from '../src/generators/xray.js';
import { buildSubscriptions, subscriptionHeaders } from '../src/subscribe.js';
import { resolveUsers } from '../src/users.js';
import { startDashboard } from '../src/server.js';

const PINNED = ['pinned', 'token', '123'].join('-');

const USERS = [
  { name: 'dave', inbounds: ['reality-in', 'ws-in'], expireAt: '2099-01-01T00:00:00Z', dataLimitBytes: 107374182400 },
];

test('registry users are provisioned into every listed inbound', () => {
  const c = makeConfig({ users: USERS });
  const xrayClient = c.xray.inbounds[0].clients.find((cl) => cl.name === 'dave');
  const sbClient = c.singbox.inbounds[0].users.find((cl) => cl.name === 'dave');
  assert.ok(xrayClient && sbClient);
  assert.match(xrayClient.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('provisioned credentials are stable across regenerations', () => {
  const a = makeConfig({ users: USERS });
  const b = makeConfig({ users: USERS });
  const idA = a.xray.inbounds[0].clients.find((cl) => cl.name === 'dave').id;
  const idB = b.xray.inbounds[0].clients.find((cl) => cl.name === 'dave').id;
  assert.equal(idA, idB);
});

test('one user, two cores, one subscription', () => {
  const c = makeConfig({ users: USERS });
  const subs = buildSubscriptions(c);
  const dave = subs.filter((s) => s.name === 'dave');
  assert.equal(dave.length, 1);
  assert.equal(dave[0].links.length, 2);
  assert.ok(dave[0].links.every((uri) => uri.includes('dave')));
});

test('pinned subToken is honoured', () => {
  const c = makeConfig({ users: [{ name: 'dave', inbounds: ['reality-in'], subToken: PINNED }] });
  const dave = buildSubscriptions(c).find((s) => s.name === 'dave');
  assert.equal(dave.token, PINNED);
  assert.equal(resolveUsers(c)[0].token, PINNED);
});

test('expiry and quota drive the user status', () => {
  const expired = makeConfig({ users: [{ name: 'dave', inbounds: ['reality-in'], expireAt: '2020-01-01T00:00:00Z' }] });
  assert.equal(resolveUsers(expired)[0].status, 'expired');
  const quota = makeConfig({
    users: [{ name: 'dave', inbounds: ['reality-in'], dataLimitBytes: 100, usage: { download: 101 } }],
  });
  assert.equal(resolveUsers(quota)[0].status, 'quota');
  const disabled = makeConfig({ users: [{ name: 'dave', inbounds: ['reality-in'], enabled: false }] });
  assert.equal(resolveUsers(disabled)[0].status, 'disabled');
});

test('subscription headers expose quota and expiry', () => {
  const c = makeConfig({ users: USERS });
  const dave = buildSubscriptions(c).find((s) => s.name === 'dave');
  const headers = subscriptionHeaders(c, 't', dave.user);
  assert.match(headers['subscription-userinfo'], /upload=0; download=0; total=107374182400; expire=\d+/);
});

test('routing profile is applied to both client formats', () => {
  const c = makeConfig({
    users: USERS,
    subscription: {
      routing: {
        bypassPrivate: true,
        directDomains: ['example.org'],
        directCidrs: ['10.0.0.0/8'],
        blockDomains: ['ads.example.net'],
      },
    },
  });
  const dave = buildSubscriptions(c).find((s) => s.name === 'dave');
  const rules = dave.singbox.route.rules;
  assert.ok(rules.some((r) => r.ip_is_private === true && r.outbound === 'direct'));
  assert.ok(rules.some((r) => r.domain_suffix && r.domain_suffix.includes('example.org') && r.outbound === 'direct'));
  assert.ok(rules.some((r) => r.ip_cidr && r.ip_cidr.includes('10.0.0.0/8')));
  assert.ok(rules.some((r) => r.domain_suffix && r.domain_suffix.includes('ads.example.net') && r.outbound === 'block'));
  assert.ok(dave.singbox.outbounds.some((o) => o.tag === 'block'));
  assert.match(dave.clash, /GEOIP,LAN,DIRECT/);
  assert.match(dave.clash, /DOMAIN-SUFFIX,example.org,DIRECT/);
  assert.match(dave.clash, /DOMAIN-SUFFIX,ads.example.net,REJECT/);
});

test('expired users are refused by the subscription endpoint', async () => {
  const c = makeConfig({ users: [{ name: 'dave', inbounds: ['reality-in'], expireAt: '2020-01-01T00:00:00Z' }] });
  const token = resolveUsers(c)[0].token;
  const server = startDashboard(c, 'config.json', 0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/sub/' + token);
    assert.equal(res.status, 403);
    assert.match(res.headers.get('subscription-userinfo'), /expire=1577836800/);
    assert.match(await res.text(), /expired/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('xray fallbacks are emitted and validated', () => {
  const c = makeConfig({ users: [] });
  const ib = c.xray.inbounds[0];
  ib.security = 'tls';
  ib.fallbacks = [{ dest: '127.0.0.1:2095', path: '/xui' }];
  const out = generateXray(c).inbounds[0];
  assert.deepEqual(out.settings.fallbacks, [{ dest: '127.0.0.1:2095', path: '/xui' }]);
  assert.deepEqual(validateConfig(c).errors, []);

  const bad = makeConfig();
  bad.singbox.inbounds[0].fallbacks = [{ dest: '127.0.0.1:1' }];
  assert.ok(validateConfig(bad).errors.some((e) => e.includes('Xray-only')));
});

test('registry validation catches unknown inbounds and bad dates', () => {
  const c = makeConfig({ users: [{ name: 'dave', inbounds: ['nope'], expireAt: 'not-a-date' }] });
  const errors = validateConfig(c).errors;
  assert.ok(errors.some((e) => e.includes('unknown inbound')));
  assert.ok(errors.some((e) => e.includes('expireAt')));
});