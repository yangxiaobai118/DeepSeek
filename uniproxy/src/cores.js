import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN_DIR = process.env.UNIPROXY_BIN_DIR || '/usr/local/bin';
const UNIT_DIR = process.env.UNIPROXY_UNIT_DIR || '/etc/systemd/system';
const SINGBOX_CONFIG = process.env.UNIPROXY_SINGBOX_CONFIG || '/usr/local/etc/sing-box/config.json';
const XRAY_INSTALL = 'curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh | bash -s -- ';

function run(command, args, timeout = 600000) {
  const res = spawnSync(command, args, { timeout, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? res.error.message : '',
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
  };
}

function runLive(command, args, timeout = 900000) {
  const res = spawnSync(command, args, { timeout, stdio: ['ignore', 'inherit', 'inherit'] });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? res.error.message : '',
  };
}

export function isRoot() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : true;
}

export function installXray(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('1/2 下载并运行 Xray 官方安装脚本（下面是脚本的实时输出）…');
  const res = runLive('bash', ['-lc', XRAY_INSTALL + 'install']);
  if (!res.ok) return { ok: false, error: res.error || ('install script exit ' + res.status) };
  say('2/2 检查已安装版本…');
  const version = run('xray', ['version'], 10000).output.split('\n')[0] || '';
  return { ok: true, version: version };
}

export function uninstallXray(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('下载并运行 Xray 官方卸载脚本…');
  const res = runLive('bash', ['-lc', XRAY_INSTALL + 'remove']);
  return { ok: res.ok, error: res.error || ('remove script exit ' + res.status) };
}

export function singboxAsset(version, arch) {
  const map = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'armv7', ppc64: 'ppc64le', s390x: 's390x', riscv64: 'riscv64' };
  const target = map[arch];
  if (!target) return '';
  return 'sing-box-' + String(version).replace(/^v/, '') + '-linux-' + target + '.tar.gz';
}

async function latestSingbox() {
  const res = run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '3', '--http1.1', 'https://api.github.com/repos/SagerNet/sing-box/releases/latest'], 30000);
  if (!res.ok) throw new Error(res.error || res.output || 'GitHub API request failed');
  return JSON.parse(res.output);
}

function downloadWithProgress(url, dest) {
  const mirror = process.env.UNIPROXY_MIRROR || '';
  const full = mirror + url;
  const res = runLive('curl', ['-fL', '--retry', '3', '--retry-delay', '3', '--http1.1', '--progress-bar', full, '-o', dest], 900000);
  try { process.stderr.write('\n'); } catch (e) { /* no tty */ }
  if (!res.ok) throw new Error(res.error || ('download failed, curl exit ' + res.status));
}

function findBinary(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(file, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return file;
    }
  }
  return '';
}

export async function installSingbox(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('1/5 查询 sing-box 最新版本…');
  const release = await latestSingbox();
  const version = release.tag_name;
  const asset = singboxAsset(version, process.arch);
  if (!asset) throw new Error('unsupported architecture: ' + process.arch);
  const entry = release.assets.find(function (a) { return a.name === asset; });
  if (!entry) throw new Error('release asset not found: ' + asset);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uniproxy-singbox-'));
  try {
    say('2/5 下载 ' + asset + '（下方是 curl 进度）…');
    const archive = path.join(tmp, 'sing-box.tar.gz');
    downloadWithProgress(entry.browser_download_url, archive);

    say('3/5 解压并检查二进制…');
    const extracted = path.join(tmp, 'extract');
    fs.mkdirSync(extracted);
    const untar = run('tar', ['-xzf', archive, '-C', extracted], 120000);
    if (!untar.ok) throw new Error('tar: ' + (untar.error || untar.output));
    const binary = findBinary(extracted, 'sing-box');
    if (!binary) throw new Error('sing-box binary not found in archive');

    say('4/5 安装到 ' + path.join(BIN_DIR, 'sing-box') + ' …');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const target = path.join(BIN_DIR, 'sing-box');
    const staging = target + '.new';
    fs.copyFileSync(binary, staging);
    fs.chmodSync(staging, 0o755);
    fs.renameSync(staging, target);

    say('5/5 写入 systemd 单元并启用…');
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    const unit = path.join(UNIT_DIR, 'sing-box.service');
    if (!fs.existsSync(unit)) {
      fs.writeFileSync(unit, [
        '[Unit]',
        'Description=sing-box service',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=' + target + ' run -c ' + SINGBOX_CONFIG,
        'Restart=on-failure',
        'RestartSec=3',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n'));
    }
    run('systemctl', ['daemon-reload'], 30000);
    run('systemctl', ['enable', 'sing-box'], 30000);
    if (run('systemctl', ['is-active', 'sing-box'], 10000).output === 'active') {
      run('systemctl', ['restart', 'sing-box'], 30000);
    }
    return { ok: true, version: version, binary: target };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstallSingbox(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('停止并禁用 sing-box 服务…');
  run('systemctl', ['disable', '--now', 'sing-box'], 30000);
  say('删除 systemd 单元与二进制（配置保留）…');
  try {
    fs.rmSync(path.join(UNIT_DIR, 'sing-box.service'), { force: true });
  } catch (e) { /* missing */ }
  try {
    fs.rmSync(path.join(BIN_DIR, 'sing-box'), { force: true });
  } catch (e) { /* missing */ }
  run('systemctl', ['daemon-reload'], 30000);
  return { ok: true };
}