'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchedule, allocateFrames, groupRuns, describeSchedule } = require('../../src/schedule');
const { parseTarget, parsePause } = require('../../src/targets');
const { parseEase, parseRampLength, makeRamp } = require('../../src/easing');
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

// -- easing -------------------------------------------------------------------

const scroll = (to, over = {}) => ({
  type: 'scroll', to: parseTarget(to), duration: null, ease: null,
  action: null, actionAt: 'start', label: `to ${to}`, ...over,
});
const holdStep = (seconds, over = {}) => ({
  type: 'hold', at: null, duration: seconds, action: null, actionAt: 'start',
  label: `hold ${seconds}s`, ...over,
});
/** Per-frame scroll distance, i.e. velocity in px/frame. */
const deltas = (frames) => frames.slice(1).map((f, i) => f.y - frames[i].y);

test('an absent plan.ease falls back to linear rather than exploding', () => {
  // Every test above builds a plan with no `ease` key at all, so this fallback
  // is load-bearing for the whole file.
  const s = buildSchedule(plan({ fps: 10, scrollDurationS: 1 }), CTX);
  assert.equal(s.ease, 'linear');
  assert.deepEqual(s.runs.map((r) => r.ease), ['linear']);
});

test('REGRESSION: an explicit linear ease is bit-identical to no ease at all', () => {
  // The default output is pinned byte-for-byte by the e2e suite, so the easing
  // code must not perturb the arithmetic when the curve is the identity.
  const a = buildSchedule(plan({ fps: 30, pauses: [parsePause('40%:1')] }), CTX);
  const b = buildSchedule(plan({ fps: 30, pauses: [parsePause('40%:1')], ease: parseEase('linear') }), CTX);
  assert.equal(a.frames.length, b.frames.length);
  a.frames.forEach((f, i) => assert.equal(f.y, b.frames[i].y, `frame ${i}`));
});

test('easing still lands exactly on both ends of the page', () => {
  for (const name of ['sine.in', 'sine.inOut', 'power1.out', 'power2.inOut', 'power4.in', 'cubic-bezier(0.65,0,0.35,1)']) {
    const s = buildSchedule(plan({ fps: 30, scrollDurationS: 2, ease: parseEase(name) }), CTX);
    assert.equal(s.frames[0].y, 0, `${name}: frame 0 is at the top`);
    assert.equal(s.frames[s.frames.length - 1].y, 1760, `${name}: the last frame is at the bottom`);
  }
});

test('an inOut curve crawls at both ends and runs fast through the middle', () => {
  const eased = buildSchedule(plan({ fps: 60, scrollDurationS: 4, ease: parseEase('power2.inOut') }), CTX);
  const linear = buildSchedule(plan({ fps: 60, scrollDurationS: 4 }), CTX);
  const d = deltas(eased.frames);
  const flat = deltas(linear.frames)[0];

  assert.ok(d.every((v) => v >= 0), 'never scrolls backwards');
  const peak = d[Math.floor(d.length / 2)];
  assert.ok(d[0] < peak / 100, `starts from rest (first step ${d[0]}px vs peak ${peak}px)`);
  assert.ok(d[d.length - 1] < peak / 100, `settles to a stop (last step ${d[d.length - 1]}px)`);
  // A cubic inOut peaks at 3x the average rate, which is the whole point: the
  // same distance in the same time, redistributed.
  assert.ok(Math.abs(peak / flat - 3) < 0.05, `peak should be ~3x the linear rate, got ${peak / flat}`);
  const travelled = eased.frames[eased.frames.length - 1].y - eased.frames[0].y;
  assert.equal(travelled, 1760, 'and the total distance is unchanged');
});

test('easing leaves a hold exactly constant', () => {
  const s = buildSchedule(plan({ fps: 60, ease: parseEase('power2.inOut'), pauses: [parsePause('50%:2')] }), CTX);
  const k = s.segments.findIndex((g) => g.kind === 'hold');
  const ys = s.frames.filter((f) => f.segment === k).map((f) => f.y);
  assert.equal(new Set(ys).size, 1);
  assert.equal(ys[0], 880);
});

test('with --pause, each leg eases independently into and out of the hold', () => {
  const s = buildSchedule(plan({ fps: 60, ease: parseEase('power2.inOut'), pauses: [parsePause('50%:2')] }), CTX);
  assert.equal(s.runs.length, 2, 'the hold splits the motion into two runs');
  assert.deepEqual(s.runs.map((r) => [r.fromSegment, r.toSegment]), [[0, 0], [2, 2]]);

  const d = deltas(s.frames);
  const holdStart = s.segments[1].startFrame;
  const holdEnd = s.segments[2].startFrame;
  assert.ok(d[holdStart - 2] < 0.05, `crawling by the time it reaches the pause (${d[holdStart - 2]}px)`);
  assert.ok(d[holdEnd] < 0.05, `and starting from rest again afterwards (${d[holdEnd]}px)`);
});

test('adjacent scroll steps ease as ONE run, with no stall at the waypoint', () => {
  // This is the reason easing warps time instead of easing each segment's own
  // progress: per-segment, the scroll would decelerate to a dead stop here.
  const s = buildSchedule(
    plan({
      fps: 60, scrollDurationS: 4, ease: parseEase('power2.inOut'),
      timeline: [scroll('50%', { duration: 2 }), scroll('100%', { duration: 2 })],
    }),
    CTX
  );
  assert.equal(s.runs.length, 1, 'both steps belong to one run');
  assert.deepEqual([s.runs[0].fromSegment, s.runs[0].toSegment], [0, 1]);

  const d = deltas(s.frames);
  const join = s.segments[1].startFrame;
  const peak = Math.max(...d);
  // The join sits at the midpoint of the run, which is where an inOut curve is
  // at its fastest, so the velocity there must be at the peak, not at zero.
  assert.ok(d[join - 1] > peak * 0.99, `velocity across the join is ${d[join - 1]}px vs peak ${peak}px`);
  assert.ok(d.every((v) => v >= 0));
});

test('a step that names its own curve becomes its own run', () => {
  const s = buildSchedule(
    plan({
      fps: 30, scrollDurationS: 4, ease: parseEase('power2.inOut'),
      timeline: [
        scroll('50%', { duration: 2 }),
        scroll('100%', { duration: 2, ease: parseEase('linear') }),
      ],
    }),
    CTX
  );
  assert.equal(s.runs.length, 2);
  assert.deepEqual(s.runs.map((r) => r.ease), ['power2.inOut', 'linear']);
  assert.deepEqual(s.segments.map((g) => g.ease), ['power2.inOut', 'linear']);

  // The eased leg still arrives at its declared waypoint on schedule...
  const lastOfFirst = s.frames[s.segments[1].startFrame - 1].y;
  assert.ok(Math.abs(lastOfFirst - 880) < 0.01, `first leg ended at ${lastOfFirst}, expected ~880`);
  // ...and the linear leg keeps a constant rate, unwarped.
  const d = deltas(s.frames.filter((f) => f.segment === 1));
  assert.ok(Math.max(...d) - Math.min(...d) < 1e-9, 'the linear leg is not warped by its neighbour');
});

test('a step curve overrides the plan curve even where they differ in kind', () => {
  const s = buildSchedule(
    plan({
      fps: 30, scrollDurationS: 2,
      timeline: [scroll('100%', { duration: 2, ease: parseEase('sine.out') })],
    }),
    CTX
  );
  assert.equal(s.ease, 'linear', 'the plan-wide curve is still linear');
  assert.deepEqual(s.runs.map((r) => r.ease), ['sine.out']);
  const d = deltas(s.frames);
  assert.ok(d[0] > d[d.length - 1] * 5, 'sine.out starts fast and settles slow');
});

test('a bezier that overshoots really overshoots, then settles back', () => {
  // The run ends mid-page, so the overshoot is visible rather than being eaten
  // by the extent. Flattening it onto the target would silently discard exactly
  // the effect the curve was chosen for.
  const s = buildSchedule(
    plan({
      fps: 60, scrollDurationS: 3, ease: parseEase('cubic-bezier(0.34, 1.8, 0.64, 1)'),
      timeline: [scroll('50%', { duration: 3 }), holdStep(0.5)],
    }),
    CTX
  );
  const peak = Math.max(...s.frames.map((f) => f.y));
  assert.ok(peak > 900, `overshot well past the 880px target, peaking at ${peak}px`);

  // The last SCROLL frame sits at p = 0.9958, not 1, and this curve is still a
  // whisker above 1 there, so it is 880.001px rather than 880 exactly. The hold
  // that follows is pinned to the resolved target, so that is exact.
  const lastMoving = s.frames[s.segments[1].startFrame - 1].y;
  assert.ok(Math.abs(lastMoving - 880) < 0.01, `settled back onto the target (${lastMoving}px)`);
  const held = s.frames.filter((f) => f.segment === 1).map((f) => f.y);
  assert.deepEqual([...new Set(held)], [880], 'and the hold is exactly on it');
});

test('an overshoot at the bottom of the page parks at the extent', () => {
  // Same curve, but the target IS the extent, so there is nowhere to overshoot
  // to. It must clamp rather than emit a y past the end of the document.
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 3, ease: parseEase('cubic-bezier(0.34, 1.8, 0.64, 1)') }),
    CTX
  );
  assert.ok(s.frames.every((f) => f.y >= 0 && f.y <= 1760), 'never leaves the scrollable extent');
  assert.ok(s.frames.some((f) => f.y === 1760 && f.i < s.totalFrames - 1), 'reaches the bottom early and sits there');
  assert.equal(s.frames[s.totalFrames - 1].y, 1760);
});

test('an undershooting curve does not scroll above the top of the page', () => {
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 3, ease: parseEase('cubic-bezier(0.5, -0.6, 0.5, 1)') }),
    CTX
  );
  assert.ok(s.frames.every((f) => f.y >= 0), 'no negative scroll offsets');
  assert.equal(s.frames[0].y, 0);
  assert.equal(s.frames[s.totalFrames - 1].y, 1760);
});

test('easing survives --fixed-duration without changing the total', () => {
  const s = buildSchedule(
    plan({ fixedDuration: true, ease: parseEase('sine.inOut'), pauses: [parsePause('30%:2'), parsePause('70%:2')] }),
    CTX
  );
  assert.equal(s.totalDurationS, 10);
  assert.equal(s.holdS, 4);
  assert.equal(s.frames[0].y, 0);
  assert.equal(s.frames[s.totalFrames - 1].y, 1760);
  assert.equal(s.runs.length, 3);
});

test('groupRuns: holds break a run, and so does a step with its own curve', () => {
  const A = parseEase('power2.inOut');
  const B = parseEase('sine.out');
  const segs = [
    { kind: 'scroll', ease: A, ownEase: false },
    { kind: 'scroll', ease: A, ownEase: false },
    { kind: 'hold' },
    { kind: 'scroll', ease: A, ownEase: false },
    { kind: 'scroll', ease: B, ownEase: true },
    { kind: 'scroll', ease: A, ownEase: false },
  ];
  const runs = groupRuns(segs, [1, 1, 1, 1, 1, 1], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(runs.map((r) => [r.from, r.to]), [[0, 1], [3, 3], [4, 4], [5, 5]]);
  assert.equal(runs[0].D, 2, 'the merged run spans both durations');
  assert.equal(runs[0].T0, 0);
  assert.equal(runs[2].ease, B, 'the own-ease step neither joins nor absorbs its neighbours');
});

test('--dry-run reports the ease and how the runs grouped', () => {
  const s = buildSchedule(plan({ fps: 60, ease: parseEase('power2.inOut'), pauses: [parsePause('50%:2')] }), CTX);
  const text = describeSchedule(s);
  assert.match(text, /ease power2\.inOut over 2 motion runs \(frames 0\.\.\d+, \d+\.\.\d+\)/);

  // A linear schedule says nothing at all, so the common case stays quiet.
  assert.doesNotMatch(describeSchedule(buildSchedule(plan(), CTX)), /ease/);
});

// -- ramps: fade in, cruise, fade out ----------------------------------------

// floorPx 0 by default so these test the pure ramp geometry; the velocity floor
// has its own block below, since it changes the profile on purpose.
const rampEase = (inS, outS, shape = 'smooth', floorPx = 0) =>
  makeRamp({ inSpec: parseRampLength(inS), outSpec: parseRampLength(outS), shape, floorPx });

test('THE POINT: the ramp is the same wall-clock length whatever the run', () => {
  // A stretched curve cannot do this. --ease sine.inOut over 40s spends 20s
  // accelerating; a 1.5s ramp spends 1.5s, on a 5s run and a 40s run alike.
  for (const [seconds, expectCruise] of [[5, 2], [40, 37]]) {
    const s = buildSchedule(plan({ fps: 60, scrollDurationS: seconds, ease: rampEase(1.5, 1.5) }), CTX);
    const [run] = s.runs;
    assert.equal(run.ramp.inS, 1.5, `${seconds}s run: ramp in`);
    assert.equal(run.ramp.outS, 1.5, `${seconds}s run: ramp out`);
    assert.ok(Math.abs(run.ramp.cruiseS - expectCruise) < 1e-9, `${seconds}s run: cruise`);
    assert.equal(run.ramp.clamped, false);
  }
});

test('the cruise frames all move by exactly the same distance', () => {
  const s = buildSchedule(plan({ fps: 60, scrollDurationS: 20, ease: rampEase(1.5, 1.5) }), CTX);
  const d = deltas(s.frames);
  // Frame indices strictly inside the cruise, a few frames clear of each corner.
  const first = Math.ceil(1.5 * 60) + 5;
  const last = s.totalFrames - Math.ceil(1.5 * 60) - 6;
  const cruise = d.slice(first, last);
  assert.ok(cruise.length > 800, `only ${cruise.length} cruise frames`);
  assert.ok(Math.max(...cruise) - Math.min(...cruise) < 1e-9, 'the cruise must be dead flat');

  // And that constant speed is the number the report quotes. Note the interval
  // is totalS/(N-1), NOT 1/fps: frames are inclusive endpoints spanning the
  // whole timeline, so 1200 frames over 20s sit 20/1199s apart. Dividing by
  // 1/fps instead is off by 0.08% here, which is enough to fail this.
  const interval = s.totalDurationS / (s.totalFrames - 1);
  const perSecond = cruise[0] / interval;
  assert.ok(Math.abs(perSecond - s.runs[0].ramp.speed) < 0.01, `${perSecond} px/s vs reported ${s.runs[0].ramp.speed}`);
  // Just above the mean, which is the property that makes --duration the pace.
  // Derived, not a magic number: v = D / (T - (a+b)/2).
  const expected = 1 / (1 - (1.5 + 1.5) / 2 / 20);
  assert.ok(Math.abs(s.runs[0].ramp.speed / (1760 / 20) - expected) < 1e-9, `${s.runs[0].ramp.speed} px/s`);
  assert.ok(expected < 1.09, 'and it stays within 9% of the mean even on a run this short');
});

test('a ramp still lands exactly on both ends', () => {
  for (const [a, b, shape] of [[1.5, 1.5, 'smooth'], [1, 4, 'sine'], [0, 2, 'linear'], [3, 0, 'smooth']]) {
    const s = buildSchedule(plan({ fps: 30, scrollDurationS: 12, ease: rampEase(a, b, shape) }), CTX);
    assert.equal(s.frames[0].y, 0, `${shape} ${a}/${b}: first frame`);
    assert.equal(s.frames[s.totalFrames - 1].y, 1760, `${shape} ${a}/${b}: last frame`);
    assert.ok(deltas(s.frames).every((v) => v >= -1e-9), `${shape} ${a}/${b}: monotone`);
  }
});

test('with --pause, every leg gets its own full ramp', () => {
  // Each leg is its own run, so each one fades up from the hold and back down
  // into the next. No extra thought required at the call site.
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 20, ease: rampEase(1.5, 1.5), pauses: [parsePause('50%:2')] }),
    CTX
  );
  assert.equal(s.runs.length, 2);
  for (const run of s.runs) {
    assert.equal(run.ramp.inS, 1.5);
    assert.equal(run.ramp.outS, 1.5);
    assert.ok(Math.abs(run.ramp.cruiseS - 7) < 1e-9, '10s leg minus 3s of ramps');
  }
  const d = deltas(s.frames);
  const holdStart = s.segments[1].startFrame;
  assert.ok(d[holdStart - 2] < 0.5, `crawling into the pause (${d[holdStart - 2]}px)`);
  assert.ok(d[s.segments[2].startFrame] < 0.5, 'and starting from rest after it');
});

test('a leg too short for its ramps is scaled, warned about, and still exact', () => {
  const s = buildSchedule(plan({ fps: 60, scrollDurationS: 2, ease: rampEase(1.5, 1.5) }), CTX);
  const [run] = s.runs;
  assert.equal(run.ramp.clamped, true);
  assert.equal(run.ramp.inS, 1);
  assert.equal(run.ramp.cruiseS, 0);
  assert.match(s.warnings.join(' '), /is 2s but the ramps asked for 1.5s \+ 1.5s; both were scaled to 1s/);
  assert.match(s.warnings.join(' '), /no constant-speed section/);
  assert.match(s.warnings.join(' '), /Give the step a longer duration/);
  // A triangle peaks at exactly 2x the mean.
  assert.ok(Math.abs(run.ramp.speed / (1760 / 2) - 2) < 1e-9);
  assert.equal(s.frames[s.totalFrames - 1].y, 1760);
});

test('a ramp and a per-step curve coexist, each on its own run', () => {
  const s = buildSchedule(
    plan({
      fps: 30, scrollDurationS: 20, ease: rampEase(1.5, 1.5),
      timeline: [
        scroll('50%', { duration: 10 }),
        scroll('100%', { duration: 10, ease: parseEase('power2.inOut') }),
      ],
    }),
    CTX
  );
  assert.equal(s.runs.length, 2, 'the step curve splits the run');
  assert.match(s.runs[0].ease, /^ramp 1\.5s\/1\.5s/);
  assert.equal(s.runs[1].ease, 'power2.inOut');
  assert.ok(s.runs[0].ramp, 'the ramp run reports its numbers');
  assert.equal(s.runs[1].ramp, null, 'the curve run has none to report');
  assert.equal(s.frames[s.totalFrames - 1].y, 1760);
});

test('--dry-run spells out each ramp run in real units', () => {
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 20, ease: rampEase(1.5, 1.5), pauses: [parsePause('50%:2')] }),
    CTX
  );
  const text = describeSchedule(s);
  assert.match(text, /ease ramp 1\.5s\/1\.5s smooth/);
  assert.match(text, /run 1\s+frames 0\.\.\d+\s+up 1\.5s · cruise 7s at \d+px\/s · down 1\.5s/);
  assert.match(text, /run 2\s+frames \d+\.\.\d+\s+up 1\.5s/);

  const clamped = describeSchedule(buildSchedule(plan({ fps: 60, scrollDurationS: 2, ease: rampEase(1.5, 1.5) }), CTX));
  assert.match(clamped, /ramps scaled to 1s, no cruise, peaks at \d+px\/s/);
});

// -- the velocity floor, i.e. the judder fix ----------------------------------

/** What the browser actually renders: scrollTo snaps to whole CSS pixels. */
const renderedSteps = (frames) => {
  const px = frames.map((f) => Math.round(f.y));
  return px.slice(1).map((v, i) => v - px[i]);
};

test('THE JUDDER FIX: a floored ramp never renders the same pixel twice', () => {
  /*
   * The bug: scrollTo snaps to whole pixels, so a ramp crawling below 1px per
   * frame renders as hold, jump, hold, jump. Taken from a real recording:
   *   0 0 0 0 0 1 0 1 0 1 1 1 1 2 2 2 2 2 2 3 3 3 4
   * The floor starts the ramp at 2px/frame so every frame advances.
   */
  const withFloor = buildSchedule(
    plan({ fps: 60, scrollDurationS: 12, ease: rampEase(4, 4, 'smooth', 2) }),
    { maxScroll: 20000, viewportH: 1080, rects: {} }
  );
  const steps = renderedSteps(withFloor.frames);
  assert.equal(steps.filter((s) => s === 0).length, 0, `${steps.filter((s) => s === 0).length} frames repeat a pixel`);
  assert.ok(Math.min(...steps) >= 2, `slowest rendered step was ${Math.min(...steps)}px, floor was 2`);
  assert.equal(withFloor.frames[withFloor.totalFrames - 1].y, 20000, 'and it still lands exactly');
  assert.equal(withFloor.warnings.length, 0, 'nothing to warn about');
});

test('...and without the floor it judders, and says so', () => {
  const bare = buildSchedule(
    plan({ fps: 60, scrollDurationS: 12, ease: rampEase(4, 4, 'smooth', 0) }),
    { maxScroll: 20000, viewportH: 1080, rects: {} }
  );
  const zeros = renderedSteps(bare.frames).filter((s) => s === 0).length;
  assert.ok(zeros > 20, `expected visible stepping, got ${zeros} repeated frames`);
  assert.match(bare.warnings.join(' '), /frames that do not move a whole pixel/);
  assert.match(bare.warnings.join(' '), /raise --ease-floor/);
});

test('the floor costs only a few percent of the cruise speed', () => {
  const ctx = { maxScroll: 20000, viewportH: 1080, rects: {} };
  const speed = (floorPx) =>
    buildSchedule(plan({ fps: 60, scrollDurationS: 12, ease: rampEase(4, 4, 'smooth', floorPx) }), ctx).runs[0].ramp.speed;
  const bare = speed(0);
  const held = speed(2);
  assert.ok(held < bare, 'the floor gives away some ground at the ends');
  assert.ok(held / bare > 0.9, `cruise dropped from ${bare} to ${held} px/s, more than 10%`);
});

test('--dry-run says what the ramp starts at', () => {
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 12, ease: rampEase(4, 4, 'smooth', 2) }),
    { maxScroll: 20000, viewportH: 1080, rects: {} }
  );
  assert.match(describeSchedule(s), /from 2px\/frame/);
});

test('a run too slow for the floor warns rather than pretending', () => {
  // 200px over 20s at 60fps is 0.17px/frame. No easing setting can save that.
  const s = buildSchedule(
    plan({ fps: 60, scrollDurationS: 20, ease: rampEase(1.5, 1.5, 'smooth', 2) }),
    { maxScroll: 200, viewportH: 1080, rects: {} }
  );
  assert.equal(s.runs[0].ramp.floorPx, 0, 'the floor could not be applied');
  assert.equal(s.warnings.length, 1, 'one warning for one symptom, not two overlapping ones');
  assert.match(s.warnings[0], /frames that do not move a whole pixel/);
  assert.match(s.warnings[0], /below the --ease-floor 2 it was given, so the floor could not apply/);
  // Raising the floor is exactly the wrong advice when the leg is already
  // slower than the floor it has, so it must not be suggested here.
  assert.doesNotMatch(s.warnings[0], /raise --ease-floor/);
  assert.match(s.warnings[0], /Give the step less time/);
  assert.equal(s.frames[s.totalFrames - 1].y, 200, 'but it still lands exactly on target');
});

test('a linear scroll too slow to move a pixel per frame warns too', () => {
  // Nothing to do with easing: this is worth catching on its own.
  const s = buildSchedule(plan({ fps: 60, scrollDurationS: 20 }), { maxScroll: 200, viewportH: 1080, rects: {} });
  assert.match(s.warnings.join(' '), /frames that do not move a whole pixel/);
  assert.match(s.warnings.join(' '), /give this step less time/);
});

test('a normal scroll says nothing at all', () => {
  // 1760px over 3s is 9.8px/frame, comfortably above the floor. The same page
  // over 20s is only 1.5px/frame, which DOES step and DOES warn, as above.
  const s = buildSchedule(plan({ fps: 60, scrollDurationS: 3, ease: rampEase(0.5, 0.5, 'smooth', 2) }), CTX);
  assert.deepEqual(s.warnings, []);
  assert.equal(renderedSteps(s.frames).filter((v) => v === 0).length, 0);
});

test('a cubic-bezier ramp shape behaves like any other, end to end', () => {
  const s = buildSchedule(
    plan({
      fps: 60, scrollDurationS: 12,
      ease: rampEase(0.5, 0.5, 'cubic-bezier(.65,0,.25,.99)', 2),
    }),
    { maxScroll: 20000, viewportH: 1080, rects: {} }
  );
  assert.match(s.runs[0].ease, /^ramp 0\.5s\/0\.5s cubic-bezier\(0\.65, 0, 0\.25, 0\.99\)$/);
  assert.equal(s.runs[0].ramp.floorPx, 2);
  assert.ok(Math.abs(s.runs[0].ramp.cruiseS - 11) < 1e-9);

  // The three things every ramp has to get right, whatever its shape.
  assert.equal(s.frames[0].y, 0);
  assert.equal(s.frames[s.totalFrames - 1].y, 20000, 'lands exactly, despite a numeric integral');
  const steps = renderedSteps(s.frames);
  assert.equal(steps.filter((v) => v === 0).length, 0, 'no repeated pixels');

  const first = Math.ceil(0.5 * 60) + 3;
  const cruise = steps.slice(first, steps.length - first);
  assert.equal(new Set(cruise).size <= 2, true, 'the cruise is one speed, give or take pixel rounding');
  assert.deepEqual(s.warnings, []);
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
