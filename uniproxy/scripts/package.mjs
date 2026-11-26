#!/usr/bin/env node
/**
 * Build the per-platform release bundles.
 *
 * uniproxy is pure JavaScript, so every archive carries the same code; the
 * platform label selects the launcher (sh vs cmd/ps1) and documents the target.
 * This mirrors the asset matrix of Go panels like 3x-ui, where each OS/arch
 * gets its own archive plus a .sha256 file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const MATRIX = [
  ['linux', '386', 'tar.gz'],
  ['linux', 'amd64', 'tar.gz'],
  ['linux', 'arm64', 'tar.gz'],
  ['linux', 'armv5', 'tar.gz'],
  ['linux', 'armv6', 'tar.gz'],
  ['linux', 'armv7', 'tar.gz'],
  ['linux', 's390x', 'tar.gz'],
  ['windows', 'amd64', 'zip'],
  ['windows', '386', 'zip'],
  ['windows', 'arm64', 'zip'],
  ['darwin', 'amd64', 'tar.gz'],
  ['darwin', 'arm64', 'tar.gz'],
];

const FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'DISCLAIMER.md', 'config.example.json'];
const DIRS = ['src'];
const FOLDER = 'uniproxy';

function parseArgs(argv) {
  const args = { out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(command + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(command + ' exited with ' + result.status);
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function stage(os, arch, stageRoot) {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  const dir = path.join(stageRoot, FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  for (const sub of DIRS) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });

  const shell = [
    '#!/bin/sh',
    '# uniproxy launcher - requires Node.js >= 18',
    'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'exec node "$DIR/src/index.js" "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'uniproxy'), shell);
  fs.chmodSync(path.join(dir, 'uniproxy'), 0o755);

  fs.writeFileSync(
    path.join(dir, 'uniproxy.cmd'),
    ['@echo off', 'setlocal', 'node "%~dp0src\\index.js" %*', ''].join('\r\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'uniproxy.ps1'),
    ['#!/usr/bin/env pwsh', '$here = Split-Path -Parent $MyInvocation.MyCommand.Path', 'node (Join-Path $here "src/index.js") @args', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'PLATFORM.txt'),
    [
      'uniproxy ' + version,
      'target: ' + os + '/' + arch,
      'runtime: Node.js >= 18',
      '',
      'uniproxy is pure JavaScript: this archive is identical to every other',
      'platform archive. The launcher (uniproxy, uniproxy.cmd or uniproxy.ps1)',
      'runs src/index.js with the local Node.js runtime.',
      '',
    ].join('\n'),
  );
  return dir;
}

function tarGz(file, stageRoot) {
  run('tar', ['-czf', file, '-C', stageRoot, FOLDER]);
}

function zip(file, stageRoot) {
  const plain = spawnSync('zip', ['-qr', file, FOLDER], { cwd: stageRoot, stdio: 'inherit' });
  if (!plain.error && plain.status === 0) return;
  if (process.platform === 'win32') {
    const command = "Compress-Archive -Path '" + path.join(stageRoot, FOLDER) + "' -DestinationPath '" + file + "' -Force";
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    return;
  }
  throw new Error('zip is not available; install zip or run on a platform that provides it');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(root, args.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stageRoot = path.join(outDir, '.stage');

  const assets = [];
  for (const [os, arch, format] of MATRIX) {
    stage(os, arch, stageRoot);
    const name = 'uniproxy-' + os + '-' + arch + '.' + format;
    const file = path.join(outDir, name);
    if (format === 'zip') zip(file, stageRoot);
    else tarGz(file, stageRoot);
    const digest = sha256(file);
    fs.writeFileSync(file + '.sha256', digest + '  ' + name + '\n');
    assets.push({ name, size: fs.statSync(file).size, sha256: digest });
  }

  fs.rmSync(stageRoot, { recursive: true, force: true });

  const header = ['# uniproxy ' + version + ' release assets', '# sha256  file', ''];
  const lines = assets.map((asset) => asset.sha256 + '  ' + asset.name);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), header.concat(lines).join('\n') + '\n');

  const width = Math.max(...assets.map((a) => a.name.length));
  for (const asset of assets) {
    console.log(asset.name.padEnd(width) + '  ' + String(asset.size).padStart(9) + ' B  ' + asset.sha256.slice(0, 16) + '...');
  }
  console.log('');
  console.log('built ' + assets.length + ' platform bundles into ' + outDir);
}

main();
