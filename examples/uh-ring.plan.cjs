/*
 * ultrahuman.com/ring: replay the hero on the very first frame, hold 6s while
 * it plays, then scroll the whole page in 30s.
 *
 *   srp --plan examples/uh-ring.plan.cjs
 *
 * Two things this example exists to show.
 *
 * WHY THE CLICK IS A TIMELINE ACTION, NOT A `before` HOOK
 * `before` runs BEFORE the warm-up pass, and the warm-up scrolls the entire
 * page and back, which would undo the replay before a single frame was
 * captured. As the first timeline step's action it fires on global frame 0
 * instead: after the warm-up, between that frame's scrollTo and its
 * screenshot. That is genuinely "just before the recording starts".
 *
 * WHY THE VIDEO COMES OUT AT THE RIGHT SPEED
 * Both of this page's videos (11.3s looping, 5s one-shot) sit paused at load,
 * so srp leaves them alone: a video that is already paused is assumed to be
 * scroll-scrubbed, and seeking it would wreck the effect. The replay click
 * starts them, srp adopts them on the next scan, and from then on they advance
 * exactly one frame per frame. Measured on this page: 0.99s of video across
 * 1.0s of output. Without that, capture is slower than real time and the 11.3s
 * clip would tear through several loops inside the six second hold.
 *
 * The page is 22996px tall, so 21916px of scroll at a 1080 viewport. 30s works
 * out at roughly 730px/s.
 */
module.exports = {
  url: 'https://ultrahuman.com/ring',
  width: 1920,
  height: 1080,
  duration: 30, // scroll-motion seconds; the hold adds 6s on top
  out: 'output/uh-ring.mp4',
  // warm-up is left ON (the default) so lazy images are cached before capture

  // The cookie banner belongs in `before`, not in a timeline action: this runs
  // ahead of measurement, so the page has already reflowed without it by the
  // time srp reads the scroll height and resolves any selectors. Matching on
  // the button's text because the class names are generated
  // (sc-36dbe881-7 QzAIU) and change between builds.
  before: async (page, ctx) => {
    const accept = page.getByRole('button', { name: /^accept$/i });
    if (await accept.count()) {
      await accept.first().click();
      ctx.log('dismissed the cookie banner');
    }
  },

  timeline: [
    {
      hold: 6,
      label: 'replay hero',
      action: async (page, ctx) => {
        // A DOM click rather than page.click(): Playwright scrolls an element
        // into view before clicking, and frame 0 must stay pinned at y=0. The
        // button sits at y=1021, only 59px above the fold of a 1080 viewport,
        // so that was a live risk. This also skips the actionability wait, so
        // it cannot stall the frame.
        const clicked = await page.evaluate(() => {
          const el = document.querySelector('.replay-btn');
          if (!el) return false;
          el.click();
          return true;
        });
        if (!clicked) throw new Error('no .replay-btn found on the page');
        ctx.log('clicked .replay-btn, hero replaying');
      },
    },
    { scrollTo: '100%', label: 'to the end' },
  ],
};
