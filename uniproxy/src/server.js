import fs from 'node:fs';
import http from 'node:http';
import { analyzePorts } from './ports.js';
import { generateLinks } from './generators/links.js';
import { generateXray } from './generators/xray.js';
import { generateSingbox } from './generators/singbox.js';
import { generateNginx } from './generators/nginx.js';

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

function render(config, cfgPath) {
  const tpl = fs.readFileSync(templatePath, 'utf8');
  const report = analyzePorts(config);
  const xray = generateXray(config);
  const singbox = generateSingbox(config);
  const nginx = generateNginx(config);
  const links = generateLinks(config);

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
  html = fill(html, '{{LINK_COUNT}}', String(links.length));
  html = fill(html, '{{LINK_ITEMS}}', linkHtml);
  html = fill(html, '{{XRAY_PREVIEW}}', pre(xray));
  html = fill(html, '{{SINGBOX_PREVIEW}}', pre(singbox));
  html = fill(html, '{{NGINX_PREVIEW}}', esc(nginx));
  return html;
}

export function startDashboard(config, cfgPath, port) {
  const server = http.createServer(function (req, res) {
    if (req.url === '/api/state') {
      const report = analyzePorts(config);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            ports: report.entries,
            errors: report.errors,
            warnings: report.warnings,
            links: generateLinks(config),
          },
          null,
          2,
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(render(config, cfgPath));
  });
  server.listen(port, '127.0.0.1', function () {
    console.log('uniproxy dashboard -> http://127.0.0.1:' + port);
  });
  return server;
}
