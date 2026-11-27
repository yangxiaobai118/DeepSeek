import fs from 'node:fs';
import path from 'node:path';

/**
 * Config backups.
 *
 * Every write already drops a `config.json.bak-<stamp>` next to the config;
 * these helpers list them, take a labelled one on demand, download one, and
 * restore one after re-validating it (with a pre-restore safety copy first).
 */

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function backupPrefix(cfgPath) {
  return path.basename(cfgPath) + '.bak-';
}

export function stamp(d = new Date()) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

export function listBackups(cfgPath) {
  const dir = path.dirname(cfgPath);
  const prefix = backupPrefix(cfgPath);
  try {
    return fs.readdirSync(dir)
      .filter(function (f) { return f.startsWith(prefix); })
      .map(function (f) {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort(function (a, b) { return b.mtime.localeCompare(a.mtime) || b.name.localeCompare(a.name); });
  } catch (e) {
    return [];
  }
}

export function resolveBackup(cfgPath, name) {
  const raw = String(name || '');
  if (!NAME_RE.test(raw) || !raw.startsWith(backupPrefix(cfgPath))) throw new Error('invalid backup name');
  const file = path.join(path.dirname(cfgPath), raw);
  if (!fs.existsSync(file)) throw new Error('backup not found');
  return file;
}

export function createBackup(cfgPath, label) {
  const dir = path.dirname(cfgPath);
  const base = path.basename(cfgPath) + '.bak-' + (label ? String(label).replace(/[^A-Za-z0-9-]/g, '') + '-' : '') + stamp();
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) { name = base + '-' + n; n += 1; }
  fs.copyFileSync(cfgPath, path.join(dir, name));
  return name;
}

/**
 * Keep only the newest `keep` backups (0 or less disables pruning).
 * Returns the names that were removed.
 */
export function pruneBackups(cfgPath, keep) {
  const limit = Number(keep);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const extra = listBackups(cfgPath).slice(limit);
  const removed = [];
  for (const item of extra) {
    try {
      fs.unlinkSync(path.join(path.dirname(cfgPath), item.name));
      removed.push(item.name);
    } catch (e) {
      // ignore a file that vanished underneath us
    }
  }
  return removed;
}

export function readBackup(cfgPath, name) {
  return fs.readFileSync(resolveBackup(cfgPath, name), 'utf8');
}

export function deleteBackup(cfgPath, name) {
  fs.unlinkSync(resolveBackup(cfgPath, name));
}

export function restoreBackup(cfgPath, name) {
  const text = readBackup(cfgPath, name);
  const parsed = JSON.parse(text);
  const safety = createBackup(cfgPath, 'pre-restore');
  const tmp = cfgPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, cfgPath);
  return { safety: safety, parsed: parsed };
}
