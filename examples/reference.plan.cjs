/*
 * Every key a --plan file supports, annotated. This file is valid and runnable
 * (a unit test loads and validates it), so it is safe to copy and cut down.
 *
 *   srp --plan examples/reference.plan.cjs --url ./test/fixtures/page.html --dry-run
 *
 * TOP LEVEL
 * ---------
 * Three plan-only keys: `timeline`, `before`, `after`.
 *
 * Plus any CLI option, in kebab or camel case ('fixed-duration' or
 * 'fixedDuration', both work). The four you cannot set here are `help`,
 * `version`, `plan` and `script`, for the obvious reason.
 *
 * Precedence is: a flag you actually typed  >  this file  >  the default.
 * Plan values go through the same validation a flag does, so `fps: -1` is
 * rejected with the same message `--fps -1` would give.
 */
module.exports = {
  // ---- page ----
  url: './test/fixtures/page.html', // bare host gets http://, a path becomes file://
  width: 1280, // rounded to an even number (H.264 and VP9 require it)
  height: 720,
  wait: 1, // settle seconds after load; 0 is allowed
  warmup: true, // pre-scroll to load lazy content. false = --no-warmup
  // headed: true,                  // show the browser window

  // ---- output ----
  out: 'output/reference.mp4', // .mp4 gives H.264, .webm gives VP9
  fps: 60,

  // ---- timing ----
  duration: 10, // scroll-motion seconds, shared between steps that
  //                                    // do not name their own duration
  // fixedDuration: true,           // make `duration` the hard total instead,
  //                                // compressing the scroll to fit the holds
  ease: 'linear', // easing MODE. 'linear' (the default) is a
  //                                // constant rate. 'ramp' fades up to speed,
  //                                // cruises, and fades back down, which is
  //                                // what you want on a long page. Or name a
  //                                // curve ('power2.inOut') to stretch one
  //                                // shape across the whole run instead, which
  //                                // suits a short clip. See the README.
  // easeIn: 2,                     // ramp up over 2s ('2', '2s' or '10%').
  // easeOut: 4,                    // ramp back down over 4s. 0 turns a side
  //                                // off. Naming either one implies
  //                                // ease: 'ramp', and the side you leave out
  //                                // defaults to 1.5s. Cannot be combined with
  //                                // a curve: they are different models.
  // easeShape: 'smooth',           // how pronounced the corners are, gentlest
  //                                // to steepest: linear, smooth (default),
  //                                // sine, smoother, smoothest, or a
  //                                // 'cubic-bezier(.65,0,.25,.99)' to go
  //                                // steeper still. Reach for this to make the
  //                                // easing STRONGER; a longer ramp does not do
  //                                // that. A bezier describes the VELOCITY
  //                                // through the ramp, so it must not dip below
  //                                // zero; above 1 overshoots the cruise speed
  //                                // and settles back.
  // easeFloor: 2,                  // least a ramp may move per frame. scrollTo
  //                                // snaps to whole pixels, so anything under
  //                                // 1px/frame visibly steps. 0 starts from a
  //                                // dead stop and accepts the stepping.

  // ---- determinism (see the README section of the same name) ----
  clock: true, // false = --no-clock, record at wall-clock time
  css: 'waapi', // 'waapi' or 'off'
  restartAnimations: false, // true starts every CSS animation from 0 on frame 0
  shadowAnimations: false, // true also walks shadow roots, every frame

  // ---- hooks ----
  hookTimeout: 15, // seconds before a stuck hook is given up on
  strictHooks: false, // true aborts on a failing action instead of warning

  // ---- debugging ----
  // dryRun: true,                  // print the schedule, record nothing
  // dumpFrames: 'output/frames',   // also write every PNG plus a frames.json

  // `pause` is settable here too, but NOT alongside `timeline`: the two are
  // different ways of saying the same thing and combining them is rejected.
  //   pause: ['40%:2', '#pricing:1.5'],

  /*
   * HOOKS
   * -----
   * Called as fn(page, ctx). `page` is a Playwright Page. `ctx` carries:
   *
   *   ctx.page             the same Page
   *   ctx.viewport         { width, height }
   *   ctx.maxScroll        scrollable extent in px (0 during `before`)
   *   ctx.frame            undefined in before/after; in an action:
   *                        { index, total, tMs, y, progress }
   *   ctx.clock.paused()   is page time frozen right now
   *   ctx.clock.nowMs()    page time for this frame, or null if not frozen
   *   ctx.sleep(ms)        advance PAGE time. Use this, never
   *                        page.waitForTimeout, once capture has started
   *   ctx.log(msg)         print a line under the current step's label
   */
  before: async (page) => {
    // Runs after load, before the settle wait, the warm-up and measurement.
    // Anything that changes layout belongs here, so the measurement sees it.
    const consent = page.locator('#accept-cookies');
    if (await consent.count()) await consent.first().click();
  },

  after: async (page, ctx) => {
    // Runs after the final frame, before the video is closed out.
    ctx.log('finished');
  },

  /*
   * TIMELINE
   * --------
   * Steps run in order. A step is either a scroll or a hold, never both.
   * The eight keys: scrollTo, hold, at, duration, ease, action, actionAt, label.
   *
   * Targets (scrollTo, at) accept:
   *   40%              percent of the scrollable extent
   *   1200px  |  1200  absolute pixels
   *   top | bottom     0% | 100%
   *   #pricing         a CSS selector, scrolled to the top of the viewport
   *   #hero@center     centred in the viewport instead
   *   #hero@+120       120px further down (modifiers live behind @, so a
   *                    selector like #hero-40 is never misread as an offset)
   */
  timeline: [
    {
      scrollTo: '#features', // required on a scroll step
      duration: 2, // optional. Omit it and this step shares the
      //                              // top-level `duration` budget with the
      //                              // other open-ended steps, in proportion
      //                              // to how far each one travels.
      //                              // If given, it must be greater than 0.
      ease: 'power2.out', // optional, and only on a scroll step (a
      //                              // hold does not move, so `ease` on one is
      //                              // an error). Overrides the top-level
      //                              // `ease` for this step, and makes the step
      //                              // its own easing run: adjacent scroll
      //                              // steps that both INHERIT the top-level
      //                              // curve are eased together as one
      //                              // continuous movement instead.
      label: 'into the features', // optional, shows in --dry-run and log lines
    },
    {
      hold: 1.5, // required on a hold step, and it IS the length.
      //                              // Passing `duration` as well is an error.
      at: '50%', // optional, and shown here only to document it.
      //                              // Omit it to hold where the previous step
      //                              // ended, which is what you want almost
      //                              // always: naming a different spot makes
      //                              // the scroll teleport rather than ease.
      action: async (page, ctx) => {
        // Fires on this step's FIRST frame by default.
        ctx.log(`holding at ${Math.round(ctx.frame.y)}px`);
      },
      actionAt: 'start', // 'start' (default) or 'end'. Nothing else.
      label: 'pause at the halfway mark',
    },
    {
      scrollTo: '100%',
      duration: 4,
      action: async (page, ctx) => ctx.log('reached the bottom'),
      actionAt: 'end', // fires on this step's LAST frame instead
    },
  ],
};
