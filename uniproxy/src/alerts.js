import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runDoctor } from './doctor.js';
import { analyzePorts } from './ports.js';

/**
 * Alerting: turn doctor findings, port conflicts and dead cores into a list
 * of alerts, then push the ones that are due to a webhook or a shell command.
 *
 * Delivery is deliberately boring: one JSON POST and/or one command with the
 * text in `UNIPROXY_ALERT_TEXT`. Telegram/Bark/ServerChan are all just a
 * webhook, and anything else is a two-line script.
 */

const CORE_UNITS = { xray: 'xray', singbox: 'sing-box', nginx: 'nginx' };

export function alertsFromDoctor(report) {
  return report.results
    .filter(function (r) { return r.level === 'fail' || r.level === 'warn'; })
    .map(function (r) {
      return { key: 'doctor:' + r.title, level: r.level, title: r.title, detail: r.detail };
    });
}

export function alertsFromPorts(c) {
  return analyzePorts(c).errors.map(function (e) {
    return { key: 'ports:' + e, level: 'fail', title: 'port conflict', detail: e };
  });
}

function probe(command) {
  const res = spawnSync(command, { shell: true, timeout: 8000, encoding: 'utf8' });
  return { ok: res.status === 0, output: String((res.stdout || '') + (res.stderr || '')).trim(), error: res.error ? res.error.code : null };
}

export function alertsFromCores(c, deps = {}) {
  if (c.alerts && c.alerts.checkCores === false) return [];
  const run = deps.probe || probe;
  const out = [];
  for (const kind of Object.keys(CORE_UNITS)) {
    const enabled = kind === 'nginx' ? true : (c[kind] && c[kind].enabled !== false);
    if (!enabled) continue;
    const res = run('systemctl is-active ' + CORE_UNITS[kind]);
    if (res.error) continue; // probe unavailable here, do not raise a false alarm
    if (res.output !== 'active') {
      out.push({ key: 'core:' + kind, level: 'warn', title: 'core inactive', detail: CORE_UNITS[kind] + ' is ' + (res.output || 'unknown') });
    }
  }
  return out;
}

export function collectAlerts(c, cfgPath, deps = {}) {
  const report = runDoctor(c, cfgPath, { probe: false });
  const all = alertsFromDoctor(report)
    .concat(alertsFromPorts(c))
    .concat(alertsFromCores(c, deps));
  const map = new Map();
  for (const alert of all) {
    const prev = map.get(alert.key);
    if (!prev || (prev.level === 'warn' && alert.level === 'fail')) map.set(alert.key, alert);
  }
  return Array.from(map.values());
}

export function shouldSend(state, key, now, cooldownMs) {
  const last = state[key];
  if (!last) return true;
  const parsed = Date.parse(last);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= cooldownMs;
}

export function markSent(state, key, now) {
  state[key] = new Date(now).toISOString();
  return state;
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

export function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export function renderText(alerts) {
  return alerts.map(function (a) { return '[' + a.level.toUpperCase() + '] ' + a.title + ': ' + a.detail; }).join('\n');
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('webhook HTTP ' + res.status);
  return res.status;
}

function runCommand(command, text) {
  const res = spawnSync(command, {
    shell: true,
    timeout: 20000,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { UNIPROXY_ALERT_TEXT: text }),
  });
  return { ok: res.status === 0, output: String((res.stdout || '') + (res.stderr || '')).trim(), error: res.error ? res.error.code : null };
}

export async function notify(c, alerts, deps = {}) {
  const cfg = c.alerts || {};
  const now = deps.now || Date.now();
  const cooldownMs = Number(cfg.cooldownHours || 12) * 3600 * 1000;
  const state = deps.state || {};
  const due = alerts.filter(function (a) { return shouldSend(state, a.key, now, cooldownMs); });
  const result = { total: alerts.length, due: due.length, skipped: alerts.length - due.length, sent: 0, errors: [] };
  if (!due.length) return result;

  const text = renderText(due);
  if (cfg.webhook) {
    try {
      await (deps.postJson || postJson)(cfg.webhook, { text: text, alerts: due });
      result.sent += 1;
    } catch (e) {
      result.errors.push('webhook: ' + e.message);
    }
  }
  if (cfg.command) {
    const res = (deps.runCommand || runCommand)(cfg.command, text);
    if (res.ok) result.sent += 1;
    else result.errors.push('command: ' + (res.output || res.error || 'failed'));
  }
  if (result.sent) {
    for (const alert of due) markSent(state, alert.key, now);
    if (deps.stateFile) saveState(deps.stateFile, state);
  }
  return result;
}
