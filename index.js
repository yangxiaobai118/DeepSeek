#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import { analyzePorts, formatPortTable } from './ports.js';
import { generateXray } from './generators/xray.js';
import { generateSingbox } from './generators/singbox.js';
import { generateNginx } from './generators/nginx.js';
import { generateLinks } from './generators/links.js';
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
    '  uniproxy generate  -c <config.json> [-o out]   write xray/sing-box/nginx configs + links',
    '  uniproxy links     -c <config.json>            print client share links',
    '  uniproxy serve     -c <config.json> [-p 8787]  start the read-only web dashboard',
    '',
    'Options:',
    '  -c, --config <file>   path to the unified config (default: config.json)',
    '  -o, --out <dir>       output directory for generate (default: out)',
    '  -p, --port <n>        dashboard port (default: 8787)',
  ].join(NL);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') args.config = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '-p' || a === '--port') args.port = Number(argv[++i]);
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
      domains: { web: 'www.example.com' },
      cert: {
        certFile: '/etc/uniproxy/certs/fullchain.pem',
        keyFile: '/etc/uniproxy/certs/privkey.pem',
      },
    },
    ports: { http: 80, https: 443, nginxInternalTls: 8443 },
    panels: {
      xui: { enabled: true, domain: 'xui.example.com', listen: '127.0.0.1', port: 54321 },
      sui: { enabled: true, domain: 'sui.example.com', listen: '127.0.0.1', port: 2095 },
    },
    nginx: {
      mode: 'stream',
      sites: [{ serverName: 'www.example.com', root: '/var/www/html', index: 'index.html' }],
    },
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
          clients: [{ id: uuid1, email: 'user1', flow: 'xtls-rprx-vision' }],
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
          wsPath: '/sbws',
          users: [{ uuid: uuid2, name: 'sbuser', flow: '' }],
        },
      ],
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

  const links = generateLinks(config);
  files[path.join(outDir, 'links.txt')] =
    '# client share links (import into v2rayN / NekoBox)' + NL + links.join(NL) + NL;

  for (const file of Object.keys(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files[file]);
  }

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
  for (const l of generateLinks(loaded.config)) console.log(l);
}

async function cmdServe(args) {
  const mod = await import('./server.js');
  const loaded = loadConfig(args.config || 'config.json');
  mod.startDashboard(loaded.config, loaded.path, args.port || 8787);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
      console.log(usage());
      return;
    }
    if (cmd === 'init') cmdInit(args);
    else if (cmd === 'validate') cmdValidate(args);
    else if (cmd === 'ports') cmdPorts(args);
    else if (cmd === 'generate') cmdGenerate(args);
    else if (cmd === 'links') cmdLinks(args);
    else if (cmd === 'serve') await cmdServe(args);
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
