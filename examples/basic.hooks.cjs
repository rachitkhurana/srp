/*
 * The smallest --script file: a `before` and an `after`.
 *
 *   srp https://my-site.com 20 --script examples/basic.hooks.cjs
 *
 * Use --script when you only need to prepare the page and tidy up afterwards,
 * and the scroll itself is a plain top-to-bottom run (optionally with --pause).
 * If you need to do something *during* the scroll, you need a timeline, so
 * reach for --plan instead. See basic.plan.cjs.
 *
 * Hooks are called as fn(page, ctx). `page` is a real Playwright Page, so
 * anything Playwright can do, a hook can do.
 */
module.exports = {
  /*
   * `before` runs after the page loads but BEFORE the settle wait, the warm-up
   * pass and measurement. That ordering is the point: dismissing a banner here
   * reflows the page before srp measures its height and resolves any selector
   * targets, so everything downstream sees the real layout.
   */
  before: async (page) => {
    // Defensive so this is safe to run against a page that has no banner.
    const consent = page.locator('#accept-cookies');
    if (await consent.count()) await consent.first().click();
  },

  /*
   * `after` runs once the last frame is captured, before the video is closed
   * out. Handy for leaving the page in a particular state, or for asserting
   * that the recording did what you meant.
   */
  after: async (page, ctx) => {
    const cta = page.locator('.cta').first();
    if (await cta.count()) await cta.hover();
    ctx.log('done');
  },
};
