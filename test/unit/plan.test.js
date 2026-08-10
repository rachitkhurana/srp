'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadUserModule } = require('../../src/loader');
const { build, validate, collectSelectors } = require('../../src/plan');
const { parse } = require('../../src/options');
const { UsageError } = require('../../src/errors');

const PLANS = path.join(__dirname, '..', 'fixtures', 'plans');
const cfg = (argv = []) => parse(argv);

test('CLI-only: the synthetic timeline is a single full-page scroll', () => {
  const plan = build(cfg(['x.com', '5']));
  assert.equal(plan.timeline.length, 1);
  assert.deepEqual(plan.timeline[0].to, { kind: 'percent', value: 100, align: 'top', offset: 0 });
  assert.equal(plan.timeline[0].duration, null);
  assert.equal(plan.scrollDurationS, 5);
  assert.deepEqual(plan.pauses, []);
});

test('CLI --pause becomes pauses, not timeline steps', () => {
  const plan = build(cfg(['--pause', '40%:2', '--pause', '#p:1']));
  assert.equal(plan.pauses.length, 2);
  assert.equal(plan.timeline.length, 1, 'pauses are expanded later, once targets have pixel values');
  assert.deepEqual(collectSelectors(plan), ['#p']);
});

test('CJS, ESM-default and ESM-named plan files all normalise identically', async () => {
  const shape = (p) => ({
    duration: p.scrollDurationS,
    steps: p.timeline.map((s) => ({ type: s.type, to: s.to, at: s.at, duration: s.duration, actionAt: s.actionAt })),
    hooks: [typeof p.before, typeof p.after],
    hasAction: p.timeline.map((s) => typeof s.action === 'function'),
  });

  const built = [];
  for (const f of ['plan.cjs', 'plan.mjs', 'plan-named.mjs']) {
    const planModule = await loadUserModule(path.join(PLANS, f));
    built.push(shape(validate(build({ ...cfg([]), planModule }))));
  }
  assert.deepEqual(built[1], built[0], 'plan.mjs differs from plan.cjs');
  assert.deepEqual(built[2], built[0], 'plan-named.mjs differs from plan.cjs');
  assert.deepEqual(built[0].hooks, ['function', 'function']);
  assert.deepEqual(built[0].hasAction, [false, true, false]);
  assert.equal(built[0].duration, 4, 'the plan file supplied the duration');
});

test('an unparseable plan file reports the absolute path', async () => {
  await assert.rejects(() => loadUserModule(path.join(PLANS, 'plan-broken.cjs')), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /plan-broken\.cjs/);
    return true;
  });
});

test('a missing plan file is a usage error', async () => {
  await assert.rejects(() => loadUserModule(path.join(PLANS, 'nope.cjs')), /cannot find/);
});

test('precedence: explicit flag beats plan file beats default', async () => {
  const planModule = await loadUserModule(path.join(PLANS, 'plan.cjs'));
  assert.equal(build({ ...cfg([]), planModule }).scrollDurationS, 4, 'plan file beats the default 10');
  assert.equal(build({ ...cfg(['--duration', '7']), planModule }).scrollDurationS, 7, 'typed flag beats the plan file');
  assert.equal(build({ ...cfg([]), planModule }).fps, 60, 'untouched by either');
});

test('a --script file supplies only before/after', async () => {
  const scriptModule = await loadUserModule(path.join(PLANS, 'hooks.cjs'));
  const plan = build({ ...cfg([]), scriptModule });
  assert.equal(typeof plan.before, 'function');
  assert.equal(typeof plan.after, 'function');
  assert.equal(plan.timeline.length, 1, 'a script does not bring a timeline');
});

test('--script overrides a plan file hook, with a warning', async () => {
  const planModule = await loadUserModule(path.join(PLANS, 'plan.cjs'));
  const scriptModule = await loadUserModule(path.join(PLANS, 'hooks.cjs'));
  const warnings = [];
  const plan = build({ ...cfg([]), planModule, scriptModule }, (m) => warnings.push(m));
  assert.equal(plan.before, scriptModule.before);
  assert.match(warnings.join(' '), /--script overrides the plan file's before and after/);
});

test('--pause plus a plan-file timeline is ambiguous and rejected', async () => {
  const planModule = await loadUserModule(path.join(PLANS, 'plan.cjs'));
  assert.throws(() => build({ ...cfg(['--pause', '50%:1']), planModule }), /--pause cannot be combined/);
});

test('step shapes are validated with a precise path', () => {
  const mk = (timeline) => () => validate(build({ ...cfg([]), planModule: { timeline } }));
  assert.throws(mk([{ scrollTo: '50%', hold: 1 }]), /timeline\[0\] cannot be both a scroll and a hold/);
  assert.throws(mk([{ scrollTo: '50%' }, { at: '#a' }]), /timeline\[1\] needs either "scrollTo" or "hold"/);
  assert.throws(mk([{ scrollTo: '50%', duration: 0 }]), /timeline\[0\]\.duration must be greater than 0/);
  assert.throws(mk([{ hold: 0 }]), /timeline\[0\]\.hold must be a number of seconds greater than 0/);
  assert.throws(mk([{ hold: 1, duration: 2 }]), /timeline\[0\] uses "hold" for its length/);
  assert.throws(mk([{ scrollTo: '50%', action: 'nope' }]), /timeline\[0\]\.action must be a function/);
  assert.throws(mk([{ scrollTo: '50%', actionAt: 'middle' }]), /timeline\[0\]\.actionAt must be "start" or "end"/);
  assert.throws(mk([{ scrollTo: '50%', durtaion: 2 }]), /timeline\[0\] has unknown key: durtaion/);
  assert.throws(mk([{ scrollTo: '50%', resolveAt: 'runtime' }]), /reserved and not yet supported/);
  assert.throws(mk([]), /must be a non-empty array/);
});

test('a typo at the top level of a plan file is caught', () => {
  assert.throws(() => build({ ...cfg([]), planModule: { timline: [] } }), /unknown key: timline/);
  assert.throws(() => build({ ...cfg([]), planModule: { before: 1 } }) && validate(build({ ...cfg([]), planModule: { before: 1 } })), /before must be a function/);
});

test('plan-file values get the same coercion a flag would', () => {
  const plan = build({ ...cfg([]), planModule: { width: 1921, url: 'localhost:3000' } });
  assert.equal(plan.viewport.width, 1922, 'forced even');
  assert.equal(plan.url, 'http://localhost:3000', 'normalised');
  assert.throws(() => build({ ...cfg([]), planModule: { fps: -1 } }), /--fps must be a positive number/);
});
