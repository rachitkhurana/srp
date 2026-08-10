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
 */

const { UsageError } = require('./errors');
const { resolveTargetPx, targetKey } = require('./targets');

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
  let cursor = 0;
  const segs = timeline.map((s, index) => {
    if (s.type === 'hold') {
      const y = s.at ? resolveTargetPx(s.at, ctx) : cursor;
      cursor = y;
      return { index, kind: 'hold', label: s.label || 'hold', y0: y, y1: y, action: s.action, actionAt: s.actionAt || 'start' };
    }
    const y1 = resolveTargetPx(s.to, ctx);
    const seg = { index, kind: 'scroll', label: s.label || 'scroll', y0: cursor, y1, action: s.action, actionAt: s.actionAt || 'start' };
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
    const k = motionS > 0 ? (totalS - holdS) / motionS : 0;
    if (motionS > 0 && k < 0.05) {
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
    if (counts[k] === 0 && segs[k].kind === 'hold') {
      warnings.push(`the ${round2(dur[k])}s hold at ${Math.round(segs[k].y0)}px is shorter than one frame at ${plan.fps}fps and was dropped`);
    }
  }

  // 4. Emit frames.
  const globalT = (i) => (totalFrames > 1 ? (i / (totalFrames - 1)) * totalS : 0);
  const frames = [];
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const span = dur[k];
    for (let j = 0; j < counts[k]; j++) {
      const i = starts[k] + j;
      const t = Math.min(Math.max(globalT(i), T[k]), T[k] + span);
      const y = seg.kind === 'hold' || span <= 0 ? seg.y1 : seg.y0 + (seg.y1 - seg.y0) * ((t - T[k]) / span);
      const actions = [];
      if (seg.action && ((seg.actionAt === 'end' && j === counts[k] - 1) || (seg.actionAt !== 'end' && j === 0))) {
        actions.push({ fn: seg.action, label: seg.label });
      }
      frames.push({ i, tMs: Math.round((i * 1000) / plan.fps), y, segment: k, actions });
    }
  }

  const segments = segs.map((s, k) => ({
    label: s.label, kind: s.kind, y0: s.y0, y1: s.y1,
    startFrame: starts[k], frameCount: counts[k], seconds: dur[k],
  }));

  return {
    fps: plan.fps, totalFrames, totalDurationS: totalS, motionS, holdS,
    maxScroll: ctx.maxScroll, segments, frames, warnings,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

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
  ].join('\n');
}

module.exports = { buildSchedule, allocateFrames, expandPauses, describeSchedule };
