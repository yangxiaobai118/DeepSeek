/**
 * Port arithmetic for the fused host.
 *
 * Rules:
 *  - nginx owns 80/443 (http mode) or 443 only (stream mode).
 *  - in stream mode every proxy inbound MUST bind loopback and MUST NOT use 443.
 *  - panels should bind loopback and be reached through nginx.
 */

export function collectPorts(c) {
  const entries = [];
  const add = (port, label, meta = {}) => {
    if (port === undefined || port === null || port === '') return;
    entries.push({ port: Number(port), label, ...meta });
  };

  add(c.ports.http, 'nginx:http');
  add(c.ports.https, 'nginx:https');
  if (c.nginx.mode === 'stream') add(c.ports.nginxInternalTls, 'nginx:internal-tls');

  if (c.panels.xui && c.panels.xui.enabled) {
    add(c.panels.xui.port, 'panel:x-ui', { listen: c.panels.xui.listen });
  }
  if (c.panels.sui && c.panels.sui.enabled) {
    add(c.panels.sui.port, 'panel:s-ui', { listen: c.panels.sui.listen });
    if (c.panels.sui.sub && c.panels.sui.sub.enabled) {
      add(c.panels.sui.sub.port, 'panel:s-ui-sub', { listen: c.panels.sui.listen });
    }
  }

  (c.xray.inbounds || []).forEach((ib, i) =>
    add(ib.port, `xray:${ib.tag || i}`, { listen: ib.listen }),
  );
  (c.singbox.inbounds || []).forEach((ib, i) =>
    add(ib.port, `singbox:${ib.tag || i}`, { listen: ib.listen }),
  );

  return entries;
}

export function analyzePorts(c) {
  const entries = collectPorts(c);
  const errors = [];
  const warnings = [];

  const byPort = new Map();
  for (const e of entries) {
    if (!byPort.has(e.port)) byPort.set(e.port, []);
    byPort.get(e.port).push(e);
  }

  for (const [port, list] of byPort) {
    if (list.length < 2) continue;
    const labels = list.map((x) => x.label).join(', ');
    const wildcard = list.some(
      (x) => !x.listen || x.listen === '0.0.0.0' || x.listen === '::',
    );
    const sameScope = new Set(list.map((x) => x.listen || '0.0.0.0')).size === 1;
    if (wildcard || sameScope) {
      errors.push(`port ${port} is claimed by multiple components: ${labels}`);
    } else {
      warnings.push(`port ${port} reused on distinct loopback addresses: ${labels}`);
    }
  }

  for (const key of ['xui', 'sui']) {
    const p = c.panels[key];
    if (p && p.enabled && p.listen && p.listen !== '127.0.0.1' && p.listen !== '::1') {
      warnings.push(
        `panel:${key} listens on ${p.listen}; recommended 127.0.0.1 behind nginx`,
      );
    }
  }

  if (c.panels.sui && c.panels.sui.enabled && c.panels.sui.sub && c.panels.sui.sub.enabled) {
    const sub = c.panels.sui.sub;
    if (sub.domain && sub.domain === c.panels.sui.domain) {
      warnings.push('panels.sui.sub.domain equals panels.sui.domain; s-ui subscriptions will shadow the panel path');
    }
  }

  if (c.nginx.mode === 'stream') {
    const inbounds = [
      ...(c.xray.inbounds || []).map((x) => ({ ...x, kind: 'xray' })),
      ...(c.singbox.inbounds || []).map((x) => ({ ...x, kind: 'singbox' })),
    ];
    for (const ib of inbounds) {
      if (Number(ib.port) === Number(c.ports.https)) {
        errors.push(
          `${ib.kind}:${ib.tag} uses port ${ib.port} which nginx stream already owns (443)`,
        );
      }
      if (!ib.listen || ib.listen === '0.0.0.0') {
        warnings.push(
          `${ib.kind}:${ib.tag} listens on 0.0.0.0; in stream mode bind 127.0.0.1 so only nginx exposes 443`,
        );
      }
      if (!ib.sni) {
        warnings.push(
          `${ib.kind}:${ib.tag} has no "sni"; it will not be reachable through the 443 stream map`,
        );
      }
    }
  }

  const duplicates = [...byPort.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([port, list]) => ({ port, labels: list.map((x) => x.label) }));

  return { entries, byPort, duplicates, errors, warnings };
}

/** Human-readable port table. */
export function formatPortTable(c) {
  const { entries } = analyzePorts(c);
  const rows = entries.map((e) => ({
    port: e.port,
    component: e.label,
    listen: e.listen || '0.0.0.0',
  }));
  const header = ['PORT', 'COMPONENT', 'LISTEN'];
  const widths = [6, 24, 16];
  const line = (cells) => cells.map((x, i) => String(x).padEnd(widths[i])).join(' ').trimEnd();
  const out = [line(header), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line([r.port, r.component, r.listen]));
  return out.join('\n');
}