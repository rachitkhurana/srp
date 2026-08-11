'use strict';

/*
 * Deterministic page time.
 *
 * Capture is decoupled from wall-clock time — a frame takes ~30ms of real time
 * to produce but represents 1/fps of video — so anything the page animates by
 * itself runs at the wrong speed. A hold is the worst case: the scroll stops
 * but the animation keeps crawling forward at whatever rate the machine
 * happens to screenshot. page.clock lets us advance page time by exactly one
 * frame per frame instead.
 *
 * THREE THINGS ABOUT playwright's clock THAT DRIVE THIS DESIGN
 * (all verified against playwright 1.62.1, not assumed):
 *
 * 1. clock.install() MOCKS requestAnimationFrame. Once the clock is paused no
 *    timer ever fires, so the obvious `rAF(() => rAF(resolve))` paint barrier
 *    hangs forever — and page.evaluate has no default timeout, so it hangs the
 *    whole process. We therefore capture the native rAF in an init script
 *    registered BEFORE install() and use that instead.
 *
 * 2. pauseAt() is the only exact stepper. It collapses every overdue timer to
 *    the target time and then runs them, so one call fires exactly one rAF
 *    whose timestamp IS the frame time. runFor() leaves rAF on a hard 16ms
 *    grid (up to a frame stale) and fastForward() truncates its argument.
 *
 * 3. install({time}) leaves the clock RUNNING. By the time load, --wait and
 *    the warm-up pass are done it is well past the epoch, and pauseAt() throws
 *    "Cannot fast-forward to the past" if you aim behind it. So: install
 *    early, pause late, and pause at a point comfortably ahead of now.
 *
 * page.clock does NOT touch CSS animations or transitions — those are on the
 * compositor's own timeline. See animations.js.
 */

const { RecordError } = require('./errors');

/** A fixed epoch so Date.now() in the page is reproducible between runs. */
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Pause this far ahead of "now", then snap up, so the base is stable. */
const MARGIN_MS = 1000;
const SNAP_MS = 1000;

/** Give up waiting for a vsync after this long. See BARRIER. */
const BARRIER_TIMEOUT_MS = 2000;

/*
 * Registered before clock.install() so it sees the real requestAnimationFrame.
 * __srpBirth is used by animations.js to date animations it has already seen.
 */
const INIT_SCRIPT = `(() => {
  if (window.__srpRaf) return;
  const raf = window.requestAnimationFrame.bind(window);
  Object.defineProperty(window, '__srpRaf',   { value: raf,           enumerable: false });
  Object.defineProperty(window, '__srpBirth', { value: new WeakMap(), enumerable: false });
})()`;

/*
 * Two real vsyncs, so the browser has actually painted the new scroll position
 * and any style we just seeked. Falls back to playwright's own stashed
 * builtins, then — only if the clock is not installed — to the page's rAF.
 */
const BARRIER = (timeoutMs) =>
  new Promise((resolve) => {
    const pw = globalThis.__pwClock && globalThis.__pwClock.builtins;
    const raf = window.__srpRaf || (pw && pw.requestAnimationFrame) || window.requestAnimationFrame;
    const call = raf.bind(window);
    // Chromium stops issuing animation frames to an occluded or minimised
    // window, so under --headed this can never resolve. page.evaluate has no
    // timeout, so an unguarded wait wedges the whole recording. Fall back to
    // the real timer, which is not faked at the Node boundary.
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const bail = (globalThis.__pwClock && globalThis.__pwClock.builtins && globalThis.__pwClock.builtins.setTimeout) || null;
    if (bail) bail.call(window, finish, timeoutMs);
    call(() => call(finish));
  });

/** Must run before install() and before goto(). */
async function installEarly(page) {
  await page.addInitScript(INIT_SCRIPT);
  // The seekers live in init scripts too, so their source is sent once rather
  // than re-serialised on every frame. addInitScript reaches every frame of
  // the page, including iframes.
  await page.addInitScript(require('./animations').INIT_SCRIPT);
  await page.addInitScript(require('./videos').INIT_SCRIPT);
}

/** Must run before goto(): libraries capture Date.now at module-eval time. */
async function install(page) {
  try {
    await page.clock.install({ time: EPOCH_MS });
  } catch (err) {
    throw new RecordError(
      `could not install the deterministic clock: ${err.message}\n` +
        `  If the page fakes timers itself, record with --no-clock.`
    );
  }
}

/**
 * Take control of time. Called after load / --wait / warm-up, because all
 * three need in-page timers to keep firing.
 * @returns the absolute fake-clock millisecond that frame time 0 maps to.
 */
async function begin(page) {
  const now = await page.evaluate(() => Date.now());
  // Snap up to a whole second so small differences in load time between runs
  // do not shift every rAF timestamp in the recording.
  const base = EPOCH_MS + Math.ceil((now - EPOCH_MS + MARGIN_MS) / SNAP_MS) * SNAP_MS;
  await page.clock.pauseAt(base);
  return base;
}

/** Advance to an exact frame time. Fires exactly one rAF at that timestamp. */
async function stepTo(page, baseMs, tMs) {
  await page.clock.pauseAt(baseMs + tMs);
}

async function paintBarrier(page, timeoutMs = BARRIER_TIMEOUT_MS) {
  await page.evaluate(BARRIER, timeoutMs);
}

module.exports = {
  installEarly, install, begin, stepTo, paintBarrier,
  EPOCH_MS, MARGIN_MS, SNAP_MS, BARRIER_TIMEOUT_MS, INIT_SCRIPT,
};
