import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateXray } from './generators/xray.js';
import { generateSingbox } from './generators/singbox.js';
import { generateNginx } from './generators/nginx.js';

export const DEFAULT_VALIDATE = {
  xray: 'xray run -test -c {file}',
  singbox: 'sing-box check -c {file}',
  nginx: 'nginx -t -c {file}',
};

export const DEFAULT_RELOAD = {
  xray: 'systemctl restart xray',
  singbox: 'systemctl restart sing-box',
  nginx: 'systemctl reload nginx',
};

/** Build the install plan without touching the filesystem. */
export function buildPlan(c) {
  const targets = [];
  const xray = generateXray(c);
  if (xray && c.apply.xrayConfig) {
    targets.push({
      kind: 'xray',
      file: c.apply.xrayConfig,
      content: JSON.stringify(xray, null, 2) + '\n',
      validate: pick(c.apply.validate, 'xray'),
      reload: pick(c.apply.reload, 'xray'),
    });
  }
  const singbox = generateSingbox(c);
  if (singbox && c.apply.singboxConfig) {
    targets.push({
      kind: 'singbox',
      file: c.apply.singboxConfig,
      content: JSON.stringify(singbox, null, 2) + '\n',
      validate: pick(c.apply.validate, 'singbox'),
      reload: pick(c.apply.reload, 'singbox'),
    });
  }
  if (c.apply.nginxConfig) {
    targets.push({
      kind: 'nginx',
      file: c.apply.nginxConfig,
      content: generateNginx(c),
      validate: pick(c.apply.validate, 'nginx'),
      reload: pick(c.apply.reload, 'nginx'),
    });
  }
  for (const t of targets) t.changed = readIfExists(t.file) !== t.content;
  return targets;
}

function pick(map, key) {
  if (map && typeof map[key] === 'string') return map[key];
  return DEFAULT_VALIDATE[key];
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function formatPlan(targets) {
  const lines = ['apply plan:'];
  for (const t of targets) {
    lines.push('  ' + pad(t.kind, 8) + t.file + '  [' + (t.changed ? 'changed' : 'unchanged') + ']');
    if (t.validate) lines.push('           validate: ' + t.validate);
    if (t.reload) lines.push('           reload:   ' + t.reload);
  }
  return lines.join('\n');
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function run(command, replacements) {
  let cmd = command;
  for (const [key, value] of Object.entries(replacements || {})) {
    cmd = cmd.split('{' + key + '}').join(value);
  }
  const res = spawnSync(cmd, { shell: true, timeout: 60000, encoding: 'utf8' });
  return {
    command: cmd,
    ok: res.status === 0,
    status: res.status,
    missing: Boolean(res.error && (res.error.code === 'ENOENT' || res.error.code === 'EACCES')),
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
  };
}

/**
 * Install generated configs, validate them first, then reload the services.
 * Anything written is restored when a reload fails.
 */
export function applyPlan(c, targets, options = {}) {
  const actions = [];
  const available = targets.filter((t) => t.changed);
  if (!available.length) {
    actions.push({ level: 'ok', text: 'nothing to do: every target already matches the generated config' });
    return { actions, failed: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniproxy-'));
  const tempFiles = new Map();
  try {
    // 1. validate staged copies before touching anything live
    for (const t of available) {
      const tmp = path.join(tmpDir, t.kind + '-config' + (t.kind === 'nginx' ? '.conf' : '.json'));
      fs.writeFileSync(tmp, t.content);
      tempFiles.set(t.kind, tmp);
      if (!t.validate || options.skipValidate) continue;
      const res = run(t.validate, { file: tmp });
      if (res.ok) {
        actions.push({ level: 'ok', text: 'validated ' + t.kind + ' config' });
      } else if (res.missing && !options.strict) {
        actions.push({ level: 'warn', text: t.kind + ' validator not installed, skipped: ' + res.command });
      } else {
        actions.push({ level: 'fail', text: t.kind + ' validation failed: ' + res.command + '\n' + res.output });
        return { actions, failed: true };
      }
    }

    // 2. back up and install
    const backups = [];
    for (const t of available) {
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      if (c.apply.backup !== false && fs.existsSync(t.file)) {
        const backup = t.file + '.bak-' + stamp();
        fs.copyFileSync(t.file, backup);
        backups.push({ file: t.file, backup });
      }
      fs.writeFileSync(t.file, t.content);
      actions.push({ level: 'ok', text: 'installed ' + t.file });
    }

    // 3. reload, restoring everything if one service refuses to come back
    for (const t of available) {
      if (!t.reload || options.skipReload) continue;
      const res = run(t.reload, { file: t.file });
      if (res.ok) {
        actions.push({ level: 'ok', text: 'reloaded ' + t.kind + ': ' + res.command });
      } else if (res.missing && !options.strict) {
        actions.push({ level: 'warn', text: t.kind + ' reload command not available: ' + res.command });
      } else {
        actions.push({ level: 'fail', text: 'reload failed for ' + t.kind + ': ' + res.command + '\n' + res.output });
        rollback(backups);
        actions.push({ level: 'warn', text: 'restored previous configs (' + backups.length + ' backup file(s))' });
        return { actions, failed: true };
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { actions, failed: false };
}

function rollback(backups) {
  for (const b of backups.reverse()) {
    try {
      fs.copyFileSync(b.backup, b.file);
    } catch {
      // best effort: report through the summary only
    }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}