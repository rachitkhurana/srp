/*
 * The smallest --plan file: a timeline.
 *
 *   srp --plan examples/basic.plan.cjs --url https://my-site.com
 *
 * A timeline is a list of steps run in order. Each step is either a scroll
 * (`scrollTo`) or a hold (`hold`). This one eases into the page, stops for a
 * second and a half, then runs to the bottom: 2 + 1.5 + 4 = 7.5 seconds.
 *
 * Use --plan when the scroll is not a single top-to-bottom sweep, or when you
 * need to do something partway through. For a plain scroll with a couple of
 * stops you do not need a file at all: `--pause 40%:2` does that on the
 * command line.
 */
module.exports = {
  // Any option can be set here instead of on the command line. A flag you
  // actually type still wins, so `--out other.mp4` would override this.
  out: 'output/basic.mp4',

  timeline: [
    { scrollTo: '50%', duration: 2 },
    { hold: 1.5 },
    { scrollTo: '100%', duration: 4 },
  ],
};
