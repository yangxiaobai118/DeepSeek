import { sha256Hex } from './util.js';

/** Protocols uniproxy can generate for both cores today. */
export const PROTOCOLS = ['vless', 'vmess', 'trojan'];

/**
 * Transport matrix, kept in one place so generators, links, Clash output and
 * the validator never disagree about what a core can actually dial.
 *
 * xray  : tcp, ws, grpc, h2, httpupgrade, xhttp
 * singbox: tcp, ws, grpc, http (h2), httpupgrade
 */
export const TRANSPORTS = {
  xray: ['tcp', 'ws', 'grpc', 'h2', 'httpupgrade', 'xhttp'],
  singbox: ['tcp', 'ws', 'grpc', 'h2', 'httpupgrade'],
};

/** sing-box spells HTTP/2 as "http"; links and Clash spell it "h2". */
export function singboxTransportName(network) {
  return network === 'h2' ? 'http' : network;
}

/** Clash/Mihomo network name for a uniproxy transport. */
export function clashNetworkName(network) {
  return network === 'h2' ? 'http' : network;
}

/** Xray/sing-box transport names that carry an HTTP-style path. */
export function isPathTransport(network) {
  return network === 'ws' || network === 'httpupgrade' || network === 'xhttp' || network === 'h2';
}

/**
 * Clients of an inbound, normalised across both schemas:
 * xray uses clients[{id,email,flow}], sing-box uses users[{uuid,name,flow}].
 */
export function inboundClients(ib) {
  const list = Array.isArray(ib.clients) ? ib.clients : Array.isArray(ib.users) ? ib.users : [];
  return list.map((raw, index) => normalizeClient(raw, index));
}

export function normalizeClient(raw, index) {
  const id = raw.id || raw.uuid || raw.password || '';
  return {
    ...raw,
    index,
    id,
    password: raw.password,
    name: raw.name || raw.email || 'user' + (index + 1),
    flow: raw.flow || '',
    subToken: raw.subToken || '',
  };
}

/**
 * Stable per-client subscription token. Derived from a secret (uuid/password)
 * so the subscription URL never leaks the credential itself and stays stable
 * across regenerations.
 */
export function clientSubToken(config, client) {
  if (client.subToken) return String(client.subToken);
  return sha256Hex([client.name, client.id, config.server.publicIp || ''].join('|')).slice(0, 24);
}

/** Port clients dial: in stream mode everything is reached through 443. */
export function publicPortFor(config, ib) {
  return config.nginx.mode === 'stream' ? Number(config.ports.https) : Number(ib.port);
}

/**
 * xtls-rprx-vision is only legal on VLESS over plain TCP with TLS/Reality.
 * Xray rejects the whole inbound otherwise, so drop the flow instead of
 * emitting an unusable config (s-ui-x strips it for the same reason).
 */
export function effectiveFlow(ib, client) {
  if (!client.flow) return '';
  if ((ib.protocol || 'vless') !== 'vless') return '';
  if ((ib.network || 'tcp') !== 'tcp') return '';
  if (!ib.security || ib.security === 'none') return '';
  return client.flow;
}

/** Human caption used in link remarks and subscription file names. */
export function clientRemark(ib, client) {
  return ib.tag + '-' + client.name;
}

/** A stable, filesystem/URL-safe slug for generated subscription files. */
export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'sub';
}