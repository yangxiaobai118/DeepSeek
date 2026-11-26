import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from './helpers.js';
import { buildPlan, formatPlan, applyPlan, DEFAULT_RELOAD } from '../src/apply.js';

function withApplyTargets(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniproxy-test-'));
  c.apply = {
    xrayConfig: path.join(dir, 'xray.json'),
    singboxConfig: path.join(dir, 'singbox.json'),
    nginxConfig: path.join(dir, 'nginx.conf'),
    backup: true,
  };
  return { c, dir };
}

test('plan uses service reload commands, not validators', () => {
  const { c } = withApplyTargets(makeConfig());
  const plan = buildPlan(c);
  for (const target of plan) {
    assert.equal(target.reload, DEFAULT_RELOAD[target.kind]);
    assert.notEqual(target.reload, target.validate);
  }
});

test('plan marks every target as changed on first install', () => {
  const { c } = withApplyTargets(makeConfig());
  const plan = buildPlan(c);
  assert.equal(plan.length, 3);
  assert.ok(plan.every((t) => t.changed));
  assert.match(formatPlan(plan), /changed/);
});

test('apply installs configs and a second plan is unchanged', () => {
  const { c } = withApplyTargets(makeConfig());
  const first = applyPlan(c, buildPlan(c), { skipValidate: true, skipReload: true });
  assert.equal(first.failed, false);
  for (const file of [c.apply.xrayConfig, c.apply.singboxConfig, c.apply.nginxConfig]) {
    assert.ok(fs.existsSync(file), file + ' should exist');
    assert.ok(fs.statSync(file).size > 0);
  }
  const second = buildPlan(c);
  assert.ok(second.every((t) => !t.changed));
  const noop = applyPlan(c, second, { skipValidate: true, skipReload: true });
  assert.equal(noop.failed, false);
  assert.match(noop.actions[0].text, /nothing to do/);
});

test('re-applying after a change keeps a backup', () => {
  const { c } = withApplyTargets(makeConfig());
  applyPlan(c, buildPlan(c), { skipValidate: true, skipReload: true });
  c.xray.inbounds[0].port = 10999;
  const plan = buildPlan(c);
  assert.equal(plan.find((t) => t.kind === 'xray').changed, true);
  applyPlan(c, plan, { skipValidate: true, skipReload: true });
  // the port change also moves the nginx stream route, so two targets change
  const backups = fs.readdirSync(path.dirname(c.apply.xrayConfig)).filter((f) => f.includes('.bak-'));
  assert.ok(backups.length >= 1);
  assert.ok(backups.some((f) => f.startsWith('xray.json.bak-')));
  assert.match(fs.readFileSync(c.apply.xrayConfig, 'utf8'), /10999/);
});