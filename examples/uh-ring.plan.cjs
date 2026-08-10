/*
 * Ultrahuman ring page: warm up, hit the hero's replay button, hold 7s while it
 * plays, then scroll the whole page in 30s.
 *
 * Why the click lives here and not in a `before` hook: `before` runs BEFORE the
 * warm-up pass, and the warm-up scrolls the entire page and back, which would
 * undo the replay before a single frame is captured. As the first timeline
 * step's action it fires on global frame 0 instead, after the warm-up, between
 * that frame's scrollTo and its screenshot. That is genuinely "just before the
 * recording starts".
 */
module.exports = {
  url: 'https://ultrahuman.com/ring',
  width: 1920,
  height: 1080,
  out: 'output/uh-ring.mp4',
  // warm-up is left ON (the default) so lazy images are cached before capture

  timeline: [
    {
      hold: 7,
      label: 'replay hero',
      action: async (page, ctx) => {
        // A DOM click rather than page.click(): Playwright scrolls an element
        // into view before clicking, and frame 0 must stay pinned at y=0.
        // This also skips the actionability wait, so it cannot stall the frame.
        const clicked = await page.evaluate(() => {
          const el = document.querySelector('.replay-btn');
          if (!el) return false;
          el.click();
          return true;
        });
        if (!clicked) throw new Error('no .replay-btn found on the page');
        ctx.log('clicked .replay-btn');
      },
    },
    { scrollTo: '100%', duration: 30 },
  ],
};
