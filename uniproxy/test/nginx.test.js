import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from './helpers.js';
import { generateNginx } from '../src/generators/nginx.js';

test('stream mode owns 443 and routes SNI to every inbound', () => {
  const conf = generateNginx(makeConfig());
  assert.match(conf, /map \$ssl_preread_server_name/);
  assert.match(conf, /ssl_preread on;/);
  assert.match(conf, /www\.bing\.com\s+127\.0\.0\.1:10443;/);
  assert.match(conf, /singbox\.example\.net\s+127\.0\.0\.1:2052;/);
  assert.match(conf, /sub\.example\.net\s+127\.0\.0\.1:8443;/);
  assert.match(conf, /listen 127\.0\.0\.1:8443 ssl http2;/);
  assert.doesNotMatch(conf, /listen 443 ssl/);
});

test('http mode terminates TLS on 443 directly', () => {
  const c = makeConfig();
  c.nginx.mode = 'http';
  const conf = generateNginx(c);
  assert.match(conf, /listen 443 ssl http2;/);
  assert.doesNotMatch(conf, /stream \{/);
});

test('http2 directive style avoids the deprecated listen flag', () => {
  const c = makeConfig();
  c.nginx.http2 = 'directive';
  const conf = generateNginx(c);
  assert.match(conf, /http2 on;/);
  assert.doesNotMatch(conf, /ssl http2/);
});

test('panel subscriptions are proxied with no-store and security headers', () => {
  const conf = generateNginx(makeConfig());
  assert.match(conf, /location \/sub\/ \{/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:2096;/);
  assert.match(conf, /add_header Cache-Control "no-store" always;/);
  assert.match(conf, /Strict-Transport-Security/);
});

test('websocket connection header uses the upgrade map', () => {
  const conf = generateNginx(makeConfig());
  assert.match(conf, /map \$http_upgrade \$connection_upgrade/);
  assert.match(conf, /proxy_set_header Connection \$connection_upgrade;/);
});

test('extra sites are proxied and routed', () => {
  const c = makeConfig();
  c.nginx.extraSites = [{ serverName: 'app.example.net', upstream: '127.0.0.1:3000' }];
  const conf = generateNginx(c);
  assert.match(conf, /server_name app\.example\.net;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(conf, /app\.example\.net\s+127\.0\.0\.1:8443;/);
});
