#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import { analyzePorts, formatPortTable } from './ports.js';
import { generateXray } from './generators/xray.js';
import { generateSingbox } from './generators/singbox.js';
import { generateNginx } from './generators/nginx.js';
import { generateLinkRecords, generateLinks } from './generators/links.js';
import { collectAlerts, notify, loadState } from './alerts.js';
import { buildSubscriptions } from './subscribe.js';
import { resolveUsers, formatUsersTable } from './users.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { buildPlan, formatPlan, applyPlan } from './apply.js';
import { genUuid, genRealityKeypair, genShortId } from './util.js';

const NL = String.fromCharCode(10);

function usage() {
  return [
    'uniproxy - unified Xray + sing-box + nginx control plane',
    '',
    'Usage:',
    '  uniproxy init      -c <config.json>            create a starter config with real secrets',
    '  uniproxy validate  -c <config.json>            check schema + port conflicts',
    '  uniproxy ports     -c <config.json>            print the resolved port map',
    '  uniproxy generate  -c <config.json> [-o out]   write configs, links and subscriptions',
    '  uniproxy links     -c <config.json>            print client share links',
    '  uniproxy subscribe -c <config.json>            print per-client subscription URLs',
    '  uniproxy users     -c <config.json>            list registry users, quotas and expiry',
    '  uniproxy doctor    -c <config.json>            pre-flight diagnostics',
    '  uniproxy alerts    -c <config.json> [--notify]  list alerts; --notify pushes due ones',
    '  uniproxy menu      -c <config.json>            open the terminal menu (like the x-ui script)',
    '  uniproxy setup     -c <config.json> [--yes]    first-run wizard (random values by default)',
    '  uniproxy apply     -c <config.json> [--yes]    validate, install and reload services',
    '  uniproxy serve     -c <config.json> [-p 8787]  start the dashboard + subscription server',
    '  uniproxy ui        -c <config.json> [-p 8788]  start the u-ui management panel',
    '',
    'Options:',
    '  -c, --config <file>   path to the unified config (default: config.json)',
    '  -o, --out <dir>       output directory for generate (default: out)',
    '  -p, --port <n>        dashboard port (default: 8787)',
    '      --client <name>   only emit links for one client (by name or index)',
    '      --address <ip>    override the public address used in links',
    '      --json            machine-readable output (links, doctor, subscribe)',
    '      --no-probe        doctor: skip xray/sing-box/nginx version probes',
    '      --yes             apply: actually write configs and reload services',
    '      --strict          apply: fail when a validator/reload command is missing',
    '      --skip-validate   apply: do not run xray/sing-box/nginx config tests',
    '      --skip-reload     apply: install configs without reloading services',
  ].join(NL);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') args.config = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '-p' || a === '--port') args.port = Number(argv[++i]);
    else if (a === '--client') args.client = argv[++i];
    else if (a === '--address') args.address = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--no-probe') args.probe = false;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--skip-validate') args.skipValidate = true;
    else if (a === '--skip-reload') args.skipReload = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

function scaffold() {
  const kp = genRealityKeypair();
  const uuid1 = genUuid();
  const uuid2 = genUuid();
  return {
    server: {
      publicIp: '203.0.113.10',
      email: 'admin@example.com',
      secret: crypto.randomBytes(32).toString('base64url'),
      domains: { web: 'www.example.com' },
      cert: {
        certFile: '/etc/uniproxy/certs/fullchain.pem',
        keyFile: '/etc/uniproxy/certs/privkey.pem',
      },
    },
    ports: { http: 80, https: 443, nginxInternalTls: 8443 },
    panels: {
      xui: { enabled: true, domain: 'xui.example.com', listen: '127.0.0.1', port: 54321 },
      sui: {
        enabled: true,
        domain: 'sui.example.com',
        listen: '127.0.0.1',
        port: 2095,
        sub: { enabled: true, domain: 'sub.example.com', port: 2096, path: '/sub/' },
      },
    },
    nginx: {
      mode: 'stream',
      http2: 'listen',
      sites: [{ serverName: 'www.example.com', root: '/var/www/html', index: 'index.html' }],
      extraSites: [],
    },
    subscription: {
      enabled: true,
      basePath: '/sub',
      publicBase: '',
      webPageUrl: '',
      supportUrl: '',
      updateIntervalHours: 12,
      profileTitle: 'uniproxy',
      routing: {
        bypassPrivate: true,
        directDomains: [],
        directCidrs: [],
        blockDomains: [],
      },
    },
    users: [],
    xray: {
      enabled: true,
      logLevel: 'warning',
      inbounds: [
        {
          tag: 'xray-vless-reality',
          protocol: 'vless',
          listen: '127.0.0.1',
          port: 10443,
          sni: 'www.bing.com',
          network: 'tcp',
          security: 'reality',
          reality: {
            dest: 'www.bing.com:443',
            serverNames: ['www.bing.com'],
            privateKey: kp.privateKey,
            shortIds: [genShortId()],
          },
          clients: [{ id: uuid1, name: 'user1', flow: 'xtls-rprx-vision' }],
        },
      ],
    },
    singbox: {
      enabled: true,
      logLevel: 'warn',
      inbounds: [
        {
          tag: 'sb-vless-ws-tls',
          listen: '127.0.0.1',
          port: 2052,
          sni: 'sb.example.com',
          network: 'ws',
          security: 'tls',
          path: '/sbws',
          users: [{ uuid: uuid2, name: 'sbuser', flow: '' }],
        },
      ],
    },
    apply: {
      xrayConfig: '/usr/local/etc/xray/config.json',
      singboxConfig: '/usr/local/etc/sing-box/config.json',
      nginxConfig: '/etc/nginx/nginx.conf',
      backup: true,
    },
  };
}

function cmdInit(args) {
  const file = args.config || 'config.json';
  if (fs.existsSync(file)) {
    console.error('refusing to overwrite existing ' + file);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scaffold(), null, 2) + NL);
  console.log('created ' + file + ' with freshly generated Reality keypair + UUIDs');
  console.log('next: edit server.publicIp / domains / cert paths, then run "uniproxy validate"');
}

function cmdValidate(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const config = loaded.config;
  const val = validateConfig(config);
  const portReport = analyzePorts(config);
  const allErrors = val.errors.concat(portReport.errors);
  const allWarnings = val.warnings.concat(portReport.warnings);

  console.log(formatPortTable(config));
  console.log('');
  for (const w of allWarnings) console.log('WARN  ' + w);
  for (const e of allErrors) console.log('ERROR ' + e);
  if (allErrors.length) {
    console.log('');
    console.log(allErrors.length + ' error(s), ' + allWarnings.length + ' warning(s)');
    process.exit(1);
  }
  console.log('');
  console.log('OK - 0 errors, ' + allWarnings.length + ' warning(s)');
}

function cmdPorts(args) {
  const loaded = loadConfig(args.config || 'config.json');
  console.log(formatPortTable(loaded.config));
}

function cmdGenerate(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const config = loaded.config;
  const cfgPath = loaded.path;
  const val = validateConfig(config);
  const portReport = analyzePorts(config);
  const blocking = val.errors.concat(portReport.errors);
  if (blocking.length) {
    for (const e of blocking) console.error('ERROR ' + e);
    console.error('fix errors before generating');
    process.exit(1);
  }

  const outDir = path.resolve(args.out || 'out');
  const files = {};

  const xray = generateXray(config);
  if (xray) files[path.join(outDir, 'xray', 'config.json')] = JSON.stringify(xray, null, 2) + NL;

  const singbox = generateSingbox(config);
  if (singbox) files[path.join(outDir, 'singbox', 'config.json')] = JSON.stringify(singbox, null, 2) + NL;

  files[path.join(outDir, 'nginx', 'nginx.conf')] = generateNginx(config);

  const records = generateLinkRecords(config);
  const links = records.map((r) => r.uri);
  files[path.join(outDir, 'links.txt')] =
    '# client share links (import into v2rayN / NekoBox / Clash)' + NL + links.join(NL) + NL;

  const subs = config.subscription.enabled ? buildSubscriptions(config) : [];
  for (const sub of subs) {
    const stem = path.join(outDir, 'sub', sub.slug + '-' + sub.token);
    files[stem + '.txt'] = sub.base64 + NL;
    if (sub.singbox) files[stem + '.json'] = JSON.stringify(sub.singbox, null, 2) + NL;
    files[stem + '.clash.yaml'] = sub.clash;
  }

  for (const file of Object.keys(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files[file]);
  }

  const subLines = subs.map(function (s) {
    const rel = config.subscription.basePath + '/' + s.token;
    const url = config.subscription.publicBase
      ? config.subscription.publicBase.replace(/\/+$/, '') + rel
      : rel;
    return '  - ' + s.name + ': ' + url;
  });

  const registryUsers = resolveUsers(config).map(function (u) {
    return '  - ' + u.name + ': ' + u.status +
      (u.expireAt ? ', expires ' + u.expireAt.toISOString().slice(0, 10) : '');
  });

  const summary = [
    '# uniproxy deployment summary',
    '',
    'config: ' + cfgPath,
    'nginx mode: ' + config.nginx.mode,
    '',
    '## port map',
    '    ' + formatPortTable(config).split(NL).join(NL + '    '),
    '',
    '## generated files',
  ]
    .concat(Object.keys(files).map(function (f) { return '  - ' + path.relative(outDir, f); }))
    .concat(['', '## users'])
    .concat(registryUsers.length ? registryUsers : ['  - (no registry users)'])
    .concat(['', '## subscriptions (serve with "uniproxy serve")'])
    .concat(subLines.length ? subLines : ['  - (disabled)'])
    .concat(['', '## client links'])
    .concat(links.map(function (l) { return '  ' + l; }))
    .concat(['', '']);

  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), summary.join(NL));

  console.log('generated:');
  for (const f of Object.keys(files)) console.log('  ' + path.relative(process.cwd(), f));
  console.log('  ' + path.relative(process.cwd(), path.join(outDir, 'SUMMARY.md')));
}

function cmdLinks(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const records = generateLinkRecords(loaded.config, {
    client: args.client,
    address: args.address,
  });
  if (args.json) {
    console.log(JSON.stringify(records.map(function (r) {
      return { client: r.client, tag: r.tag, protocol: r.protocol, uri: r.uri };
    }), null, 2));
    return;
  }
  for (const r of records) console.log(r.uri);
}

function cmdSubscribe(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const config = loaded.config;
  const subs = buildSubscriptions(config);
  if (args.json) {
    console.log(JSON.stringify(subs.map(function (s) {
      return { name: s.name, token: s.token, url: config.subscription.basePath + '/' + s.token, links: s.links.length };
    }), null, 2));
    return;
  }
  if (!subs.length) {
    console.log('no subscriptions (check subscription.enabled and inbound clients)');
    return;
  }
  const base = config.subscription.publicBase
    ? config.subscription.publicBase.replace(/\/+$/, '')
    : 'http://127.0.0.1:8787';
  console.log('subscriptions (' + subs.length + '):');
  for (const s of subs) {
    const root = base + config.subscription.basePath + '/' + s.token;
    const status = s.user ? s.user.status : 'active';
    const expiry = s.user && s.user.expireAt ? s.user.expireAt.toISOString().slice(0, 10) : '-';
    console.log('  ' + s.name + '  (' + s.links.length + ' link(s), ' + status + ', expires ' + expiry + ')');
    console.log('    links: ' + root);
    console.log('    json:  ' + root + '/json');
    console.log('    clash: ' + root + '/clash');
  }
}

function cmdUsers(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const users = resolveUsers(loaded.config);
  if (args.json) {
    console.log(JSON.stringify(users.map(function (u) {
      return {
        name: u.name,
        status: u.status,
        expireAt: u.expireAt ? u.expireAt.toISOString() : null,
        dataLimitBytes: u.dataLimitBytes,
        usage: u.usage,
        token: u.token,
        inbounds: u.inbounds.map(function (x) { return x.tag; }),
        note: u.note,
      };
    }), null, 2));
    return;
  }
  if (!users.length) {
    console.log('no users in the registry; add a "users" array to config.json');
    return;
  }
  console.log(formatUsersTable(users));
}

function cmdDoctor(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const report = runDoctor(loaded.config, loaded.path, { probe: args.probe !== false });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctor(report));
  if (report.failed) process.exit(1);
}

function cmdApply(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const config = loaded.config;
  const val = validateConfig(config);
  const portReport = analyzePorts(config);
  const blocking = val.errors.concat(portReport.errors);
  if (blocking.length) {
    for (const e of blocking) console.error('ERROR ' + e);
    console.error('fix errors before applying');
    process.exit(1);
  }
  if (!config.apply) {
    console.error('no "apply" block in config; add target paths first');
    process.exit(1);
  }

  const targets = buildPlan(config);
  if (!targets.length) {
    console.error('apply has no target paths; set apply.xrayConfig / singboxConfig / nginxConfig');
    process.exit(1);
  }
  console.log(formatPlan(targets));
  if (!args.yes) {
    console.log('');
    console.log('dry run: re-run with --yes to write these files and reload the services');
    return;
  }

  const result = applyPlan(config, targets, {
    strict: args.strict,
    skipValidate: args.skipValidate,
    skipReload: args.skipReload,
  });
  console.log('');
  for (const a of result.actions) console.log(a.level.toUpperCase() + '  ' + a.text);
  if (result.failed) process.exit(1);
}

async function cmdSetup(args) {
  const mod = await import('./setup.js');
  const flags = {};
  const rest = args._.slice(1);
  const yes = rest.includes('--yes');
  const dryRun = rest.includes('--dry-run');
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : '';
    if (name === 'domain') flags.domain = value;
    else if (name === 'ip') flags.ip = value;
    else if (name === 'email') flags.email = value;
    else if (name === 'panel-port') flags.panelPort = value;
    else if (name === 'sub-port') flags.subPort = value;
    else if (name === 'password') flags.password = value;
    else if (name === 'no-viewer') flags.viewer = false;
  }
  const result = await mod.runSetup({ configPath: args.config || 'config.json', yes: yes, flags: flags, detectIp: !yes });
  if (!result.ok) process.exitCode = 1;
}

async function cmdMenu(args) {
  const mod = await import('./menu.js');
  await mod.runMenu({ configPath: args.config || 'config.json' });
}

async function cmdAlerts(args) {
  const loaded = loadConfig(args.config || 'config.json');
  const alerts = collectAlerts(loaded.config, loaded.path);
  if (args.json) {
    console.log(JSON.stringify(alerts, null, 2));
    return;
  }
  if (!alerts.length) console.log('no alerts');
  for (const a of alerts) console.log(a.level.toUpperCase() + '  ' + a.title + '  ' + a.detail);
  if (args._.includes('--notify')) {
    const stateFile = loaded.path + '.alerts-state.json';
    const result = await notify(loaded.config, alerts, { state: loadState(stateFile), stateFile: stateFile });
    console.log('notify: sent=' + result.sent + ' skipped=' + result.skipped + (result.errors.length ? ' errors=' + result.errors.join('; ') : ''));
  }
}

async function cmdServe(args) {
  const mod = await import('./server.js');
  const loaded = loadConfig(args.config || 'config.json');
  const port = args.port || (loaded.config.subscription && loaded.config.subscription.port) || 8787;
  mod.startDashboard(loaded.config, loaded.path, port);
}

async function cmdUi(args) {
  const mod = await import('./ui/server.js');
  const loaded = loadConfig(args.config || 'config.json');
  const port = args.port || (loaded.config.ui && loaded.config.ui.port) || 8788;
  const inst = await mod.startUi(args.config || 'config.json', port);
  console.log('u-ui -> ' + inst.url);
  console.log('password: UNIPROXY_UI_PASSWORD env var, or "ui": { "password": "..." } in the config');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (!cmd && process.stdin.isTTY) {
      await cmdMenu(args);
      return;
    }
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
      console.log(usage());
      return;
    }
    if (cmd === 'init') cmdInit(args);
    else if (cmd === 'validate') cmdValidate(args);
    else if (cmd === 'ports') cmdPorts(args);
    else if (cmd === 'generate') cmdGenerate(args);
    else if (cmd === 'links') cmdLinks(args);
    else if (cmd === 'subscribe') cmdSubscribe(args);
    else if (cmd === 'users') cmdUsers(args);
    else if (cmd === 'doctor') cmdDoctor(args);
    else if (cmd === 'alerts') await cmdAlerts(args);
    else if (cmd === 'menu') await cmdMenu(args);
    else if (cmd === 'setup') await cmdSetup(args);
    else if (cmd === 'apply') cmdApply(args);
    else if (cmd === 'serve') await cmdServe(args);
    else if (cmd === 'ui') await cmdUi(args);
    else {
      console.error('unknown command: ' + cmd);
      console.log(usage());
      process.exit(1);
    }
  } catch (e) {
    console.error('fatal: ' + e.message);
    process.exit(1);
  }
}

main();