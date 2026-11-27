#!/usr/bin/env node
/**
 * Build standalone single-file binaries with Node.js SEA.
 *
 * Each target downloads the matching Node.js runtime for the exact version
 * that generated the SEA blob, injects the bundled CLI into it, and writes a
 * checksum. The result runs without Node.js installed.
 *
 * Requirements: esbuild and postject in node_modules (CI installs them with
 * "npm install --no-save esbuild postject"); macOS targets additionally need
 * codesign, so they must be built on a macOS runner.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = process.versions.node;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = {
  'linux-x64': { platform: 'linux-x64', archive: 'tar.xz', entry: 'bin/node' },
  'linux-arm64': { platform: 'linux-arm64', archive: 'tar.xz', entry: 'bin/node' },
  'linux-ppc64le': { platform: 'linux-ppc64le', archive: 'tar.xz', entry: 'bin/node' },
  'linux-s390x': { platform: 'linux-s390x', archive: 'tar.xz', entry: 'bin/node' },
  'linux-musl-x64': { platform: 'linux-x64-musl', archive: 'tar.xz', entry: 'bin/node' },
  'win-x64': { platform: 'win-x64', archive: 'zip', entry: 'node.exe', ext: '.exe' },
  'win-arm64': { platform: 'win-arm64', archive: 'zip', entry: 'node.exe', ext: '.exe' },
  'darwin-x64': { platform: 'darwin-x64', archive: 'tar.gz', entry: 'bin/node', darwin: true },
  'darwin-arm64': { platform: 'darwin-arm64', archive: 'tar.gz', entry: 'bin/node', darwin: true },
};

function parseArgs(argv) {
  const args = { out: 'bin', targets: Object.keys(TARGETS).join(',') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--targets') args.targets = argv[++i];
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(command + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(command + ' exited with ' + String(result.status));
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findEsbuild() {
  if (process.env.ESBUILD_BIN) return process.env.ESBUILD_BIN;
  const candidates = [];
  const modules = path.join(root, 'node_modules');
  const platformDir = path.join(modules, '@esbuild');
  if (fs.existsSync(platformDir)) {
    for (const name of fs.readdirSync(platformDir)) {
      candidates.push(path.join(platformDir, name, process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'));
    }
  }
  candidates.push(path.join(modules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('esbuild not found; run "npm install --no-save esbuild" first');
  return found;
}

function postjectCli() {
  if (process.env.POSTJECT_CLI) return process.env.POSTJECT_CLI;
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('postject/package.json');
  return path.join(path.dirname(manifest), 'dist', 'cli.js');
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  console.log('downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status + ' for ' + url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    const unzip = spawnSync('unzip', ['-q', '-o', archive, '-d', destDir], { stdio: 'inherit' });
    if (!unzip.error && unzip.status === 0) return;
    run('tar', ['-xf', archive, '-C', destDir]);
    return;
  }
  run('tar', ['-xf', archive, '-C', destDir]);
}

function bundle(buildDir) {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  run(findEsbuild(), [
    'src/index.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node' + nodeVersion.split('.')[0],
    '--outfile=' + path.join(buildDir, 'uniproxy.cjs'),
  ], { cwd: root });
}

function makeBlob(buildDir) {
  fs.copyFileSync(path.join(root, 'src', 'dashboard.html'), path.join(buildDir, 'dashboard.html'));
  fs.writeFileSync(
    path.join(buildDir, 'sea-config.json'),
    JSON.stringify(
      {
        main: 'uniproxy.cjs',
        output: 'sea.blob',
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: { 'dashboard.html': 'dashboard.html' },
      },
      null,
      2,
    ) + '\n',
  );
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: buildDir });
  return path.join(buildDir, 'sea.blob');
}

function inject(target, binary, outFile, blob) {
  fs.copyFileSync(binary, outFile);
  fs.chmodSync(outFile, 0o755);
  if (target.darwin) {
    if (process.platform !== 'darwin') throw new Error('macOS targets must be built on macOS (codesign required)');
    try {
      run('codesign', ['--remove-signature', outFile]);
    } catch {
      // unsigned binaries have nothing to remove
    }
  }
  const args = [postjectCli(), outFile, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
  if (target.darwin) args.push('--macho-segment-name', 'NODE_SEA');
  run(process.execPath, args, { cwd: root });
  if (target.darwin) run('codesign', ['--sign', '-', '--force', outFile]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.targets.split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of targets) {
    if (!TARGETS[name]) throw new Error('unknown target: ' + name);
  }
  const outDir = path.resolve(root, args.out);
  const cacheDir = path.join(root, '.cache', 'node-sea', 'v' + nodeVersion);
  const buildDir = path.join(root, 'build-sea');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  bundle(buildDir);
  const blob = makeBlob(buildDir);

  const built = [];
  for (const name of targets) {
    const target = TARGETS[name];
    const archiveName = 'node-v' + nodeVersion + '-' + target.platform + '.' + target.archive;
    const archivePath = path.join(cacheDir, archiveName);
    await download('https://nodejs.org/dist/v' + nodeVersion + '/' + archiveName, archivePath);

    const extracted = path.join(cacheDir, 'node-v' + nodeVersion + '-' + target.platform);
    if (!fs.existsSync(extracted)) extract(archivePath, cacheDir);
    const nodeBinary = path.join(extracted, target.entry);
    if (!fs.existsSync(nodeBinary)) throw new Error('node binary missing: ' + nodeBinary);

    const asset = 'uniproxy-' + pkg.version + '-' + name + (target.ext || '');
    const outFile = path.join(outDir, asset);
    inject(target, nodeBinary, outFile, blob);
    const digest = sha256(outFile);
    fs.writeFileSync(outFile + '.sha256', digest + '  ' + asset + '\n');
    built.push({ name, asset, digest, size: fs.statSync(outFile).size });

    const gzAsset = asset + '.gz';
    const gzFile = path.join(outDir, gzAsset);
    fs.writeFileSync(gzFile, zlib.gzipSync(fs.readFileSync(outFile), { level: 6 }));
    const gzDigest = sha256(gzFile);
    fs.writeFileSync(gzFile + '.sha256', gzDigest + '  ' + gzAsset + '\n');
    built.push({ name, asset: gzAsset, digest: gzDigest, size: fs.statSync(gzFile).size, compressed: true });
    console.log('built ' + asset + '  ' + digest.slice(0, 16) + '...');
    console.log('built ' + gzAsset + '  ' + gzDigest.slice(0, 16) + '...');
  }

  const rows = built.map(
    (item) => '| `' + item.asset + '` | ' + item.name + (item.compressed ? ' (gzip)' : '') + ' | ' + item.size + ' | `' + item.digest + '` |',
  );
  fs.writeFileSync(
    path.join(outDir, 'BINARIES.md'),
    [
      '# uniproxy ' + pkg.version + ' standalone binaries',
      '',
      'Built with Node.js ' + nodeVersion + ' Single Executable Applications: no Node.js installation needed.',
      '',
      '| Asset | Target | Bytes | SHA-256 |',
      '|-------|--------|-------|---------|',
      ...rows,
      '',
      'Linux binaries need the glibc version of the Node.js runtime they embed (official Node builds: glibc >= 2.28);',
      '`linux-musl-x64` is statically friendly for Alpine. macOS binaries are ad-hoc signed.',
      '',
    ].join('\n'),
  );
  console.log('built ' + built.length + ' binaries into ' + outDir);
}

main().catch((error) => {
  console.error('build-sea: ' + error.message);
  process.exit(1);
});