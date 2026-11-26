#!/usr/bin/env node
/**
 * Build the portable release packages.
 *
 * uniproxy is pure JavaScript: one archive runs on every OS and architecture
 * that has Node.js >= 18, and the bundle ships launchers for sh, cmd and
 * PowerShell. Asset names therefore describe the real requirement instead of
 * imitating the per-CPU matrix of compiled-binary projects.
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

function writeRequirements(dir) {
  fs.writeFileSync(
    path.join(dir, 'REQUIREMENTS.txt'),
    [
      'uniproxy ' + version,
      '',
      'runtime:      Node.js >= 18 (built and tested on Node.js 24)',
      'architectures: every architecture with an official Node.js build',
      '              (no native modules, no CPU-specific code)',
      '',
      'linux:        standard glibc distribution; official Node.js builds need',
      '              glibc >= 2.28 (RHEL 8 / Debian 10 / Ubuntu 20.04 or newer).',
      '              No special kernel features: no kernel modules, eBPF or',
      '              io_uring requirements.',
      'macos:        every macOS release supported by your Node.js >= 18 build',
      'windows:      Windows 10 / Server 2016 or newer with Node.js >= 18',
      '',
      'optional, only for "uniproxy apply" on Linux:',
      '              systemd, xray, sing-box and nginx on PATH, running as root',
      '',
      'run:',
      '  ./uniproxy --help            (sh launcher, chmod +x if the unzip tool dropped the bit)',
      '  uniproxy.cmd --help          (Windows cmd)',
      '  pwsh ./uniproxy.ps1 --help   (PowerShell)',
      '  node src/index.js --help     (any platform)',
      '',
    ].join('\n'),
  );
}

function stage(stageRoot) {
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
  writeRequirements(dir);
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

  stage(stageRoot);

  const assets = [];
  const tarball = path.join(outDir, 'uniproxy-' + version + '.tar.gz');
  const zipFile = path.join(outDir, 'uniproxy-' + version + '.zip');
  tarGz(tarball, stageRoot);
  zip(zipFile, stageRoot);
  for (const file of [tarball, zipFile]) {
    const digest = sha256(file);
    fs.writeFileSync(file + '.sha256', digest + '  ' + path.basename(file) + '\n');
    assets.push({ name: path.basename(file), size: fs.statSync(file).size, sha256: digest });
  }

  fs.rmSync(stageRoot, { recursive: true, force: true });

  const lines = ['# uniproxy ' + version + ' portable packages', '# sha256  file', ''];
  for (const asset of assets) lines.push(asset.sha256 + '  ' + asset.name);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');

  for (const asset of assets) {
    console.log(asset.name.padEnd(28) + String(asset.size).padStart(9) + ' B  ' + asset.sha256.slice(0, 16) + '...');
  }
  console.log('');
  console.log('built ' + assets.length + ' portable packages into ' + outDir);
}

main();
