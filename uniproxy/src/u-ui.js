#!/usr/bin/env node
import { runMenu } from './menu.js';

const args = process.argv.slice(2);
let configPath = 'config.json';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-c' || args[i] === '--config') configPath = args[++i];
}

runMenu({ configPath }).catch(function (e) {
  console.error('fatal: ' + e.message);
  process.exit(1);
});
