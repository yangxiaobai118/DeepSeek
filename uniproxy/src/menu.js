import readline from 'node:readline';
import fs from 'node:fs';
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

/**
 * Terminal menu, modelled on the 3x-ui management script: boxed sections,
 * numbered actions, live status footer. Everything it does is the same code
 * the CLI and the panel call, so behaviour cannot drift.
 */

const UI_UNIT = process.env.UNIPROXY_UI_UNIT || 'uniproxy-ui';
const CORE_UNITS = { xray: 'xray', singbox: 'sing-box', nginx: 'nginx' };
const WIDTH = 46;

function run(command) {
  const res = spawnSync(command, { shell: true, timeout: 20000, encoding: 'utf8' });
  return { ok: res.status === 0, output: String((res.stdout || '') + (res.stderr || '')).trim(), error: res.error ? res.error.code : null };
}

function unitState(unit) {
  const res = run('systemctl is-active ' + unit);
  if (res.error) return 'unknown';
  return res.output || 'unknown';
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

export function box(title, lines) {
  const out = [];
  const head = '┌─ ' + title + ' ';
  out.push(head + '─'.repeat(Math.max(0, WIDTH - dispWidth(head) - 1)) + '┐');
  for (const line of lines) out.push('│ ' + pad(line, WIDTH - 3) + '│');
  out.push('└' + '─'.repeat(WIDTH - 1) + '┘');
  return out.join('\n');
}

function readCfg(cfgPath) {
  const loaded = loadConfig(cfgPath);
  return loaded;
}

export function renderMenu(ctx) {
  const sections = buildMenu(ctx);
  const parts = [];
  parts.push(box('u-ui · uniproxy', ['0. 退出菜单']));
  for (const section of sections) {
    parts.push(box(section.title, section.items.map(function (i) { return i.key + '. ' + i.label; })));
  }
  let cfg = null;
  try { cfg = readCfg(ctx.configPath).config; } catch (e) { /* unreadable config */ }
  const uiState = unitState(UI_UNIT);
  const coreLine = Object.keys(CORE_UNITS).map(function (k) { return CORE_UNITS[k] + ': ' + unitState(CORE_UNITS[k]); }).join('   ');
  const footer = [
    '面板状态: ' + uiState + '   开机自启: ' + (run('systemctl is-enabled ' + UI_UNIT).output || 'unknown'),
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

  const panel = [
    { key: '1', label: '查看当前设置', run: function () { return withCfg(showSettings(ctx)); } },
    { key: '2', label: '修改面板端口', run: function () { return withCfg(changePort(ctx)); } },
    { key: '3', label: '重置管理员密码', run: function () { return withCfg(setPassword(ctx, 'password')); } },
    { key: '4', label: '重置只读密码', run: function () { return withCfg(setPassword(ctx, 'viewerPassword')); } },
  ];

  const service = [
    { key: '5', label: '启动面板', run: function () { return systemctl(ctx, 'start'); } },
    { key: '6', label: '停止面板', run: function () { return systemctl(ctx, 'stop'); } },
    { key: '7', label: '重启面板', run: function () { return systemctl(ctx, 'restart'); } },
    { key: '8', label: '查看状态', run: function () { return showStatus(ctx); } },
    { key: '9', label: '查看日志', run: function () { return showLogs(ctx); } },
    { key: '10', label: '启用开机自启', run: function () { return systemctl(ctx, 'enable'); } },
    { key: '11', label: '关闭开机自启', run: function () { return systemctl(ctx, 'disable'); } },
  ];

  const config = [
    { key: '12', label: '校验配置 validate', run: function () { return withCfg(runValidate(ctx)); } },
    { key: '13', label: '预检 doctor', run: function () { return withCfg(runDoctorItem(ctx)); } },
    { key: '14', label: '生成并下发 apply', run: function () { return withCfg(runApply(ctx)); } },
    { key: '15', label: '立即备份配置', run: function () { return withCfg(doBackup(ctx)); } },
    { key: '16', label: '恢复备份', run: function () { return withCfg(restorePicker(ctx)); } },
  ];

  const cores = [
    { key: '17', label: '重启 xray', run: function () { return restartCore(ctx, 'xray'); } },
    { key: '18', label: '重启 sing-box', run: function () { return restartCore(ctx, 'singbox'); } },
    { key: '19', label: '重启 nginx', run: function () { return restartCore(ctx, 'nginx'); } },
  ];

  const extra = [
    { key: '20', label: '证书状态', run: function () { return withCfg(showCert(ctx)); } },
    { key: '21', label: '申请 / 续期证书', run: function () { return withCfg(issueCert(ctx)); } },
    { key: '22', label: '查看告警', run: function () { return withCfg(showAlerts(ctx)); } },
    { key: '23', label: '节点列表', run: function () { return withCfg(showNodes(ctx)); } },
  ];

  return [
    { title: '面板', items: panel },
    { title: '服务', items: service },
    { title: '配置', items: config },
    { title: '内核', items: cores },
    { title: '其他', items: extra },
  ];
}

function showSettings(ctx) {
  return function (c) {
    const ports = analyzePorts(c);
    const users = resolveUsers(c);
    const cert = certStatus(c);
    ctx.io.print([
      '配置: ' + ctx.configPath,
      'nginx 模式: ' + c.nginx.mode,
      '公网 IP: ' + (c.server.publicIp || '(未设置)'),
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
    ctx.io.print('已保存面板端口 ' + port + '，重启面板后生效（菜单 7）');
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
    ctx.io.print('已更新 ' + key + '，重启面板后生效（菜单 7）');
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

function restartCore(ctx, kind) {
  const unit = CORE_UNITS[kind];
  const res = run('systemctl restart ' + unit);
  ctx.io.print(res.ok ? ('重启 ' + unit + ' 成功') : ('重启 ' + unit + ' 失败: ' + (res.output || res.error)));
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
    print: function (s) { process.stdout.write(String(s) + '\n'); },
    close: function () { rl.close(); },
  };
}

export async function runMenu(options = {}) {
  const ctx = {
    configPath: options.configPath || 'config.json',
    io: options.io || defaultIO(),
  };
  const items = buildMenu(ctx).reduce(function (acc, s) { return acc.concat(s.items); }, []);
  for (;;) {
    ctx.io.print(renderMenu(ctx));
    const answer = String((await ctx.io.question('\n请选择 [0-23]: ')) || '').trim();
    if (answer === '0' || answer.toLowerCase() === 'q') { ctx.io.print('已退出'); break; }
    const item = items.find(function (i) { return i.key === answer; });
    if (!item) { ctx.io.print('无效选项: ' + answer); continue; }
    try {
      await item.run();
    } catch (e) {
      ctx.io.print('执行失败: ' + e.message);
    }
  }
  if (ctx.io.close) ctx.io.close();
}
