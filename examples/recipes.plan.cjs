/*
 * The patterns worth copying, in one runnable timeline.
 *
 *   srp --plan examples/recipes.plan.cjs --url ./test/fixtures/page.html --dry-run
 *
 * Each step below is a recipe with the reasoning attached. Delete the ones you
 * do not need. The fixture selectors (#features, #tab-2, #pricing) come from
 * test/fixtures/page.html so this runs as-is.
 */
module.exports = {
  url: './test/fixtures/page.html',
  out: 'output/recipes.mp4',
  duration: 8,

  before: async (page) => {
    // RECIPE: prepare the page before anything is measured.
    // `before` runs ahead of the settle wait, the warm-up pass AND the
    // measurement, so this is the only place to do things that change layout.
    // A banner dismissed here means the page height and every selector target
    // are measured against the real layout.
    const consent = page.locator('#accept-cookies');
    if (await consent.count()) await consent.first().click();

    // RECIPE: wait for something specific rather than guessing at --wait.
    // Safe here because page time still runs normally during `before`.
    await page.waitForSelector('#hero', { state: 'visible' }).catch(() => {});
  },

  timeline: [
    {
      // RECIPE: replay a hero animation on the very first frame.
      //
      // A `before` hook is the wrong place for this: `before` runs before the
      // warm-up pass, which scrolls the whole page and back, and that would
      // undo the replay before a single frame was captured. An action on the
      // FIRST timeline step fires on global frame 0, after the warm-up, in
      // between that frame's scroll and its screenshot.
      hold: 1.5,
      label: 'replay the hero',
      action: async (page, ctx) => {
        // RECIPE: click without moving the page.
        //
        // page.click() scrolls the element into view first, which would shift
        // frame 0 off y=0. A DOM click cannot move the scroll position, and it
        // skips the actionability wait so it can never stall the frame.
        // Use page.click() freely on later frames where a nudge does not matter.
        const clicked = await page.evaluate(() => {
          const el = document.querySelector('#tab-2');
          if (!el) return false;
          el.click();
          return true;
        });
        if (!clicked) ctx.log('no #tab-2 on this page, skipping');
      },
    },

    { scrollTo: '#features', duration: 2 },

    {
      // RECIPE: let an animation finish without spending video frames on it.
      //
      // ctx.sleep advances PAGE time and no video time, so the animation jumps
      // forward between two adjacent frames. If you want to WATCH it play, do
      // not use sleep: give the step a longer `hold` instead, which spends real
      // frames on it.
      //
      // Never use page.waitForTimeout during capture. It is a Node-side timer,
      // so it burns wall-clock while the page sits frozen, which is the
      // opposite of what you meant. An in-page setTimeout is worse: with the
      // clock frozen it never fires at all and the hook hits --hook-timeout.
      hold: 1,
      label: 'skip the intro animation',
      action: async (page, ctx) => {
        await ctx.sleep(2000);
      },
    },

    {
      // RECIPE: land a section in the middle of the viewport, not at its top.
      // Modifiers live behind @: `@center`, `@+120`, `@center-40`.
      scrollTo: '#pricing@center',
      duration: 2,
      // RECIPE: fire at the END of a step rather than the start.
      // Useful for hovering a CTA exactly when the scroll lands on it.
      actionAt: 'end',
      action: async (page) => {
        const cta = page.locator('#pricing a, #pricing button').first();
        if (await cta.count()) await cta.hover();
      },
    },

    {
      // A hold with no `at` stays wherever the previous step ended, which is
      // what you want almost every time. Pass `at` only to jump somewhere else,
      // and be aware that it is a jump: the scroll teleports rather than eases.
      hold: 1,
      label: 'sit on pricing',
    },

    { scrollTo: 'bottom', duration: 2 },
  ],

  after: async (page, ctx) => {
    // RECIPE: prove the recording did what you meant. Throwing here aborts the
    // run and removes the partial video, so a broken capture never looks like
    // a good one.
    const ok = await page.evaluate(() => window.scrollY > 0);
    if (!ok) throw new Error('the page never scrolled');
    ctx.log('verified');
  },
};
