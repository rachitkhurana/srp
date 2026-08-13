'use strict';

/*
 * Turns a normalised plan plus the measured page geometry into an explicit
 * list of frames. Pure — no browser, no ffmpeg — so all of the timing maths is
 * unit-testable, and `--dry-run` is just this module plus a printer.
 *
 * THE POSITION MODEL
 * ------------------
 * Frames are treated as endpoints spanning the whole timeline inclusively:
 * frame 0 is at t=0 and frame N-1 is at t=totalS. Scroll position is then a
 * continuous piecewise-linear function of t, sampled at those instants. That
 * has three properties we need:
 *
 *   - the last frame lands exactly on the final position (the old script's
 *     `reachedBottom` guarantee),
 *   - segment boundaries produce neither a duplicated nor a skipped position,
 *   - with a single scroll segment it reduces algebraically to the original
 *     `y = maxScroll * i / (N - 1)`, so a refactor is byte-identical.
 *
 * Each frame's t is clamped into its own segment's interval, so a hold is
 * exactly constant even when rounding puts a boundary frame a hair early.
 *
 * EASING
 * ------
 * Easing warps TIME, not position. A frame's t is mapped through the curve and
 * the warped time is then looked up in the unchanged piecewise-linear position
 * function. Doing it that way buys three things a per-segment ease does not:
 * adjacent scroll steps ease as one continuous stretch of motion instead of
 * decelerating to a dead stop at every waypoint, backward scrolls and unequal
 * step durations need no special cases, and a linear ease is exactly the
 * identity, so the default output is untouched to the last bit.
 *
 * Frame allocation, the frame-to-segment mapping and action placement are all
 * unaffected: only the position lookup changes. One consequence worth knowing
 * is that a frame belonging to segment k can legitimately render a position
 * inside segment k+1 of the same run, because that is what warped time means.
 */

const { UsageError } = require('./errors');
const { resolveTargetPx, targetKey } = require('./targets');
const { LINEAR } = require('./easing');

/**
 * CLI `--pause` desugaring: split the synthetic single scroll into
 * scroll/hold/scroll/... so the flag form and the plan-file form land on the
 * identical timeline before anything else looks at it.
 */
function expandPauses(plan, ctx, warnings) {
  if (!plan.pauses || !plan.pauses.length) return plan.timeline;

  const base = plan.timeline[0];
  const endY = resolveTargetPx(base.to, ctx);

  // Group by resolved pixel position: two pauses landing on the same spot are
  // one longer hold, not two adjacent zero-distance segments.
  const byY = new Map();
  for (const p of plan.pauses) {
    const y = resolveTargetPx(p.target, ctx);
    if (byY.has(y)) {
      warnings.push(`two --pause targets both resolve to ${Math.round(y)}px; merged into one hold`);
      byY.set(y, byY.get(y) + p.seconds);
    } else {
      byY.set(y, p.seconds);
    }
  }

  const stops = [...byY.entries()].sort((a, b) => a[0] - b[0]);
  const timeline = [];
  let cursor = 0;

  for (const [y, seconds] of stops) {
    if (y > cursor) {
      timeline.push({ ...base, to: { kind: 'pixels', value: y, align: 'top', offset: 0 }, duration: null });
      cursor = y;
    }
    timeline.push({ type: 'hold', at: null, duration: seconds, action: null, actionAt: 'start', label: `hold ${seconds}s` });
  }
  if (cursor < endY || timeline.length === 0) {
    timeline.push({ ...base, duration: null });
  }
  return timeline;
}

/**
 * A motion run is a maximal stretch of adjacent scroll segments sharing one
 * curve, and it is the unit easing applies to. Holds break a run, because
 * slowing to a stop for a pause and accelerating out of it is exactly right.
 * A step that names its own curve is a run of one, so its declared duration is
 * honoured rather than warped along with its neighbours.
 */
function groupRuns(segs, dur, T) {
  const runs = [];
  let open = null;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg.kind !== 'scroll') {
      open = null;
      continue;
    }
    if (open && !seg.ownEase && open.ease === seg.ease) {
      open.to = k;
      open.D += dur[k];
      continue;
    }
    open = { from: k, to: k, T0: T[k], D: dur[k], ease: seg.ease };
    runs.push(open);
    if (seg.ownEase) open = null;
  }
  return runs;
}

/**
 * Warped time within a run. Reads `run.curve`, not `run.ease`: a ramp cannot be
 * evaluated until it knows how long its run is, so the curve is resolved once
 * per run in buildSchedule and cached there.
 */
const warpInRun = (run, t) => (run.D > 0 ? run.T0 + run.D * run.curve.fn((t - run.T0) / run.D) : t);

/**
 * Where a run is at warped time `tw`. Walks the run's own segments, so the
 * per-step waypoints and durations still shape the path; only the rate along
 * it has changed. Zero-duration segments are points, not intervals, and get
 * skipped without leaving a gap (T[k+1] === T[k] when dur[k] is 0).
 *
 * `tw` can land OUTSIDE the run, because a cubic-bezier whose y control points
 * leave [0,1] returns progress below 0 or above 1 on purpose. Those cases
 * extrapolate along the nearest moving segment rather than being flattened onto
 * its endpoint, so an overshoot curve genuinely overshoots and settles back.
 * The caller bounds the result to the scrollable extent.
 */
function positionInRun(run, segs, dur, T, tw) {
  let last = -1;
  for (let k = run.from; k <= run.to; k++) {
    if (dur[k] <= 0) continue;
    last = k;
    if (tw <= T[k] + dur[k]) {
      // p < 0 here on the first segment, which is the undershoot case.
      const p = (tw - T[k]) / dur[k];
      return segs[k].y0 + (segs[k].y1 - segs[k].y0) * p;
    }
  }
  if (last === -1) return segs[run.to].y1; // nothing in this run actually moves
  return segs[last].y0 + ((segs[last].y1 - segs[last].y0) * (tw - T[last])) / dur[last];
}

/** Frame counts per segment, summing to exactly totalFrames (no ±1 drift). */
function allocateFrames(durations, totalS, totalFrames) {
  const counts = [];
  let acc = 0;
  let prevEnd = 0;
  for (let k = 0; k < durations.length; k++) {
    acc += durations[k];
    const end = k === durations.length - 1 ? totalFrames : Math.round((acc / totalS) * totalFrames);
    counts.push(Math.max(0, end - prevEnd));
    prevEnd = prevEnd + counts[k];
  }
  return counts;
}

/**
 * @param plan  NormalizedPlan
 * @param ctx   { maxScroll, viewportH, rects }
 * @returns     { fps, totalFrames, totalDurationS, maxScroll, segments, frames, warnings }
 */
function buildSchedule(plan, ctx) {
  const warnings = [];
  const timeline = expandPauses(plan, ctx, warnings);
  if (!timeline.length) throw new UsageError('the timeline is empty');

  // 1. Resolve every step to a start/end pixel position, walking a cursor.
  const planEase = plan.ease || LINEAR;
  let cursor = 0;
  const segs = timeline.map((s, index) => {
    if (s.type === 'hold') {
      const y = s.at ? resolveTargetPx(s.at, ctx) : cursor;
      cursor = y;
      return { index, kind: 'hold', label: s.label || 'hold', y0: y, y1: y, action: s.action, actionAt: s.actionAt || 'start' };
    }
    const y1 = resolveTargetPx(s.to, ctx);
    const seg = {
      index, kind: 'scroll', label: s.label || 'scroll', y0: cursor, y1,
      // `ownEase` is what makes a step its own run, so it has to survive the
      // fall back to the plan-wide curve rather than being inferred from it.
      ease: s.ease || planEase, ownEase: Boolean(s.ease),
      action: s.action, actionAt: s.actionAt || 'start',
    };
    cursor = y1;
    return seg;
  });

  // 2. Durations. Scroll steps without an explicit duration share the
  //    --duration budget in proportion to how far they travel, so a pause at
  //    90% correctly gets a long first leg and a short last one.
  const dur = timeline.map((s) => (s.duration == null ? 0 : s.duration));
  const auto = timeline.map((s, i) => (s.type === 'scroll' && s.duration == null ? i : -1)).filter((i) => i >= 0);
  if (auto.length) {
    const spans = auto.map((i) => Math.abs(segs[i].y1 - segs[i].y0));
    const spanTotal = spans.reduce((a, b) => a + b, 0);
    auto.forEach((i, k) => {
      dur[i] = spanTotal > 0 ? (plan.scrollDurationS * spans[k]) / spanTotal : plan.scrollDurationS / auto.length;
    });
  } else if (plan.durationWasSet && !plan.fixedDuration) {
    // Every scroll step named its own duration, so the budget is never read.
    // Silently ignoring a flag the user typed is how you get a 4s video after
    // asking for 30.
    warnings.push(
      `--duration ${round2(plan.scrollDurationS)}s was ignored: every step in the timeline sets its own ` +
        `duration. Remove those, or use --fixed-duration to scale them to fit.`
    );
  }

  const holdS = segs.reduce((a, s, i) => a + (s.kind === 'hold' ? dur[i] : 0), 0);
  let motionS = segs.reduce((a, s, i) => a + (s.kind === 'scroll' ? dur[i] : 0), 0);
  let totalS;

  if (plan.fixedDuration) {
    totalS = plan.scrollDurationS;
    if (holdS >= totalS) {
      throw new UsageError(
        `holds total ${round2(holdS)}s but --duration is ${round2(totalS)}s with --fixed-duration; ` +
          `raise --duration or shorten a pause`
      );
    }
    if (motionS === 0) {
      // Nothing to compress. Padding the timeline out to --duration would land
      // entirely on the last segment, so a declared 3s hold would silently run
      // for 8s while --dry-run still printed "3s".
      throw new UsageError(
        `--fixed-duration needs something to compress, but this timeline is ${round2(holdS)}s of holds ` +
          `and no scrolling. Drop --fixed-duration, or give a step a scrollTo.`
      );
    }
    const k = (totalS - holdS) / motionS;
    if (k < 0.05) {
      warnings.push(`--fixed-duration compresses the scroll to ${(k * 100).toFixed(1)}% of its natural speed`);
    }
    for (let i = 0; i < dur.length; i++) if (segs[i].kind === 'scroll') dur[i] *= k;
    motionS = totalS - holdS;
  } else {
    totalS = motionS + holdS;
  }

  if (!(totalS > 0)) throw new UsageError('the total duration is zero');

  // 3. Frame allocation, in integer frame space.
  const totalFrames = Math.max(1, Math.round(totalS * plan.fps));
  const counts = allocateFrames(dur, totalS, totalFrames);

  const starts = [];
  const T = [];
  let f = 0;
  let t0 = 0;
  for (let k = 0; k < segs.length; k++) {
    starts.push(f);
    T.push(t0);
    f += counts[k];
    t0 += dur[k];
    if (counts[k] === 0) {
      // A zero-frame segment emits nothing at all, which quietly takes its
      // action with it: the click you attached simply never fires.
      const what = segs[k].kind === 'hold' ? `the ${round2(dur[k])}s hold at ${Math.round(segs[k].y0)}px` : `"${segs[k].label}"`;
      warnings.push(
        `${what} is shorter than one frame at ${plan.fps}fps and was dropped` +
          (segs[k].action ? ', along with its action, which will never fire' : '')
      );
    }
  }

  // 4. Group the scroll segments into easing runs and resolve each run's curve.
  //    A linear run is left out of `runOf` entirely so its frames go down the
  //    original code path and the default output stays byte-identical.
  const runs = groupRuns(segs, dur, T);
  const runOf = new Array(segs.length).fill(null);
  for (const run of runs) {
    // Ground actually covered, so the report can quote a speed in px/s. Summed
    // per segment rather than end-to-end, so a run that doubles back is not
    // described as having travelled the net distance.
    run.distance = 0;
    for (let k = run.from; k <= run.to; k++) run.distance += Math.abs(segs[k].y1 - segs[k].y0);

    if (run.ease.linear || !(run.D > 0)) continue;
    // A ramp is defined in absolute seconds and in pixels per frame, so it only
    // becomes a curve once it knows the shape of the run it landed on.
    run.curve = run.ease.ramp
      ? run.ease.curveFor({ durationS: run.D, distancePx: run.distance, fps: plan.fps })
      : run.ease;

    // A disabled floor is not warned about here: it always shows up as sub-pixel
    // frames, and step 6 says so once, with a count and the advice that actually
    // applies. Two warnings for one symptom is worse than one.

    if (run.curve.clamped) {
      const asked = `${round2(run.ease.inSpec.value)}${run.ease.inSpec.unit === 'percent' ? '%' : 's'}` +
        ` + ${round2(run.ease.outSpec.value)}${run.ease.outSpec.unit === 'percent' ? '%' : 's'}`;
      warnings.push(
        `"${segs[run.from].label}" is ${round2(run.D)}s but the ramps asked for ${asked}; both were scaled to ` +
          `${round2(run.curve.inS)}s, so it has no constant-speed section and peaks at ` +
          `${Math.round((run.curve.cruiseFactor * run.distance) / run.D)}px/s ` +
          `(${round2(run.curve.cruiseFactor)}x its average). Give the step a longer duration to fix it.`
      );
    }
    for (let k = run.from; k <= run.to; k++) runOf[k] = run;
  }

  // 5. Emit frames.
  const globalT = (i) => (totalFrames > 1 ? (i / (totalFrames - 1)) * totalS : 0);
  const frames = [];
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const span = dur[k];
    for (let j = 0; j < counts[k]; j++) {
      const i = starts[k] + j;
      const t = Math.min(Math.max(globalT(i), T[k]), T[k] + span);
      const raw =
        seg.kind === 'hold' || span <= 0
          ? seg.y1
          : runOf[k]
            ? positionInRun(runOf[k], segs, dur, T, warpInRun(runOf[k], t))
            : seg.y0 + (seg.y1 - seg.y0) * ((t - T[k]) / span);
      // Load-bearing for an overshooting curve, which positionInRun lets run
      // past the run's own target on purpose. Every resolved target is already
      // inside the extent, so this is a no-op on the linear path and cannot
      // perturb the byte-identical default output.
      const y = Math.max(0, Math.min(ctx.maxScroll, raw));
      const actions = [];
      if (seg.action && ((seg.actionAt === 'end' && j === counts[k] - 1) || (seg.actionAt !== 'end' && j === 0))) {
        actions.push({ fn: seg.action, label: seg.label });
      }
      frames.push({ i, tMs: Math.round((i * 1000) / plan.fps), y, segment: k, actions });
    }
  }

  // 6. Sub-pixel check. window.scrollTo snaps to whole CSS pixels, so any part
  //    of a scroll moving slower than 1px per frame renders as a hold followed
  //    by a jump, which reads as judder. Worth saying out loud: it is invisible
  //    in the schedule, where y is a smooth float the whole way.
  for (const run of runs) {
    const first = starts[run.from];
    const last = first + counts.slice(run.from, run.to + 1).reduce((a, b) => a + b, 0) - 1;
    if (last <= first) continue;
    let repeats = 0;
    for (let i = first + 1; i <= last; i++) {
      if (Math.round(frames[i].y) === Math.round(frames[i - 1].y)) repeats++;
    }
    if (repeats <= 5) continue;

    // The advice has to match why it is happening, or it sends people to a flag
    // that cannot help them.
    const perFrame = round2(run.distance / run.D / plan.fps);
    let fix;
    if (!run.ease.ramp) {
      fix = run.ease.linear
        ? 'give this step less time, so it moves further per frame'
        : 'switch to --ease ramp, which can hold a minimum speed; a curve cannot';
    } else if (run.curve && run.curve.floorDisabled) {
      // Raising the floor is exactly the wrong advice here: the leg is already
      // slower than the floor it has, which is why the floor could not apply.
      fix =
        `this leg averages ${perFrame}px per frame, below the --ease-floor ${run.ease.floorPx} it was given, ` +
        'so the floor could not apply. Give the step less time so it covers more ground per frame';
    } else if (!run.ease.floorPx) {
      fix = 'raise --ease-floor above 0, or shorten the ramp';
    } else {
      fix = `raise --ease-floor above ${run.ease.floorPx}, shorten the ramp, or use a gentler --ease-shape`;
    }
    warnings.push(
      `"${segs[run.from].label}" has ${repeats} frames that do not move a whole pixel, so the scroll will ` +
        `visibly step there (scrollTo snaps to whole pixels). To fix: ${fix}.`
    );
  }

  const segments = segs.map((s, k) => ({
    label: s.label, kind: s.kind, y0: s.y0, y1: s.y1,
    startFrame: starts[k], frameCount: counts[k], seconds: dur[k],
    ease: s.kind === 'scroll' ? s.ease.name : null,
  }));

  // Reported so --dry-run and frames.json can show how the runs grouped, which
  // is the one thing about easing that is not obvious from the segment table.
  const runDescriptions = runs.map((run) => {
    // Summed rather than read off the last segment: if that segment was dropped
    // for being shorter than a frame, starts[run.to] belongs to the NEXT
    // segment and the range would come out inverted.
    const frameCount = counts.slice(run.from, run.to + 1).reduce((a, b) => a + b, 0);
    const c = run.curve;
    return {
      ease: run.ease.name,
      fromSegment: run.from, toSegment: run.to,
      startFrame: starts[run.from],
      endFrame: starts[run.from] + frameCount - 1,
      frameCount,
      seconds: run.D,
      distance: run.distance,
      // Only a ramp has these. `speed` is the constant-speed section in px/s,
      // which is the number worth reading: it should sit just above distance/D.
      ramp: c && c.cruiseFactor !== undefined
        ? {
            inS: c.inS, outS: c.outS, cruiseS: c.cruiseS, clamped: c.clamped,
            speed: run.D > 0 ? (c.cruiseFactor * run.distance) / run.D : 0,
            floorPx: c.floorPx, floorDisabled: c.floorDisabled,
          }
        : null,
    };
  });

  return {
    fps: plan.fps, totalFrames, totalDurationS: totalS, motionS, holdS,
    maxScroll: ctx.maxScroll, ease: planEase.name, segments, runs: runDescriptions,
    frames, warnings,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * One line per distinct curve, listing the frame spans it covers. Which
 * segments got merged into one run is the only thing about easing you cannot
 * read off the segment table, and getting it wrong is the difference between a
 * continuous scroll and one that stalls at every waypoint.
 */
function describeRuns(runs = []) {
  const live = runs.filter((r) => r.ease !== 'linear' && r.frameCount > 0);
  if (!live.length) return [];

  // A ramp resolves to different numbers on every run, and those numbers are
  // the whole point of it, so each run gets its own line.
  if (live.some((r) => r.ramp)) {
    const out = [`  ease ${live[0].ease}`];
    live.forEach((r, i) => {
      const where = `run ${i + 1}  frames ${r.startFrame}..${r.endFrame}`.padEnd(30);
      const floor = r.ramp && r.ramp.floorPx ? ` · from ${round2(r.ramp.floorPx)}px/frame` : '';
      const how = r.ramp
        ? r.ramp.clamped
          ? `ramps scaled to ${round2(r.ramp.inS)}s, no cruise, peaks at ${Math.round(r.ramp.speed)}px/s${floor}`
          : `up ${round2(r.ramp.inS)}s · cruise ${round2(r.ramp.cruiseS)}s at ${Math.round(r.ramp.speed)}px/s · down ${round2(r.ramp.outS)}s${floor}`
        : r.ease;
      out.push(`    ${where}${how}`);
    });
    return out;
  }

  const byEase = new Map();
  for (const run of live) {
    if (!byEase.has(run.ease)) byEase.set(run.ease, []);
    byEase.get(run.ease).push(`${run.startFrame}..${run.endFrame}`);
  }
  return [...byEase].map(
    ([ease, spans]) =>
      `  ease ${ease} over ${spans.length} motion run${spans.length > 1 ? 's' : ''} (frames ${spans.join(', ')})`
  );
}

function describeSchedule(s) {
  const rows = s.segments.map((g, k) => {
    const move = g.kind === 'hold' ? `hold @ ${Math.round(g.y0)}px` : `${Math.round(g.y0)} -> ${Math.round(g.y1)}px`;
    return `  ${String(k).padStart(2)}  ${g.kind.padEnd(6)}  ${move.padEnd(24)}  ${round2(g.seconds)}s`.padEnd(60) +
      `  frames ${g.startFrame}..${g.startFrame + g.frameCount - 1} (${g.frameCount})`;
  });
  return [
    `  extent ${Math.round(s.maxScroll)}px · ${round2(s.totalDurationS)}s total ` +
      `(${round2(s.motionS)}s scroll + ${round2(s.holdS)}s held) · ${s.fps}fps · ${s.totalFrames} frames`,
    ...rows,
    ...describeRuns(s.runs),
  ].join('\n');
}

module.exports = { buildSchedule, allocateFrames, expandPauses, groupRuns, describeSchedule, describeRuns };
