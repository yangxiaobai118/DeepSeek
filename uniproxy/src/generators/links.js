import { x25519PublicFromPrivate } from '../util.js';
import {
  inboundClients,
  clientRemark,
  clientSubToken,
  effectiveFlow,
  isPathTransport,
} from '../clients.js';

/**
 * Client share links. In stream mode the public entrypoint is 443 (nginx
 * stream), so links must point at ports.https even though the inbound itself
 * listens on a loopback port.
 *
 * Every client of every inbound gets its own link: subscriptions are
 * per-client in a multi-user setup (s-ui-x models the same thing).
 */
export function generateLinkRecords(c, options = {}) {
  const streamMode = c.nginx.mode === 'stream';
  const records = [];

  for (const kind of ['xray', 'singbox']) {
    const block = c[kind];
    if (!block || block.enabled === false) continue;
    for (const ib of block.inbounds || []) {
      const port = streamMode ? Number(c.ports.https) : Number(ib.port);
      const clients = inboundClients(ib);
      let chosen = clients;
      if (options.client != null) {
        chosen = clients.filter(
          (cl) => cl.name === options.client || String(cl.index) === String(options.client),
        );
      }
      for (const client of chosen) {
        const record = buildRecord(c, kind, ib, client, port, options);
        if (record) records.push(record);
      }
    }
  }
  return records;
}

/** Back-compat: plain URI list, optionally filtered to one client. */
export function generateLinks(c, options = {}) {
  return generateLinkRecords(c, options).map((r) => r.uri);
}

function buildRecord(c, kind, ib, client, port, options) {
  const addr = options.address || c.server.publicIp || 'YOUR_SERVER_IP';
  const proto = ib.protocol || 'vless';
  const remark = clientRemark(ib, client);
  let uri = null;
  if (proto === 'vless') uri = vlessLink(addr, port, ib, client, remark);
  else if (proto === 'vmess') uri = vmessLink(addr, port, ib, client, remark);
  else if (proto === 'trojan') uri = trojanLink(addr, port, ib, client, remark);
  if (!uri) return null;
  return {
    uri,
    remark,
    tag: ib.tag,
    client: client.name,
    clientId: client.id,
    kind,
    protocol: proto,
    inbound: ib,
    flow: effectiveFlow(ib, client),
    token: clientSubToken(c, client),
    server: addr,
    port,
  };
}

function transportParams(params, ib) {
  const network = ib.network || 'tcp';
  const host = ib.host || ib.wsHost || ib.httpHost;
  const path = ib.path || ib.wsPath || ib.h2Path || (network === 'ws' ? '/ws' : '/');

  params.set('type', network);
  if (isPathTransport(network)) params.set('path', path);
  if (network === 'grpc') {
    params.set('serviceName', ib.grpcService || 'grpc');
  }
  if (host && network !== 'grpc') params.set('host', host);
  if (network === 'xhttp') params.set('mode', ib.xhttpMode || 'auto');
}

function tlsParams(params, ib, client) {
  const security = ib.security || 'none';
  if (security === 'none') return;
  params.set('security', security);
  if (ib.sni) params.set('sni', ib.sni);
  if ((ib.network || 'tcp') === 'h2') params.set('alpn', 'h2,http/1.1');
  params.set('fp', ib.fingerprint || 'chrome');
  if (security === 'reality') {
    try {
      params.set('pbk', x25519PublicFromPrivate(ib.reality.privateKey));
    } catch {
      params.set('pbk', 'REPLACE_PUBLIC_KEY');
    }
    const sid = (ib.reality.shortIds && ib.reality.shortIds[0]) || '';
    if (sid) params.set('sid', sid);
    if (ib.reality.spiderX) params.set('spx', ib.reality.spiderX);
  }
  const flow = effectiveFlow(ib, client);
  if (flow) params.set('flow', flow);
}

function vlessLink(addr, port, ib, client, remark) {
  const uuid = client.id || 'REPLACE_UUID';
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  transportParams(params, ib);
  tlsParams(params, ib, client);
  return `vless://${uuid}@${addr}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
}

function vmessLink(addr, port, ib, client, remark) {
  const network = ib.network || 'tcp';
  const host = ib.host || ib.wsHost || ib.httpHost;
  const path = ib.path || ib.wsPath || ib.h2Path || (network === 'ws' ? '/ws' : '');
  const payload = {
    v: '2',
    ps: remark,
    add: addr,
    port: String(port),
    id: client.id || 'REPLACE_UUID',
    aid: String(client.alterId == null ? 0 : client.alterId),
    scy: 'auto',
    net: network,
    type: 'none',
    host: host || '',
    path,
    tls: ib.security === 'tls' || ib.security === 'reality' ? 'tls' : '',
    sni: ib.sni || '',
    fp: ib.fingerprint || '',
    alpn: network === 'h2' ? 'h2,http/1.1' : '',
  };
  return 'vmess://' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function trojanLink(addr, port, ib, client, remark) {
  const password = client.password || 'REPLACE_PASSWORD';
  const params = new URLSearchParams();
  params.set('security', ib.security || 'none');
  if (ib.sni) params.set('sni', ib.sni);
  transportParams(params, ib);
  if (ib.alpn) params.set('alpn', ib.alpn);
  return `trojan://${encodeURIComponent(password)}@${addr}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
}