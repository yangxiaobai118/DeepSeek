import crypto from 'node:crypto';
import { genUuid, genRealityKeypair, genShortId } from './util.js';

/** Starter config with fresh secrets, keys and UUIDs. */
export function scaffold() {
  const kp = genRealityKeypair();
  const uuid1 = genUuid();
  const uuid2 = genUuid();
  return {
    server: {
      publicIp: '203.0.113.10',
      email: 'admin@example.com',
      secret: crypto.randomBytes(32).toString('base64url'),
      domains: { web: 'www.example.com' },
      cert: {
        certFile: '/etc/uniproxy/certs/fullchain.pem',
        keyFile: '/etc/uniproxy/certs/privkey.pem',
      },
    },
    ports: { http: 80, https: 443, nginxInternalTls: 8443 },
    panels: {
      xui: { enabled: true, domain: 'xui.example.com', listen: '127.0.0.1', port: 54321 },
      sui: {
        enabled: true,
        domain: 'sui.example.com',
        listen: '127.0.0.1',
        port: 2095,
        sub: { enabled: true, domain: 'sub.example.com', port: 2096, path: '/sub/' },
      },
    },
    nginx: {
      mode: 'stream',
      http2: 'listen',
      sites: [{ serverName: 'www.example.com', root: '/var/www/html', index: 'index.html' }],
      extraSites: [],
    },
    subscription: {
      enabled: true,
      basePath: '/sub',
      publicBase: '',
      webPageUrl: '',
      supportUrl: '',
      updateIntervalHours: 12,
      profileTitle: 'uniproxy',
      routing: {
        bypassPrivate: true,
        directDomains: [],
        directCidrs: [],
        blockDomains: [],
      },
    },
    users: [],
    xray: {
      enabled: true,
      logLevel: 'warning',
      inbounds: [
        {
          tag: 'xray-vless-reality',
          protocol: 'vless',
          listen: '127.0.0.1',
          port: 10443,
          sni: 'www.bing.com',
          network: 'tcp',
          security: 'reality',
          reality: {
            dest: 'www.bing.com:443',
            serverNames: ['www.bing.com'],
            privateKey: kp.privateKey,
            shortIds: [genShortId()],
          },
          clients: [{ id: uuid1, name: 'user1', flow: 'xtls-rprx-vision' }],
        },
      ],
    },
    singbox: {
      enabled: true,
      logLevel: 'warn',
      inbounds: [
        {
          tag: 'singbox-vless-ws-tls',
          listen: '127.0.0.1',
          port: 2052,
          sni: 'singbox.example.com',
          network: 'ws',
          security: 'tls',
          path: '/sbws',
          users: [{ uuid: uuid2, name: 'sbuser', flow: '' }],
        },
      ],
    },
    apply: {
      xrayConfig: '/usr/local/etc/xray/config.json',
      singboxConfig: '/usr/local/etc/sing-box/config.json',
      nginxConfig: '/etc/nginx/nginx.conf',
      backup: true,
    },
  };
}