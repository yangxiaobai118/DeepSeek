import { stripUndefined } from '../util.js';

/** Build a complete sing-box config.json from the unified config. */
export function generateSingbox(c) {
  if (!c.singbox || !c.singbox.enabled) return null;
  const ctx = {
    certFile: c.server.cert.certFile,
    keyFile: c.server.cert.keyFile,
  };

  return stripUndefined({
    log: { level: c.singbox.logLevel || 'warn', timestamp: true },
    inbounds: (c.singbox.inbounds || []).map((ib) => buildInbound(ib, ctx)),
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }] },
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

  if (type === 'vless') {
    inbound.users = (ib.users || []).map((u) =>
      stripUndefined({ uuid: u.uuid, name: u.name, flow: u.flow || undefined }),
    );
  } else if (type === 'vmess') {
    inbound.users = (ib.users || []).map((u) =>
      stripUndefined({
        uuid: u.uuid,
        name: u.name,
        alterId: u.alterId == null ? 0 : u.alterId,
      }),
    );
  } else if (type === 'trojan') {
    inbound.users = (ib.users || []).map((u) =>
      stripUndefined({ password: u.password, name: u.name }),
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
    });
  } else if (ib.security === 'reality') {
    const dest = (ib.reality && ib.reality.dest) || '';
    const idx = dest.lastIndexOf(':');
    const host = idx >= 0 ? dest.slice(0, idx) : dest;
    const port = idx >= 0 ? Number(dest.slice(idx + 1)) : 443;
    inbound.tls = stripUndefined({
      enabled: true,
      server_name: ib.sni,
      reality: stripUndefined({
        enabled: true,
        handshake: stripUndefined({ server: host, server_port: port }),
        private_key: ib.reality && ib.reality.privateKey,
        short_id: (ib.reality && ib.reality.shortIds && ib.reality.shortIds[0]) || '',
      }),
    });
  }

  const network = ib.network || 'tcp';
  if (network === 'ws') {
    inbound.transport = stripUndefined({
      type: 'ws',
      path: ib.wsPath || '/ws',
      headers: ib.wsHost ? { Host: ib.wsHost } : undefined,
    });
  } else if (network === 'grpc') {
    inbound.transport = { type: 'grpc', service_name: ib.grpcService || 'grpc' };
  }

  return inbound;
}
