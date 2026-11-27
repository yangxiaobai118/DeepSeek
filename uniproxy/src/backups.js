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
      .sort(function (a, b) { return b.mtime.localeCompare(a.mtime); });
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
  const name = path.basename(cfgPath) + '.bak-' + (label ? String(label).replace(/[^A-Za-z0-9-]/g, '') + '-' : '') + stamp();
  fs.copyFileSync(cfgPath, path.join(path.dirname(cfgPath), name));
  return name;
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
