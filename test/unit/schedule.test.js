'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchedule, allocateFrames } = require('../../src/schedule');
const { parseTarget, parsePause } = require('../../src/targets');
const { UsageError } = require('../../src/errors');

const CTX = { maxScroll: 1760, viewportH: 240, rects: { '#mid': { top: 880, height: 100 } } };

function plan(over = {}) {
  return {
    fps: 60,
    scrollDurationS: 10,
    fixedDuration: false,
    pauses: [],
    timeline: [{ type: 'scroll', to: parseTarget('100%'), duration: null, action: null, actionAt: 'start', label: 'scroll' }],
    ...over,
  };
}

test('allocateFrames: counts always sum to totalFrames exactly', () => {
  // Deterministic pseudo-random durations; no ±1 drift is allowed anywhere.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rnd() * 8);
    const durations = Array.from({ length: n }, () => rnd() * 5 + 0.01);
    const totalS = durations.reduce((a, b) => a + b, 0);
    const fps = [10, 24, 30, 60][Math.floor(rnd() * 4)];
    const totalFrames = Math.max(1, Math.round(totalS * fps));
    const counts = allocateFrames(durations, totalS, totalFrames);
    assert.equal(counts.reduce((a, b) => a + b, 0), totalFrames, `trial ${trial}`);
    assert.ok(counts.every((c) => c >= 0 && Number.isInteger(c)), `trial ${trial}`);
  }
});

test('REGRESSION: a single scroll reproduces the original y = maxScroll*i/(N-1)', () => {
  const s = buildSchedule(plan({ fps: 10, scrollDurationS: 1 }), CTX);
  assert.equal(s.totalFrames, 10);
  assert.equal(s.frames[0].y, 0, 'first frame is exactly at the top');
  assert.equal(s.frames[9].y, 1760, 'last frame is exactly at the bottom');
  for (let i = 0; i < 10; i++) {
    assert.ok(Math.abs(s.frames[i].y - (1760 * i) / 9) < 1e-9, `frame ${i}`);
  }
});

test('tMs sits on the fps grid and never goes backwards', () => {
  const s = buildSchedule(plan({ fps: 24, scrollDurationS: 3 }), CTX);
  for (const f of s.frames) assert.equal(f.tMs, Math.round((f.i * 1000) / 24));
  for (let i = 1; i < s.frames.length; i++) assert.ok(s.frames[i].tMs >= s.frames[i - 1].tMs);
});

test('extend mode: pauses add to the video length', () => {
  const s = buildSchedule(plan({ pauses: [parsePause('30%:2'), parsePause('70%:2')] }), CTX);
  assert.equal(s.totalDurationS, 14, '10s scroll + 2s + 2s');
  assert.equal(s.totalFrames, 840);
  assert.equal(s.holdS, 4);
  assert.equal(s.motionS, 10);
  assert.deepEqual(s.segments.map((g) => g.kind), ['scroll', 'hold', 'scroll', 'hold', 'scroll']);
  assert.equal(s.frames[s.frames.length - 1].y, 1760);
});

test('fixed mode: --duration is the hard total and the scroll compresses', () => {
  const s = buildSchedule(plan({ fixedDuration: true, pauses: [parsePause('30%:2'), parsePause('70%:2')] }), CTX);
  assert.equal(s.totalDurationS, 10);
  assert.equal(s.totalFrames, 600);
  assert.equal(s.holdS, 4);
  assert.ok(Math.abs(s.motionS - 6) < 1e-9, 'scroll squeezed from 10s into 6s');
  // Scroll segments scaled by (10-4)/10 = 0.6
  const scrolls = s.segments.filter((g) => g.kind === 'scroll');
  assert.ok(Math.abs(scrolls.reduce((a, g) => a + g.seconds, 0) - 6) < 1e-9);
});

test('fixed mode: holds that do not fit are a pointed usage error', () => {
  assert.throws(
    () => buildSchedule(plan({ fixedDuration: true, scrollDurationS: 3, pauses: [parsePause('50%:3.5')] }), CTX),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /holds total 3.5s but --duration is 3s/);
      return true;
    }
  );
});

test('a hold holds: y is exactly constant across the segment', () => {
  const s = buildSchedule(plan({ pauses: [parsePause('50%:2')] }), CTX);
  const hold = s.segments.find((g) => g.kind === 'hold');
  const ys = s.frames.filter((f) => f.segment === s.segments.indexOf(hold)).map((f) => f.y);
  assert.equal(new Set(ys).size, 1, 'every frame of the hold is at the same offset');
  assert.equal(ys[0], 880, '50% of 1760');
  assert.equal(ys.length, 120, '2s at 60fps');
});

test('scroll time is shared in proportion to distance travelled', () => {
  // A pause at 90% means a long first leg and a short last one.
  const s = buildSchedule(plan({ pauses: [parsePause('90%:1')] }), CTX);
  const [first, , last] = s.segments;
  assert.ok(Math.abs(first.seconds - 9) < 1e-9);
  assert.ok(Math.abs(last.seconds - 1) < 1e-9);
});

test('pauses resolving to the same pixel merge into one hold', () => {
  const s = buildSchedule(plan({ pauses: [parsePause('50%:1'), parsePause('880px:2')] }), CTX);
  assert.equal(s.segments.filter((g) => g.kind === 'hold').length, 1);
  assert.equal(s.holdS, 3);
  assert.match(s.warnings.join(' '), /merged into one hold/);
});

test('pauses at the very top and very bottom become boundary holds', () => {
  const s = buildSchedule(plan({ pauses: [parsePause('top:1'), parsePause('bottom:2')] }), CTX);
  assert.deepEqual(s.segments.map((g) => g.kind), ['hold', 'scroll', 'hold']);
  assert.equal(s.segments[0].y0, 0);
  assert.equal(s.segments[2].y0, 1760);
});

test('actions land on the first or last frame of their step', () => {
  const fn = () => {};
  const s = buildSchedule(
    plan({
      scrollDurationS: 2,
      fps: 10,
      timeline: [
        { type: 'scroll', to: parseTarget('50%'), duration: 1, action: fn, actionAt: 'start', label: 'a' },
        { type: 'scroll', to: parseTarget('100%'), duration: 1, action: fn, actionAt: 'end', label: 'b' },
      ],
    }),
    CTX
  );
  const withActions = s.frames.filter((f) => f.actions.length).map((f) => f.i);
  assert.deepEqual(withActions, [0, s.totalFrames - 1]);
});

test('an unscrollable page still produces a well-formed static schedule', () => {
  const s = buildSchedule(plan({ fps: 10, scrollDurationS: 1 }), { maxScroll: 0, viewportH: 240, rects: {} });
  assert.equal(s.totalFrames, 10);
  assert.ok(s.frames.every((f) => f.y === 0));
});

test('a hold shorter than one frame is dropped with a warning', () => {
  const s = buildSchedule(plan({ fps: 10, pauses: [parsePause('50%:0.01')] }), CTX);
  assert.match(s.warnings.join(' '), /shorter than one frame/);
  assert.equal(s.frames.reduce((a, b) => a + 1, 0), s.totalFrames);
});

test('selector targets work as pause points', () => {
  const s = buildSchedule(plan({ pauses: [parsePause('#mid:1.5')] }), CTX);
  const hold = s.segments.find((g) => g.kind === 'hold');
  assert.equal(hold.y0, 880);
  assert.equal(s.totalDurationS, 11.5);
});

test('every frame index is contiguous from 0', () => {
  const s = buildSchedule(plan({ fps: 30, pauses: [parsePause('25%:1'), parsePause('75%:1')] }), CTX);
  assert.equal(s.frames.length, s.totalFrames);
  s.frames.forEach((f, i) => assert.equal(f.i, i));
});

test('WARNS when --duration is set but every step names its own', () => {
  // Silently ignoring a typed flag is how you ask for 30s and get 4.
  const s = buildSchedule(
    plan({ durationWasSet: true, scrollDurationS: 30,
      timeline: [{ type: 'scroll', to: parseTarget('100%'), duration: 4, action: null, actionAt: 'start', label: 'x' }] }),
    CTX
  );
  assert.equal(s.totalDurationS, 4);
  assert.match(s.warnings.join(' '), /--duration 30s was ignored/);
});

test('--fixed-duration with nothing to compress is an error, not a stretched hold', () => {
  // This used to inflate a declared 3s hold to 8s while --dry-run said 3s.
  assert.throws(
    () => buildSchedule(
      plan({ fixedDuration: true, scrollDurationS: 10,
        timeline: [{ type: 'hold', at: null, duration: 2, action: null, actionAt: 'start', label: 'a' },
                   { type: 'hold', at: null, duration: 3, action: null, actionAt: 'start', label: 'b' }] }),
      CTX
    ),
    /needs something to compress/
  );
});

test('WARNS when a zero-frame segment takes its action with it', () => {
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 10,
      timeline: [
        { type: 'scroll', to: parseTarget('50%'), duration: 5, action: null, actionAt: 'start', label: 'a' },
        { type: 'scroll', to: parseTarget('50%'), duration: 0.004, action: () => {}, actionAt: 'start', label: 'fire me' },
        { type: 'scroll', to: parseTarget('100%'), duration: 5, action: null, actionAt: 'start', label: 'c' }] }),
    CTX
  );
  assert.equal(s.frames.filter((f) => f.actions.length).length, 0, 'the action really is lost');
  assert.match(s.warnings.join(' '), /"fire me" is shorter than one frame/);
  assert.match(s.warnings.join(' '), /along with its action/);
});
