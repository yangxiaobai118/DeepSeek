import fs from 'node:fs';
import path from 'node:path';

/** Directory holding the uniproxy systemd units. */
export function unitDir(env = process.env) {
  return env.UNIPROXY_UNIT_DIR || '/etc/systemd/system';
}

/**
 * Keep the installed units in sync with the config ports.
 *
 * The one-line installer writes -p <port> into ExecStart; the setup wizard and
 * the menu edit ui.port / subscription.port. Without this rewrite the service
 * would keep listening on the install-time port while the panel shows the new
 * one. Missing units (JS/dev mode) are simply skipped.
 */
export function syncUnitPorts(opts = {}) {
  const dir = opts.unitDir || unitDir();
  const jobs = [
    { file: 'uniproxy-ui.service', port: opts.uiPort },
    { file: 'uniproxy-sub.service', port: opts.subPort },
  ];
  const result = { updated: [], errors: [] };
  for (const job of jobs) {
    const port = Number(job.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const file = path.join(dir, job.file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    if (!/-p\s+\d+/.test(text)) continue;
    const next = text.replace(/(-p\s+)(\d+)/, function (m, prefix) { return prefix + String(port); });
    if (next === text) continue;
    try {
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, file);
      result.updated.push(file);
    } catch (e) {
      result.errors.push(file + ': ' + e.message);
    }
  }
  return result;
}
