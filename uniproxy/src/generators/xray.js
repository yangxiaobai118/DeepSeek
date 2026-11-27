import { stripUndefined } from '../util.js';
import { effectiveFlow } from '../clients.js';

/** Build a complete Xray config.json from the unified config. */
export function generateXray(c) {
  if (!c.xray || !c.xray.enabled) return null;
  const ctx = {
    certFile: c.server.cert.certFile,
    keyFile: c.server.cert.keyFile,
  };

  const statsOn = c.xray.stats !== false;
  const apiPort = Number(c.xray.apiPort || 10085);
  const inbounds = (c.xray.inbounds || []).map((ib) => buildInbound(ib, ctx));
  if (statsOn) {
    inbounds.push({
      tag: 'api',
      listen: '127.0.0.1',
      port: apiPort,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
      sniffing: { enabled: false },
    });
  }
  const rules = [];
  if (statsOn) rules.push({ type: 'field', inboundTag: ['api'], outboundTag: 'api' });
  rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'block' });

  return stripUndefined({
    log: { loglevel: c.xray.logLevel || 'warning' },
    stats: statsOn ? {} : undefined,
    api: statsOn ? { tag: 'api', services: ['StatsService'] } : undefined,
    policy: statsOn
      ? {
          levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
          system: { statsInboundUplink: true, statsInboundDownlink: true },
        }
      : undefined,
    inbounds,
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: { domainStrategy: 'AsIs', rules },
  });
}

function buildInbound(ib, ctx) {
  const protocol = ib.protocol || 'vless';
  const settings = buildSettings(protocol, ib);
  if (Array.isArray(ib.fallbacks) && ib.fallbacks.length) {
    settings.fallbacks = ib.fallbacks.map((fallback) =>
      stripUndefined({
        dest: fallback.dest,
        path: fallback.path,
        name: fallback.name,
        alpn: fallback.alpn,
        xver: fallback.xver,
      }),
    );
  }
  return stripUndefined({
    tag: ib.tag,
    listen: ib.listen || '0.0.0.0',
    port: Number(ib.port),
    protocol,
    settings,
    streamSettings: buildStream(ib, ctx),
    sniffing:
      ib.sniff === false
        ? undefined
        : { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  });
}

function buildSettings(protocol, ib) {
  const clients = Array.isArray(ib.clients) ? ib.clients : ib.users || [];
  if (protocol === 'vless') {
    return {
      clients: clients.map((cl) =>
        stripUndefined({
          id: cl.id || cl.uuid,
          email: cl.email || cl.name,
          flow: effectiveFlow(ib, cl) || undefined,
        }),
      ),
      decryption: 'none',
    };
  }
  if (protocol === 'vmess') {
    return {
      clients: clients.map((cl) =>
        stripUndefined({
          id: cl.id || cl.uuid,
          email: cl.email || cl.name,
          alterId: cl.alterId == null ? 0 : cl.alterId,
        }),
      ),
    };
  }
  if (protocol === 'trojan') {
    return {
      clients: clients.map((cl) =>
        stripUndefined({ password: cl.password, email: cl.email || cl.name }),
      ),
    };
  }
  throw new Error('unsupported xray protocol: ' + protocol);
}

function buildStream(ib, ctx) {
  const network = ib.network || 'tcp';
  const security = ib.security || 'none';
  const ss = { network, security };
  const host = ib.host || ib.wsHost || ib.httpHost;
  const path = ib.path || ib.wsPath || ib.h2Path || (network === 'ws' ? '/ws' : '/');

  if (network === 'ws') {
    ss.wsSettings = stripUndefined({
      path,
      headers: host ? { Host: host } : undefined,
    });
  } else if (network === 'grpc') {
    ss.grpcSettings = stripUndefined({
      serviceName: ib.grpcService || 'grpc',
      multiMode: ib.grpcMultiMode === true ? true : undefined,
    });
  } else if (network === 'h2') {
    ss.httpSettings = stripUndefined({ path, host: host ? [host] : undefined });
  } else if (network === 'httpupgrade') {
    ss.httpupgradeSettings = stripUndefined({ path, host: host || undefined });
  } else if (network === 'xhttp') {
    ss.xhttpSettings = stripUndefined({
      path,
      host: host || undefined,
      mode: ib.xhttpMode || 'auto',
    });
  }

  if (security === 'tls') {
    ss.tlsSettings = stripUndefined({
      serverName: ib.sni,
      alpn: network === 'h2' ? ['h2', 'http/1.1'] : ['http/1.1'],
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
      spiderX: ib.reality && ib.reality.spiderX,
    });
  }
  return ss;
}