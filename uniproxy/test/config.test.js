import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './helpers.js';
import { validateConfig } from '../src/config.js';
import { analyzePorts } from '../src/ports.js';

test('a complete config has no validation errors', () => {
  const c = makeConfig();
  const { errors, warnings } = validateConfig(c);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('rejects a transport the protocol cannot use', () => {
  const c = makeConfig();
  c.singbox.inbounds[0].network = 'xhttp';
  const { errors } = validateConfig(c);
  assert.ok(errors.some((e) => e.includes('does not support the xhttp transport')));
});

test('rejects a protocol the chosen core cannot serve', () => {
  const c = makeConfig();
  c.xray.inbounds[0].protocol = 'hysteria2';
  const { errors } = validateConfig(c);
  assert.ok(errors.some((e) => e.includes('not supported by the xray core')));
});

test('warns when xtls-rprx-vision is used off plain TCP', () => {
  const c = makeConfig();
  c.xray.inbounds[0].network = 'ws';
  c.xray.inbounds[0].path = '/ws';
  const { warnings } = validateConfig(c);
  assert.ok(warnings.some((w) => w.includes('will be dropped')));
});

test('detects duplicate inbound tags even across cores', () => {
  const c = makeConfig();
  c.singbox.inbounds[0].tag = c.xray.inbounds[0].tag;
  const { errors } = validateConfig(c);
  assert.ok(errors.some((e) => e.includes('duplicate inbound tag')));
});

test('subscription base path and public base are validated', () => {
  const c = makeConfig();
  c.subscription.basePath = 'sub';
  c.subscription.publicBase = 'ftp://sub.example.net';
  const { errors } = validateConfig(c);
  assert.ok(errors.some((e) => e.includes('subscription.basePath')));
  assert.ok(errors.some((e) => e.includes('subscription.publicBase')));
});

test('port planner flags two wildcard listeners on the same port', () => {
  const c = makeConfig();
  c.xray.inbounds[0].listen = '0.0.0.0';
  c.xray.inbounds[0].port = 443;
  const report = analyzePorts(c);
  assert.ok(report.errors.some((e) => e.includes('port 443')));
});

test('port planner counts the s-ui subscription port', () => {
  const c = makeConfig();
  const report = analyzePorts(c);
  assert.ok(report.entries.some((e) => e.label === 's-ui:subscription' && e.port === 2096));
});

test('port planner reports the internal TLS listener on loopback', () => {
  const c = makeConfig();
  const report = analyzePorts(c);
  const entry = report.entries.find((e) => e.label === 'nginx:internal-tls');
  assert.equal(entry.port, 8443);
  assert.equal(entry.listen, '127.0.0.1');
});

test('port planner groups listeners by owner', () => {
  const report = analyzePorts(makeConfig());
  const owners = new Set(report.entries.map(function (e) { return e.owner; }));
  for (const g of ['u-ui', '3x-ui', 's-ui']) {
    assert.ok(owners.has(g), g);
  }
  const ui = report.entries.find(function (e) { return e.label === 'u-ui:panel'; });
  assert.equal(ui.port, 8788);
  assert.equal(ui.listen, '127.0.0.1');
  assert.equal(ui.owner, 'u-ui');
});

test('port planner assigns specific ports to other owners', () => {
  const c = makeConfig();
  c.ports.owners = { 10443: '3x-ui' };
  c.ports.extra = [{ port: 55555, label: '3x-ui xray ws', listen: '127.0.0.1', owner: '3x-ui' }];
  const report = analyzePorts(c);
  const inbound = report.entries.find(function (e) { return e.port === 10443; });
  assert.equal(inbound.owner, '3x-ui');
  const extra = report.entries.find(function (e) { return e.port === 55555; });
  assert.equal(extra.owner, '3x-ui');
});

test('stream mode warns about inbounds without sni', () => {
  const c = makeConfig();
  delete c.singbox.inbounds[0].sni;
  const report = analyzePorts(c);
  assert.ok(report.warnings.some((w) => w.includes('no "sni"')));
});
