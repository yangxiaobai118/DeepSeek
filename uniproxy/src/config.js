import fs from 'node:fs';
import path from 'node:path';

const PANELS = ['xui', 'sui'];
const PROXY_KINDS = ['xray', 'singbox'];

export function loadConfig(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`config not found: ${abs} (run "uniproxy init" first)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`invalid JSON in ${abs}: ${e.message}`);
  }
  return { config: applyDefaults(parsed), path: abs };
}

export function applyDefaults(c) {
  c.server = c.server || {};
  c.server.domains = c.server.domains || {};
  c.server.cert = c.server.cert || {};

  c.ports = c.ports || {};
  if (c.ports.http == null) c.ports.http = 80;
  if (c.ports.https == null) c.ports.https = 443;
  if (c.ports.nginxInternalTls == null) c.ports.nginxInternalTls = 8443;

  c.panels = c.panels || {};
  for (const key of PANELS) {
    const p = c.panels[key];
    if (!p) continue;
    if (p.listen == null) p.listen = '127.0.0.1';
    if (p.enabled == null) p.enabled = true;
  }

  c.nginx = c.nginx || {};
  if (c.nginx.mode == null) c.nginx.mode = 'http';
  if (c.nginx.sites == null) c.nginx.sites = [];

  c.xray = c.xray || {};
  if (c.xray.inbounds == null) c.xray.inbounds = [];
  if (c.xray.logLevel == null) c.xray.logLevel = 'warning';

  c.singbox = c.singbox || {};
  if (c.singbox.inbounds == null) c.singbox.inbounds = [];
  if (c.singbox.logLevel == null) c.singbox.logLevel = 'warn';

  for (const kind of PROXY_KINDS) {
    for (const ib of c[kind].inbounds) {
      if (ib.listen == null) ib.listen = '0.0.0.0';
      if (ib.network == null) ib.network = 'tcp';
      if (ib.security == null) ib.security = 'none';
      if (ib.protocol == null) ib.protocol = 'vless';
    }
  }
  return c;
}

export function validateConfig(c) {
  const errors = [];
  const warnings = [];

  if (c.nginx.mode !== 'http' && c.nginx.mode !== 'stream') {
    errors.push(`nginx.mode must be "http" or "stream", got "${c.nginx.mode}"`);
  }
  if (!c.server.publicIp) {
    warnings.push('server.publicIp not set; client links will use a placeholder');
  }
  if (!c.server.cert.certFile || !c.server.cert.keyFile) {
    warnings.push('server.cert.certFile / keyFile not fully set; TLS blocks will be incomplete');
  }

  for (const key of PANELS) {
    const p = c.panels[key];
    if (p && p.enabled) {
      if (!p.domain) errors.push(`panels.${key}.domain is required when enabled`);
      if (!Number.isInteger(Number(p.port))) errors.push(`panels.${key}.port must be an integer`);
    }
  }

  (c.nginx.sites || []).forEach((s, i) => {
    if (!s.serverName) errors.push(`nginx.sites[${i}].serverName is required`);
  });

  const checkInbound = (ib, kind, i) => {
    const at = `${kind}.inbounds[${i}]`;
    if (!ib.tag) errors.push(`${at}.tag is required`);
    if (!Number.isInteger(Number(ib.port)) || Number(ib.port) < 1 || Number(ib.port) > 65535) {
      errors.push(`${at}.port must be an integer in 1..65535`);
    }
    if (ib.security === 'reality' && !ib.reality) {
      errors.push(`${at} security=reality requires a "reality" block`);
    }
    if (ib.security === 'tls' && (!c.server.cert.certFile || !c.server.cert.keyFile)) {
      warnings.push(`${at} security=tls but no server cert configured`);
    }
    if (ib.network === 'ws' && !ib.wsPath) {
      warnings.push(`${at} network=ws without wsPath (defaults to /ws)`);
    }
  };

  (c.xray.inbounds || []).forEach((ib, i) => checkInbound(ib, 'xray', i));
  (c.singbox.inbounds || []).forEach((ib, i) => checkInbound(ib, 'singbox', i));

  return { errors, warnings };
}
