# srp

*screen record playwright*: record a **perfectly smooth, dead-linear scroll** of any webpage to an
MP4 or WebM video, pausing wherever you like and running your own Playwright code mid-capture.

Built for capturing marketing pages, portfolios and scroll-driven animations cleanly. No jitter, no
dropped frames, exact duration every time, and animation that plays at the same speed on every run
regardless of how fast the machine is.

---

## Why it's smooth

It does **not** screen-record in real time (which drops or duplicates frames whenever the page
hitches). Instead it captures **deterministically**:

1. It computes the exact scroll position for every output frame (`600 frames = 10s at 60fps`).
2. It sets that position, advances page time by exactly one frame, waits for the browser to paint,
   and screenshots.
3. It pipes the frames straight into **ffmpeg** at a hard-locked frame rate.

Because the scroll offset is a pure function of the frame index, the motion has **zero jitter by
construction**. And because page time is driven one frame at a time rather than read off the wall
clock, animations play at their real speed no matter how slow the machine is.

---

## Requirements

- **Node 20+**
- That's it. **ffmpeg ships bundled** via `ffmpeg-static`, so no system install is needed.

## Install

```bash
cd srp
npm install          # playwright + ffmpeg-static, and downloads Chromium
npm link             # optional: puts `srp` on your PATH
```

`npm install` runs `playwright install chromium` for you. If it ever goes missing, run
`npx playwright install chromium`.

---

## Usage

```bash
srp [url] [duration] [options]
srp --url <url> --duration <seconds> [options]

# without npm link:
node bin/srp.js [url] [duration] [options]
```

The video is written relative to your current working directory.

```bash
# Local dev server, 15-second scroll
srp http://localhost:3000 15

# A live site to WebM
srp --url https://rachitkay.com --duration 8 --out hero.webm

# A local file, watched live in a real browser window
srp ./index.html 6 --headed
```

---

## Pausing

Hold the scroll at a point so an animation can play out. Targets can be a percentage, a pixel
offset, a CSS selector, or `top` / `bottom`:

```bash
srp https://site.com 10 --pause 40%:2 --pause '#pricing:1.5' --pause bottom:1
```

By default **pauses extend the video**: `--duration` is the scroll-motion time, so the example above
is `10 + 2 + 1.5 + 1 = 14.5s`. Pass `--fixed-duration` to make `--duration` a hard total instead,
compressing the scroll to make room for the holds.

Scroll time is shared between the legs in proportion to distance travelled, so a pause at 90% gets a
long first leg and a short last one, not two equal halves.

Selector targets take modifiers behind an `@`, so a selector that happens to end in a number is
never misread:

| Target | Means |
|---|---|
| `40%` | 40% of the scrollable extent |
| `1200px` or `1200` | absolute pixels |
| `top` / `bottom` | 0% / 100% |
| `#pricing` | scroll that element to the top of the viewport |
| `#hero@center` | centre it in the viewport instead |
| `#hero@+120` | 120px further down |
| `#hero@center-40` | both |

Check what you are going to get without recording anything:

```bash
$ srp https://site.com 10 --pause 50%:2 --dry-run
  extent 1760px · 12s total (10s scroll + 2s held) · 60fps · 720 frames
   0  scroll  0 -> 880px       5s      frames 0..299 (300)
   1  hold    hold @ 880px     2s      frames 300..419 (120)
   2  scroll  880 -> 1760px    5s      frames 420..719 (300)
```

---

## Running your own code

`--script` takes a file exporting `before` and `after` hooks. They get Playwright's `page`, so they
can do anything Playwright can:

```js
// hooks.js
module.exports = {
  before: async (page) => page.click('#accept-cookies'),
  after:  async (page) => page.hover('.cta'),
};
```

```bash
srp https://site.com 10 --script ./hooks.js --pause 40%:2
```

`before` runs after load but **before** the settle wait, the warm-up pass and measurement, so
dismissing a modal or expanding an accordion reflows the page before any geometry is read.

For full control, `--plan` takes a file that describes the whole timeline. Steps run in order, and
any step can carry an `action` that fires on its first frame (or its last, with `actionAt: 'end'`):

```js
// plan.js
module.exports = {
  url: 'https://site.com',
  out: 'demo.mp4',

  before: async (page) => page.click('#accept-cookies'),

  timeline: [
    { scrollTo: '#hero',     duration: 2 },
    { hold: 1.5, action: async (page) => page.click('.tab-2') },
    { scrollTo: '#pricing',  duration: 3 },
    { hold: 1 },
    { scrollTo: '100%',      duration: 4 },
  ],

  after: async (page) => page.screenshot({ path: 'last.png' }),
};
```

```bash
srp --plan ./plan.js
```

Both `.cjs`/CommonJS and `.mjs`/ESM files work, with a default export or named exports. A plan file
can set any option (in kebab or camel case) except `help`, `version`, `plan` and `script`; a flag you
actually type on the command line still wins.

### Timeline steps

A step is either a scroll or a hold, never both. These are all the keys it takes:

| Key | On | Meaning |
|---|---|---|
| `scrollTo` | scroll | Where to scroll to. Required. Takes any target (`40%`, `#pricing`, `bottom`) |
| `hold` | hold | How long to hold, in seconds. This *is* the length, so do not also pass `duration` |
| `at` | hold | Where to hold. Omit it to hold wherever the previous step ended, which is usual |
| `duration` | scroll | Seconds. Omit it to share the top-level `duration` budget with the other open-ended steps, split in proportion to distance travelled |
| `action` | either | `async (page, ctx) => {}`, fired on one frame of this step |
| `actionAt` | either | `'start'` (default) or `'end'`: the step's first or last frame |
| `label` | either | Shown in `--dry-run` and in log lines |

### The hook context

Hooks are called `fn(page, ctx)`. `page` is a real Playwright `Page`. `ctx` carries:

| Field | |
|---|---|
| `ctx.page` | The same `Page` |
| `ctx.viewport` | `{ width, height }` |
| `ctx.maxScroll` | Scrollable extent in px (still `0` during `before`) |
| `ctx.frame` | `undefined` in `before`/`after`; in an action, `{ index, total, tMs, y, progress }` |
| `ctx.clock.paused()` | Whether page time is currently frozen |
| `ctx.clock.nowMs()` | Page time for this frame, or `null` if not frozen |
| `ctx.sleep(ms)` | Advance page time. See below |
| `ctx.log(msg)` | Print a line under the current step's label |

**Inside a hook, use `ctx.sleep(ms)`, not `page.waitForTimeout(ms)`.** During capture the page clock
is frozen, so `waitForTimeout` burns real seconds while the page sits still, and an in-page
`setTimeout` never fires at all. `ctx.sleep` advances page time instead, without spending video
frames on it: if you want to *watch* something play, give the step a longer `hold`.

A failing per-frame action warns and carries on, because losing a whole render to a decorative click
is worse than the click. `--strict-hooks` makes it abort instead. A failing `before`/`after` always
aborts, and the partial video is removed.

### Worked examples

Every file in [`examples/`](examples/) is loaded and validated by the test suite, so none of them can
drift out of sync with the validator. Copy one and cut it down.

| File | What it shows |
|---|---|
| [`basic.hooks.cjs`](examples/basic.hooks.cjs) | The smallest `--script` file |
| [`basic.hooks.mjs`](examples/basic.hooks.mjs) | The same thing as an ES module |
| [`basic.plan.cjs`](examples/basic.plan.cjs) | The smallest `--plan` file |
| [`reference.plan.cjs`](examples/reference.plan.cjs) | Every supported key, annotated |
| [`recipes.plan.cjs`](examples/recipes.plan.cjs) | The patterns worth copying, each with its reasoning |
| [`uh-ring.plan.cjs`](examples/uh-ring.plan.cjs) | A real one: replay a hero animation, hold, then scroll a 22000px page |

Your own files go in [`hooks/`](hooks/), which is git-ignored so scratch work never shows up in
`git status`.

---

## Deterministic time

Frame-by-frame capture takes roughly 30ms of real time per frame but each frame represents 1/fps of
video, so anything the page animates on its own runs at the wrong speed. A hold is the worst case:
the scroll stops, but the animation keeps crawling at whatever rate the machine happens to
screenshot. srp fixes this in two places, both on by default:

- **`page.clock`** drives everything JavaScript-timed: `requestAnimationFrame`, `setTimeout`,
  `setInterval`, `Date.now`, `performance.now`. GSAP and friends land here.
- **The Web Animations API** drives CSS keyframe animations and transitions, which live on the
  compositor's own timeline and are completely untouched by `page.clock`.

Scroll-driven CSS (`animation-timeline: scroll()`) is deliberately left alone, since it is already
frame-locked by the scroll position and freezing it would kill the exact effect you are recording.

By default an animation already running when capture starts keeps its phase. `--restart-animations`
starts everything from zero on frame 0, so two runs put every animation at exactly the same point on
every frame.

How exact is "the same"? Frame timing is exact: on any run, frame `i` is rendered at page time
`i * 1000/fps`, to the millisecond. Pixels are byte-identical for content that is a pure function of
scroll position. They are not *quite* byte-identical for an element Chromium has promoted to its own
compositor layer: whether it is still on that layer at screenshot time is settled at page load, and
the two paths rasterise edge antialiasing a shade differently. That shows up as a thin halo worth a
hundred-odd pixels, never as a difference in animation phase.

If a page misbehaves with faked timers (a consent SDK that polls, a video player that uses
`performance.now` for buffering), fall back with `--no-clock`. Everything else still works.

---

## Options

| Option | Default | Description |
|---|---|---|
| `url` *(positional)* / `--url` | `http://localhost:3000` | Page to record. A bare host like `localhost:5173` gets `http://`; a path like `./index.html` becomes a `file://` URL. |
| `duration` *(positional)* / `-d`, `--duration` | `10` | Scroll-motion seconds. Pauses add on top unless `--fixed-duration`. |
| `--fixed-duration` | *(off)* | Make `--duration` the hard total and compress the scroll to fit the pauses. |
| `--pause <target>:<sec>` | | Hold at a point. Repeatable. |
| `--plan <file>` | | A `.js` file exporting `{ timeline, before, after }`. |
| `--script <file>` | | A `.js` file exporting `{ before, after }`. |
| `--hook-timeout <sec>` | `15` | Give up on a hook that has not returned in this long. |
| `--strict-hooks` | *(off)* | Abort on a failing per-frame action instead of warning. |
| `-o`, `--out <file>` | `scroll.mp4` | Output file. `.mp4` gives H.264, `.webm` gives VP9. |
| `--fps <n>` | `60` | Output frame rate (locked). |
| `--width <px>` | `1920` | Viewport width (rounded to an even number). |
| `--height <px>` | `1080` | Viewport height (rounded to an even number). |
| `--wait <sec>` | `3` | Settle time after load, before capture. `0` is allowed. |
| `--no-warmup` | *(off)* | Skip the pre-scroll that loads lazy content. Faster, but can clip footers. |
| `--headed` | *(off)* | Show the browser window instead of running headless. |
| `--no-clock` | *(off)* | Record at wall-clock time instead of frame-locking page time. |
| `--css <waapi\|off>` | `waapi` | Frame-lock CSS keyframes and transitions too. |
| `--restart-animations` | *(off)* | Start every CSS animation from 0 on frame 0. |
| `--shadow-animations` | *(off)* | Also freeze animations inside shadow roots (walks the DOM every frame). |
| `--dry-run` | *(off)* | Measure the page and print the frame schedule without recording. |
| `--dump-frames <dir>` | | Also write every frame as a PNG plus a `frames.json`, for debugging. |
| `-h`, `--help` | | Print the option list. |
| `--version` | | Print the version. |

---

## How a run goes

```
▶ Recording https://your-site.com
  1920x1080 · 60fps
  waiting 3s for the page to settle…
  warming up (loading lazy content so the footer is not clipped)…
  scroll extent: 12000px (page grew 600px during warm-up)
  12s · 720 frames (2s held)
  capturing frames…
  frame 720/720
✔ Saved /path/to/scroll.mp4
```

Load, `before` hook, settle (`--wait`), warm-up scroll, measure the stable height, resolve every
selector, build the frame schedule, freeze the clock, capture, `after` hook, encode.

---

## Notes and troubleshooting

- **Footer getting clipped?** Heavy pages lazy-load as you scroll, so they grow taller mid-scroll.
  The warm-up pass (on by default) scrolls through once to trigger all of it *before* measuring. If
  a page is still growing afterwards the run says so; raise `--wait`.
- **Capture is not real-time.** A 10s clip is 600 screenshots and takes a few minutes. That is
  precisely why the motion is perfect, and the output is always exactly the length asked for.
- **Element positions are measured once,** after the `before` hook and warm-up. If a mid-capture
  action changes the layout, selector targets resolved later are stale. Put layout-changing work in
  `before`.
- **Don't navigate inside a per-frame action.** Each clock step registers an init script that a
  navigation would replay into the new document.
- **`setInterval` fires once per frame** under the frame-locked clock rather than at its nominal
  rate. That is correct for frame stepping, but worth knowing if a page counts intervals.
- **Output is exactly the viewport size.** `deviceScaleFactor` is `1`, so `1920x1080` in gives
  `1920x1080` out. Retina capture is not wired up yet.
- **Two runs can differ by a thin halo.** An element Chromium has promoted to its own compositor
  layer rasterises edge antialiasing slightly differently depending on whether it is still on that
  layer at screenshot time, which is settled at page load. It is worth about a hundred pixels and it
  is never a difference in animation phase, which stays exact to the millisecond.
- **MP4 vs WebM.** MP4/H.264 (`yuv420p`, `+faststart`) plays everywhere; WebM/VP9 is smaller. Pick
  with the `--out` extension.

---

## Development

```bash
npm test        # unit tests, no browser needed
npm run test:e2e   # records the fixture and checks the result
npm run test:all
```

Source layout, starting at `src/cli.js`:

| File | Responsibility |
|---|---|
| `src/options.js` | The one option-spec table. Defaults, parsing and help text are all derived from it. |
| `src/targets.js` | Parsing scroll targets and pauses, and resolving them to pixels. Pure. |
| `src/plan.js` | CLI flags plus a plan file, compiled into one normalised plan. Pure. |
| `src/schedule.js` | A plan plus page geometry, turned into an explicit list of frames. Pure. |
| `src/loader.js` | Loading a user's CJS or ESM plan/script file. |
| `src/clock.js` | The deterministic clock, the frame stepper, and the paint barrier. |
| `src/animations.js` | Freezing and seeking CSS animations through the Web Animations API. |
| `src/browser.js` | Everything that touches Playwright. |
| `src/encoder.js` | ffmpeg. |
| `src/recorder.js` | The frame loop. |

`record-scroll.js` is kept as a back-compat entry point.

[`AGENTS.md`](AGENTS.md) is the playbook for coding agents: how to drive srp, and the invariants to
respect before changing `src/`. Several of them fail silently or hang rather than erroring, so it is
worth reading before touching the capture path.
