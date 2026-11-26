import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './helpers.js';
import { generateLinkRecords, generateLinks } from '../src/generators/links.js';

test('every client of every inbound gets a link', () => {
  const c = makeConfig();
  const records = generateLinkRecords(c);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.client).sort(), ['alice', 'bob', 'carol']);
});

test('stream mode always points links at 443', () => {
  const c = makeConfig();
  for (const record of generateLinkRecords(c)) {
    assert.equal(record.port, 443);
    assert.match(record.uri, /@45.77.12.34:443\b/);
  }
});

test('http mode points links at the inbound port', () => {
  const c = makeConfig();
  c.nginx.mode = 'http';
  const records = generateLinkRecords(c);
  assert.equal(records.find((r) => r.tag === 'ws-in').port, 2052);
});

test('vision flow is only emitted where it is legal', () => {
  const c = makeConfig();
  const alice = generateLinkRecords(c).find((r) => r.client === 'alice');
  const bob = generateLinkRecords(c).find((r) => r.client === 'bob');
  assert.match(alice.uri, /flow=xtls-rprx-vision/);
  assert.doesNotMatch(bob.uri, /flow=/);
});

test('vision flow is dropped for ws inbounds but the link still works', () => {
  const c = makeConfig();
  c.singbox.inbounds[0].users[0].flow = 'xtls-rprx-vision';
  const carol = generateLinkRecords(c).find((r) => r.client === 'carol');
  assert.doesNotMatch(carol.uri, /flow=/);
});

test('links can be filtered to one client', () => {
  const c = makeConfig();
  const links = generateLinks(c, { client: 'bob', address: 'proxy.example.org' });
  assert.equal(links.length, 1);
  assert.match(links[0], /@proxy\.example\.org:443/);
});

test('xhttp links carry path and mode', () => {
  const c = makeConfig();
  const ib = c.xray.inbounds[0];
  ib.network = 'xhttp';
  ib.path = '/xhttp';
  ib.xhttpMode = 'packet-up';
  ib.security = 'tls';
  const uri = generateLinkRecords(c).find((r) => r.client === 'alice').uri;
  const url = new URL(uri.replace('vless://', 'https://'));
  assert.equal(url.searchParams.get('type'), 'xhttp');
  assert.equal(url.searchParams.get('path'), '/xhttp');
  assert.equal(url.searchParams.get('mode'), 'packet-up');
});

test('vmess links decode to a v2rayN compatible payload', () => {
  const c = makeConfig();
  const ib = c.singbox.inbounds[0];
  ib.protocol = 'vmess';
  ib.users = [{ uuid: '11111111-2222-4333-8444-555555555555', name: 'dave' }];
  const record = generateLinkRecords(c).find((r) => r.client === 'dave');
  const payload = JSON.parse(Buffer.from(record.uri.slice('vmess://'.length), 'base64').toString('utf8'));
  assert.equal(payload.net, 'ws');
  assert.equal(payload.path, '/wspath');
  assert.equal(payload.tls, 'tls');
  assert.equal(payload.id, '11111111-2222-4333-8444-555555555555');
});