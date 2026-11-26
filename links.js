import { x25519PublicFromPrivate } from '../util.js';

/**
 * Client share links. In stream mode the public entrypoint is 443 (nginx
 * stream), so links must point at ports.https even though the inbound itself
 * listens on a loopback port.
 */
export function generateLinks(c) {
  const addr = c.server.publicIp || 'YOUR_SERVER_IP';
  const streamMode = c.nginx.mode === 'stream';
  const links = [];

  for (const ib of c.xray.inbounds || []) {
    const port = streamMode ? c.ports.https : ib.port;
    const proto = ib.protocol || 'vless';
    if (proto === 'vless') links.push(vlessLink(addr, port, ib));
    else if (proto === 'vmess') links.push(vmessLink(addr, port, ib));
    else if (proto === 'trojan') links.push(trojanLink(addr, port, ib));
  }
  for (const ib of c.singbox.inbounds || []) {
    const port = streamMode ? c.ports.https : ib.port;
    const proto = ib.protocol || 'vless';
    if (proto === 'vless') links.push(vlessLink(addr, port, ib, true));
    else if (proto === 'vmess') links.push(vmessLink(addr, port, ib, true));
    else if (proto === 'trojan') links.push(trojanLink(addr, port, ib));
  }
  return links;
}

function vlessLink(addr, port, ib, singbox = false) {
  const user = (ib.clients && ib.clients[0]) || (ib.users && ib.users[0]) || {};
  const uuid = user.id || user.uuid || 'REPLACE_UUID';
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('security', ib.security || 'none');
  if (ib.sni) params.set('sni', ib.sni);
  params.set('type', ib.network || 'tcp');
  if (ib.network === 'ws') params.set('path', ib.wsPath || '/ws');
  if (ib.network === 'grpc') params.set('serviceName', ib.grpcService || 'grpc');
  if (ib.wsHost) params.set('host', ib.wsHost);
  if (ib.security === 'reality') {
    params.set('fp', 'chrome');
    try {
      params.set('pbk', x25519PublicFromPrivate(ib.reality.privateKey));
    } catch {
      params.set('pbk', 'REPLACE_PUBLIC_KEY');
    }
    const sid = (ib.reality.shortIds && ib.reality.shortIds[0]) || '';
    params.set('sid', sid);
  }
  if (user.flow) params.set('flow', user.flow);
  return `vless://${uuid}@${addr}:${port}?${params.toString()}#${encodeURIComponent(ib.tag)}`;
}

function vmessLink(addr, port, ib, singbox = false) {
  const user = (ib.clients && ib.clients[0]) || (ib.users && ib.users[0]) || {};
  const payload = {
    v: '2',
    ps: ib.tag,
    add: addr,
    port: String(port),
    id: user.id || user.uuid || 'REPLACE_UUID',
    aid: String(user.alterId == null ? 0 : user.alterId),
    scy: 'auto',
    net: ib.network || 'tcp',
    type: 'none',
    host: ib.wsHost || '',
    path: ib.wsPath || '',
    tls: ib.security === 'tls' ? 'tls' : '',
    sni: ib.sni || '',
  };
  return 'vmess://' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function trojanLink(addr, port, ib) {
  const user = (ib.clients && ib.clients[0]) || (ib.users && ib.users[0]) || {};
  const password = user.password || 'REPLACE_PASSWORD';
  const params = new URLSearchParams();
  if (ib.sni) params.set('sni', ib.sni);
  params.set('type', ib.network || 'tcp');
  if (ib.network === 'ws') params.set('path', ib.wsPath || '/ws');
  return `trojan://${encodeURIComponent(password)}@${addr}:${port}?${params.toString()}#${encodeURIComponent(ib.tag)}`;
}
