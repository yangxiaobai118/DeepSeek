import { spawnSync } from 'node:child_process';

export const LOG_UNITS = {
  xray: 'xray',
  singbox: 'sing-box',
  nginx: 'nginx',
  sub: 'uniproxy-sub',
};

export function logSources() {
  return Object.keys(LOG_UNITS);
}

function defaultRun(command) {
  const res = spawnSync(command, { shell: true, timeout: 15000, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
    error: res.error ? res.error.code : null,
  };
}

export function collectLogs(key, lines, deps = {}) {
  const unit = LOG_UNITS[key];
  if (!unit) throw new Error('unknown log source: ' + key);
  const n = Math.min(Math.max(Number(lines) || 100, 10), 1000);
  const run = deps.run || defaultRun;
  const res = run('journalctl -u ' + unit + ' -n ' + n + ' --no-pager -o cat');
  return { unit: unit, lines: n, ok: res.ok, output: res.output || res.error || '' };
}
