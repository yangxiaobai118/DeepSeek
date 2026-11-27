import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * Multi-node orchestration over plain ssh/scp.
 *
 * There is no agent to install: every remote action is an argv array passed to
 * the local ssh/scp client, so nothing from the panel is ever concatenated into
 * a shell string. Nodes are expected to already have uniproxy installed and the
 * operator's key authorised (BatchMode=yes fails fast instead of prompting).
 */

const UNIT_LIST = 'xray sing-box nginx';

export function normalizeNodes(c) {
  return (c.nodes || []).map(function (n) {
    return {
      id: String(n.id || n.name || n.host || ''),
      name: String(n.name || n.host || ''),
      host: String(n.host || ''),
      user: String(n.user || 'root'),
      port: Number(n.port || 22),
      key: String(n.key || ''),
      group: String(n.group || 'default'),
      configPath: String(n.configPath || '/etc/uniproxy/config.json'),
    };
  }).filter(function (n) { return n.id && n.host; });
}

export function sshArgs(node, remote) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-p', String(node.port)];
  if (node.key) args.push('-i', node.key);
  args.push(node.user + '@' + node.host, remote);
  return args;
}

export function probeCommand(node) {
  return ['ssh'].concat(sshArgs(node, 'for u in ' + UNIT_LIST + '; do printf "%s=" "$u"; systemctl is-active "$u"; done'));
}

export function deployCommands(cfgPath, node) {
  if (!path.isAbsolute(node.configPath)) throw new Error('node configPath must be absolute');
  const scpArgs = ['-P', String(node.port)];
  if (node.key) scpArgs.push('-i', node.key);
  scpArgs.push(cfgPath, node.user + '@' + node.host + ':' + node.configPath);
  const remote = 'uniproxy validate -c ' + node.configPath + ' && uniproxy apply -c ' + node.configPath + ' --yes';
  return [['scp'].concat(scpArgs), ['ssh'].concat(sshArgs(node, remote))];
}

function defaultRun(argv) {
  const res = spawnSync(argv[0], argv.slice(1), { timeout: 120000, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? res.error.code : null,
    output: String((res.stdout || '') + (res.stderr || '')).trim(),
  };
}

export function probe(node, deps = {}) {
  const run = deps.run || defaultRun;
  const res = run(probeCommand(node));
  const status = {};
  if (res.ok) {
    for (const line of res.output.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) status[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  }
  return { ok: res.ok, status: status, output: res.output, error: res.error || '' };
}

const SAFE_PATH = /^[A-Za-z0-9._\/-]+$/;

export function localChecksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function checksumCommand(node) {
  if (!SAFE_PATH.test(node.configPath)) throw new Error('node configPath contains unsafe characters');
  return ['ssh'].concat(sshArgs(node, 'sha256sum ' + node.configPath + ' 2>/dev/null | cut -d" " -f1'));
}

export function probeBatch(nodes, deps = {}) {
  return {
    ok: true,
    results: nodes.map(function (node) {
      const r = probe(node, deps);
      return { id: node.id, host: node.host, group: node.group, ok: r.ok, status: r.status, output: r.output, error: r.error };
    }),
  };
}

export function deployBatch(cfgPath, nodes, deps = {}) {
  const results = [];
  for (const node of nodes) {
    const r = deploy(cfgPath, node, deps);
    results.push({ id: node.id, host: node.host, group: node.group, ok: r.ok, skipped: Boolean(r.skipped), output: r.output, error: r.error });
  }
  return { ok: results.every(function (r) { return r.ok; }), results: results };
}

export function deploy(cfgPath, node, deps = {}) {
  const run = deps.run || defaultRun;
  const steps = [];
  if (deps.incremental !== false && deps.force !== true) {
    try {
      const local = localChecksum(cfgPath);
      const remote = run(checksumCommand(node));
      const hash = remote.ok ? String(remote.output || '').trim().split(/\s+/)[0] : '';
      if (hash && hash === local) return { ok: true, skipped: true, steps: [], output: 'unchanged, skipped', error: '' };
    } catch (e) {
      // fall through to a full deploy when the check itself fails
    }
  }
  let commands;
  try { commands = deployCommands(cfgPath, node); } catch (e) { return { ok: false, steps: [], output: '', error: e.message }; }
  for (const argv of commands) {
    const res = run(argv);
    steps.push({ command: argv.join(' '), ok: res.ok, output: res.output, error: res.error || '' });
    if (!res.ok) return { ok: false, steps: steps, output: res.output, error: res.error || 'step failed' };
  }
  return { ok: true, steps: steps, output: steps.map(function (s) { return s.output; }).join('\n'), error: '' };
}
