'use strict';

/*
 * Easing curves for the scroll. Pure: a curve is a function from progress to
 * progress, both nominally in [0, 1], and nothing here knows about pages,
 * frames or pixels.
 *
 * The vocabulary is GSAP's, because that is what anyone reaching for easing on
 * a scroll already has in their head: `sine.inOut`, `power2.out`, and so on.
 * They are exact closed forms rather than bezier approximations of the Penner
 * equations, so `power2.inOut` here is the same curve GSAP would give you.
 * `cubic-bezier(x1,y1,x2,y2)` is the escape hatch for everything else.
 *
 * TWO THINGS THAT LOOK LIKE FUSSINESS AND ARE NOT
 *
 * 1. Every curve is wrapped so that f(0) is exactly 0 and f(1) is exactly 1.
 *    That is not defensive padding: `Math.cos(Math.PI / 2)` is 6.12e-17, not 0,
 *    so `sine.in(1)` computes to 0.9999999999999999 and the last frame of a
 *    recording would land a hair short of the bottom of the page. srp's whole
 *    contract is that it does not do that.
 *
 * 2. `linear` returns the literal identity function, and callers are expected
 *    to branch on it and skip the easing path entirely. A curve that is
 *    algebraically straight is not good enough: the default output is pinned
 *    byte-for-byte by the e2e suite, so the default must not touch the
 *    arithmetic at all.
 */

const { UsageError } = require('./errors');

/** Snap the endpoints, and keep everything outside [0,1] out of the curve. */
const clampEnds = (fn) => (p) => (p <= 0 ? 0 : p >= 1 ? 1 : fn(p));

/** GSAP's powerN is exponent N+1: power1 is quad, power2 cubic, power4 quint. */
function powerFamily(k) {
  return {
    in: (p) => Math.pow(p, k),
    out: (p) => 1 - Math.pow(1 - p, k),
    inOut: (p) => (p < 0.5 ? Math.pow(2 * p, k) / 2 : 1 - Math.pow(2 - 2 * p, k) / 2),
  };
}

const FAMILIES = {
  sine: {
    in: (p) => 1 - Math.cos((p * Math.PI) / 2),
    out: (p) => Math.sin((p * Math.PI) / 2),
    inOut: (p) => (1 - Math.cos(Math.PI * p)) / 2,
  },
  power1: powerFamily(2),
  power2: powerFamily(3),
  power3: powerFamily(4),
  power4: powerFamily(5),
};

/** `inout`, `in-out` and `ineout`-free spellings all mean the same direction. */
const DIRECTIONS = { in: 'in', out: 'out', inout: 'inOut', 'in-out': 'inOut' };

/** Aliases for "do not ease", all resolving to the identity function. */
const LINEAR_NAMES = new Set(['linear', 'none', 'power0', 'off']);

/** Every name `--ease` accepts, canonical spelling, in help/README order. */
const EASE_NAMES = [
  'linear',
  ...Object.keys(FAMILIES).flatMap((f) => ['in', 'out', 'inOut'].map((d) => `${f}.${d}`)),
];

const IDENTITY = (p) => p;

// -- cubic-bezier ------------------------------------------------------------

/*
 * A CSS cubic-bezier is y as a function of x, but the curve is parameterised by
 * t, so evaluating it means solving x(t) = x first. Newton-Raphson converges in
 * a couple of iterations across almost the whole domain; bisection is the
 * fallback for the flat spots where the derivative is near zero.
 */
const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-6;
const SUBDIVISION_EPSILON = 1e-7;
const SUBDIVISION_ITERATIONS = 32;

function bezierCoefficients(p1, p2) {
  const c = 3 * p1;
  const b = 3 * (p2 - p1) - c;
  return { a: 1 - c - b, b, c };
}

const bezierAt = (k, t) => ((k.a * t + k.b) * t + k.c) * t;
const bezierSlopeAt = (k, t) => (3 * k.a * t + 2 * k.b) * t + k.c;

function solveT(kx, x) {
  let t = x; // x is a good first guess: the curve stays near the diagonal
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = bezierSlopeAt(kx, t);
    if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
    const next = t - (bezierAt(kx, t) - x) / slope;
    if (!Number.isFinite(next)) break;
    t = next;
  }
  if (t >= 0 && t <= 1 && Math.abs(bezierAt(kx, t) - x) < SUBDIVISION_EPSILON) return t;

  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < SUBDIVISION_ITERATIONS; i++) {
    const err = bezierAt(kx, t) - x;
    if (Math.abs(err) < SUBDIVISION_EPSILON) break;
    if (err > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return t;
}

function cubicBezier(x1, y1, x2, y2) {
  const kx = bezierCoefficients(x1, x2);
  const ky = bezierCoefficients(y1, y2);
  return (p) => bezierAt(ky, solveT(kx, p));
}

/** Trim a parsed number back to a tidy string, so --dry-run prints it cleanly. */
const num = (n) => String(Math.round(n * 1e6) / 1e6);

function parseCubicBezier(raw) {
  const inner = raw.slice('cubic-bezier('.length, -1);
  const parts = inner.split(',').map((s) => s.trim());
  if (parts.length !== 4 || parts.some((s) => s === '')) {
    throw new UsageError(`--ease cubic-bezier() needs exactly 4 numbers (got "${raw}")`);
  }
  const n = parts.map(Number);
  if (n.some((v) => !Number.isFinite(v))) {
    throw new UsageError(`--ease cubic-bezier() takes numbers (got "${raw}")`);
  }
  const [x1, y1, x2, y2] = n;
  // The x control points must stay in [0,1] or the curve doubles back and y is
  // no longer a function of x. y is deliberately unconstrained: a y outside
  // [0,1] is an overshoot, which is a legitimate thing to want.
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new UsageError(
      `--ease cubic-bezier() x values must be between 0 and 1 (got x1=${num(x1)}, x2=${num(x2)}); ` +
        'y values may be outside that range to overshoot'
    );
  }
  return {
    name: `cubic-bezier(${n.map(num).join(', ')})`,
    fn: clampEnds(cubicBezier(x1, y1, x2, y2)),
    linear: false,
  };
}

// -- the entry point ---------------------------------------------------------

/**
 * Resolve an ease name into `{ name, fn, linear }`.
 *
 * `name` is the canonical spelling (for --dry-run and the run header), `fn` is
 * the curve, and `linear` is the flag callers branch on to bypass easing
 * entirely rather than multiplying by an identity.
 *
 * @param {string} raw  'power2.inOut', 'sine.out', 'cubic-bezier(.65,0,.35,1)'
 */
function parseEase(raw) {
  if (raw && typeof raw === 'object' && typeof raw.fn === 'function' && raw.name) {
    return raw; // already resolved; makes the option merge idempotent
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UsageError(`--ease needs a curve name (${EASE_NAMES.slice(0, 4).join(', ')}, …)`);
  }
  const s = raw.trim();
  const lower = s.toLowerCase();

  if (LINEAR_NAMES.has(lower)) return { name: 'linear', fn: IDENTITY, linear: true };
  if (lower.startsWith('cubic-bezier(') && lower.endsWith(')')) return parseCubicBezier(s);

  const dot = lower.indexOf('.');
  const family = dot === -1 ? lower : lower.slice(0, dot);
  const direction = dot === -1 ? '' : lower.slice(dot + 1);

  if (!FAMILIES[family]) {
    throw new UsageError(
      `--ease does not know "${s}". Available: ${['linear', ...Object.keys(FAMILIES).map((f) => f + '.*')].join(', ')}, ` +
        'cubic-bezier(x1,y1,x2,y2)'
    );
  }
  const dir = DIRECTIONS[direction];
  if (!dir) {
    throw new UsageError(
      `--ease "${s}" needs a direction: ${family}.in, ${family}.out or ${family}.inOut`
    );
  }
  return { name: `${family}.${dir}`, fn: clampEnds(FAMILIES[family][dir]), linear: false };
}

/** The identity ease, for callers that need a default without parsing. */
const LINEAR = { name: 'linear', fn: IDENTITY, linear: true };

// -- ramps: fade in, cruise, fade out ----------------------------------------

/*
 * A curve above is stretched across whatever run it lands on, so on a 38 second
 * leg the "ease in" occupies the first 19 seconds and nothing ever travels at a
 * constant speed. A ramp is the other model, the one video and audio fades use:
 * accelerate for a FIXED number of seconds, hold one speed, decelerate for a
 * fixed number of seconds. Change the page length and the ramps do not move.
 *
 * THE CRUISE SPEED
 * For a run of duration T covering distance D with ramps a and b:
 *
 *     D = v*(a/2) + v*(T - a - b) + v*(b/2)   ->   v = D / (T - (a+b)/2)
 *
 * The halves come from the ramps being symmetric about their own midpoints, so
 * each covers exactly half the ground it would at full speed. Every shape below
 * satisfies that (G(1) === 0.5, which a test pins), which is why the cruise
 * speed does not depend on which shape you pick.
 *
 * The useful consequence: v lands within a few percent of D/T for any sane ramp
 * length, so --duration goes back to being the only thing that sets the pace.
 */

const RAMP_DEFAULT_S = 1.5;

/*
 * THE VELOCITY FLOOR, and why a ramp does not start from a true standstill.
 *
 * window.scrollTo snaps the scroll offset to WHOLE CSS PIXELS. Measured against
 * Chromium, and deviceScaleFactor makes no difference: 1, 2 and 3 all quantise
 * identically, so rendering larger and downscaling does not help either.
 *
 * The consequence is that any scroll slower than 1px per frame renders as a
 * hold followed by a jump. Taken from a real recording, the first rendered
 * steps of a ramp starting from zero:
 *
 *     0 0 0 0 0 1 0 1 0 1 1 1 1 2 2 2 2 2 2 3 3 3 4
 *
 * That "1 0 1 0 1" is visible judder, and a longer ramp makes it worse because
 * more frames land in the sub-pixel region. So a ramp starts at a minimum speed
 * instead of at zero, chosen so every frame moves at least `floorPx` pixels.
 *
 * Velocity through the ramp becomes v*(F + (1-F)*g(u)), so the ramp integral
 * generalises to G_F(u) = F*u + (1-F)*G(u) and G_F(1) = (1+F)/2. Feeding that
 * through the distance identity and substituting F = floorPx*fps/v gives a
 * closed form for the cruise speed:
 *
 *     v = (D - (a+b)*floorPx*fps/2) / (T - (a+b)/2)
 *
 * F = 0 reduces all of this to the unfloored case exactly.
 */
const FLOOR_DEFAULT_PX = 2;

/**
 * `g` is the VELOCITY ramp from 0 to 1; `G` is its integral, which is what the
 * position function actually needs. `mean` is G(1): the fraction of full-speed
 * ground the ramp covers, and the number the cruise-speed formula divides by.
 *
 * Every shape here is symmetric about its own midpoint, so all of them have
 * mean 0.5. A cubic-bezier supplied by the user need not be, which is exactly
 * why the formula reads `mean` rather than hardcoding a half.
 */
const RAMP_SHAPES = {
  // Constant acceleration: a true trapezoid. There IS a corner where it meets
  // the cruise, which reads as a slight snap. It also reaches full speed
  // soonest, so it suffers least from the sub-pixel stepping described above.
  linear: { g: (u) => u, G: (u) => (u * u) / 2, mean: 0.5, peakSlope: 1 },
  // Smoothstep. Zero slope at both ends of the ramp, so there is no jerk where
  // the ramp meets the cruise. The right default.
  smooth: { g: (u) => u * u * (3 - 2 * u), G: (u) => u ** 3 - u ** 4 / 2, mean: 0.5, peakSlope: 1.5 },
  sine: {
    g: (u) => (1 - Math.cos(Math.PI * u)) / 2,
    G: (u) => u / 2 - Math.sin(Math.PI * u) / (2 * Math.PI),
    mean: 0.5,
    peakSlope: Math.PI / 2,
  },
  // Perlin's smootherstep and the 7th-order term after it. Progressively more
  // pronounced: flatter at the ends, steeper through the middle of the ramp.
  smoother: {
    g: (u) => u * u * u * (u * (6 * u - 15) + 10),
    G: (u) => u ** 6 - 3 * u ** 5 + 2.5 * u ** 4,
    mean: 0.5,
    peakSlope: 1.875,
  },
  smoothest: {
    g: (u) => u ** 4 * (35 - 84 * u + 70 * u * u - 20 * u ** 3),
    G: (u) => -2.5 * u ** 8 + 10 * u ** 7 - 14 * u ** 6 + 7 * u ** 5,
    mean: 0.5,
    peakSlope: 2.1875,
  },
};

const RAMP_SHAPE_NAMES = Object.keys(RAMP_SHAPES);

/*
 * A cubic-bezier has no closed-form antiderivative as a function of x, so its G
 * is a cumulative trapezoid table built once and interpolated.
 *
 * The load-bearing detail: `mean` is read out of THIS table as G(1), never
 * estimated separately. The cruise speed is derived from `mean` and the
 * position from `G`, so taking both from one table makes them consistent by
 * construction, and the scroll lands exactly on target even though the
 * integration is only approximate.
 */
const RAMP_TABLE_STEPS = 2048;

function integrateRamp(g) {
  const table = new Float64Array(RAMP_TABLE_STEPS + 1);
  const h = 1 / RAMP_TABLE_STEPS;
  let acc = 0;
  let prev = g(0);
  table[0] = 0;
  for (let i = 1; i <= RAMP_TABLE_STEPS; i++) {
    const cur = g(i * h);
    acc += ((prev + cur) / 2) * h;
    table[i] = acc;
    prev = cur;
  }
  const G = (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return table[RAMP_TABLE_STEPS];
    const x = u * RAMP_TABLE_STEPS;
    const i = Math.floor(x);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
  return { G, mean: table[RAMP_TABLE_STEPS] };
}

/**
 * Resolve `--ease-shape`: one of the named shapes, or a `cubic-bezier(...)`
 * used as the velocity ramp itself.
 */
function parseRampShape(raw) {
  if (raw && typeof raw === 'object' && typeof raw.g === 'function') return raw;
  const s = String(raw == null ? '' : raw).trim();
  const lower = s.toLowerCase();

  if (RAMP_SHAPES[lower]) return { name: lower, ...RAMP_SHAPES[lower] };

  if (!lower.startsWith('cubic-bezier(')) {
    throw new UsageError(
      `--ease-shape must be one of ${RAMP_SHAPE_NAMES.join(' | ')}, or a cubic-bezier(x1,y1,x2,y2) (got "${s}")`
    );
  }

  // parseCubicBezier already rejects x outside [0,1] and normalises the name.
  const bez = parseCubicBezier(s);
  const g = bez.fn;

  // A ramp is a VELOCITY curve, so a negative value means the scroll runs
  // backwards inside the fade. Above 1 is fine: that overshoots past the cruise
  // speed and settles back, which is a legitimate snap.
  for (let i = 0; i <= 1000; i++) {
    const v = g(i / 1000);
    if (v < 0) {
      throw new UsageError(
        `--ease-shape ${bez.name} dips below zero, which would scroll backwards inside the ramp. ` +
          'Keep both y values at or above 0 (above 1 is fine, that overshoots the cruise speed).'
      );
    }
  }

  const { G, mean } = integrateRamp(g);
  let peakSlope = 0;
  const h = 1e-6;
  for (let i = 0; i <= 2000; i++) {
    const u = i / 2000;
    const lo = Math.max(0, u - h);
    const hi = Math.min(1, u + h);
    peakSlope = Math.max(peakSlope, (g(hi) - g(lo)) / (hi - lo));
  }
  return { name: bez.name, g, G, mean, peakSlope };
}

/**
 * A ramp length: `1.5`, `1.5s`, or `15%` of the run. Zero is legal and switches
 * that side off. Returns { value, unit } rather than seconds, because a
 * percentage cannot be resolved until the run's duration is known.
 */
function parseRampLength(raw, flag = '--ease-in') {
  if (typeof raw === 'number') raw = String(raw);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UsageError(`${flag} needs a length in seconds (1.5) or a percentage (15%)`);
  }
  const s = raw.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(s|%)?$/.exec(s);
  if (!m) {
    throw new UsageError(`${flag} must be a number of seconds (1.5, 1.5s) or a percentage (15%), got "${raw}"`);
  }
  const value = Number(m[1]);
  const unit = m[2] === '%' ? 'percent' : 'seconds';
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`${flag} cannot be negative (got "${raw}")`);
  }
  if (unit === 'percent' && value > 100) {
    throw new UsageError(`${flag} cannot be more than 100% of the scroll (got "${raw}")`);
  }
  return { value, unit };
}

const rampText = (len) => (len.unit === 'percent' ? `${len.value}%` : `${len.value}s`);

/**
 * Build a ramp profile. Unlike a curve it cannot be evaluated until it knows
 * how long the run is, so it hands back `curveFor(durationS)` instead of `fn`.
 *
 * @param inSpec   parseRampLength result for the fade in
 * @param outSpec  parseRampLength result for the fade out
 * @param shape    key of RAMP_SHAPES
 */
function makeRamp({ inSpec, outSpec, shape = 'smooth', floorPx = FLOOR_DEFAULT_PX }) {
  const resolved = parseRampShape(shape);
  // Nothing to ramp: hand back the identity so the caller keeps the untouched,
  // byte-identical linear path rather than routing through a no-op profile.
  if (inSpec.value === 0 && outSpec.value === 0) return LINEAR;

  const { G, mean } = resolved;
  // The ground a ramp gives away against running at full speed the whole time.
  // For every named shape this is exactly 0.5, which is where the `/2` in the
  // original derivation came from.
  const w = 1 - mean;

  return {
    name: `ramp ${rampText(inSpec)}/${rampText(outSpec)} ${resolved.name}`,
    shapeMean: mean,
    ramp: true,
    linear: false,
    inSpec,
    outSpec,
    shape,
    floorPx,

    /**
     * @param durationS   how long this run lasts
     * @param distancePx  how far it travels, needed for the floor
     * @param fps         needed for the floor, which is per FRAME not per second
     */
    curveFor({ durationS, distancePx = 0, fps = 60 }) {
      const T = durationS;
      const resolve = (spec) => (spec.unit === 'percent' ? (spec.value / 100) * T : spec.value);
      let a = resolve(inSpec);
      let b = resolve(outSpec);

      // Ramps that do not fit scale down together, which turns the profile into
      // a triangle peaking at 2x the mean. Reported, never silent.
      let clamped = false;
      if (T > 0 && a + b > T) {
        const k = T / (a + b);
        a *= k;
        b *= k;
        clamped = true;
      }

      // The floor is resolved AFTER clamping, against the ramp lengths that are
      // actually going to be used.
      let F = 0;
      let floorDisabled = null;
      if (floorPx > 0 && distancePx > 0 && T > 0) {
        // v = (D - (a+b)*w*floorPx*fps) / (T - (a+b)*w). At w = 1/2 this is the
        // halves-everywhere form the named shapes have always used.
        const speed = (distancePx - (a + b) * w * floorPx * fps) / (T - (a + b) * w);
        if (!(speed > 0)) {
          floorDisabled = 'the run is too slow to hold that floor';
        } else {
          F = (floorPx * fps) / speed;
          if (!(F < 1)) {
            // The cruise itself is below the floor, so there is no headroom to
            // ramp through. Nothing can be done here; the caller warns.
            F = 0;
            floorDisabled = 'the whole run is slower than that floor';
          }
        }
      }

      const alpha = T > 0 ? a / T : 0;
      const beta = T > 0 ? b / T : 0;
      // D = v*[T - (a+b)(1-F)(1-mean)], normalised. F = 0 and mean = 1/2 give
      // back 1 / (1 - (alpha+beta)/2), the original formula.
      const v = 1 / (1 - (alpha + beta) * (1 - F) * w);
      const Gf = (u) => F * u + (1 - F) * G(u);
      // What one full ramp covers, as a fraction of running it at cruise speed.
      const rampShare = F + (1 - F) * mean;

      const fn = (q) => {
        if (q <= 0) return 0;
        if (q >= 1) return 1;
        if (alpha > 0 && q < alpha) return v * alpha * Gf(q / alpha);
        if (beta > 0 && q > 1 - beta) return 1 - v * beta * Gf((1 - q) / beta);
        return v * (alpha * rampShare + (q - alpha));
      };

      return {
        name: this.name, fn, linear: false,
        inS: a, outS: b, cruiseS: Math.max(0, T - a - b), cruiseFactor: v, clamped,
        floorPx: F > 0 ? floorPx : 0, floorFraction: F, floorDisabled,
      };
    },
  };
}

module.exports = {
  parseEase, EASE_NAMES, FAMILIES, LINEAR, cubicBezier,
  parseRampLength, makeRamp, parseRampShape, RAMP_SHAPES, RAMP_SHAPE_NAMES, RAMP_DEFAULT_S, FLOOR_DEFAULT_PX,
};
