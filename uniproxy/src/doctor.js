import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateConfig } from './config.js';
import { analyzePorts } from './ports.js';
import { inboundClients, clientSubToken } from './clients.js';
import { isPlaceholderAddress, x25519PublicFromPrivate } from './util.js';

/**
 * Pre-flight diagnostics, modelled on s-ui-x's doctor: everything that would
 * make a generated config fail on the server is reported before you deploy.
 */
export function runDoctor(c, cfgPath, options = {}) {
  const results = [];
  const add = (level, title, detail) => results.push({ level, title, detail });

  add('ok', 'config loaded', cfgPath);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add('ok', 'node runtime', process.version + ' (requires >= 18)');
  else add('fail', 'node runtime', process.version + ' is too old; uniproxy requires node >= 18');

  const val = validateConfig(c);
  for (const e of val.errors) add('fail', 'config', e);
  for (const w of val.warnings) add('warn', 'config', w);

  const ports = analyzePorts(c);
  for (const e of ports.errors) add('fail', 'ports', e);
  for (const w of ports.warnings) add('warn', 'ports', w);
  if (!ports.errors.length && !ports.warnings.length) add('ok', 'ports', ports.entries.length + ' listeners, no conflicts');

  if (isPlaceholderAddress(c.server.publicIp)) {
    add('fail', 'server.publicIp', 'still a placeholder (' + (c.server.publicIp || 'unset') + '); client links would be unusable');
  } else {
    add('ok', 'server.publicIp', c.server.publicIp);
  }

  const exampleDomains = collectDomains(c).filter((d) => /example\.(com|org|net)$/.test(d));
  if (exampleDomains.length) {
    add('warn', 'domains', 'still example domains: ' + exampleDomains.join(', '));
  }

  checkReality(c, add);
  checkStreamRouting(c, add);
  checkNginxServers(c, add);
  checkCertificate(c, add);
  checkSubscriptions(c, add);

  if (options.probe !== false) checkBinaries(add);

  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  return { results, failed, warned };
}

function collectDomains(c) {
  const out = [];
  for (const p of [c.panels.xui, c.panels.sui]) {
    if (!p || !p.enabled) continue;
    if (p.domain) out.push(p.domain);
    if (p.sub && p.sub.domain) out.push(p.sub.domain);
  }
  for (const s of c.nginx.sites || []) if (s.serverName) out.push(s.serverName);
  for (const s of c.nginx.extraSites || []) if (s.serverName) out.push(s.serverName);
  return out;
}

function checkReality(c, add) {
  let seen = 0;
  for (const kind of ['xray', 'singbox']) {
    for (const ib of c[kind].inbounds || []) {
      if (ib.security !== 'reality') continue;
      seen++;
      const at = kind + ':' + ib.tag;
      if (!ib.reality || !ib.reality.privateKey) continue;
      try {
        const pub = x25519PublicFromPrivate(ib.reality.privateKey);
        add('ok', 'reality key', at + ' public key ' + pub);
      } catch (e) {
        add('fail', 'reality key', at + ': ' + e.message);
      }
      const sid = (ib.reality.shortIds || [])[0];
      if (sid && !/^[0-9a-f]{2,16}$/i.test(sid)) {
        add('warn', 'reality shortId', at + ': "' + sid + '" should be 2-16 hex characters');
      }
      if (ib.sni && ib.reality.serverNames && !ib.reality.serverNames.includes(ib.sni)) {
        add('warn', 'reality sni', at + ': sni "' + ib.sni + '" is not in reality.serverNames');
      }
      const dest = ib.reality.dest || '';
      if (dest && !/^[^:]+:\d+$/.test(dest)) {
        add('warn', 'reality dest', at + ': "' + dest + '" should look like host:port');
      }
    }
  }
  if (!seen) add('warn', 'reality', 'no reality inbound configured');
}

function checkStreamRouting(c, add) {
  if (c.nginx.mode !== 'stream') return;
  const snis = new Map();
  const inbounds = [
    ...(c.xray.inbounds || []).map((ib) => ({ ...ib, kind: 'xray' })),
    ...(c.singbox.inbounds || []).map((ib) => ({ ...ib, kind: 'singbox' })),
  ];
  for (const ib of inbounds) {
    if (!ib.sni) continue;
    const at = ib.kind + ':' + ib.tag;
    const previous = snis.get(ib.sni);
    if (previous) add('fail', 'stream sni', ib.sni + ' is claimed by both ' + previous + ' and ' + at);
    else snis.set(ib.sni, at);
  }
  const fallback = (c.nginx.sites || [])[0];
  if (!fallback) add('warn', 'stream fallback', 'no nginx.sites entry; unmatched SNI falls back to the internal TLS server');
}

function checkNginxServers(c, add) {
  const names = new Map();
  const push = (name, who) => {
    if (!name) return;
    if (names.has(name)) add('fail', 'nginx server_name', name + ' is used by both ' + names.get(name) + ' and ' + who);
    else names.set(name, who);
  };
  for (const s of c.nginx.sites || []) push(s.serverName, 'sites');
  for (const s of c.nginx.extraSites || []) push(s.serverName, 'extraSites');
  for (const key of ['xui', 'sui']) {
    const p = c.panels[key];
    if (!p || !p.enabled) continue;
    push(p.domain, 'panel:' + key);
    if (p.sub && p.sub.enabled) push(p.sub.domain || p.domain, 'panel:' + key + ' sub');
  }
}

function checkCertificate(c, add) {
  const { certFile, keyFile } = c.server.cert;
  if (!certFile || !keyFile) {
    add('warn', 'certificate', 'server.cert is incomplete; TLS/Reality inbounds cannot serve TLS');
    return;
  }
  if (!fs.existsSync(certFile)) {
    add('warn', 'certificate', certFile + ' is not readable on this host (fine if you generate on the deploy box)');
    return;
  }
  try {
    const pem = fs.readFileSync(certFile, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    const validTo = new Date(cert.validTo);
    const days = Math.floor((validTo.getTime() - Date.now()) / 86400000);
    if (days < 0) add('fail', 'certificate', 'expired on ' + validTo.toISOString().slice(0, 10));
    else if (days < 30) add('warn', 'certificate', 'expires in ' + days + ' day(s) on ' + validTo.toISOString().slice(0, 10));
    else add('ok', 'certificate', 'valid for ' + days + ' day(s), subject ' + cert.subject.replace(/\n/g, ', '));
  } catch (e) {
    add('warn', 'certificate', 'cannot parse ' + certFile + ': ' + e.message);
  }
}

function checkSubscriptions(c, add) {
  if (!c.subscription.enabled) {
    add('warn', 'subscriptions', 'disabled; no /sub endpoints or profiles will be generated');
    return;
  }
  const users = new Map();
  for (const kind of ['xray', 'singbox']) {
    for (const ib of c[kind].inbounds || []) {
      for (const client of inboundClients(ib)) {
        const token = clientSubToken(c, client);
        const entry = users.get(token);
        if (!entry) users.set(token, { name: client.name, inbounds: 1 });
        else entry.inbounds++;
      }
    }
  }
  add('ok', 'subscriptions', users.size + ' client profile(s) under ' + c.subscription.basePath + '/<token>');
}

function checkBinaries(add) {
  const probes = [
    { name: 'xray', args: ['version'] },
    { name: 'sing-box', args: ['version'] },
    { name: 'nginx', args: ['-v'] },
  ];
  for (const probe of probes) {
    const res = spawnSync(probe.name, probe.args, { timeout: 4000, encoding: 'utf8' });
    if (res.error) {
      add('warn', 'binary ' + probe.name, 'not runnable here (' + res.error.code + '); configs cannot be validated locally');
      continue;
    }
    const output = String(res.stdout || res.stderr || '').trim().split(/\r?\n/)[0];
    if (res.status === 0 || output) add('ok', 'binary ' + probe.name, output || 'present');
    else add('warn', 'binary ' + probe.name, 'exited with ' + res.status);
  }
}

export function formatDoctor(report) {
  const icon = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  const lines = report.results.map(function (r) {
    return icon[r.level] + '  ' + r.title.padEnd(18) + ' ' + r.detail;
  });
  lines.push('', report.failed + ' failure(s), ' + report.warned + ' warning(s)');
  return lines.join('\n');
}