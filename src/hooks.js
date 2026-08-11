'use strict';

/*
 * Running user-supplied Playwright code safely.
 *
 * Hooks are called as fn(page, ctx) — `page` first so the common one-liner
 * `async (page) => page.click('#accept')` just works.
 *
 * The two hazards this guards against, both of which only appear once the page
 * clock is frozen (step 5):
 *   - an in-page setTimeout/rAF inside a hook never fires, so the hook hangs
 *     forever. Hence the real-time timeout.
 *   - page.waitForTimeout() is a Node-side timer, so it DOES resolve, but it
 *     burns wall-clock while the page is frozen — the opposite of what the
 *     author meant. Hence the "did you mean ctx.sleep()" warning.
 */

const { RecordError } = require('./errors');

const BLOCKING_WARN_MS = 500;

function makeRunner(plan, page, io, state) {
  const warned = new Set();

  return async function runHook(fn, { label, phase = 'action', frame = null }) {
    const ctx = {
      page,
      viewport: plan.viewport,
      maxScroll: state.maxScroll,
      frame: frame
        ? {
            index: frame.i,
            total: state.totalFrames,
            tMs: frame.tMs,
            y: frame.y,
            progress: state.totalFrames > 1 ? frame.i / (state.totalFrames - 1) : 0,
          }
        : undefined,
      clock: {
        paused: () => state.clockPaused,
        // Must include the offset ctx.sleep accumulates, or this reads behind
        // the page's real time by however much has been slept.
        nowMs: () =>
          state.clockPaused ? state.clockBaseMs + (frame ? frame.tMs : 0) + state.clockOffsetMs : null,
      },
      // Advance the RECORDING clock rather than real time. state.sleep is
      // swapped for the clock-advancing version once the clock is installed.
      sleep: (ms) => state.sleep(ms),
      log: (m) => io.log(`  · ${label}: ${m}`),
    };

    const started = Date.now();
    let timer;
    const call = Promise.resolve().then(() => fn(page, ctx));
    call.catch(() => {}); // a hook we abandoned on timeout must not crash the process later

    try {
      await Promise.race([
        call,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RecordError(
                  `hook "${label}" exceeded ${plan.hookTimeoutMs / 1000}s` +
                    (state.clockPaused
                      ? '. The page clock is frozen during capture, so an in-page setTimeout or ' +
                        'requestAnimationFrame will never fire. Use ctx.sleep(ms) instead.'
                      : '')
                )
              ),
            plan.hookTimeoutMs
          );
        }),
      ]);
    } catch (err) {
      if (phase !== 'action' || plan.strictHooks) throw err;
      const msg = `frame ${frame ? frame.i : '?'} · ${label}: ${err.message}`;
      io.warn(msg);
      state.warnings.push(msg);
      return;
    } finally {
      clearTimeout(timer);
    }

    const spent = Date.now() - started;
    if (state.clockPaused && spent > BLOCKING_WARN_MS && !warned.has(label)) {
      warned.add(label);
      io.warn(
        `${label} blocked ${(spent / 1000).toFixed(1)}s of real time without advancing the page clock. ` +
          `Did you mean ctx.sleep()? (page.waitForTimeout sleeps the recorder, not the page)`
      );
    }
  };
}

module.exports = { makeRunner, BLOCKING_WARN_MS };
