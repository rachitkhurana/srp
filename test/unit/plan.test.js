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
  assert.throws(mk([{ hold: 2, ease: 'sine.out' }]), /timeline\[0\] is a hold, which does not move; drop "ease"/);
  assert.throws(mk([{ scrollTo: '50%', ease: 'bounce.out' }]), /--ease does not know "bounce.out"/);
  assert.throws(mk([]), /must be a non-empty array/);
});

test('--ease resolves to a curve, on the plan and per step', () => {
  const flag = build(cfg(['--ease', 'power2.inOut']));
  assert.equal(flag.ease.name, 'power2.inOut');
  assert.equal(flag.ease.linear, false);
  assert.equal(typeof flag.ease.fn, 'function');
  assert.equal(flag.timeline[0].ease, null, 'the synthetic step inherits rather than overriding');

  const dflt = build(cfg([]));
  assert.equal(dflt.ease.name, 'linear');
  assert.equal(dflt.ease.linear, true, 'so schedule.js can skip the easing path entirely');

  const stepped = validate(build({ ...cfg([]), planModule: { timeline: [{ scrollTo: '100%', ease: 'sine.out' }] } }));
  assert.equal(stepped.ease.name, 'linear');
  assert.equal(stepped.timeline[0].ease.name, 'sine.out');
});

test('ramp mode: --ease ramp, or naming either side, and 1.5s fills the rest', () => {
  const both = build(cfg(['--ease', 'ramp']));
  assert.equal(both.ease.ramp, true);
  assert.equal(both.ease.name, 'ramp 1.5s/1.5s smooth');

  // Naming one side switches ramp mode on by itself; the other side defaults.
  assert.equal(build(cfg(['--ease-in', '3'])).ease.name, 'ramp 3s/1.5s smooth');
  assert.equal(build(cfg(['--ease-out', '4s'])).ease.name, 'ramp 1.5s/4s smooth');
  assert.equal(build(cfg(['--ease', 'ramp', '--ease-in', '2', '--ease-out', '5'])).ease.name, 'ramp 2s/5s smooth');
  assert.equal(build(cfg(['--ease-in', '10%'])).ease.name, 'ramp 10%/1.5s smooth');
  assert.equal(build(cfg(['--ease', 'ramp', '--ease-shape', 'sine'])).ease.name, 'ramp 1.5s/1.5s sine');
});

test('--ease-shape takes a cubic-bezier as well as the named shapes', () => {
  const p = build(cfg(['--ease-in', '0.5', '--ease-out', '0.5', '--ease-shape', 'cubic-bezier(.65,0,.25,.99)']));
  assert.equal(p.ease.name, 'ramp 0.5s/0.5s cubic-bezier(0.65, 0, 0.25, 0.99)');
  assert.ok(Math.abs(p.ease.shapeMean - 0.528) < 0.001, 'and it carries its own mean, not 0.5');

  assert.throws(() => cfg(['--ease-shape', 'cubic-bezier(2,0,1,1)']), /x values must be between 0 and 1/);
  assert.throws(() => cfg(['--ease-shape', 'cubic-bezier(.5,-0.6,.5,1)']), /would scroll backwards inside the ramp/);
  assert.throws(() => cfg(['--ease-shape', 'cubic-bezier(0,0)']), /needs exactly 4 numbers/);
});

test('ramp mode: 0 switches a side off, and 0 on both sides is plain linear', () => {
  assert.equal(build(cfg(['--ease-out', '0'])).ease.name, 'ramp 1.5s/0s smooth');
  const off = build(cfg(['--ease-in', '0', '--ease-out', '0'])).ease;
  assert.equal(off.linear, true, 'so the byte-identical default path is kept');
  assert.equal(off.name, 'linear');
});

test('a curve and a ramp are different models, and combining them is refused', () => {
  assert.throws(
    () => build(cfg(['--ease', 'power2.inOut', '--ease-in', '1'])),
    /--ease power2.inOut stretches one curve over the whole scroll.*Pick one: drop --ease, or use --ease ramp/s
  );
  // --ease linear is the default rather than a choice, so it does not conflict.
  assert.equal(build(cfg(['--ease', 'linear', '--ease-in', '2'])).ease.name, 'ramp 2s/1.5s smooth');
});

test('a ramp is global, so a step cannot ask for one', () => {
  assert.throws(
    () => validate(build({ ...cfg([]), planModule: { timeline: [{ scrollTo: '100%', ease: 'ramp' }] } })),
    /timeline\[0\]\.ease cannot be "ramp"; ramps are set once with --ease-in \/ --ease-out/
  );
});

test('a plan file can set the ramp in camelCase, and flags still win', () => {
  assert.equal(build({ ...cfg([]), planModule: { easeIn: '2', easeOut: '3' } }).ease.name, 'ramp 2s/3s smooth');
  assert.equal(build({ ...cfg([]), planModule: { ease: 'ramp', easeShape: 'linear' } }).ease.name, 'ramp 1.5s/1.5s linear');
  const won = build({ ...cfg(['--ease-in', '5']), planModule: { easeIn: '2' } });
  assert.equal(won.ease.name, 'ramp 5s/1.5s smooth');
});

test('bad ramp lengths are rejected on the command line, not mid-render', () => {
  // "=" form, because parseArgs reads a bare "-1" as another flag.
  assert.throws(() => cfg(['--ease-in=-1']), /--ease-in must be a number of seconds/);
  assert.throws(() => cfg(['--ease-out', '150%']), /--ease-out cannot be more than 100%/);
  assert.throws(() => cfg(['--ease-shape', 'bouncy']), /--ease-shape must be one of linear \| smooth \| sine \| smoother \| smoothest/);
  assert.throws(() => cfg(['--ease-floor=-1']), /--ease-floor must be 0 or greater/);
});

test('--ease accepts GSAP spellings and a cubic-bezier, and rejects nonsense', () => {
  assert.equal(build(cfg(['--ease', 'POWER4.inout'])).ease.name, 'power4.inOut');
  assert.equal(build(cfg(['--ease', 'cubic-bezier(.65,0,.35,1)'])).ease.name, 'cubic-bezier(0.65, 0, 0.35, 1)');
  assert.throws(() => cfg(['--ease', 'quad.in']), /--ease does not know "quad.in"/);
  assert.throws(() => cfg(['--ease', 'cubic-bezier(2,0,1,1)']), /x values must be between 0 and 1/);
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
  assert.throws(() => build({ ...cfg([]), planModule: { ease: 'nope.in' } }), /--ease does not know "nope.in"/);
});

test('a plan file can set the ease, and a typed --ease still wins', () => {
  assert.equal(build({ ...cfg([]), planModule: { ease: 'sine.inOut' } }).ease.name, 'sine.inOut');
  const overridden = build({ ...cfg(['--ease', 'power3.out']), planModule: { ease: 'sine.inOut' } });
  assert.equal(overridden.ease.name, 'power3.out');
});
