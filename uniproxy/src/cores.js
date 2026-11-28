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

function runLive(command, args, timeout = 900000, env) {
  const res = spawnSync(command, args, { timeout, stdio: ['ignore', 'inherit', 'inherit'], env: env || process.env });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? res.error.message : '',
  };
}

export function isRoot() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : true;
}

const XRAY_SCRIPT_URL = 'https://github.com/XTLS/Xray-install/raw/main/install-release.sh';

function fetchXrayScript(dir) {
  const file = path.join(dir, 'install-release.sh');
  const mirror = process.env.UNIPROXY_MIRROR || '';
  const res = run('curl', ['-fsSL', '--retry', '5', '--retry-delay', '3', '--http1.1', mirror + XRAY_SCRIPT_URL, '-o', file], 120000);
  if (!res.ok) throw new Error(res.error || res.output || 'cannot download the Xray install script');
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace('"$(type -P curl)" -q -L', '"$(type -P curl)" --http1.1 -q -L');
  text = text.replace(`curl -f -H 'Cache-Control: no-cache' -o "$ZIP_FILE"`, `curl -f --progress-bar -H 'Cache-Control: no-cache' -o "$ZIP_FILE"`);
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
  return file;
}

function latestXray() {
  const res = run('curl', ['-fsSL', '--retry', '5', '--retry-delay', '3', '--http1.1', 'https://api.github.com/repos/XTLS/Xray-core/releases/latest'], 30000);
  if (!res.ok) throw new Error(res.error || res.output || 'cannot query the Xray release');
  const data = JSON.parse(res.output);
  if (!data.tag_name) throw new Error('Xray release response has no tag_name');
  return data.tag_name;
}

const XRAY_MACHINE = { x64: '64', arm64: 'arm64-v8a', ia32: '32', arm: 'arm32-v7a', ppc64: 'ppc64le', s390x: 's390x', riscv64: 'riscv64' };

function downloadXrayZip(url, dest) {
  const mirror = process.env.UNIPROXY_MIRROR || '';
  const full = mirror + url;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = runLive('curl', [
      '-fL', '-C', '-', '--connect-timeout', '15', '--max-time', '1800',
      '--http1.1', '--progress-bar', full, '-o', dest,
    ], 1800000);
    if (res.ok) return true;
    if (attempt < 5) run('sleep', ['3'], 5000);
  }
  return false;
}

export function installXray(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('1/4 查询 Xray 最新版本…');
  let version;
  try {
    version = latestXray();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  say('最新版本: ' + version);

  const machine = XRAY_MACHINE[process.arch];
  if (!machine) return { ok: false, error: 'unsupported architecture: ' + process.arch };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uniproxy-xray-'));
  try {
    const script = fetchXrayScript(tmp);
    const zip = path.join(tmp, 'Xray-linux-' + machine + '.zip');
    const url = 'https://github.com/XTLS/Xray-core/releases/download/' + version + '/Xray-linux-' + machine + '.zip';
    say('2/4 下载 ' + url + '（进度条，断线自动续传）…');
    if (!downloadXrayZip(url, zip)) return { ok: false, error: 'Xray zip download failed after 5 attempts' };
    say('3/4 校验并解压…');
    say('4/4 运行官方安装脚本（使用本地 zip，不再访问 GitHub）…');
    const res = runLive('bash', [script, 'install', '--local', zip], 900000, process.env);
    if (!res.ok) return { ok: false, error: res.error || ('install script exit ' + res.status) };
    const installed = run('xray', ['version'], 10000).output.split('\n')[0] || '';
    return { ok: true, version: installed || version };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstallXray(log) {
  const say = typeof log === 'function' ? log : function () {};
  say('下载并运行 Xray 官方卸载脚本…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uniproxy-xray-'));
  try {
    const script = fetchXrayScript(tmp);
    const res = runLive('bash', [script, 'remove'], 900000, process.env);
    return { ok: res.ok, error: res.error || ('remove script exit ' + res.status) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
function packageManager() {
  for (const pm of ['apt-get', 'dnf', 'yum', 'apk', 'zypper']) {
    if (run('sh', ['-c', 'command -v ' + pm], 5000).ok) return pm;
  }
  return '';
}

export function installNginx(log) {
  const say = typeof log === 'function' ? log : function () {};
  const pm = packageManager();
  if (!pm) return { ok: false, error: 'no supported package manager (apt/dnf/yum/apk/zypper)' };
  const env = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' });
  say('1/3 更新软件包索引（' + pm + '）…');
  if (pm === 'apt-get') {
    const updated = runLive('apt-get', ['update'], 600000, env);
    if (!updated.ok) say('警告: apt-get update 失败，尝试使用现有索引继续…');
  }
  say('2/3 安装 nginx…');
  const args = {
    'apt-get': ['-y', 'install', 'nginx'],
    dnf: ['-y', 'install', 'nginx'],
    yum: ['-y', 'install', 'nginx'],
    apk: ['add', 'nginx'],
    zypper: ['-n', 'install', 'nginx'],
  }[pm];
  const res = runLive(pm, args, 900000, env);
  if (!res.ok) return { ok: false, error: 'package install failed, exit ' + res.status };
  say('3/3 启用并启动 nginx…');
  run('systemctl', ['enable', 'nginx'], 30000);
  run('systemctl', ['start', 'nginx'], 30000);
  const version = run('nginx', ['-v'], 10000).output.trim();
  return { ok: true, version: version };
}

export function uninstallNginx(log) {
  const say = typeof log === 'function' ? log : function () {};
  const pm = packageManager();
  if (!pm) return { ok: false, error: 'no supported package manager (apt/dnf/yum/apk/zypper)' };
  const env = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' });
  say('1/3 停止并禁用 nginx…');
  run('systemctl', ['disable', '--now', 'nginx'], 30000);
  say('2/3 卸载 nginx 软件包（配置目录保留）…');
  let args;
  if (pm === 'apt-get') {
    const query = run('dpkg-query', ['-W', '-f=${Package}\n', 'nginx', 'nginx-common', 'nginx-core'], 10000);
    const installed = query.output.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    args = ['-y', 'remove'].concat(installed.length ? installed : ['nginx']);
  } else if (pm === 'apk') {
    args = ['del', 'nginx'];
  } else if (pm === 'zypper') {
    args = ['rm', '-y', 'nginx'];
  } else {
    args = ['-y', 'remove', 'nginx'];
  }
  const res = runLive(pm, args, 600000, env);
  if (!res.ok) return { ok: false, error: 'package remove failed, exit ' + res.status };
  say('3/3 清理 systemd…');
  run('systemctl', ['daemon-reload'], 30000);
  return { ok: true };
}
