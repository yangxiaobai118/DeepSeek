import fs from 'node:fs';
import http from 'node:http';
import { analyzePorts } from './ports.js';
import { generateLinks } from './generators/links.js';
import { generateXray } from './generators/xray.js';
import { generateSingbox } from './generators/singbox.js';
import { generateNginx } from './generators/nginx.js';
import { buildSubscriptions, subscriptionHeaders } from './subscribe.js';

const templatePath = new URL('./dashboard.html', import.meta.url);

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return '&quot;';
  });
}

function fill(tpl, token, value) {
  return tpl.split(token).join(value);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(body);
}

function render(config, cfgPath) {
  const tpl = fs.readFileSync(templatePath, 'utf8');
  const report = analyzePorts(config);
  const xray = generateXray(config);
  const singbox = generateSingbox(config);
  const nginx = generateNginx(config);
  const links = generateLinks(config);
  const subs = config.subscription.enabled ? buildSubscriptions(config) : [];
  const base = config.subscription.basePath;

  const portRows = report.entries
    .map(function (e) {
      return '<tr><td>' + esc(e.port) + '</td><td>' + esc(e.label) + '</td><td>' + esc(e.listen || '0.0.0.0') + '</td></tr>';
    })
    .join('');

  const issues = report.errors
    .map(function (x) { return '<li class="err">' + esc(x) + '</li>'; })
    .concat(report.warnings.map(function (x) { return '<li class="warn">' + esc(x) + '</li>'; }))
    .join('');
  const issueHtml = issues || '<li class="warn">no issues</li>';

  const linkItems = links
    .map(function (l) { return '<li><code>' + esc(l) + '</code></li>'; })
    .join('');
  const linkHtml = linkItems || '<li>none</li>';

  const subRows = subs
    .map(function (s) {
      const root = base + '/' + s.token;
      return '<tr><td>' + esc(s.name) + '</td>' +
        '<td><code>' + esc(root) + '</code></td>' +
        '<td><code>' + esc(root + '/json') + '</code></td>' +
        '<td><code>' + esc(root + '/clash') + '</code></td></tr>';
    })
    .join('');
  const subHtml = subRows || '<tr><td colspan="4">no clients configured</td></tr>';

  const pre = function (obj) {
    if (!obj) return '(disabled)';
    return esc(JSON.stringify(obj, null, 2));
  };

  let html = tpl;
  html = fill(html, '{{CONFIG_PATH}}', esc(cfgPath));
  html = fill(html, '{{MODE}}', esc(config.nginx.mode));
  html = fill(html, '{{PUBLIC_IP}}', esc(config.server.publicIp || 'unset'));
  html = fill(html, '{{PORT_ROWS}}', portRows);
  html = fill(html, '{{ISSUES}}', issueHtml);
  html = fill(html, '{{SUB_COUNT}}', String(subs.length));
  html = fill(html, '{{SUB_ROWS}}', subHtml);
  html = fill(html, '{{LINK_COUNT}}', String(links.length));
  html = fill(html, '{{LINK_ITEMS}}', linkHtml);
  html = fill(html, '{{XRAY_PREVIEW}}', pre(xray));
  html = fill(html, '{{SINGBOX_PREVIEW}}', pre(singbox));
  html = fill(html, '{{NGINX_PREVIEW}}', esc(nginx));
  return html;
}

export function startDashboard(config, cfgPath, port) {
  const base = config.subscription.basePath;
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/state') {
      const report = analyzePorts(config);
      const subs = config.subscription.enabled ? buildSubscriptions(config) : [];
      send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' },
        JSON.stringify(
          {
            ports: report.entries,
            errors: report.errors,
            warnings: report.warnings,
            links: generateLinks(config),
            subscriptions: subs.map(function (s) {
              return { name: s.name, token: s.token, url: base + '/' + s.token };
            }),
          },
          null,
          2,
        ));
      return;
    }

    if (config.subscription.enabled && url.pathname.startsWith(base + '/')) {
      const parts = url.pathname.slice(base.length + 1).split('/').filter(Boolean);
      const token = parts[0];
      const format = parts[1] || 'links';
      const sub = buildSubscriptions(config).find(function (s) { return s.token === token; });
      if (!sub) {
        send(res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          'unknown subscription token');
        return;
      }
      const headers = subscriptionHeaders(config, sub.title);
      if (format === 'links') {
        send(res, 200, headers, sub.base64);
      } else if (format === 'json') {
        if (!sub.singbox) {
          send(res, 404, headers, 'no sing-box compatible inbounds for this client');
          return;
        }
        send(res, 200, { ...headers, 'content-type': 'application/json; charset=utf-8' },
          JSON.stringify(sub.singbox, null, 2));
      } else if (format === 'clash') {
        send(res, 200, { ...headers, 'content-type': 'text/yaml; charset=utf-8' }, sub.clash);
      } else {
        send(res, 404, headers, 'unknown subscription format');
      }
      return;
    }

    send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      render(config, cfgPath));
  });
  server.listen(port, '127.0.0.1', function () {
    console.log('uniproxy dashboard -> http://127.0.0.1:' + port);
    if (config.subscription.enabled) {
      console.log('subscriptions   -> http://127.0.0.1:' + port + base + '/<token>[/json|/clash]');
    }
  });
  return server;
}
