'use strict';

/*
 * The frame loop. Everything it needs has already been decided by the time it
 * runs: the schedule is a plain array of { i, tMs, y, actions }.
 */

const fs = require('fs');
const path = require('path');

async function run(plan, io) {
  const browser = require('./browser');
  const encoder = require('./encoder');
  const { buildSchedule } = require('./schedule');
  const { collectSelectors } = require('./plan');

  fs.mkdirSync(path.dirname(plan.out), { recursive: true });

  const { makeRunner } = require('./hooks');

  const { browser: instance, page } = await browser.launch(plan);
  let enc = null;
  let encoderStarted = false;

  const state = {
    maxScroll: 0,
    totalFrames: 0,
    clockPaused: false,
    clockBaseMs: 0,
    clockOffsetMs: 0,
    currentTMs: 0,
    warnings: [],
    // Replaced with a clock-advancing version once the clock is installed.
    sleep: (ms) => page.waitForTimeout(ms),
  };
  const runHook = makeRunner(plan, page, io, state);

  try {
    const { heightBefore } = await browser.prepare(page, plan, io.log, runHook);

    const measured = await browser.measure(page, plan.viewport);
    state.maxScroll = measured.maxScroll;
    const grew = measured.pageHeight - heightBefore;
    if (measured.maxScroll === 0) {
      io.warn('page is not taller than the viewport, so the scroll will be static.');
    } else {
      io.log(`  scroll extent: ${measured.maxScroll}px` + (grew > 0 ? ` (page grew ${grew}px during warm-up)` : ''));
    }

    const rects = await browser.resolveSelectors(page, collectSelectors(plan));
    const schedule = buildSchedule(plan, { ...measured, rects });
    schedule.warnings.forEach(io.warn);

    state.totalFrames = schedule.totalFrames;

    if (plan.dryRun) return { schedule, dryRun: true, warnings: state.warnings };

    io.log(
      `  ${round2(schedule.totalDurationS)}s · ${schedule.totalFrames} frames` +
        (schedule.holdS > 0 ? ` (${round2(schedule.holdS)}s held)` : '')
    );

    // Take control of time. This happens AFTER load, --wait and the warm-up
    // pass, all of which need in-page timers to keep firing.
    const clock = require('./clock');
    const animations = require('./animations');
    if (plan.clock.enabled) {
      state.clockBaseMs = await clock.begin(page);
      state.clockPaused = true;
      // ctx.sleep now advances page time instead of burning wall-clock. It
      // shifts every later frame by the same amount so the clock never has to
      // move backwards, which pauseAt refuses to do.
      state.sleep = async (ms) => {
        state.clockOffsetMs += ms;
        await clock.stepTo(page, state.clockBaseMs, state.currentTMs + state.clockOffsetMs);
      };
    }

    enc = encoder.start({ outAbs: plan.out, fps: plan.fps });
    encoderStarted = true;

    const dump = plan.dumpFrames ? [] : null;
    if (dump) fs.mkdirSync(plan.dumpFrames, { recursive: true });

    io.log('  capturing frames…');
    for (const frame of schedule.frames) {
      // Set the scroll position, then wait for two animation frames so the
      // browser has actually painted (and scroll-driven effects like GSAP
      // ScrollTrigger have updated) before we screenshot.
      state.currentTMs = frame.tMs;

      // 1. Scroll first — scroll-driven effects (GSAP ScrollTrigger and the
      //    like) read window.scrollY inside the frame we are about to fire.
      await page.evaluate((targetY) => window.scrollTo(0, targetY), frame.y);

      // 2. Actions before the tick, so their DOM writes are visible to it.
      for (const action of frame.actions) {
        await runHook(action.fn, { label: action.label, phase: 'action', frame });
      }

      // 3. Advance page time by exactly one frame. Fires exactly one animation
      //    frame, timestamped with this frame's time.
      const pageTMs = frame.tMs + state.clockOffsetMs;
      if (plan.clock.enabled) {
        await clock.stepTo(page, state.clockBaseMs, pageTMs);
      }

      // 4. Freeze and seek CSS animations and transitions, which the clock
      //    cannot reach. After the tick, so anything it just started is caught.
      if (plan.clock.css === 'waapi') {
        await animations.seek(page, pageTMs, {
          shadow: plan.clock.shadow,
          restart: plan.clock.restartAnimations,
          firstScan: frame.i === 0,
        });
      }

      // 5. Two real vsyncs, so the new position and styles have painted. The
      //    mocked rAF would deadlock here; clock.js uses the stashed native one.
      await clock.paintBarrier(page);

      const png = await page.screenshot({ type: 'png' });
      await enc.write(png);

      if (dump) {
        const name = `frame-${String(frame.i).padStart(5, '0')}.png`;
        fs.writeFileSync(path.join(plan.dumpFrames, name), png);
        // Read back what the page actually thinks the time is, so a dump can
        // be checked without OCR-ing the PNGs.
        const probe = await page.evaluate(() => {
          const el = document.querySelector('[data-srp-probe]');
          let animations = [];
          try {
            animations = document.getAnimations().map((a) => ({
              name: a.animationName || a.transitionProperty || 'animation',
              timeline: a.timeline && a.timeline.constructor ? a.timeline.constructor.name : '?',
              t: typeof a.currentTime === 'number' ? Math.round(a.currentTime) : String(a.currentTime),
              state: a.playState,
            }));
          } catch {}
          return { text: el ? el.textContent : null, animations };
        });
        dump.push({
          i: frame.i, file: name, tMs: frame.tMs, y: frame.y, segment: frame.segment,
          probe: probe.text, animations: probe.animations,
        });
      }

      if ((frame.i + 1) % plan.fps === 0 || frame.i === schedule.totalFrames - 1) {
        io.progress(`  frame ${frame.i + 1}/${schedule.totalFrames}`);
      }
    }
    io.progressDone();

    if (dump) {
      fs.writeFileSync(
        path.join(plan.dumpFrames, 'frames.json'),
        JSON.stringify({ segments: schedule.segments, frames: dump }, null, 2)
      );
      io.log(`  dumped ${dump.length} frames to ${plan.dumpFrames}`);
    }

    if (plan.after) await runHook(plan.after, { label: 'after', phase: 'after' });

    if (!(await browser.reachedBottom(page)) && measured.maxScroll > 0 && !hasHoldAtEnd(schedule)) {
      io.warn('final frame did not reach the bottom; the page is still growing, so try a longer --wait.');
    }

    await enc.finish();
    return { schedule, outAbs: plan.out, warnings: state.warnings };
  } catch (err) {
    if (enc) enc.kill();
    // Don't leave a truncated video behind, but only remove a file we made.
    if (encoderStarted) {
      try {
        fs.unlinkSync(plan.out);
      } catch {}
    }
    throw err;
  } finally {
    await instance.close();
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/** A plan may deliberately finish somewhere other than the bottom. */
function hasHoldAtEnd(schedule) {
  const last = schedule.segments[schedule.segments.length - 1];
  return !last || last.y1 < schedule.maxScroll;
}

module.exports = { run };
