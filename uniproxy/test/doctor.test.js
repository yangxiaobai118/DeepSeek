import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './helpers.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';

test('doctor reports a placeholder address as a failure', () => {
  const c = makeConfig();
  c.server.publicIp = '203.0.113.10';
  const report = runDoctor(c, 'config.json', { probe: false });
  assert.ok(report.failed >= 1);
  assert.ok(report.results.some((r) => r.level === 'fail' && r.title === 'server.publicIp'));
});

test('doctor is clean for a complete config', () => {
  const report = runDoctor(makeConfig(), 'config.json', { probe: false });
  assert.equal(report.failed, 0, JSON.stringify(report.results, null, 2));
});

test('doctor catches duplicate SNI in stream mode', () => {
  const c = makeConfig();
  c.xray.inbounds[0].sni = 'sb.example.net';
  const report = runDoctor(c, 'config.json', { probe: false });
  assert.ok(report.results.some((r) => r.level === 'fail' && r.title === 'stream sni'));
});

test('doctor output is readable', () => {
  const text = formatDoctor(runDoctor(makeConfig(), 'config.json', { probe: false }));
  assert.match(text, /config loaded/);
  assert.match(text, /0 failure\(s\)/);
});
