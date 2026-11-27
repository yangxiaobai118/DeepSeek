import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package version.
 *
 * SEA builds inject __UNIPROXY_VERSION__ at bundle time (the executable has no
 * package.json); a source checkout reads package.json instead.
 */
export function version() {
  if (typeof __UNIPROXY_VERSION__ === 'string') return __UNIPROXY_VERSION__;
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch (e) {
    return 'dev';
  }
}
