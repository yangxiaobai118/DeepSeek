import { applyDefaults } from '../src/config.js';
import { genRealityKeypair, genUuid, genShortId } from '../src/util.js';

/** A minimal, valid config used across the test suite. */
export function makeConfig(overrides = {}) {
  const kp = genRealityKeypair();
  const base = {
    server: {
      publicIp: '45.77.12.34',
      email: 'ops@example.net',
      secret: ['test', 'secret', 'fixture'].join('-'),
      domains: { web: 'www.example.net' },
      cert: { certFile: '/etc/uniproxy/fullchain.pem', keyFile: '/etc/uniproxy/privkey.pem' },
    },
    ports: { http: 80, https: 443, nginxInternalTls: 8443 },
    panels: {
      xui: { enabled: true, domain: 'xui.example.net', listen: '127.0.0.1', port: 54321 },
      sui: {
        enabled: true,
        domain: 'sui.example.net',
        listen: '127.0.0.1',
        port: 2095,
        sub: { enabled: true, domain: 'sub.example.net', port: 2096, path: '/sub/' },
      },
    },
    nginx: { mode: 'stream', http2: 'listen', sites: [{ serverName: 'www.example.net', root: '/var/www/html' }] },
    subscription: {
      enabled: true,
      basePath: '/sub',
      publicBase: '',
      webPageUrl: '',
      supportUrl: '',
      updateIntervalHours: 12,
      profileTitle: 'uniproxy',
      routing: { bypassPrivate: true, directDomains: [], directCidrs: [], blockDomains: [] },
    },
    users: [],
    xray: {
      enabled: true,
      logLevel: 'warning',
      inbounds: [
        {
          tag: 'reality-in',
          protocol: 'vless',
          listen: '127.0.0.1',
          port: 10443,
          sni: 'www.bing.com',
          network: 'tcp',
          security: 'reality',
          reality: { dest: 'www.bing.com:443', serverNames: ['www.bing.com'], privateKey: kp.privateKey, shortIds: [genShortId()] },
          clients: [
            { id: genUuid(), name: 'alice', flow: 'xtls-rprx-vision' },
            { id: genUuid(), name: 'bob' },
          ],
        },
      ],
    },
    singbox: {
      enabled: true,
      logLevel: 'warn',
      inbounds: [
        {
          tag: 'ws-in',
          protocol: 'vless',
          listen: '127.0.0.1',
          port: 2052,
          sni: 'sb.example.net',
          network: 'ws',
          security: 'tls',
          path: '/wspath',
          users: [{ uuid: genUuid(), name: 'carol' }],
        },
      ],
    },
  };
  return applyDefaults(merge(base, overrides));
}

function merge(target, source) {
  if (!source) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      merge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}