import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read a bundled text asset.
 *
 * In a Node SEA binary the file lives inside the executable and is exposed via
 * node:sea; in a normal checkout it is read relative to this module. The
 * bundler rewrites the module to CommonJS, where __dirname is available.
 */
export function readTextAsset(name) {
  try {
    const sea = process.getBuiltinModule?.('node:sea');
    if (sea && sea.isSea()) return sea.getAsset(name, 'utf8');
  } catch {
    // fall through to the filesystem
  }
  const dir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(dir, name), 'utf8');
}
