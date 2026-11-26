import { stripUndefined } from '../util.js';

/** Build a complete Xray config.json from the unified config. */
export function generateXray(c) {
  if (!c.xray || !c.xray.enabled) return null;
  const ctx = {
    certFile: c.server.cert.certFile,
    keyFile: c.server.cert.keyFile,
  };

  return stripUndefined({
    log: { loglevel: c.xray.logLevel || 'warning' },
    inbounds: (c.xray.inbounds || []).map((ib) => buildInbound(ib, ctx)),
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'block' }],
    },
  });
}

function buildInbound(ib, ctx) {
  const protocol = ib.protocol || 'vless';
  return stripUndefined({
    tag: ib.tag,
    listen: ib.listen || '0.0.0.0',
    port: Number(ib.port),
    protocol,
    settings: buildSettings(protocol, ib),
    streamSettings: buildStream(ib, ctx),
    sniffing:
      ib.sniff === false
        ? undefined
        : { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  });
}

function buildSettings(protocol, ib) {
  if (protocol === 'vless') {
    return {
      clients: (ib.clients || []).map((cl) =>
        stripUndefined({ id: cl.id, email: cl.email, flow: cl.flow }),
      ),
      decryption: 'none',
    };
  }
  if (protocol === 'vmess') {
    return {
      clients: (ib.clients || []).map((cl) =>
        stripUndefined({
          id: cl.id,
          email: cl.email,
          alterId: cl.alterId == null ? 0 : cl.alterId,
        }),
      ),
    };
  }
  if (protocol === 'trojan') {
    return {
      clients: (ib.clients || []).map((cl) =>
        stripUndefined({ password: cl.password, email: cl.email }),
      ),
    };
  }
  throw new Error('unsupported xray protocol: ' + protocol);
}

function buildStream(ib, ctx) {
  const network = ib.network || 'tcp';
  const security = ib.security || 'none';
  const ss = { network, security };

  if (network === 'ws') {
    ss.wsSettings = stripUndefined({
      path: ib.wsPath || '/ws',
      headers: ib.wsHost ? { Host: ib.wsHost } : undefined,
    });
  } else if (network === 'grpc') {
    ss.grpcSettings = { serviceName: ib.grpcService || 'grpc' };
  } else if (network === 'h2') {
    ss.httpSettings = stripUndefined({
      path: ib.h2Path || '/',
      host: ib.wsHost ? [ib.wsHost] : undefined,
    });
  }

  if (security === 'tls') {
    ss.tlsSettings = stripUndefined({
      serverName: ib.sni,
      alpn: ['h2', 'http/1.1'],
      certificates: [{ certificateFile: ctx.certFile, keyFile: ctx.keyFile }],
    });
  } else if (security === 'reality') {
    ss.realitySettings = stripUndefined({
      show: false,
      dest: ib.reality && ib.reality.dest,
      serverNames: ib.reality && ib.reality.serverNames,
      privateKey: ib.reality && ib.reality.privateKey,
      shortIds: ib.reality && ib.reality.shortIds && ib.reality.shortIds.length
        ? ib.reality.shortIds
        : [''],
    });
  }
  return ss;
}
