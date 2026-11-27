import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig, validateConfig } from './config.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { buildPlan, applyPlan, formatPlan } from './apply.js';
import { analyzePorts } from './ports.js';
import { resolveUsers } from './users.js';
import { certStatus, issue } from './certs.js';
import { listBackups, createBackup, restoreBackup } from './backups.js';
import { collectAlerts } from './alerts.js';
import { normalizeNodes } from './nodes.js';
import { syncUnitPorts } from './units.js';
import { isPlaceholderAddress } from './util.js';

/**
 * Terminal menu, modelled on the 3x-ui management script: boxed sections,
 * numbered actions, live status footer. Everything it does is the same code
 * the CLI and the panel call, so behaviour cannot drift.
 */

const UI_UNIT = process.env.UNIPROXY_UI_UNIT || 'uniproxy-ui';
function unitDir() { return process.env.UNIPROXY_UNIT_DIR || '/etc/systemd/system'; }
const CORE_UNITS = { xray: 'xray', singbox: 'sing-box', nginx: 'nginx' };
const WIDTH = 46;

const COLOR = (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1') && !process.env.NO_COLOR;
const GREEN = COLOR ? '\x1b[32m' : '';
const BRIGHT = COLOR ? '\x1b[92m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

const INSTALL_URL = 'https://raw.githubusercontent.com/yangxiaobai118/DeepSeek/feature/uniproxy/uniproxy/install.sh';

function isSea() {
  try {
    const sea = process.getBuiltinModule && process.getBuiltinModule('node:sea');
    return Boolean(sea && sea.isSea && sea.isSea());
  } catch (e) {
    return false;
  }
}

function run(command) {
  const res = spawnSync(command, { shell: true, timeout: 20000, encoding: 'utf8' });
  return { ok: res.status === 0, output: String((res.stdout || '') + (res.stderr || '')).trim(), error: res.error ? res.error.code : null };
}

function unitState(unit) {
  const res = run('systemctl is-active ' + unit);
  if (res.error) return 'unknown';
  const text = String(res.output || '').trim();
  if (!text) return 'unknown';
  if (/failed to|no such file|not-found/i.test(text)) return 'not-found';
  const first = text.split('\n')[0].trim();
  return first || 'unknown';
}

function unitEnabled(unit) {
  const res = run('systemctl is-enabled ' + unit);
  if (res.error) return 'unknown';
  const text = String(res.output || '').trim();
  if (!text || /failed to get unit file state|no such file|not-found/i.test(text)) return 'not-found';
  return text.split('\n')[0].trim();
}

/** Terminal columns used by one code point: CJK and fullwidth forms take 2. */
function charWidth(ch) {
  const code = ch.codePointAt(0);
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch);
  return w;
}

function pad(text, width) {
  let s = String(text);
  let w = dispWidth(s);
  while (w > width) { s = Array.from(s).slice(0, -1).join(''); w = dispWidth(s); }
  return s + ' '.repeat(width - w);
}

function colorMenuItem(text) {
  const match = String(text).match(/^([0-9A-Za-z]+\.)\s/);
  if (!match) return text;
  return GREEN + match[1] + RESET + ' ' + String(text).slice(match[0].length);
}

export function box(title, lines) {
  const out = [];
  const dashes = Math.max(0, WIDTH - 3 - dispWidth(title) - 2);
  out.push(GREEN + '┌─ ' + RESET + BRIGHT + title + RESET + GREEN + ' ' + '─'.repeat(dashes) + '┐' + RESET);
  for (const line of lines) {
    out.push(GREEN + '│' + RESET + ' ' + colorMenuItem(pad(line, WIDTH - 3)) + GREEN + '│' + RESET);
  }
  out.push(GREEN + '└' + '─'.repeat(WIDTH - 2) + '┘' + RESET);
  return out.join('\n');
}

function colorState(value) {
  let text = String(value || 'unknown');
  if (text === 'not-found') text = '未安装';
  if (/^(active|enabled|running)/.test(text)) return GREEN + text + RESET;
  if (/^(not installed|未安装|activating|deactivating|reloading|unknown|static|masked|indirect)/.test(text)) return YELLOW + text + RESET;
  if (/^(inactive|failed|disabled)/.test(text)) return RED + text + RESET;
  return text;
}

function paintLines(text) {
  if (!COLOR) return String(text);
  return String(text).split('\n').map(function (line) {
    if (/^(ERROR|FAIL|错误|失败|执行失败|无效选项|无法读取|证书不可读)/.test(line)) return RED + line + RESET;
    if (/^(WARN|警告)/.test(line)) return YELLOW + line + RESET;
    if (/^(OK|成功|已)/.test(line)) return GREEN + line + RESET;
    return line;
  }).join('\n');
}

function readCfg(cfgPath) {
  const loaded = loadConfig(cfgPath);
  return loaded;
}

export function renderMenu(ctx) {
  const sections = buildMenu(ctx);
  const parts = [];
  parts.push(box('u-ui · uniproxy', ['0. 退出菜单 (Exit)']));
  for (const section of sections) {
    parts.push(box(section.title, section.items.map(function (i) { return i.key + '. ' + i.label; })));
  }
  let cfg = null;
  try { cfg = readCfg(ctx.configPath).config; } catch (e) { /* unreadable config */ }
  const uiState = unitState(UI_UNIT);
  const coreLine = Object.keys(CORE_UNITS).map(function (k) { return CORE_UNITS[k] + ': ' + colorState(unitState(CORE_UNITS[k])); }).join('   ');
  const footer = [
    '面板状态: ' + colorState(uiState) + '   开机自启: ' + colorState(unitEnabled(UI_UNIT)),
    '配置文件: ' + (cfg ? ctx.configPath : '(读取失败)'),
    coreLine,
  ];
  parts.push(footer.join('\n'));
  return parts.join('\n\n');
}

export function buildMenu(ctx) {
  const withCfg = async function (fn) {
    let loaded;
    try { loaded = readCfg(ctx.configPath); } catch (e) { ctx.io.print('无法读取配置: ' + e.message); return; }
    await fn(loaded.config, loaded.path);
  };

  const install = [
    { key: '1', label: '安装到系统路径 (Install)', run: function () { return installSystem(ctx); } },
    { key: '2', label: '卸载系统安装 (Uninstall)', run: function () { return uninstallSystem(ctx); } },
    { key: '3', label: '初始化向导 (Setup)', run: function () { return runSetupItem(ctx); } },
    { key: 'U', label: '更新到最新版本 (Update)', run: function () { return updateSystem(ctx); } },
  ];

  const panel = [
    { key: '4', label: '查看当前设置 (Show Current Settings)', run: function () { return withCfg(showSettings(ctx)); } },
    { key: '5', label: '修改面板端口 (Change Panel Port)', run: function () { return withCfg(changePort(ctx)); } },
    { key: '6', label: '重置账号密码 (Reset Password)', run: function () { return withCfg(resetPassword(ctx)); } },
    { key: '7', label: '新增只读账号 (Add Viewer)', run: function () { return withCfg(addViewer(ctx)); } },
  ];

  const service = [
    { key: '8', label: '安装服务单元 (Install Units)', run: function () { return installService(ctx); } },
    { key: '9', label: '卸载服务单元 (Uninstall Units)', run: function () { return uninstallService(ctx); } },
    { key: '10', label: '启动面板 (Start Panel)', run: function () { return systemctl(ctx, 'start'); } },
    { key: '11', label: '停止面板 (Stop Panel)', run: function () { return systemctl(ctx, 'stop'); } },
    { key: '12', label: '重启面板 (Restart Panel)', run: function () { return systemctl(ctx, 'restart'); } },
    { key: '13', label: '查看状态 (Show Status)', run: function () { return showStatus(ctx); } },
    { key: '14', label: '查看日志 (Show Logs)', run: function () { return showLogs(ctx); } },
    { key: '15', label: '启用开机自启 (Enable Autostart)', run: function () { return systemctl(ctx, 'enable'); } },
    { key: '16', label: '关闭开机自启 (Disable Autostart)', run: function () { return systemctl(ctx, 'disable'); } },
  ];

  const config = [
    { key: '17', label: '校验配置 (Validate Config)', run: function () { return withCfg(runValidate(ctx)); } },
    { key: '18', label: '预检 (Doctor)', run: function () { return withCfg(runDoctorItem(ctx)); } },
    { key: '19', label: '生成并下发 (Apply)', run: function () { return withCfg(runApply(ctx)); } },
    { key: '20', label: '立即备份配置 (Backup Config)', run: function () { return withCfg(doBackup(ctx)); } },
    { key: '21', label: '恢复备份 (Restore Backup)', run: function () { return withCfg(restorePicker(ctx)); } },
  ];

  const cores = [
    { key: '22', label: '重启 xray (Restart Xray)', run: function () { return coreAction(ctx, 'xray', 'restart'); } },
    { key: '23', label: '重启 sing-box (Restart Sing-box)', run: function () { return coreAction(ctx, 'singbox', 'restart'); } },
    { key: '24', label: '重启 nginx (Restart Nginx)', run: function () { return coreAction(ctx, 'nginx', 'restart'); } },
    { key: '25', label: '停止 xray (Stop Xray)', run: function () { return coreAction(ctx, 'xray', 'stop'); } },
    { key: '26', label: '停止 sing-box (Stop Sing-box)', run: function () { return coreAction(ctx, 'singbox', 'stop'); } },
    { key: '27', label: '停止 nginx (Stop Nginx)', run: function () { return coreAction(ctx, 'nginx', 'stop'); } },
    { key: '28', label: '启动 xray (Start Xray)', run: function () { return coreAction(ctx, 'xray', 'start'); } },
    { key: '29', label: '启动 sing-box (Start Sing-box)', run: function () { return coreAction(ctx, 'singbox', 'start'); } },
    { key: '30', label: '启动 nginx (Start Nginx)', run: function () { return coreAction(ctx, 'nginx', 'start'); } },
  ];

  const extra = [
    { key: '31', label: '证书状态 (Certificate Status)', run: function () { return withCfg(showCert(ctx)); } },
    { key: '32', label: '申请 / 续期证书 (Issue / Renew Cert)', run: function () { return withCfg(issueCert(ctx)); } },
    { key: '33', label: '查看告警 (Show Alerts)', run: function () { return withCfg(showAlerts(ctx)); } },
    { key: '34', label: '节点列表 (List Nodes)', run: function () { return withCfg(showNodes(ctx)); } },
  ];

  return [
    { title: '安装 (Install)', items: install },
    { title: '面板 (Panel)', items: panel },
    { title: '服务 (Service)', items: service },
    { title: '配置 (Config)', items: config },
    { title: '内核 (Cores)', items: cores },
    { title: '其他 (Other)', items: extra },
  ];
}

function posix(s) { return String(s).replace(/\\/g, '/'); }

function pjoin(...parts) { return path.posix.join.apply(path.posix, parts.map(posix)); }

function pkgRoot() {
  const url = import.meta.url;
  if (!url) throw new Error('source tree is not available in this build');
  return path.resolve(path.dirname(fileURLToPath(url)), '..');
}

function paths() {
  return {
    prefix: process.env.UNIPROXY_PREFIX || '/usr/local/uniproxy',
    binDir: process.env.UNIPROXY_BIN_DIR || '/usr/local/bin',
    etcDir: process.env.UNIPROXY_ETC_DIR || (process.env.UNIPROXY_PREFIX ? path.join(process.env.UNIPROXY_PREFIX, 'etc') : '/etc/uniproxy'),
    unitDir: unitDir(),
  };
}

/** Describe a system install without touching the filesystem. */
export function installPlan(opts = {}) {
  const p = Object.assign(paths(), opts);
  const sea = opts.sea != null ? Boolean(opts.sea) : isSea();
  const root = opts.sourceDir || (sea ? null : pkgRoot());
  const configPath = pjoin(p.etcDir, 'config.json');
  const exe = opts.exe || (sea ? pjoin(p.prefix, 'uniproxy') : ('node ' + pjoin(p.prefix, 'src', 'index.js')));
  const launchers = {};
  if (sea) {
    launchers[pjoin(p.binDir, 'uniproxy')] = '#!/bin/sh\n# uniproxy launcher\nexec "' + pjoin(p.prefix, 'uniproxy') + '" "$@"\n';
    launchers[pjoin(p.binDir, 'u-ui')] = '#!/bin/sh\n# uniproxy menu launcher\nexec "' + pjoin(p.prefix, 'uniproxy') + '" menu "$@"\n';
  } else {
    launchers[pjoin(p.binDir, 'uniproxy')] = '#!/bin/sh\n# uniproxy launcher\nexec node "' + pjoin(p.prefix, 'src', 'index.js') + '" "$@"\n';
    launchers[pjoin(p.binDir, 'u-ui')] = '#!/bin/sh\n# uniproxy menu launcher\nexec node "' + pjoin(p.prefix, 'src', 'u-ui.js') + '" "$@"\n';
  }
  return {
    prefix: p.prefix,
    binDir: p.binDir,
    etcDir: p.etcDir,
    unitDir: p.unitDir,
    configPath: configPath,
    sourceDir: root,
    binary: sea ? process.execPath : null,
    copy: sea ? [] : ['src', 'package.json', 'README.md', 'CHANGELOG.md', 'DISCLAIMER.md', 'LICENSE', 'config.example.json'],
    launchers: launchers,
    units: unitFiles({ configPath: configPath, exe: exe }),
  };
}

export async function installSystem(ctx) {
  const plan = installPlan();
  ctx.io.print('目标目录: ' + plan.prefix);
  try {
    fs.mkdirSync(plan.prefix, { recursive: true });
    if (plan.binary) {
      const target = pjoin(plan.prefix, 'uniproxy');
      const staging = target + '.new';
      fs.copyFileSync(plan.binary, staging);
      fs.chmodSync(staging, 0o755);
      fs.renameSync(staging, target);
      ctx.io.print('写入 ' + target);
    } else {
      for (const item of plan.copy) {
        const from = path.join(plan.sourceDir, item);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, pjoin(plan.prefix, item), { recursive: true });
      }
    }
    fs.mkdirSync(plan.binDir, { recursive: true });
    for (const file of Object.keys(plan.launchers)) {
      fs.writeFileSync(file, plan.launchers[file]);
      fs.chmodSync(file, 0o755);
      ctx.io.print('写入 ' + file);
    }
    fs.mkdirSync(plan.etcDir, { recursive: true });
    if (!fs.existsSync(plan.configPath)) {
      const sample = pjoin(plan.prefix, 'config.example.json');
      if (fs.existsSync(sample)) { fs.copyFileSync(sample, plan.configPath); ctx.io.print('生成 ' + plan.configPath + '（请编辑后使用）'); }
    }
    fs.mkdirSync(plan.unitDir, { recursive: true });
    for (const name of Object.keys(plan.units)) {
      fs.writeFileSync(pjoin(plan.unitDir, name), plan.units[name]);
      ctx.io.print('写入 ' + pjoin(plan.unitDir, name));
    }
    run('systemctl daemon-reload');
    ctx.io.print('安装完成。下一步：编辑 ' + plan.configPath + '，然后菜单 17 validate / 19 apply，或 15 启用自启后 10 启动');
  } catch (e) {
    ctx.io.print('安装失败: ' + e.message + '（需要 root 权限）');
  }
}

async function updateSystem(ctx) {
  const answer = String((await ctx.io.question('从 GitHub 安装最新版本? [y/N]: ')) || '').trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return ctx.io.print('已取消');
  ctx.io.print('正在下载并安装最新版本（完成后会重启面板服务）…');
  const result = spawnSync('sh', ['-c', 'curl -fsSL ' + INSTALL_URL + ' | sh'], {
    stdio: 'inherit',
    timeout: 600000,
    env: Object.assign({}, process.env, { UNIPROXY_NO_MENU: '1' }),
  });
  if (result.error) return ctx.io.print('更新失败: ' + result.error.message);
  ctx.io.print(result.status === 0 ? '更新完成' : ('更新失败: exit ' + result.status));
}

export async function runSetupItem(ctx) {
  const mod = await import('./setup.js');
  await mod.runSetup({ configPath: ctx.configPath, io: ctx.io });
}

export async function uninstallSystem(ctx) {
  const p = paths();
  const configPath = pjoin(p.etcDir, 'config.json');
  for (const name of ['uniproxy-ui.service', 'uniproxy-sub.service']) {
    run('systemctl disable --now ' + name);
    try { fs.unlinkSync(path.join(p.unitDir, name)); } catch (e) { /* missing */ }
  }
  run('systemctl daemon-reload');
  for (const name of ['uniproxy', 'u-ui']) {
    try { fs.unlinkSync(pjoin(p.binDir, name)); ctx.io.print('已删除 ' + pjoin(p.binDir, name)); } catch (e) { /* missing */ }
  }
  try { fs.rmSync(p.prefix, { recursive: true, force: true }); } catch (e) { /* missing */ }
  ctx.io.print('已卸载程序与 unit；配置目录 ' + path.dirname(configPath) + ' 保留（需要时手动删除）');
  ctx.io.print('uniproxy 已卸载，菜单退出');
  ctx.quit = true;
}

/** Where the service should point: a node script needs the interpreter in front. */
export function executable() {
  if (isSea()) return process.execPath;
  const script = process.argv[1] || '';
  if (/\.(js|mjs|cjs)$/.test(script)) return process.execPath + ' ' + script;
  return script || 'uniproxy';
}

export function unitFiles(opts) {
  const exe = opts.exe || executable();
  const cfg = opts.configPath;
  const uiPort = opts.uiPort || 8788;
  const subPort = opts.subPort || 8787;
  // unit files are Linux-only: keep POSIX semantics even when generated on Windows
  const workDir = cfg.indexOf('/') === 0 ? (cfg.replace(/\/[^/]*$/, '') || '/') : path.dirname(path.resolve(cfg));
  const make = function (desc, args) {
    return [
      '[Unit]',
      'Description=' + desc,
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=' + workDir,
      'ExecStart=' + exe + ' ' + args,
      'Restart=on-failure',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
  };
  return {
    'uniproxy-ui.service': make('uniproxy u-ui panel', 'ui -c ' + cfg + ' -p ' + uiPort),
    'uniproxy-sub.service': make('uniproxy subscription server', 'serve -c ' + cfg + ' -p ' + subPort),
  };
}

async function installService(ctx) {
  const files = unitFiles({ configPath: cfgPathOf(ctx) });
  try { fs.mkdirSync(unitDir(), { recursive: true }); } catch (e) { /* exists */ }
  for (const name of Object.keys(files)) {
    const file = path.join(unitDir(), name);
    try { fs.writeFileSync(file, files[name]); ctx.io.print('写入 ' + file); }
    catch (e) { ctx.io.print('写入失败 ' + file + ': ' + e.message); return; }
  }
  const r = run('systemctl daemon-reload');
  ctx.io.print(r.ok ? 'daemon-reload 完成' : ('daemon-reload 失败: ' + (r.output || r.error)));
  ctx.io.print('下一步：菜单 15 启用开机自启，或 systemctl enable --now uniproxy-ui');
}

async function uninstallService(ctx) {
  for (const name of ['uniproxy-ui.service', 'uniproxy-sub.service']) {
    run('systemctl disable --now ' + name);
    try { fs.unlinkSync(path.join(unitDir(), name)); ctx.io.print('已删除 ' + name); }
    catch (e) { ctx.io.print('未找到 ' + name); }
  }
  run('systemctl daemon-reload');
  ctx.io.print('服务单元已卸载');
}

function cfgPathOf(ctx) { return path.resolve(ctx.configPath || 'config.json'); }

function showSettings(ctx) {
  return function (c) {
    const ports = analyzePorts(c);
    const users = resolveUsers(c);
    const cert = certStatus(c);
    ctx.io.print([
      '配置: ' + ctx.configPath,
      'nginx 模式: ' + c.nginx.mode,
      '公网 IP: ' + (isPlaceholderAddress(c.server.publicIp) ? (YELLOW + (c.server.publicIp || '(未设置)') + '（占位符，请先运行 3. 初始化向导）' + RESET) : c.server.publicIp),
      '面板端口: ' + ((c.ui && c.ui.port) || 8788),
      '监听端口: ' + ports.entries.length + ' 个',
      '用户: ' + users.length + ' 个',
      '证书: ' + (cert.ok ? (cert.daysLeft + ' 天后到期') : ('不可读 (' + (cert.error || '') + ')')),
    ].join('\n'));
  };
}

function changePort(ctx) {
  return async function (c, cfgPath) {
    const answer = (await ctx.io.question('新面板端口 [1-65535]: ')).trim();
    const port = Number(answer);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return ctx.io.print('端口无效');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ui = raw.ui || {};
    raw.ui.port = port;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    const synced = syncUnitPorts({ uiPort: port });
    let msg = '已保存面板端口 ' + port;
    if (synced.updated.length) msg += '，已同步服务单元';
    if (synced.errors.length) msg += '，服务单元同步失败（需要 root）: ' + synced.errors.join('; ');
    ctx.io.print(msg + '；重启面板后生效（菜单 12）');
  };
}

async function resetPassword(ctx) {
  const { hashPassword, USERNAME_RE } = await import('./auth.js');
  return async function (c, cfgPath) {
    const first = (c.ui && c.ui.users && c.ui.users[0] && c.ui.users[0].username) || 'admin';
    const username = (await ctx.io.question('用户名 [' + first + ']: ')).trim() || first;
    if (!USERNAME_RE.test(username)) return ctx.io.print('用户名不合法');
    const value = (await ctx.io.question('新密码（回车 = 随机）: ')).trim();
    const password = value || (await import('./setup.js')).randomPassword();
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ui = raw.ui || {};
    raw.ui.users = raw.ui.users || [];
    const idx = raw.ui.users.findIndex(function (u) { return String(u.username) === username; });
    if (idx < 0) return ctx.io.print('没有这个账号: ' + username);
    raw.ui.users[idx].hash = hashPassword(password);
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    ctx.io.print('已更新 ' + username + ' 的密码: ' + password);
  };
}

async function addViewer(ctx) {
  const { hashPassword, USERNAME_RE } = await import('./auth.js');
  return async function (c, cfgPath) {
    const username = String(await ctx.io.question('用户名: ')).trim();
    if (!USERNAME_RE.test(username)) return ctx.io.print('用户名不合法');
    const value = String(await ctx.io.question('密码（回车 = 随机）: ')).trim();
    const password = value || (await import('./setup.js')).randomPassword();
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ui = raw.ui || {};
    raw.ui.users = raw.ui.users || [];
    if (raw.ui.users.some(function (u) { return String(u.username) === username; })) return ctx.io.print('账号已存在');
    raw.ui.users.push({ username: username, role: 'viewer', hash: hashPassword(password), addedAt: new Date().toISOString() });
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    ctx.io.print('已新增只读账号 ' + username + '，密码: ' + password);
  };
}

function setPassword(ctx, key) {
  return async function (c, cfgPath) {
    const value = (await ctx.io.question('新密码（输入可见）: ')).trim();
    if (!value) return ctx.io.print('已取消');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ui = raw.ui || {};
    raw.ui[key] = value;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    ctx.io.print('已更新 ' + key + '，重启面板后生效（菜单 12）');
  };
}

function systemctl(ctx, action) {
  const res = run('systemctl ' + action + ' ' + UI_UNIT);
  ctx.io.print(res.ok ? (action + ' 成功') : (action + ' 失败: ' + (res.output || res.error)));
}

function showStatus(ctx) {
  const lines = ['面板(' + UI_UNIT + '): ' + unitState(UI_UNIT), '开机自启: ' + (run('systemctl is-enabled ' + UI_UNIT).output || 'unknown')];
  for (const name of Object.keys(CORE_UNITS)) lines.push(CORE_UNITS[name] + ': ' + unitState(CORE_UNITS[name]));
  ctx.io.print(lines.join('\n'));
}

function showLogs(ctx) {
  const res = run('journalctl -u ' + UI_UNIT + ' -n 60 --no-pager -o cat');
  ctx.io.print(res.output || '(无日志)');
}

function runValidate(ctx) {
  return function (c) {
    const result = validateConfig(c);
    const ports = analyzePorts(c);
    const errors = result.errors.concat(ports.errors);
    ctx.io.print(errors.length ? ('错误:\n' + errors.join('\n')) : '配置校验通过');
    if (result.warnings.length) ctx.io.print('警告:\n' + result.warnings.join('\n'));
  };
}

function runDoctorItem(ctx) {
  return function (c) {
    const report = runDoctor(c, ctx.configPath);
    ctx.io.print(formatDoctor(report));
  };
}

function runApply(ctx) {
  return async function (c) {
    const targets = buildPlan(c);
    ctx.io.print(formatPlan(targets));
    const answer = (await ctx.io.question('输入 APPLY 执行下发: ')).trim();
    if (answer !== 'APPLY') return ctx.io.print('已取消');
    const result = applyPlan(c, targets, {});
    for (const a of result.actions) ctx.io.print(a.level.toUpperCase() + '  ' + a.text);
  };
}

function doBackup(ctx) {
  return function (c, cfgPath) {
    const name = createBackup(cfgPath, 'menu');
    ctx.io.print('已备份: ' + name);
  };
}

function restorePicker(ctx) {
  return async function (c, cfgPath) {
    const list = listBackups(cfgPath);
    if (!list.length) return ctx.io.print('没有备份');
    list.slice(0, 10).forEach(function (b, i) { ctx.io.print('[' + (i + 1) + '] ' + b.name); });
    const answer = (await ctx.io.question('恢复哪一份 [1-' + Math.min(10, list.length) + ']: ')).trim();
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= Math.min(10, list.length)) return ctx.io.print('已取消');
    const result = restoreBackup(cfgPath, list[idx].name);
    ctx.io.print('已恢复 ' + list[idx].name + '（安全备份 ' + result.safety + '）');
  };
}

function coreAction(ctx, kind, action) {
  const unit = CORE_UNITS[kind];
  const verb = action === 'start' ? '启动' : (action === 'stop' ? '停止' : '重启');
  const res = run('systemctl ' + action + ' ' + unit);
  ctx.io.print(res.ok ? (verb + ' ' + unit + ' 成功') : (verb + ' ' + unit + ' 失败: ' + (res.output || res.error)));
}

function showCert(ctx) {
  return function (c) {
    const s = certStatus(c);
    ctx.io.print(s.ok ? ('subject: ' + s.subject + '\n到期: ' + s.validTo + '（' + s.daysLeft + ' 天）') : ('证书不可读: ' + (s.error || '')));
  };
}

function issueCert(ctx) {
  return async function (c) {
    const answer = (await ctx.io.question('i=申请  r=续期  (回车取消): ')).trim().toLowerCase();
    if (answer !== 'i' && answer !== 'r') return ctx.io.print('已取消');
    const result = issue(c, { mode: answer === 'r' ? 'renew' : 'issue' });
    ctx.io.print((result.command ? '$ ' + result.command + '\n' : '') + (result.output || '') + '\n' + (result.ok ? 'OK' : ('FAILED ' + (result.error || ''))));
  };
}

function showAlerts(ctx) {
  return function (c) {
    const alerts = collectAlerts(c, ctx.configPath);
    ctx.io.print(alerts.length ? alerts.map(function (a) { return a.level.toUpperCase() + '  ' + a.title + '  ' + a.detail; }).join('\n') : '没有告警');
  };
}

function showNodes(ctx) {
  return function (c) {
    const nodes = normalizeNodes(c);
    ctx.io.print(nodes.length ? nodes.map(function (n) { return n.id + '  ' + n.user + '@' + n.host + ':' + n.port + '  group=' + n.group; }).join('\n') : '没有节点');
  };
}

function defaultIO() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: function (q) { return new Promise(function (resolve) { rl.question(q, resolve); }); },
    print: function (s) { process.stdout.write(paintLines(String(s)) + '\n'); },
    close: function () { rl.close(); },
  };
}

export async function runMenu(options = {}) {
  const pause = options.pause !== false;
  let configPath = options.configPath || 'config.json';
  if (!fs.existsSync(configPath)) {
    const etc = process.env.UNIPROXY_ETC_DIR || '/etc/uniproxy';
    const installed = path.join(etc, 'config.json');
    if (fs.existsSync(installed)) configPath = installed;
  }
  const ctx = {
    configPath: configPath,
    io: options.io || defaultIO(),
  };
  const items = buildMenu(ctx).reduce(function (acc, s) { return acc.concat(s.items); }, []);
  for (;;) {
    ctx.io.print(renderMenu(ctx));
    const answer = String((await ctx.io.question('\n' + GREEN + '请选择 [0-34/U]: ' + RESET)) || '').trim();
    if (answer === '0' || answer.toLowerCase() === 'q') { ctx.io.print('已退出'); break; }
    const item = items.find(function (i) { return i.key === answer; });
    if (!item) { ctx.io.print('无效选项: ' + answer); continue; }
    try {
      await item.run();
    } catch (e) {
      ctx.io.print('执行失败: ' + e.message);
    }
    if (ctx.quit) {
      if (ctx.io.close) ctx.io.close();
      return;
    }
    if (pause && answer !== '0') {
      ctx.io.print('\n' + YELLOW + '按回车返回主菜单' + RESET);
      await ctx.io.question('');
    }
  }
  if (ctx.io.close) ctx.io.close();
}