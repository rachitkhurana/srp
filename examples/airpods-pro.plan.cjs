/*
 * apple.com/ae/airpods-pro. This is the recording in ../docs/demo.gif.
 *
 *   srp --plan examples/airpods-pro.plan.cjs --restart-animations
 *
 * --restart-animations is worth adding here: without it the hero video keeps
 * whatever phase it was at when capture began, so the six second hold catches
 * it mid-clip and wraps. With it, the clip starts at 0 and plays one clean pass.
 *
 * Hold 6s on the hero, run down to the "Get the highlights." gallery, hold
 * there while the carousel advances one card, then scroll to the end.
 *
 * Measured on the page: 28442px tall, so 27362px of scroll at a 1080 viewport.
 * The two open-ended scroll steps share the 40s budget in proportion to how far
 * each travels, which gives roughly 1.7s down to the gallery and 38s for the
 * rest, a steady ~685px/s throughout.
 */
module.exports = {
  url: 'https://www.apple.com/ae/airpods-pro/',
  width: 1920,
  height: 1080,
  duration: 40, // scroll-motion seconds; the two holds add 11s on top
  wait: 5, // it is a heavy page, give it a moment past load
  out: 'output/airpods-pro.mp4',

  timeline: [
    {
      hold: 6,
      label: 'hero',
    },
    {
      // #highlights-gallery sits at y=1380 and is 710 tall, so @center parks it
      // in the middle of the frame with the "Get the highlights." headline
      // still visible above it.
      scrollTo: '#highlights-gallery@center',
      label: 'down to the highlights',
    },
    {
      hold: 5,
      label: 'highlights carousel',
      action: async (page, ctx) => {
        const result = await page.evaluate(() => {
          const sec = document.querySelector('section.section-highlights');
          if (!sec) return 'no highlights section';

          // Stop the autoplay first. It advances on its own every ~6s, and the
          // warm-up pass has already left it on an arbitrary card, so without
          // this the hold could show two advances or none.
          const toggle = sec.querySelector('button.play-pause-button');
          if (toggle && /pause/i.test(toggle.getAttribute('aria-label') || '')) toggle.click();

          // Clicking the next dot hands the work to Apple's own transition,
          // which eases over about a second (0 -> 22 -> 94 -> ... -> 1280).
          // Setting scrollLeft directly would work too, but it would be a hard
          // cut with no slide.
          const dots = [...sec.querySelectorAll('a.dotnav-link')];
          if (!dots.length) return 'no dotnav found';
          const current = dots.findIndex((d) => d.classList.contains('current'));
          dots[(current + 1) % dots.length].click();
          return `advanced from card ${current + 1} of ${dots.length}`;
        });
        ctx.log(result);
      },
    },
    {
      scrollTo: '100%',
      label: 'to the end',
    },
  ],
};
