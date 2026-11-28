import crypto from 'node:crypto';
import { inboundClients, clientSubToken } from './clients.js';
import { sha256Hex } from './util.js';

/**
 * User registry helpers.
 *
 * Modelled on Marzban / Hiddify: a user is a first-class object that can span
 * several inbounds (and both cores), with one subscription, an expiry date and
 * an optional traffic quota. Credentials are derived deterministically from
 * server.secret so regenerating never rotates a user's UUID.
 */

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function deriveUuid(secret, ...parts) {
  const h = crypto.createHmac('sha256', secret || 'uniproxy').update(parts.join('|')).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

export function derivePassword(secret, ...parts) {
  return crypto
    .createHmac('sha256', secret || 'uniproxy')
    .update(['pw'].concat(parts).join('|'))
    .digest('base64url')
    .slice(0, 24);
}

/** Find an inbound by tag across both cores. */
export function findInbound(c, tag) {
  for (const kind of ['xray', 'singbox']) {
    for (const ib of c[kind].inbounds || []) {
      if (ib.tag === tag) return { kind, ib };
    }
  }
  return null;
}

function clientList(c, kind, ib) {
  if (Array.isArray(ib.clients)) return ib.clients;
  if (Array.isArray(ib.users)) return ib.users;
  const list = [];
  if (kind === 'xray') ib.clients = list;
  else ib.users = list;
  return list;
}

function newClientFor(kind, ib, user, secret) {
  const protocol = ib.protocol || 'vless';
  const base = { name: user.name, email: user.name, subToken: user.subToken || undefined };
  if (protocol === 'trojan') {
    return { ...base, password: user.password || derivePassword(secret, 'trojan', user.name, ib.tag) };
  }
  const id = user.uuid || deriveUuid(secret, protocol, user.name, ib.tag);
  return { ...base, id: id, uuid: id };
}

/**
 * Project the user registry onto the inbounds: reuse an existing client with
 * the same name, otherwise create one with a deterministic credential.
 */
export function userToken(c, name) {
  return sha256Hex(['user', name, c.server.publicIp || ''].join('|')).slice(0, 24);
}

export function materializeUsers(c) {
  if (!Array.isArray(c.users) || !c.users.length) return;
  const secret = c.server.secret || 'uniproxy';
  for (const user of c.users) {
    if (!user || !user.name || user.enabled === false) continue;
    const targets = [];
    if (Array.isArray(user.inbounds) && user.inbounds.length) {
      for (const tag of user.inbounds) {
        const found = findInbound(c, tag);
        if (found) targets.push(found);
      }
    } else {
      // no explicit list: bind to every inbound that already knows this user
      for (const kind of ['xray', 'singbox']) {
        for (const ib of c[kind].inbounds || []) {
          if (inboundClients(ib).some((cl) => cl.name === user.name)) targets.push({ kind, ib });
        }
      }
    }
    for (const { kind, ib } of targets) {
      const list = clientList(c, kind, ib);
      let client = list.find((cl) => (cl.name || cl.email) === user.name);
      if (!client) {
        client = newClientFor(kind, ib, user, secret);
        list.push(client);
      } else if ((ib.protocol || 'vless') === 'trojan') {
        client.password = user.password || derivePassword(secret, 'trojan', user.name, ib.tag);
      } else {
        const id = user.uuid || deriveUuid(secret, ib.protocol || 'vless', user.name, ib.tag);
        client.id = id;
        if (client.uuid !== undefined) client.uuid = id;
      }
      // one token per user across every inbound/core, so the subscription
      // aggregates the whole user (Marzban/Hiddify model)
      client.subToken = user.subToken || userToken(c, user.name);
    }
  }
}

/** Resolve registry users into their inbounds, token and account status. */
export function resolveUsers(c, now = new Date()) {
  return (c.users || []).map((user) => {
    const inbounds = [];
    for (const kind of ['xray', 'singbox']) {
      for (const ib of c[kind].inbounds || []) {
        for (const client of inboundClients(ib)) {
          if (client.name !== user.name) continue;
          if (Array.isArray(user.inbounds) && user.inbounds.length && !user.inbounds.includes(ib.tag)) continue;
          inbounds.push({ kind, tag: ib.tag, client, protocol: ib.protocol || 'vless' });
        }
      }
    }
    const first = inbounds[0];
    const token = first ? clientSubToken(c, first.client) : '';
    const usage = user.usage || {};
    const used = Number(usage.upload || 0) + Number(usage.download || 0);
    const limit = Number(user.dataLimitBytes || 0);
    const expireAt = parseDate(user.expireAt);
    let status = 'active';
    if (user.enabled === false) status = 'disabled';
    else if (expireAt && expireAt.getTime() <= now.getTime()) status = 'expired';
    else if (limit > 0 && used >= limit) status = 'quota';
    return {
      name: user.name,
      note: user.note || '',
      token,
      enabled: user.enabled !== false,
      expireAt,
      dataLimitBytes: limit,
      usage: { upload: Number(usage.upload || 0), download: Number(usage.download || 0) },
      usedBytes: used,
      status,
      inbounds,
      uuid: user.uuid || '',
      password: user.password || '',
    };
  });
}

export function formatBytes(n) {
  const v = Number(n || 0);
  if (!v) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (i === 0 ? String(x) : x.toFixed(1)) + ' ' + units[i];
}

export function formatDate(d) {
  if (!d) return '-';
  return d.toISOString().slice(0, 10);
}

export function formatUsersTable(users) {
  const header = ['USER', 'INBOUNDS', 'STATUS', 'EXPIRES', 'USAGE', 'SUBSCRIPTION'];
  const rows = users.map((u) => [
    u.name,
    u.inbounds.map((i) => i.tag).join(',') || '-',
    u.status,
    formatDate(u.expireAt),
    formatBytes(u.usedBytes) + ' / ' + formatBytes(u.dataLimitBytes),
    u.token || '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)) + 2);
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w)))].concat(rows.map(line)).join('\n');
}