import { generateLinkRecords } from './generators/links.js';
import { generateClash } from './generators/clash.js';
import { slugify } from './clients.js';
import { x25519PublicFromPrivate, stripUndefined } from './util.js';
import { resolveUsers } from './users.js';

/**
 * Per-client subscriptions in the three formats s-ui-x serves: base64 link
 * list (v2rayN/NekoBox), sing-box profile JSON, Clash/Mihomo YAML.
 */
export function buildSubscriptions(c) {
  const records = generateLinkRecords(c);
  const users = new Map(resolveUsers(c).map((user) => [user.token, user]));
  const groups = new Map();

  for (const record of records) {
    const key = record.token;
    let group = groups.get(key);
    if (!group) {
      group = { token: key, name: record.client, records: [] };
      groups.set(key, group);
    }
    group.records.push(record);
  }

  const out = [];
  for (const group of groups.values()) {
    group.user = users.get(group.token) || null;
    const links = group.records.map((r) => r.uri);
    const singbox = buildSingboxProfile(c, group);
    const clash = generateClash(c, group.records);
    const represented = singbox ? singbox.outbounds.length - 1 : 0;
    out.push({
      token: group.token,
      name: group.name,
      slug: slugify(group.name),
      title: c.subscription.profileTitle + ' - ' + group.name,
      links,
      base64: Buffer.from(links.join('\n') + '\n', 'utf8').toString('base64'),
      singbox,
      clash,
      user: group.user,
      status: group.user ? group.user.status : 'active',
      skipped: group.records.length - represented,
    });
  }
  return out;
}

function buildSingboxProfile(c, group) {
  const outbounds = [];
  for (const record of group.records) {
    const outbound = clientOutbound(record);
    if (outbound) outbounds.push(outbound);
  }
  if (!outbounds.length) return null;
  const first = outbounds[0].tag;
  const routing = (c.subscription && c.subscription.routing) || {};
  const rules = [];
  if (routing.bypassPrivate !== false) rules.push({ ip_is_private: true, outbound: 'direct' });
  if (routing.directDomains && routing.directDomains.length) {
    rules.push({ domain_suffix: routing.directDomains, outbound: 'direct' });
  }
  if (routing.directCidrs && routing.directCidrs.length) {
    rules.push({ ip_cidr: routing.directCidrs, outbound: 'direct' });
  }
  const blockDomains = routing.blockDomains || [];
  if (blockDomains.length) rules.push({ domain_suffix: blockDomains, outbound: 'block' });
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30'],
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
      },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: outbounds.concat(
      blockDomains.length
        ? [{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }]
        : [{ type: 'direct', tag: 'direct' }],
    ),
    route: stripUndefined({ auto_detect_interface: true, rules: rules.length ? rules : undefined, final: first }),
  };
}

function clientOutbound(record) {
  const ib = record.inbound;
  const network = ib.network || 'tcp';
  if (network === 'xhttp') return null; // sing-box has no xhttp transport

  const out = {
    type: record.protocol,
    tag: record.remark,
    server: record.server,
    server_port: Number(record.port),
  };

  if (record.protocol === 'trojan') out.password = record.clientId;
  else {
    out.uuid = record.clientId;
    if (record.protocol === 'vmess') {
      out.security = 'auto';
      out.alter_id = 0;
    }
    if (record.protocol === 'vless' && record.flow) out.flow = record.flow;
  }

  const tls = ib.security === 'tls' || ib.security === 'reality';
  if (tls) {
    out.tls = stripUndefined({
      enabled: true,
      server_name: ib.sni,
      utls: { enabled: true, fingerprint: ib.fingerprint || 'chrome' },
      alpn: network === 'h2' ? ['h2', 'http/1.1'] : undefined,
      reality:
        ib.security === 'reality'
          ? stripUndefined({
              enabled: true,
              public_key: realityPublicKey(ib),
              short_id: (ib.reality && ib.reality.shortIds && ib.reality.shortIds[0]) || '',
            })
          : undefined,
    });
  }

  const host = ib.host || ib.wsHost || ib.httpHost;
  const path = ib.path || ib.wsPath || ib.h2Path || (network === 'ws' ? '/ws' : '/');
  if (network === 'ws') {
    out.transport = stripUndefined({
      type: 'ws',
      path,
      headers: host ? { Host: host } : undefined,
    });
  } else if (network === 'grpc') {
    out.transport = { type: 'grpc', service_name: ib.grpcService || 'grpc' };
  } else if (network === 'h2') {
    out.transport = stripUndefined({ type: 'http', path, host: host ? [host] : undefined });
  } else if (network === 'httpupgrade') {
    out.transport = stripUndefined({ type: 'httpupgrade', path, host: host ? [host] : undefined });
  }

  return stripUndefined(out);
}

function realityPublicKey(ib) {
  if (ib.reality && ib.reality.publicKey) return ib.reality.publicKey;
  try {
    return x25519PublicFromPrivate(ib.reality.privateKey);
  } catch {
    return 'REPLACE_PUBLIC_KEY';
  }
}

/** Header set used by the dashboard subscription endpoints. */
export function subscriptionHeaders(c, title, user) {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'profile-title': title,
    'profile-update-interval': String(c.subscription.updateIntervalHours || 12),
    'x-content-type-options': 'nosniff',
  };
  if (c.subscription.webPageUrl) headers['profile-web-page-url'] = c.subscription.webPageUrl;
  if (c.subscription.supportUrl) headers['support-url'] = c.subscription.supportUrl;
  if (user && (user.dataLimitBytes || user.expireAt || user.usedBytes)) {
    const expire = user.expireAt ? Math.floor(user.expireAt.getTime() / 1000) : 0;
    headers['subscription-userinfo'] =
      'upload=' + user.usage.upload + '; download=' + user.usage.download +
      '; total=' + (user.dataLimitBytes || 0) + '; expire=' + expire;
  }
  return headers;
}