import fs from 'node:fs';
import path from 'node:path';
import { validateChoice } from './protocols.js';
import { PROTOCOLS, TRANSPORTS, inboundClients, clientSubToken, effectiveFlow, isPathTransport } from './clients.js';
import { materializeUsers, parseDate, findInbound } from './users.js';

const PANELS = ['xui', 'sui'];
const PROXY_KINDS = ['xray', 'singbox'];
const SECURITY = ['none', 'tls', 'reality'];

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
  const sui = c.panels.sui;
  if (sui && sui.sub) {
    const sub = sui.sub;
    if (sub.enabled == null) sub.enabled = true;
    if (sub.port == null) sub.port = 2096;
    if (sub.path == null) sub.path = '/sub/';
    if (!sub.path.endsWith('/')) sub.path += '/';
    if (sub.path[0] !== '/') sub.path = '/' + sub.path;
  }

  c.nginx = c.nginx || {};
  if (c.nginx.mode == null) c.nginx.mode = 'http';
  if (c.nginx.sites == null) c.nginx.sites = [];
  if (c.nginx.http2 == null) c.nginx.http2 = 'listen';
  if (c.nginx.extraSites == null) c.nginx.extraSites = [];
  if (c.nginx.fallback == null) c.nginx.fallback = { upstream: '', root: '' };
  if (typeof c.nginx.fallback === 'string') c.nginx.fallback = { upstream: c.nginx.fallback, root: '' };
  if (c.nginx.fallback.upstream == null) c.nginx.fallback.upstream = '';
  if (c.nginx.fallback.root == null) c.nginx.fallback.root = '';

  c.subscription = c.subscription || {};
  if (c.subscription.enabled == null) c.subscription.enabled = true;
  if (c.subscription.basePath == null) c.subscription.basePath = '/sub';
  if (!c.subscription.basePath.startsWith('/')) c.subscription.basePath = '/' + c.subscription.basePath;
  c.subscription.basePath = c.subscription.basePath.replace(/\/+$/, '');
  if (c.subscription.updateIntervalHours == null) c.subscription.updateIntervalHours = 12;
  if (c.subscription.profileTitle == null) c.subscription.profileTitle = 'uniproxy';
  if (c.subscription.publicBase == null) c.subscription.publicBase = '';
  if (c.subscription.webPageUrl == null) c.subscription.webPageUrl = '';
  if (c.subscription.supportUrl == null) c.subscription.supportUrl = '';

  c.xray = c.xray || {};
  if (c.xray.inbounds == null) c.xray.inbounds = [];
  if (c.xray.logLevel == null) c.xray.logLevel = 'warning';
  if (c.xray.stats == null) c.xray.stats = true;
  if (c.xray.apiPort == null) c.xray.apiPort = 10085;

  c.singbox = c.singbox || {};
  if (c.singbox.inbounds == null) c.singbox.inbounds = [];
  if (c.singbox.logLevel == null) c.singbox.logLevel = 'warn';
  if (c.singbox.clashApi == null) c.singbox.clashApi = true;
  if (c.singbox.clashPort == null) c.singbox.clashPort = 9090;

  for (const kind of PROXY_KINDS) {
    for (const ib of c[kind].inbounds) {
      if (ib.listen == null) ib.listen = '0.0.0.0';
      if (ib.network == null) ib.network = 'tcp';
      if (ib.security == null) ib.security = 'none';
      if (ib.protocol == null) ib.protocol = 'vless';
      // sing-box h2 spelling differs; normalise the user-facing "h2" on read
      // so links/Clash/nginx agree, and translate at generator time.
      if (kind === 'singbox' && ib.network === 'http') ib.network = 'h2';
      if (ib.fallbacks == null) ib.fallbacks = undefined;
    }
  }
  // project registry users onto inbounds before anything validates them
  materializeUsers(c);
  return c;
}

export function validateConfig(c) {
  const errors = [];
  const warnings = [];

  if (c.nginx.mode !== 'http' && c.nginx.mode !== 'stream') {
    errors.push(`nginx.mode must be "http" or "stream", got "${c.nginx.mode}"`);
  }
  if (!['listen', 'directive', 'off'].includes(c.nginx.http2)) {
    errors.push('nginx.http2 must be "listen", "directive" or "off"');
  }
  if (!c.server.publicIp) {
    warnings.push('server.publicIp not set; client links will use a placeholder');
  }
  if (!c.server.cert.certFile || !c.server.cert.keyFile) {
    warnings.push('server.cert.certFile / keyFile not fully set; TLS blocks will be incomplete');
  }
  if (!c.subscription.basePath.startsWith('/')) {
    errors.push('subscription.basePath must start with "/"');
  }
  for (const key of ['publicBase', 'webPageUrl', 'supportUrl']) {
    if (c.subscription[key] && !/^https?:\/\//.test(c.subscription[key])) {
      errors.push(`subscription.${key} must start with http:// or https://`);
    }
  }

  const routing = c.subscription.routing;
  if (typeof routing.bypassPrivate !== 'boolean') {
    errors.push('subscription.routing.bypassPrivate must be true or false');
  }
  for (const key of ['directDomains', 'directCidrs', 'blockDomains']) {
    if (!Array.isArray(routing[key])) {
      errors.push(`subscription.routing.${key} must be an array`);
      continue;
    }
    for (const value of routing[key]) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`subscription.routing.${key} entries must be non-empty strings`);
      }
    }
  }
  for (const cidr of routing.directCidrs) {
    if (typeof cidr === 'string' && !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr)) {
      errors.push(`subscription.routing.directCidrs entry "${cidr}" is not a CIDR block`);
    }
  }

  const seenUserNames = new Map();
  (c.users || []).forEach((user, i) => {
    const at = `users[${i}]`;
    if (!user || typeof user !== 'object') {
      errors.push(at + ' must be an object');
      return;
    }
    if (!user.name) errors.push(at + '.name is required');
    else if (seenUserNames.has(user.name)) {
      errors.push(`duplicate user name "${user.name}" (${seenUserNames.get(user.name)} and ${at})`);
    } else seenUserNames.set(user.name, at);

    if (user.expireAt && !parseDate(user.expireAt)) {
      errors.push(`${at}.expireAt is not a valid ISO date`);
    }
    if (user.dataLimitBytes != null) {
      const limit = Number(user.dataLimitBytes);
      if (!Number.isFinite(limit) || limit < 0) errors.push(`${at}.dataLimitBytes must be a non-negative number`);
    }
    if (user.usage) {
      for (const key of ['upload', 'download']) {
        if (user.usage[key] == null) continue;
        const value = Number(user.usage[key]);
        if (!Number.isFinite(value) || value < 0) errors.push(`${at}.usage.${key} must be a non-negative number`);
      }
    }
    if (user.inbounds != null) {
      if (!Array.isArray(user.inbounds)) {
        errors.push(`${at}.inbounds must be an array of inbound tags`);
      } else {
        for (const tag of user.inbounds) {
          if (!findInbound(c, tag)) errors.push(`${at}.inbounds references unknown inbound "${tag}"`);
        }
        if (user.inbounds.length && !c.server.secret && user.enabled !== false) {
          warnings.push(`${at} will be provisioned with a predictable credential; set server.secret (run "uniproxy init" for a new config)`);
        }
      }
    }
  });

  for (const key of PANELS) {
    const p = c.panels[key];
    if (p && p.enabled) {
      if (!p.domain) errors.push(`panels.${key}.domain is required when enabled`);
      if (!Number.isInteger(Number(p.port))) errors.push(`panels.${key}.port must be an integer`);
    }
    if (p && p.sub && p.sub.enabled) {
      if (!Number.isInteger(Number(p.sub.port))) errors.push(`panels.${key}.sub.port must be an integer`);
      if (!p.sub.domain) warnings.push(`panels.${key}.sub.domain not set; the subscription host will not be routed`);
    }
  }

  const fallback = c.nginx.fallback || {};
  if (fallback.upstream && !/^https?:\/\//i.test(fallback.upstream)) {
    errors.push('nginx.fallback.upstream must start with http:// or https://');
  }
  if (!fallback.upstream && fallback.root && !String(fallback.root).startsWith('/')) {
    errors.push('nginx.fallback.root must be an absolute path');
  }
  (c.nginx.sites || []).forEach((s, i) => {
    if (!s.serverName) errors.push(`nginx.sites[${i}].serverName is required`);
  });
  (c.nginx.extraSites || []).forEach((s, i) => {
    if (!s.serverName) errors.push(`nginx.extraSites[${i}].serverName is required`);
    if (!s.upstream) errors.push(`nginx.extraSites[${i}].upstream is required`);
  });

  const seenTags = new Map();
  const seenTokens = new Map();

  const checkInbound = (ib, kind, i) => {
    const at = `${kind}.inbounds[${i}]`;
    const tag = ib.tag || '';
    if (!tag) errors.push(`${at}.tag is required`);
    else if (seenTags.has(tag)) errors.push(`duplicate inbound tag "${tag}" (${seenTags.get(tag)} and ${at})`);
    else seenTags.set(tag, at);

    if (!Number.isInteger(Number(ib.port)) || Number(ib.port) < 1 || Number(ib.port) > 65535) {
      errors.push(`${at}.port must be an integer in 1..65535`);
    }
    for (const problem of validateChoice(ib.protocol, kind, ib.network, ib.security)) {
      errors.push(`${at}: ${problem}`);
    }
    if (ib.security === 'reality') {
      if (!ib.reality) errors.push(`${at} security=reality requires a "reality" block`);
      else {
        if (!ib.reality.privateKey) errors.push(`${at}.reality.privateKey is required`);
        if (!ib.reality.dest) errors.push(`${at}.reality.dest is required (e.g. "www.bing.com:443")`);
        if (!Array.isArray(ib.reality.serverNames) || !ib.reality.serverNames.length) {
          errors.push(`${at}.reality.serverNames must list at least one SNI`);
        }
      }
    }
    if (ib.security === 'tls' && (!c.server.cert.certFile || !c.server.cert.keyFile)) {
      warnings.push(`${at} security=tls but no server cert configured`);
    }
    if (isPathTransport(ib.network) && !ib.path && !ib.wsPath && !ib.h2Path) {
      warnings.push(`${at} network=${ib.network} without a path (defaults to /ws)`);
    }
    if (ib.fallbacks != null) {
      if (kind !== 'xray') {
        errors.push(at + '.fallbacks is Xray-only');
      } else if (!Array.isArray(ib.fallbacks)) {
        errors.push(at + '.fallbacks must be an array');
      } else if ((ib.network || 'tcp') !== 'tcp' || ib.security !== 'tls') {
        errors.push(at + '.fallbacks requires network=tcp and security=tls');
      } else {
        ib.fallbacks.forEach((fallback, j) => {
          if (!fallback || !fallback.dest) errors.push(`${at}.fallbacks[${j}].dest is required`);
        });
      }
    }

    const clients = inboundClients(ib);
    if (!clients.length) warnings.push(`${at} has no clients/users; nothing to connect with`);
    for (const client of clients) {
      const who = `${at}.clients[${client.index}]`;
      if (ib.protocol === 'trojan' && !client.password) errors.push(`${who} trojan client needs a password`);
      if (ib.protocol !== 'trojan' && !client.id) errors.push(`${who} needs a uuid/id`);
      if (client.flow && !effectiveFlow(ib, client)) {
        warnings.push(`${who} flow "${client.flow}" is only valid on vless+tcp+tls/reality over TCP; it will be dropped`);
      }
      if (c.subscription.enabled) {
        const identity = client.name;
        const token = clientSubToken(c, client);
        const previous = seenTokens.get(token);
        if (previous && previous.identity !== identity) {
          errors.push(
            `subscription token collision between ${who} and ${previous.who}; set distinct subToken values`,
          );
        } else {
          seenTokens.set(token, { identity, who });
        }
      }
    }
  };

  (c.xray.inbounds || []).forEach((ib, i) => checkInbound(ib, 'xray', i));
  (c.singbox.inbounds || []).forEach((ib, i) => checkInbound(ib, 'singbox', i));

  if (!c.xray.enabled) warnings.push('xray.enabled is false; no Xray config will be generated');
  if (!c.singbox.enabled) warnings.push('singbox.enabled is false; no sing-box config will be generated');

  if (c.apply) {
    for (const key of ['xrayConfig', 'singboxConfig', 'nginxConfig']) {
      const p = c.apply[key];
      if (p && !path.isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) {
        warnings.push(`apply.${key} "${p}" is not an absolute path`);
      }
    }
  }

  return { errors, warnings };
}