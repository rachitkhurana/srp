'use strict';

/*
 * The curves are the whole feature, and they are pure functions, so almost
 * everything worth checking is checkable here without a browser.
 *
 * The load-bearing test is the endpoint one. If f(1) is 0.9999999999999999
 * instead of 1, the last frame of a recording lands a pixel short of the bottom
 * of the page, which is precisely the class of bug srp exists not to have.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEase, EASE_NAMES, LINEAR,
  parseRampLength, makeRamp, parseRampShape, RAMP_SHAPES, RAMP_SHAPE_NAMES,
} = require('../../src/easing');
const { UsageError } = require('../../src/errors');

const NAMED = EASE_NAMES.map((n) => [n, parseEase(n).fn]);
const IN_OUT = EASE_NAMES.filter((n) => n.endsWith('.inOut'));

/**
 * An independent cubic-bezier, deliberately written differently from the one
 * under test: pure bisection over the Bernstein form, no coefficient expansion
 * and no Newton step, so an algebra mistake in src/easing.js cannot hide here.
 */
function referenceBezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

test('every advertised name resolves, and its canonical name round-trips', () => {
  assert.equal(EASE_NAMES.length, 16, 'linear plus 5 families of 3');
  for (const name of EASE_NAMES) {
    const e = parseEase(name);
    assert.equal(e.name, name, `${name} should be its own canonical spelling`);
    assert.equal(typeof e.fn, 'function');
  }
});

test('THE ONE THAT MATTERS: f(0) is exactly 0 and f(1) is exactly 1', () => {
  // sine.in(1) is 1 - Math.cos(Math.PI / 2), and Math.cos(Math.PI / 2) is
  // 6.12e-17, so without the endpoint snap this is 0.9999999999999999.
  for (const [name, fn] of NAMED) {
    assert.equal(fn(0), 0, `${name}(0)`);
    assert.equal(fn(1), 1, `${name}(1)`);
  }
  const bez = parseEase('cubic-bezier(0.65, 0, 0.35, 1)').fn;
  assert.equal(bez(0), 0);
  assert.equal(bez(1), 1);
});

test('named curves are monotonic and stay inside [0, 1]', () => {
  for (const [name, fn] of NAMED) {
    let prev = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const v = fn(i / 1000);
      assert.ok(v >= prev, `${name} went backwards at p=${i / 1000}`);
      assert.ok(v >= 0 && v <= 1, `${name} left [0,1] at p=${i / 1000}: ${v}`);
      prev = v;
    }
  }
});

test('inOut curves are symmetric about the midpoint', () => {
  // To a tolerance, not to the bit: sine.inOut(0.5) is (1 - cos(pi/2)) / 2, and
  // cos(pi/2) is 6.12e-17 rather than 0, so it computes to 0.49999999999999994.
  // That is one ULP on a progress value, i.e. 1.7e-12 px on a 30000px page.
  // The endpoints are the only place exactness buys anything, and the test
  // above pins those.
  for (const name of IN_OUT) {
    const fn = parseEase(name).fn;
    assert.ok(Math.abs(fn(0.5) - 0.5) < 1e-15, `${name}(0.5) is ${fn(0.5)}`);
    for (const p of [0.1, 0.25, 0.4, 0.49]) {
      assert.ok(Math.abs(fn(p) + fn(1 - p) - 1) < 1e-12, `${name} asymmetric at ${p}`);
    }
  }
});

test('out is the mirror of in', () => {
  for (const family of ['sine', 'power1', 'power2', 'power3', 'power4']) {
    const easeIn = parseEase(`${family}.in`).fn;
    const easeOut = parseEase(`${family}.out`).fn;
    for (let i = 1; i < 100; i++) {
      const p = i / 100;
      assert.ok(Math.abs(easeOut(p) - (1 - easeIn(1 - p))) < 1e-12, `${family} at ${p}`);
    }
  }
});

test('the power families use GSAP exponents: powerN is N+1', () => {
  // power1 = quad, power2 = cubic, power3 = quart, power4 = quint.
  for (const [name, expected] of [
    ['power1.in', 0.25],
    ['power2.in', 0.125],
    ['power3.in', 0.0625],
    ['power4.in', 0.03125],
  ]) {
    assert.equal(parseEase(name).fn(0.5), expected, name);
  }
});

test('sine matches the trig identities', () => {
  assert.ok(Math.abs(parseEase('sine.in').fn(0.5) - (1 - Math.cos(Math.PI / 4))) < 1e-15);
  assert.ok(Math.abs(parseEase('sine.out').fn(0.5) - Math.sin(Math.PI / 4)) < 1e-15);
});

test('linear is the identity function and is flagged as such', () => {
  const e = parseEase('linear');
  assert.equal(e.linear, true);
  assert.equal(e.name, 'linear');
  for (const p of [0, 0.1, 1 / 3, 0.5, 0.9999, 1]) assert.equal(e.fn(p), p, `linear(${p})`);
  // The exported constant must be the same shape, since schedule.js falls back
  // to it and branches on `.linear` to skip the easing path entirely.
  assert.equal(LINEAR.linear, true);
  assert.equal(LINEAR.fn(0.37), 0.37);
});

test('nothing but linear claims to be linear', () => {
  for (const name of EASE_NAMES.filter((n) => n !== 'linear')) {
    assert.equal(parseEase(name).linear, false, name);
  }
  // Even a bezier that happens to be straight: it is still a solve, and the
  // point of the flag is to skip arithmetic, not to describe the shape.
  const straight = parseEase('cubic-bezier(0, 0, 1, 1)');
  assert.equal(straight.linear, false);
  for (const p of [0.2, 0.5, 0.8]) assert.ok(Math.abs(straight.fn(p) - p) < 1e-6);
});

test('aliases and loose spellings all land on the canonical name', () => {
  for (const alias of ['none', 'power0', 'off', 'LINEAR', ' linear ']) {
    assert.equal(parseEase(alias).name, 'linear', alias);
  }
  for (const alias of ['power2.inOut', 'power2.inout', 'POWER2.INOUT', 'power2.in-out']) {
    assert.equal(parseEase(alias).name, 'power2.inOut', alias);
  }
  assert.equal(parseEase('Sine.Out').name, 'sine.out');
});

test('cubic-bezier agrees with an independent solver', () => {
  const cases = [
    [0.65, 0, 0.35, 1],
    [0.25, 0.1, 0.25, 1],
    [0.42, 0, 0.58, 1],
    [0, 0, 0.58, 1],
    [0.5, 1.6, 0.5, -0.6], // overshoot at both ends
  ];
  for (const [x1, y1, x2, y2] of cases) {
    const mine = parseEase(`cubic-bezier(${x1},${y1},${x2},${y2})`).fn;
    const ref = referenceBezier(x1, y1, x2, y2);
    let prev = -Infinity;
    for (let i = 1; i < 100; i++) {
      const p = i / 100;
      assert.ok(
        Math.abs(mine(p) - ref(p)) < 1e-6,
        `cubic-bezier(${x1},${y1},${x2},${y2}) at ${p}: ${mine(p)} vs ${ref(p)}`
      );
      if (y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1) {
        assert.ok(mine(p) >= prev, `cubic-bezier(${x1},${y1},${x2},${y2}) went backwards at ${p}`);
        prev = mine(p);
      }
    }
  }
});

test('cubic-bezier(1,0,0,1) is as accurate as doubles allow, which is not much', () => {
  /*
   * The extreme ease-in-out. dx/dt = 3(2t-1)^2, which is ZERO at t=0.5, so x is
   * flat to third order there and x(t) can only be computed to ~1e-16. That
   * pins t to no better than cbrt(1e-16/4) = 2.9e-6 and y to ~4.4e-6, for any
   * solver, including the bisection reference above (which is why this curve is
   * excluded from that comparison rather than tested against it).
   *
   * 4.4e-6 of progress is 0.13px on a 30000px page, and the recorder hands y to
   * window.scrollTo, so it rounds away entirely. Worth knowing, not worth fixing.
   */
  const fn = parseEase('cubic-bezier(1,0,0,1)').fn;
  assert.equal(fn(0.5), 0.5, 'the analytic midpoint is exact: x(0.5) = y(0.5) = 0.5');
  assert.equal(fn(0), 0);
  assert.equal(fn(1), 1);

  let prev = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    const v = fn(i / 1000);
    assert.ok(v >= prev - 5e-6, `dropped by more than the arithmetic floor at ${i / 1000}`);
    assert.ok(v >= 0 && v <= 1, `left [0,1] at ${i / 1000}: ${v}`);
    prev = Math.max(prev, v);
  }
});

test('a cubic-bezier name is canonicalised for printing', () => {
  assert.equal(parseEase('cubic-bezier(.65,0,.35,1)').name, 'cubic-bezier(0.65, 0, 0.35, 1)');
  assert.equal(parseEase('cubic-bezier( 0.5 , 1 , 0.5 , 0 )').name, 'cubic-bezier(0.5, 1, 0.5, 0)');
});

test('a y control point outside [0,1] overshoots, on purpose', () => {
  const fn = parseEase('cubic-bezier(0.34, 1.56, 0.64, 1)').fn;
  const peak = Math.max(...Array.from({ length: 99 }, (_, i) => fn((i + 1) / 100)));
  assert.ok(peak > 1, `expected an overshoot, peaked at ${peak}`);
  assert.equal(fn(1), 1, 'and it still lands exactly on 1');
});

test('parseEase is idempotent, so merging an already-resolved curve is safe', () => {
  const once = parseEase('sine.out');
  assert.equal(parseEase(once), once);
});

test('bad curves are usage errors with a pointed message', () => {
  const cases = [
    ['power9.in', /does not know "power9.in"/],
    ['bounce.out', /does not know "bounce.out"/],
    ['power2', /needs a direction: power2.in, power2.out or power2.inOut/],
    ['power2.middle', /needs a direction/],
    ['sine.', /needs a direction/],
    ['cubic-bezier(2,0,1,1)', /x values must be between 0 and 1/],
    ['cubic-bezier(0,0,-0.2,1)', /x values must be between 0 and 1/],
    ['cubic-bezier(0,0)', /needs exactly 4 numbers/],
    ['cubic-bezier(0,0,1,1,1)', /needs exactly 4 numbers/],
    ['cubic-bezier(0,0,,1)', /needs exactly 4 numbers/],
    ['cubic-bezier(a,0,1,1)', /takes numbers/],
    ['', /needs a curve name/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseEase(input), (e) => {
      assert.ok(e instanceof UsageError, `${JSON.stringify(input)} should be a UsageError`);
      assert.match(e.message, pattern, JSON.stringify(input));
      return true;
    });
  }
  for (const input of [null, undefined, 42, {}, []]) {
    assert.throws(() => parseEase(input), UsageError, String(input));
  }
});

test('an overshooting y is allowed but a doubling-back x is not', () => {
  // y outside [0,1] is an overshoot, which is a legitimate thing to ask for.
  // x outside [0,1] would make the curve not a function of x at all.
  assert.doesNotThrow(() => parseEase('cubic-bezier(0.5, -0.5, 0.5, 1.5)'));
  assert.throws(() => parseEase('cubic-bezier(-0.5, 0, 1, 1)'), UsageError);
});

// -- ramps: fade in, cruise, fade out ----------------------------------------

/*
 * floorPx defaults to 0 here so these exercise the pure ramp geometry. The
 * velocity floor is a separate concern with its own block at the bottom, and it
 * only engages when curveFor is also told a distance and an fps.
 */
const ramp = (inS, outS, shape = 'smooth', floorPx = 0) =>
  makeRamp({ inSpec: parseRampLength(inS), outSpec: parseRampLength(outS), shape, floorPx });

/** Numeric slope of a normalised curve, i.e. speed as a multiple of the mean. */
const slope = (fn, q, h = 1e-6) => (fn(Math.min(1, q + h)) - fn(Math.max(0, q - h))) / (Math.min(1, q + h) - Math.max(0, q - h));

test('THE LOAD-BEARING IDENTITY: every ramp shape integrates to exactly 1/2', () => {
  /*
   * The cruise speed is derived as v = D / (T - (a+b)/2). Those halves are only
   * correct because each ramp covers half the ground it would at full speed,
   * which is to say G(1) = 1/2. A shape that broke this would silently make
   * every eased recording land short of or past its target.
   */
  for (const name of RAMP_SHAPE_NAMES) {
    const { g, G } = RAMP_SHAPES[name];
    assert.ok(Math.abs(G(1) - 0.5) < 1e-15, `${name}: G(1) is ${G(1)}, must be 0.5`);
    assert.equal(G(0), 0, `${name}: G(0)`);
    assert.equal(g(0), 0, `${name}: the ramp starts from a standstill`);
    assert.ok(Math.abs(g(1) - 1) < 1e-15, `${name}: the ramp reaches full speed`);

    // And G really is the integral of g, not an unrelated function.
    let acc = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) acc += g((i + 0.5) / N) / N;
    assert.ok(Math.abs(acc - G(1)) < 1e-6, `${name}: G is not the integral of g (${acc} vs ${G(1)})`);
  }
});

test('a ramp is a fixed number of SECONDS, not a fraction of the run', () => {
  // The entire reason this exists. A stretched curve cannot do it.
  const r = ramp(1.5, 1.5);
  for (const T of [5, 12, 40, 120]) {
    const c = r.curveFor({ durationS: T });
    assert.equal(c.inS, 1.5, `${T}s run: ramp in`);
    assert.equal(c.outS, 1.5, `${T}s run: ramp out`);
    assert.ok(Math.abs(c.cruiseS - (T - 3)) < 1e-12, `${T}s run: cruise`);
  }
});

test('the cruise speed is v = D / (T - (a+b)/2), and it barely moves', () => {
  for (const [a, b, T] of [[1.5, 1.5, 38.27], [2.5, 2.5, 38.27], [4, 4, 38.27], [1, 3, 20], [0, 2, 10]]) {
    const c = ramp(a, b).curveFor({ durationS: T });
    assert.ok(Math.abs(c.cruiseFactor - 1 / (1 - (a + b) / 2 / T)) < 1e-12, `${a}/${b} over ${T}s`);
  }
  // On a long run the constant-speed section sits within a few percent of the
  // mean, which is what makes --duration the only thing that sets the pace.
  assert.ok(Math.abs(ramp(1.5, 1.5).curveFor({ durationS: 38.27 }).cruiseFactor - 1.041) < 0.001);
});

test('the middle really is at one constant speed', () => {
  const fn = ramp(1.5, 1.5).curveFor({ durationS: 20 }).fn;
  const alpha = 1.5 / 20;
  const beta = 1.5 / 20;
  const speeds = [];
  for (let q = alpha + 0.02; q < 1 - beta - 0.02; q += 0.01) speeds.push(slope(fn, q));
  assert.ok(speeds.length > 50);
  assert.ok(Math.max(...speeds) - Math.min(...speeds) < 1e-6, 'the cruise section must be flat');
  // And the ends are genuinely slower than it.
  assert.ok(slope(fn, 0.001) < speeds[0] / 100, 'starts from a standstill');
  assert.ok(slope(fn, 0.999) < speeds[0] / 100, 'ends at a standstill');
});

test('a ramp covers exactly the distance, no more and no less', () => {
  // Integrating the speed profile back up must return exactly 1, or the scroll
  // would not land where the schedule says it does.
  for (const [a, b, T, shape] of [[1.5, 1.5, 20, 'smooth'], [1, 4, 12, 'sine'], [2, 2, 8, 'linear'], [0, 3, 10, 'smooth']]) {
    const fn = ramp(a, b, shape).curveFor({ durationS: T }).fn;
    assert.equal(fn(0), 0, `${shape} ${a}/${b}: starts at 0`);
    assert.equal(fn(1), 1, `${shape} ${a}/${b}: ends at exactly 1`);
    let prev = 0;
    for (let i = 1; i <= 2000; i++) {
      const v = fn(i / 2000);
      assert.ok(v >= prev - 1e-15, `${shape} ${a}/${b}: went backwards at ${i / 2000}`);
      prev = v;
    }
  }
});

test('the shape changes the corners but never the cruise speed', () => {
  const factors = RAMP_SHAPE_NAMES.map((s) => ramp(1.5, 1.5, s).curveFor({ durationS: 20 }).cruiseFactor);
  assert.ok(Math.max(...factors) - Math.min(...factors) < 1e-15, 'shape must not affect the cruise speed');
  // smooth and sine reach the cruise with zero acceleration; linear does not,
  // which is the trapezoid corner you can see.
  const accel = (shape) => {
    const fn = ramp(1.5, 1.5, shape).curveFor({ durationS: 20 }).fn;
    const at = 1.5 / 20;
    return Math.abs(slope(fn, at - 0.004) - slope(fn, at - 0.02));
  };
  assert.ok(accel('smooth') < accel('linear'), 'smooth should meet the cruise more gently than linear');
});

test('ramps that do not fit scale down together and say so', () => {
  const c = ramp(1.5, 1.5).curveFor({ durationS: 2 });
  assert.equal(c.clamped, true);
  assert.equal(c.inS, 1);
  assert.equal(c.outS, 1);
  assert.equal(c.cruiseS, 0);
  assert.ok(Math.abs(c.cruiseFactor - 2) < 1e-12, 'a pure triangle peaks at exactly 2x the mean');
  assert.equal(c.fn(0), 0);
  assert.equal(c.fn(1), 1);

  // Asymmetric ramps keep their ratio when they are scaled.
  const d = ramp(1, 3).curveFor({ durationS: 2 });
  assert.ok(Math.abs(d.inS - 0.5) < 1e-12);
  assert.ok(Math.abs(d.outS - 1.5) < 1e-12);
});

test('exactly-fitting ramps are a triangle with no cruise, and are not "clamped"', () => {
  const c = ramp(1.5, 1.5).curveFor({ durationS: 3 });
  assert.equal(c.clamped, false);
  assert.equal(c.cruiseS, 0);
  assert.ok(Math.abs(c.cruiseFactor - 2) < 1e-12);
});

test('percentages resolve against the run, seconds do not', () => {
  const pct = makeRamp({ inSpec: parseRampLength('10%'), outSpec: parseRampLength('10%'), shape: 'smooth' });
  assert.equal(pct.curveFor({ durationS: 20 }).inS, 2);
  assert.equal(pct.curveFor({ durationS: 60 }).inS, 6, 'a percentage moves with the run, which is the point of offering both');
  assert.equal(pct.name, 'ramp 10%/10% smooth');
});

test('a one-sided ramp is a fade on that side only', () => {
  const out = ramp(0, 2).curveFor({ durationS: 10 });
  assert.equal(out.inS, 0);
  assert.equal(out.outS, 2);
  const fn = out.fn;
  assert.ok(slope(fn, 0.001) > 0.9, 'no fade in: it leaves at full speed');
  assert.ok(slope(fn, 0.999) < 0.05, 'but it still settles to a stop');
  assert.equal(fn(1), 1);
});

test('a ramp of zero on both sides is the LINEAR object, not an identity ramp', () => {
  // Returning a no-op profile would route the frames through the easing path
  // and off the byte-identical default one, for no gain at all.
  assert.equal(ramp(0, 0), LINEAR);
  assert.equal(ramp('0%', '0s'), LINEAR);
});

test('a ramp names itself for --dry-run', () => {
  assert.equal(ramp(1.5, 1.5).name, 'ramp 1.5s/1.5s smooth');
  assert.equal(ramp(1, 4, 'sine').name, 'ramp 1s/4s sine');
});

test('parseRampLength takes seconds, bare numbers and percentages', () => {
  assert.deepEqual(parseRampLength('1.5'), { value: 1.5, unit: 'seconds' });
  assert.deepEqual(parseRampLength('1.5s'), { value: 1.5, unit: 'seconds' });
  assert.deepEqual(parseRampLength('15%'), { value: 15, unit: 'percent' });
  assert.deepEqual(parseRampLength(2), { value: 2, unit: 'seconds' });
  assert.deepEqual(parseRampLength(' 0 '), { value: 0, unit: 'seconds' });

  for (const [bad, pattern] of [
    ['-1', /must be a number of seconds/],
    ['150%', /cannot be more than 100%/],
    ['1.5 s', /must be a number of seconds/],
    ['fast', /must be a number of seconds/],
    ['', /needs a length in seconds/],
  ]) {
    assert.throws(() => parseRampLength(bad), (e) => {
      assert.ok(e instanceof UsageError, bad);
      assert.match(e.message, pattern, bad);
      return true;
    });
  }
});

test('an unknown ramp shape is a usage error', () => {
  assert.throws(
    () => makeRamp({ inSpec: parseRampLength(1), outSpec: parseRampLength(1), shape: 'bouncy' }),
    /--ease-shape must be one of linear \| smooth \| sine \| smoother \| smoothest/
  );
});

// -- the velocity floor -------------------------------------------------------

/** Ramp with the floor engaged, resolved against a real run. */
const floored = (inS, outS, { T, D, fps = 60, floorPx = 2, shape = 'smooth' }) =>
  makeRamp({ inSpec: parseRampLength(inS), outSpec: parseRampLength(outS), shape, floorPx })
    .curveFor({ durationS: T, distancePx: D, fps });

test('shapes are ordered gentlest to steepest, and the docs say so', () => {
  // "Steeper" has to mean something measurable, or --ease-shape is vibes.
  // It is the steepest SLOPE of the velocity ramp, not its peak value: every
  // ramp peaks at 1 by definition, because that is the cruise speed.
  const peaks = RAMP_SHAPE_NAMES.map((n) => RAMP_SHAPES[n].peakSlope);
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] > peaks[i - 1], `${RAMP_SHAPE_NAMES[i]} should be steeper than ${RAMP_SHAPE_NAMES[i - 1]}`);
  }
  // And the declared slope is the real one, not a number someone typed.
  for (const name of RAMP_SHAPE_NAMES) {
    const { g, peakSlope } = RAMP_SHAPES[name];
    const h = 1e-7;
    let max = 0;
    for (let i = 0; i <= 100000; i++) {
      const u = i / 100000;
      const lo = Math.max(0, u - h);
      const hi = Math.min(1, u + h);
      max = Math.max(max, (g(hi) - g(lo)) / (hi - lo));
    }
    assert.ok(Math.abs(max - peakSlope) < 1e-3, `${name}: declared ${peakSlope}, measured ${max}`);
    assert.ok(Math.abs(g(1) - 1) < 1e-12, `${name}: every ramp must top out at the cruise speed`);
  }
});

test('THE JUDDER FIX: a floored ramp opens at exactly the requested px/frame', () => {
  // scrollTo snaps to whole pixels, so a ramp that crawls below 1px/frame
  // renders as hold-then-jump. Starting at 2px/frame removes that entirely.
  const T = 37;
  const D = 26414; // the airpods long leg
  const c = floored(8, 8, { T, D, floorPx: 2 });
  assert.equal(c.floorPx, 2);
  assert.equal(c.floorDisabled, null);

  // Opening velocity, read off the curve rather than trusted from the maths.
  const N = T * 60;
  const first = c.fn(1 / (N - 1)) * D;
  assert.ok(Math.abs(first - 2) < 0.01, `first frame moved ${first}px, expected 2`);

  // Every frame of the ramp clears a whole pixel once rounded.
  let prev = 0;
  for (let i = 1; i < (8 / T) * N; i++) {
    const y = Math.round(c.fn(i / (N - 1)) * D);
    assert.ok(y > prev, `frame ${i} did not advance a pixel (${y})`);
    prev = y;
  }
});

test('the floor barely moves the cruise speed', () => {
  const T = 37;
  const D = 26414;
  const bare = floored(8, 8, { T, D, floorPx: 0 });
  const held = floored(8, 8, { T, D, floorPx: 2 });
  const speed = (c) => (c.cruiseFactor * D) / T;
  assert.ok(Math.abs(speed(bare) - 911) < 1, `unfloored ${speed(bare)}`);
  assert.ok(Math.abs(speed(held) - 878) < 1, `floored ${speed(held)}`);
  assert.ok(speed(bare) - speed(held) < 40, 'the floor should cost only a few percent of cruise');
});

test('a floor of 0 reproduces the unfloored profile exactly', () => {
  const T = 20;
  const D = 5000;
  const bare = ramp(1.5, 1.5).curveFor({ durationS: T });
  const zero = floored(1.5, 1.5, { T, D, floorPx: 0 });
  assert.equal(zero.floorFraction, 0);
  assert.equal(zero.cruiseFactor, bare.cruiseFactor);
  for (const q of [0, 0.01, 0.1, 0.5, 0.9, 0.99, 1]) assert.equal(zero.fn(q), bare.fn(q), `q=${q}`);
});

test('a floored ramp still covers exactly the distance', () => {
  // G_F(1) = (1+F)/2, and the cruise speed is derived from that. Get it wrong
  // and every eased recording lands short of or past its target.
  for (const [a, b, T, D, shape] of [
    [1.5, 1.5, 20, 5000, 'smooth'],
    [8, 8, 37, 26414, 'smoothest'],
    [0, 3, 12, 4000, 'sine'],
    [2, 2, 10, 900, 'linear'],
  ]) {
    const c = floored(a, b, { T, D, shape });
    assert.equal(c.fn(0), 0, `${shape} ${a}/${b}: starts at 0`);
    assert.equal(c.fn(1), 1, `${shape} ${a}/${b}: ends at exactly 1`);
    let prev = -1;
    for (let i = 0; i <= 2000; i++) {
      const v = c.fn(i / 2000);
      assert.ok(v >= prev, `${shape} ${a}/${b}: went backwards at ${i / 2000}`);
      prev = v;
    }
  }
});

test('the floor is resolved after the ramps are clamped, not before', () => {
  // A leg too short for its ramps scales them first; the floor then applies to
  // the lengths actually used. Doing it the other way round would overshoot.
  const c = floored(1.5, 1.5, { T: 2, D: 1760, floorPx: 2 });
  assert.equal(c.clamped, true);
  assert.equal(c.inS, 1);
  assert.equal(c.floorDisabled, null);
  const N = 2 * 60;
  assert.ok(Math.abs(c.fn(1 / (N - 1)) * 1760 - 2) < 0.05, 'still opens at 2px/frame');
  assert.equal(c.fn(1), 1);
});

test('a run too slow to hold the floor says so instead of pretending', () => {
  // 200px over 40s is 0.08px/frame. There is no headroom to ramp through, and
  // no easing setting can stop that stepping.
  const c = floored(1.5, 1.5, { T: 40, D: 200, floorPx: 2 });
  assert.equal(c.floorFraction, 0);
  assert.equal(c.floorPx, 0);
  assert.match(c.floorDisabled, /slower than that floor|too slow/);
  assert.equal(c.fn(1), 1, 'and it still lands exactly on target');
});

test('the floor needs a distance and an fps, and is skipped without them', () => {
  // curveFor is also called in contexts that have neither, e.g. a --dry-run of
  // an unmeasured plan. It must degrade to the plain ramp, not to NaN.
  const c = makeRamp({ inSpec: parseRampLength(1.5), outSpec: parseRampLength(1.5), floorPx: 2 })
    .curveFor({ durationS: 20 });
  assert.equal(c.floorFraction, 0);
  assert.equal(c.fn(0), 0);
  assert.equal(c.fn(1), 1);
  assert.ok(Number.isFinite(c.cruiseFactor));
});

// -- a cubic-bezier as the ramp shape -----------------------------------------

const BEZ = 'cubic-bezier(.65,0,.25,.99)';

const bezRamp = (inS, outS, opts = {}) =>
  makeRamp({
    inSpec: parseRampLength(inS), outSpec: parseRampLength(outS),
    shape: opts.shape || BEZ, floorPx: opts.floorPx == null ? 0 : opts.floorPx,
  });

test('the named shapes all declare a mean of exactly 0.5, as the old formula assumed', () => {
  // This IS the guarantee the cruise-speed derivation used to hardcode as "/2".
  // It is now read from `mean`, so it has to stay pinned for the named shapes.
  for (const name of RAMP_SHAPE_NAMES) {
    const s = RAMP_SHAPES[name];
    assert.equal(s.mean, 0.5, `${name} declares a mean of ${s.mean}`);
    assert.ok(Math.abs(s.G(1) - s.mean) < 1e-15, `${name}: G(1) must equal its declared mean`);
  }
});

test('a bezier ramp shape carries its own mean, which is NOT 0.5', () => {
  const s = parseRampShape(BEZ);
  assert.equal(s.name, 'cubic-bezier(0.65, 0, 0.25, 0.99)');
  assert.ok(Math.abs(s.mean - 0.528) < 0.001, `mean is ${s.mean}`);
  // Consistency is the load-bearing part: G(1) and mean must be the same number
  // out of the same table, or the cruise speed and the position disagree.
  assert.equal(s.G(1), s.mean);
  assert.equal(s.G(0), 0);
});

test('THE RISK: a bezier ramp still lands exactly on target', () => {
  // G is a numeric table here, so this is the property integration could break.
  for (const [a, b, T, D, floorPx] of [
    [0.5, 0.5, 6, 920, 0],
    [0.5, 0.5, 37, 26414, 2],
    [1.5, 1.5, 20, 5000, 2],
    [0, 2, 12, 4000, 2],
    [4, 4, 6, 3000, 2], // clamped
  ]) {
    const c = bezRamp(a, b, { floorPx }).curveFor({ durationS: T, distancePx: D, fps: 60 });
    assert.equal(c.fn(0), 0, `${a}/${b} over ${T}s: starts at 0`);
    assert.equal(c.fn(1), 1, `${a}/${b} over ${T}s: ends at exactly 1`);
    let prev = -1;
    for (let i = 0; i <= 4000; i++) {
      const v = c.fn(i / 4000);
      assert.ok(v >= prev - 1e-12, `${a}/${b} over ${T}s: went backwards at ${i / 4000}`);
      prev = v;
    }
  }
});

test('a bezier ramp holds a genuinely flat cruise', () => {
  const c = bezRamp(0.5, 0.5).curveFor({ durationS: 6, distancePx: 920, fps: 30 });
  const alpha = 0.5 / 6;
  const speeds = [];
  for (let q = alpha + 0.02; q < 1 - alpha - 0.02; q += 0.005) speeds.push(slope(c.fn, q));
  assert.ok(speeds.length > 100);
  assert.ok(Math.max(...speeds) - Math.min(...speeds) < 1e-6, 'the cruise must still be flat');
});

test('the cruise speed uses the shape mean, not a hardcoded half', () => {
  // A shape covering MORE ground in its ramps (mean > 0.5) needs a slightly
  // slower cruise to land in the same place. Getting this wrong is a silent
  // 2.8% miss on the ramp distance for this curve.
  const T = 37;
  const D = 26414;
  const bez = bezRamp(1.5, 1.5).curveFor({ durationS: T, distancePx: D, fps: 60 });
  const named = ramp(1.5, 1.5, 'smoothest').curveFor({ durationS: T });
  const mean = parseRampShape(BEZ).mean;
  assert.ok(Math.abs(bez.cruiseFactor - 1 / (1 - (3 / T) * (1 - mean))) < 1e-12);
  assert.ok(bez.cruiseFactor < named.cruiseFactor, 'a fuller ramp needs a slower cruise');
});

test('the floor still opens at the requested px/frame with a non-half mean', () => {
  const c = bezRamp(0.5, 0.5, { floorPx: 2 }).curveFor({ durationS: 37, distancePx: 26414, fps: 60 });
  assert.equal(c.floorDisabled, null);
  const N = 37 * 60;
  assert.ok(Math.abs(c.fn(1 / (N - 1)) * 26414 - 2) < 0.02, `opened at ${c.fn(1 / (N - 1)) * 26414}px`);
  assert.equal(c.fn(1), 1);
});

test('a bezier ramp is steeper than any named shape, which is the point', () => {
  const s = parseRampShape(BEZ);
  assert.ok(s.peakSlope > RAMP_SHAPES.smoothest.peakSlope, `${s.peakSlope} vs ${RAMP_SHAPES.smoothest.peakSlope}`);
  assert.ok(Math.abs(s.peakSlope - 3.335) < 0.01, `peak slope is ${s.peakSlope}`);
});

test('a ramp shape that would scroll backwards is refused', () => {
  // y below 0 is a NEGATIVE velocity inside the fade. y above 1 is fine: that
  // overshoots the cruise speed and settles back.
  assert.throws(
    () => parseRampShape('cubic-bezier(.5,-0.6,.5,1)'),
    /dips below zero, which would scroll backwards inside the ramp/
  );
  assert.doesNotThrow(() => parseRampShape('cubic-bezier(.5,1.6,.5,1)'));
  assert.throws(() => parseRampShape('bouncy'), /must be one of linear \| smooth \| sine \| smoother \| smoothest, or a cubic-bezier/);
  assert.throws(() => parseRampShape('cubic-bezier(2,0,1,1)'), /x values must be between 0 and 1/);
});

test('parseRampShape is idempotent and names itself for --dry-run', () => {
  const once = parseRampShape(BEZ);
  assert.equal(parseRampShape(once), once);
  assert.equal(bezRamp(0.5, 0.5).name, 'ramp 0.5s/0.5s cubic-bezier(0.65, 0, 0.25, 0.99)');
  assert.equal(parseRampShape('SMOOTHER').name, 'smoother');
});
