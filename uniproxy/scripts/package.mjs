#!/usr/bin/env node
/**
 * Build platform-labelled release bundles.
 *
 * uniproxy is pure JavaScript: every bundle carries the same code, so the
 * OS/architecture suffix documents the target environment and the matching
 * Node.js runtime, not a compiled binary. Each archive carries an
 * ENVIRONMENT.txt describing exactly what it fits, and the release ships a
 * PLATFORMS.md matrix for the download page.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const FOLDER = 'uniproxy';

const FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'DISCLAIMER.md', 'config.example.json'];
const DIRS = ['src', 'test'];

const MATRIX = [
  { os: 'linux', arch: 'x86_64', bits: 64, label: 'Linux x86_64 (64-bit x86)', node: 'linux-x64', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'linux', arch: 'i386', bits: 32, label: 'Linux i386 (32-bit x86)', node: 'linux-ia32 (community/distro build)', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28 on the Node build you install' },
  { os: 'linux', arch: 'arm64', bits: 64, label: 'Linux arm64 (64-bit ARM)', node: 'linux-arm64', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'linux', arch: 'armv7l', bits: 32, label: 'Linux armv7l (32-bit ARM)', node: 'linux-armv7l', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'linux', arch: 'armv6l', bits: 32, label: 'Linux armv6l (32-bit ARM)', node: 'linux-armv6l (unofficial build)', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'linux', arch: 's390x', bits: 64, label: 'Linux s390x (64-bit big-endian)', node: 'linux-s390x', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'linux', arch: 'ppc64le', bits: 64, label: 'Linux ppc64le (64-bit little-endian Power)', node: 'linux-ppc64le', launcher: 'sh', format: 'tar.gz', glibc: 'glibc >= 2.28' },
  { os: 'windows', arch: 'x86_64', bits: 64, label: 'Windows x86_64 (64-bit x86)', node: 'win-x64', launcher: 'cmd', format: 'zip' },
  { os: 'windows', arch: 'i386', bits: 32, label: 'Windows i386 (32-bit x86)', node: 'win-x86', launcher: 'cmd', format: 'zip' },
  { os: 'windows', arch: 'arm64', bits: 64, label: 'Windows arm64 (64-bit ARM)', node: 'win-arm64', launcher: 'cmd', format: 'zip' },
  { os: 'macos', arch: 'x86_64', bits: 64, label: 'macOS x86_64 (Intel)', node: 'darwin-x64', launcher: 'sh', format: 'tar.gz' },
  { os: 'macos', arch: 'arm64', bits: 64, label: 'macOS arm64 (Apple silicon)', node: 'darwin-arm64', launcher: 'sh', format: 'tar.gz' },
];

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
  if (result.status !== 0) throw new Error(command + ' exited with ' + String(result.status));
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function stage(entry, stageRoot) {
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

  const asset = 'uniproxy-' + version + '-' + entry.os + '-' + entry.arch + '.' + entry.format;
  const lines = [
    'uniproxy ' + version,
    '',
    'environment:  ' + entry.label,
    'architecture: ' + entry.arch + ' (' + entry.bits + '-bit)',
    'node runtime: ' + (entry.os === 'windows' || entry.os === 'macos' ? 'Node.js >= 18, official build for ' + entry.node : 'Node.js >= 18, ' + entry.node),
  ];
  if (entry.glibc) lines.push('linux libc:   ' + entry.glibc);
  lines.push(
    'launcher:     ' + (entry.launcher === 'sh' ? './uniproxy' : 'uniproxy.cmd (or pwsh ./uniproxy.ps1)'),
    '',
    'install:',
    entry.format === 'zip'
      ? '  Expand-Archive ' + asset + ' .\\uniproxy'
      : '  tar -xzf ' + asset + ' && cd uniproxy',
    entry.launcher === 'sh' ? '  ./uniproxy init -c config.json' : '  uniproxy.cmd init -c config.json',
    '',
    'note: uniproxy is pure JavaScript and contains no compiled binaries.',
    '      Every platform bundle ships the same code; the OS/architecture label',
    '      tells you which environment it is meant for and which Node.js build',
    '      to install. No native modules are used.',
    '',
  );
  fs.writeFileSync(path.join(dir, 'ENVIRONMENT.txt'), lines.join('\n'));
  return asset;
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

function platformsDoc() {
  const rows = MATRIX.map((entry) => {
    const asset = 'uniproxy-' + version + '-' + entry.os + '-' + entry.arch + '.' + entry.format;
    return '| `' + asset + '` | ' + entry.label + ' | ' + entry.bits + '-bit | ' + entry.node + ' | ' + (entry.launcher === 'sh' ? '`./uniproxy`' : '`uniproxy.cmd`') + ' |';
  });
  return [
    '# uniproxy ' + version + ' platform matrix',
    '',
    '| Asset | Environment | Bits | Node.js build | Launcher |',
    '|-------|-------------|------|---------------|----------|',
    ...rows,
    '',
    '## What the labels mean',
    '',
    'uniproxy is pure JavaScript. Every archive ships the same code, so the',
    'OS/architecture suffix tells you which environment the bundle is meant for',
    'and which Node.js runtime to install - it is not a compiled binary.',
    'Pick the row that matches your server/desktop, install Node.js >= 18 for',
    'that platform, and run the launcher. The npm tarball',
    '`uniproxy-' + version + '.tgz` is platform-neutral and works the same way.',
    '',
    'Linux notes: official Node.js builds need glibc >= 2.28 (RHEL 8, Debian 10,',
    'Ubuntu 20.04 or newer); Alpine/musl needs the node package from Alpine.',
    'No special kernel features (no kernel modules, eBPF or io_uring) are used.',
    '',
    'Only `uniproxy apply` needs extra software: systemd, xray, sing-box and',
    'nginx on PATH, plus root privileges.',
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(root, args.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stageRoot = path.join(outDir, '.stage');

  const assets = [];
  for (const entry of MATRIX) {
    const asset = stage(entry, stageRoot);
    const file = path.join(outDir, asset);
    if (entry.format === 'zip') zip(file, stageRoot);
    else tarGz(file, stageRoot);
    const digest = sha256(file);
    fs.writeFileSync(file + '.sha256', digest + '  ' + asset + '\n');
    assets.push({ name: asset, size: fs.statSync(file).size, sha256: digest });
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });

  const doc = platformsDoc();
  fs.writeFileSync(path.join(outDir, 'PLATFORMS.md'), doc);

  const lines = ['# uniproxy ' + version + ' release assets', '# sha256  file', ''];
  for (const asset of assets) lines.push(asset.sha256 + '  ' + asset.name);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

  for (const asset of assets) {
    console.log(asset.name.padEnd(46) + String(asset.size).padStart(9) + ' B');
  }
  console.log('');
  console.log('built ' + assets.length + ' platform bundles + PLATFORMS.md into ' + outDir);
}

main();