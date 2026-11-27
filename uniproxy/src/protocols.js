/**
 * One protocol matrix for both cores.
 *
 * The panel does not ask "xray or sing-box?" first: you pick a protocol, and
 * the registry says which cores can serve it and which transports/securities
 * are legal. That keeps a single list in the UI and a single validation rule
 * in the backend.
 */

export const PROTOCOLS = {
  vless: { cores: ['xray', 'singbox'], transports: ['tcp', 'ws', 'grpc', 'h2'], securities: ['none', 'tls', 'reality'] },
  vmess: { cores: ['xray', 'singbox'], transports: ['tcp', 'ws', 'grpc', 'h2'], securities: ['none', 'tls'] },
  trojan: { cores: ['xray', 'singbox'], transports: ['tcp', 'ws', 'grpc'], securities: ['tls'] },
  shadowsocks: { cores: ['xray', 'singbox'], transports: ['tcp'], securities: ['none'], needs: ['method', 'password'] },
  socks: { cores: ['xray', 'singbox'], transports: ['tcp'], securities: ['none'] },
  http: { cores: ['xray', 'singbox'], transports: ['tcp'], securities: ['none'] },
  hysteria2: { cores: ['singbox'], transports: ['quic'], securities: ['tls'], needs: ['password'] },
  tuic: { cores: ['singbox'], transports: ['quic'], securities: ['tls'], needs: ['uuid', 'password'] },
};

export function protocolList() {
  return Object.keys(PROTOCOLS).map(function (name) {
    const p = PROTOCOLS[name];
    return { name: name, cores: p.cores, transports: p.transports, securities: p.securities, needs: p.needs || [] };
  });
}

export function protocolInfo(name) {
  return PROTOCOLS[name] || null;
}

/** Pick a core that can serve this protocol (xray first when both can). */
export function defaultCore(name) {
  const p = PROTOCOLS[name];
  return p ? p.cores[0] : 'xray';
}

/** Return a list of human-readable problems; empty means the combination is legal. */
export function validateChoice(protocol, core, network, security) {
  const p = PROTOCOLS[protocol];
  if (!p) return ['unknown protocol: ' + protocol];
  const errors = [];
  if (!p.cores.includes(core)) errors.push(protocol + ' is not supported by the ' + core + ' core (use ' + p.cores.join(' or ') + ')');
  if (network && !p.transports.includes(network)) errors.push(protocol + ' does not support the ' + network + ' transport (allowed: ' + p.transports.join(', ') + ')');
  if (security && !p.securities.includes(security)) errors.push(protocol + ' does not support ' + security + ' security (allowed: ' + p.securities.join(', ') + ')');
  return errors;
}
