import { stripUndefined } from '../util.js';
import { effectiveFlow, singboxTransportName } from '../clients.js';

/** Build a complete sing-box config.json from the unified config. */
export function generateSingbox(c) {
  if (!c.singbox || !c.singbox.enabled) return null;
  const ctx = {
    certFile: c.server.cert.certFile,
    keyFile: c.server.cert.keyFile,
  };

  const clashOn = c.singbox.clashApi !== false;
  const clashPort = Number(c.singbox.clashPort || 9090);

  return stripUndefined({
    log: { level: c.singbox.logLevel || 'warn', timestamp: true },
    inbounds: (c.singbox.inbounds || []).map((ib) => buildInbound(ib, ctx)),
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }] },
    experimental: clashOn
      ? { clash_api: { external_controller: '127.0.0.1:' + clashPort, default_mode: 'direct' } }
      : undefined,
  });
}

function buildInbound(ib, ctx) {
  const type = ib.protocol || 'vless';
  const inbound = {
    type,
    tag: ib.tag,
    listen: ib.listen || '0.0.0.0',
    listen_port: Number(ib.port),
  };

  const users = Array.isArray(ib.users) ? ib.users : ib.clients || [];

  if (type === 'vless') {
    inbound.users = users.map((u) =>
      stripUndefined({ uuid: u.uuid || u.id, name: u.name || u.email, flow: effectiveFlow(ib, u) || undefined }),
    );
  } else if (type === 'vmess') {
    inbound.users = users.map((u) =>
      stripUndefined({
        uuid: u.uuid || u.id,
        name: u.name || u.email,
        alterId: u.alterId == null ? 0 : u.alterId,
      }),
    );
  } else if (type === 'trojan') {
    // sing-box has no top-level trojan password: only per-user "users".
    inbound.users = users.map((u) =>
      stripUndefined({ password: u.password, name: u.name || u.email }),
    );
  } else {
    throw new Error('unsupported sing-box protocol: ' + type);
  }

  if (ib.security === 'tls') {
    inbound.tls = stripUndefined({
      enabled: true,
      certificate_path: ctx.certFile,
      key_path: ctx.keyFile,
      server_name: ib.sni,
      alpn: (ib.network || 'tcp') === 'h2' ? ['h2', 'http/1.1'] : undefined,
    });
  } else if (ib.security === 'reality') {
    const dest = (ib.reality && ib.reality.dest) || '';
    const idx = dest.lastIndexOf(':');
    const host = idx >= 0 ? dest.slice(0, idx) : dest;
    const port = idx >= 0 ? Number(dest.slice(idx + 1)) : 443;
    inbound.tls = stripUndefined({
      enabled: true,
      server_name: ib.sni,
      alpn: (ib.network || 'tcp') === 'h2' ? ['h2', 'http/1.1'] : undefined,
      reality: stripUndefined({
        enabled: true,
        handshake: stripUndefined({ server: host, server_port: port }),
        private_key: ib.reality && ib.reality.privateKey,
        short_id: (ib.reality && ib.reality.shortIds && ib.reality.shortIds[0]) || '',
      }),
    });
  }

  const network = ib.network || 'tcp';
  const host = ib.host || ib.wsHost || ib.httpHost;
  const path = ib.path || ib.wsPath || ib.h2Path || (network === 'ws' ? '/ws' : '/');
  const transportType = singboxTransportName(network);

  if (network === 'ws') {
    inbound.transport = stripUndefined({
      type: 'ws',
      path,
      headers: host ? { Host: host } : undefined,
    });
  } else if (network === 'grpc') {
    inbound.transport = { type: 'grpc', service_name: ib.grpcService || 'grpc' };
  } else if (network === 'h2') {
    inbound.transport = stripUndefined({
      type: 'http',
      path,
      host: host ? [host] : undefined,
    });
  } else if (network === 'httpupgrade') {
    inbound.transport = stripUndefined({
      type: 'httpupgrade',
      path,
      host: host ? [host] : undefined,
    });
  } else if (network === 'xhttp') {
    throw new Error('sing-box does not support the xhttp transport; use it only under xray');
  }
  if (transportType === 'tcp') delete inbound.transport;

  return inbound;
}
