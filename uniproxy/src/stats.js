import { spawnSync } from 'node:child_process';

/**
 * Traffic accounting helpers.
 *
 * Xray exposes per-user counters through the stats API
 * (`xray api statsquery --server=127.0.0.1:10085`), keyed as
 * `user>>>NAME>>>traffic>>>uplink|downlink`.
 *
 * sing-box exposes a Clash-compatible API; `/connections` carries upload and
 * download per live connection, tagged with `metadata.user` when the inbound
 * sets one.
 *
 * Both collectors are injectable so the parsing can be tested without the
 * cores installed.
 */

export function parseXrayStatNames(list) {
  const users = {};
  for (const entry of list || []) {
    const parts = String(entry.name || '').split('>>>');
    if (parts.length < 4 || parts[0] !== 'user' || parts[2] !== 'traffic') continue;
    const name = parts[1];
    const dir = parts[3];
    users[name] = users[name] || { upload: 0, download: 0 };
    const value = Number(entry.value) || 0;
    if (dir === 'uplink') users[name].upload += value;
    else if (dir === 'downlink') users[name].download += value;
  }
  return users;
}

export function parseClashConnections(json) {
  const users = {};
  for (const conn of (json && json.connections) || []) {
    const meta = conn.metadata || {};
    const name = meta.user || meta.email || '';
    if (!name) continue;
    users[name] = users[name] || { upload: 0, download: 0 };
    users[name].upload += Number(conn.upload) || 0;
    users[name].download += Number(conn.download) || 0;
  }
  return users;
}

function defaultRun(command) {
  const res = spawnSync(command, { shell: true, timeout: 15000, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
    error: res.error ? res.error.code : null,
  };
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return res.json();
}

export async function collectStats(c, deps = {}) {
  const run = deps.run || defaultRun;
  const fetchJson = deps.fetchJson || defaultFetchJson;
  const out = { xray: {}, singbox: {}, errors: [] };

  if (c.xray && c.xray.enabled) {
    const apiPort = Number((c.xray && c.xray.apiPort) || 10085);
    const cmd = (c.stats && c.stats.xray && c.stats.xray.command) || ('xray api statsquery --server=127.0.0.1:' + apiPort);
    try {
      const res = run(cmd);
      if (res.ok) {
        const parsed = JSON.parse(res.output);
        out.xray = parseXrayStatNames(parsed.stat || parsed);
      } else {
        out.errors.push('xray: ' + (res.output || res.error || 'query failed'));
      }
    } catch (e) {
      out.errors.push('xray: ' + e.message);
    }
  }

  if (c.singbox && c.singbox.enabled) {
    const clashPort = Number((c.singbox && c.singbox.clashPort) || 9090);
    const url = (c.stats && c.stats.singbox && c.stats.singbox.url) || ('http://127.0.0.1:' + clashPort + '/connections');
    try {
      out.singbox = parseClashConnections(await fetchJson(url));
    } catch (e) {
      out.errors.push('singbox: ' + e.message);
    }
  }

  return out;
}

/** Combine both cores into one row per user, keyed by user name. */
export function combineStats(stats) {
  const names = new Set([...Object.keys(stats.xray || {}), ...Object.keys(stats.singbox || {})]);
  const rows = [];
  for (const name of names) {
    const a = (stats.xray || {})[name] || { upload: 0, download: 0 };
    const b = (stats.singbox || {})[name] || { upload: 0, download: 0 };
    rows.push({ name: name, upload: a.upload + b.upload, download: a.download + b.download });
  }
  rows.sort(function (x, y) { return (y.upload + y.download) - (x.upload + x.download); });
  return rows;
}

/** Write the collected counters into `users[].usage` (snapshot, not a delta). */
export function mergeUsage(users, stats) {
  let changed = 0;
  for (const user of users || []) {
    const a = (stats.xray || {})[user.name] || { upload: 0, download: 0 };
    const b = (stats.singbox || {})[user.name] || { upload: 0, download: 0 };
    const next = { upload: a.upload + b.upload, download: a.download + b.download };
    const prev = user.usage || { upload: 0, download: 0 };
    if (Number(prev.upload || 0) === next.upload && Number(prev.download || 0) === next.download) continue;
    user.usage = next;
    changed++;
  }
  return changed;
}
