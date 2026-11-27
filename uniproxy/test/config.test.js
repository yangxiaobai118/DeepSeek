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
  assert.ok(report.entries.some((e) => e.label === 'panel:s-ui-sub' && e.port === 2096));
});

test('stream mode warns about inbounds without sni', () => {
  const c = makeConfig();
  delete c.singbox.inbounds[0].sni;
  const report = analyzePorts(c);
  assert.ok(report.warnings.some((w) => w.includes('no "sni"')));
});
