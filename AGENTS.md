# AGENTS.md: how to drive srp

You are a coding agent helping someone turn a webpage into a video. srp does not screen-record. It
computes the exact scroll position for every output frame, advances page time by exactly one frame,
screenshots, and pipes the PNGs into a bundled ffmpeg at a locked frame rate. That is why the motion
is perfect, and it is also why every instinct you have about "recording" is slightly wrong here.

Part 1 is using srp. Part 2 is changing it. Read Part 2 before touching `src/`.

---

# Part 1: driving srp

## Golden rules

- **Capture is not real time, and a slow run has not hung.** A 30s clip at 60fps is 1800
  screenshots at roughly 30ms each. Budget minutes. Never kill a run because it is quiet, and never
  "fix" slowness by lowering the frame count without saying so.
- **Run `--dry-run` first** for anything past a plain scroll. It loads and measures the page, prints
  the frame schedule, and records nothing. It is seconds instead of minutes, and it catches a
  missing selector or a nonsense duration before you spend a render.
- **Inside a hook, use `ctx.sleep(ms)`, never `page.waitForTimeout(ms)`.** During capture page time
  is frozen and stepped one frame at a time. `waitForTimeout` is a Node-side timer, so it burns real
  seconds while the page sits still. An in-page `setTimeout` never fires at all and the hook dies on
  `--hook-timeout`.
- **Do not navigate inside a per-frame action.** Each clock step registers an init script, and a
  navigation replays the accumulated pile into the new document. Navigate in `before` if you must.
- **`before` runs before the warm-up pass**, which scrolls the whole page and back. Anything a
  scroll would undo (a replayed entrance animation, an opened menu) must go on the first timeline
  step's `action` instead, which fires on frame 0 after the warm-up.
- **The user's own plan files go in `hooks/`**, which is git-ignored. `examples/` is committed and is
  documentation. Do not write scratch files into `examples/`.
- **Recordings go to `output/`**, also git-ignored. Never commit a video.
- **Report what actually happened.** If a run warned, say so. The warnings matter: a dropped hold, a
  failed action, a page that never reached the bottom.

## The commands (your API)

```
srp [url] [duration] [options]          # after `npm link`
node bin/srp.js [url] [duration] […]    # without it

  --url <url>            bare host gets http://, a path becomes file://
  --duration <seconds>   scroll-motion seconds (-d). Pauses ADD to this
  --fixed-duration       make --duration the hard total instead
  --ease <curve|ramp>    easing mode, default linear. "ramp" for fixed fades
                         with a constant-speed middle, or a curve: GSAP names
                         sine.*, power1..power4.* (.in / .out / .inOut),
                         or cubic-bezier(x1,y1,x2,y2). Quote the parens
  --ease-in <sec|%>      ramp up over this long, then cruise. Implies ramp mode
  --ease-out <sec|%>     ramp back down over this long. 0 switches it off
  --ease-shape <shape>   ramp corner shape, gentlest to steepest: linear,
                         smooth (default), sine, smoother, smoothest, or a
                         cubic-bezier(x1,y1,x2,y2) to go steeper still
  --ease-floor <px>      least a ramp may move per frame, default 2. Below 1px
                         the scroll visibly steps. 0 starts from a dead stop
  --out <file>           .mp4 gives H.264, .webm gives VP9 (-o)
  --fps <n>              default 60
  --width <px>           default 1920, forced even
  --height <px>          default 1080, forced even
  --wait <seconds>       settle after load, default 3, 0 allowed
  --no-warmup            skip the pre-scroll that loads lazy content
  --headed               show the browser window

  --pause <target>:<sec> hold at a point, repeatable
  --plan <file>          a timeline plus before/after
  --script <file>        just before/after
  --hook-timeout <sec>   default 15
  --strict-hooks         abort on a failing action instead of warning

  --no-clock             record at wall-clock time (escape hatch)
  --css <waapi|off>      CSS animation freezing, default waapi
  --video <seek|off>     <video> and SVG SMIL freezing, default seek
  --restart-animations   every animation, video and SMIL clip starts at 0
  --shadow-animations    also walk shadow roots, every frame

  --dry-run              measure and print the schedule, record nothing
  --dump-frames <dir>    every frame as a PNG plus a frames.json
  --help  --version
```

Pause and scroll targets: `40%`, `1200px`, `1200`, `top`, `bottom`, `#pricing`, `#hero@center`,
`#hero@+120`. Modifiers live behind `@` so a selector like `#hero-40` is never misread as an offset.

Exit codes: `0` success, `1` bad arguments or a failed run. A failed run removes its partial video.

## Workflow 1: record a page

```bash
srp https://site.com 20 --out output/site.mp4
```

`--duration` is the scroll time. Pick it from the page height: `--dry-run` prints the extent, and
roughly 500 to 1000 px/s reads well. A 20000px page wants 20 to 40 seconds, not 10.

## Workflow 2: hold at a point

```bash
srp https://site.com 20 --pause 40%:2 --pause '#pricing:1.5' --dry-run
```

Holds extend the video by default, so that is a 23.5s clip. `--fixed-duration` makes 20s the hard
total and compresses the scroll instead. Scroll time is shared between the legs in proportion to
distance, so a pause at 90% correctly gets a long first leg.

A pause at `top` or `bottom` becomes a leading or trailing hold rather than splitting anything.

## Workflow 2b: make the scroll look hand-driven

**Reach for `--ease ramp` first.** It fades up to speed over a fixed 1.5s, holds one constant speed,
and fades back down over 1.5s, which is how a video fade works and what almost everyone means by
"make it natural".

```bash
srp https://site.com 40 --ease ramp --pause 40%:2
srp https://site.com 40 --ease-in 2 --ease-out 4        # naming a side implies ramp mode
```

The ramp length is in **seconds, not a fraction of the run**, so a 40s scroll and a 5s scroll get the
same 1.5s fade. The cruise speed comes out within a few percent of the plain average, which keeps
`--duration` as the only thing that sets the pace.

`--ease <curve>` is the other mode: one curve normalised across the whole run. Fine on a short clip,
wrong on a long page, where it means the scroll is accelerating or decelerating the entire time and
never holds a speed. The two modes cannot be combined and srp will refuse rather than pick one.

Either way, easing warps time rather than distance, so determinism is untouched and the last frame
still lands exactly on target. It applies to each stretch of continuous motion, and a hold ends a
stretch, so with `--pause` each leg fades down into its pause and up out of it for free. Two adjacent
scroll steps with no hold between them are eased **together** as one movement; give a step its own
`ease` to time it separately, which makes it its own run.

**To make the easing stronger, change the shape, not the length.** `--ease-shape smoother` or
`smoothest`, or a `cubic-bezier(...)` to go steeper than either. A longer ramp does not sharpen the
corners; it just spends more of the video winding up and down, and it makes the sub-pixel stepping
worse. This is a mistake worth not making on the user's behalf: if they ask for "more ease", ask
whether they mean stronger or longer before spending a render.

`--dry-run` prints each run with its real numbers: ramp lengths, cruise length, cruise speed in px/s,
and the floor it starts from. Read that before assuming. Three things it can tell you:

- **"ramps scaled to Xs, no cruise"** means that leg is shorter than its ramps and is peaking at
  twice its average. Give the step a longer `duration`.
- **A warning about frames that "do not move a whole pixel"** means the scroll will visibly step.
  The message names the fix that applies to that specific case; follow it rather than guessing.
- **No `· from Npx/frame`** on a run means the floor could not be applied, because the leg is slower
  than the floor to begin with. That leg will step, and the only fix is to give it less time.

## Workflow 3: do something mid-capture

`--pause` holds cannot carry an action. The moment you need a click, you need a timeline:

```js
// hooks/my-page.cjs
module.exports = {
  url: 'https://site.com',
  timeline: [
    { hold: 3, action: async (page) => page.evaluate(() => document.querySelector('.replay')?.click()) },
    { scrollTo: '100%', duration: 30 },
  ],
};
```

Two things to get right. An action on the **first** step fires on global frame 0, which is the only
way to act "just before recording starts". And prefer a DOM click over `page.click()` on frame 0:
Playwright scrolls an element into view before clicking, which would shift frame 0 off the top.

Copy `examples/recipes.plan.cjs`; every pattern in it is annotated with why.

## Workflow 4: debug a recording that looks wrong

1. `--dry-run` and read the segment table. Wrong frame counts or a `0px` extent are visible here.
2. `--dump-frames output/frames` and read `frames.json`. Every entry carries the frame index, the
   scroll `y`, the page time `tMs`, the text of any `[data-srp-probe]` element, and the state of
   every animation the page is running (name, timeline type, currentTime, playState). The file also
   carries the resolved `ease` and a `runs` array with each run's ramp lengths, cruise and speed.
3. Compare the PNGs. Frames identical when they should move usually means the scroll is stuck, but
   check `y` in `frames.json` first, because it can also mean the scroll moved less than a whole
   pixel and got snapped away. That is expected in `--ease <curve>` mode, which cannot hold a
   velocity floor: at 60fps over a 1760px page `power2.inOut` moves 0.004px between the first two
   frames. In ramp mode it should NOT happen, since the floor holds every step at 2px by default, so
   if it does, look for the warning explaining why the floor was disabled. Frames changing during a
   hold is usually correct (time advances, scroll does not).
4. Symptoms worth knowing:
   - **Footer clipped**: the page grew during capture. Raise `--wait`, or keep the warm-up on.
   - **Images popping in**: you passed `--no-warmup` on a lazy-loading page.
   - **An animation plays at the wrong speed**: something is driving it that none of the three
     mechanisms reaches. Check `frames.json` for its timeline type, and the `media` array for
     whether a video was adopted (`managed: true`) or left alone.
   - **A video plays at the wrong speed**: if `managed` is false it was already paused when srp
     first saw it, so srp assumed it was scroll-scrubbed. Note the error is not always *fast*: it
     is wall-clock instead of frame-clock, so a light page at a low fps runs it slow instead.
   - **Something animates that nothing reports**: probably an animated GIF, `<marquee>`, or a
     sub-frame `setInterval`. See the limitations in the README; these are not fixable here.
   - **The scroll stutters or steps**: it is moving less than a pixel per frame somewhere, and the
     offset snaps to whole pixels. srp warns with a count and the fix. Most often the run is simply
     too slow: shorten that step's `duration`. In ramp mode also check `--ease-floor` is not 0.
   - **A hold looks frozen solid**: expected if the page has nothing time-driven at that point.

## Workflow 5: a page that breaks under the faked clock

srp fakes `Date`, `performance`, `setTimeout`, `setInterval` and `requestAnimationFrame` for the
page's whole life. Consent SDKs that poll, video players that use `performance.now` for buffering,
and analytics with long timeouts can all misbehave. The symptoms are a page that never finishes
loading, or a hero video that renders black.

`--no-clock` reverts to wall-clock capture and everything else keeps working. You lose correct
animation speed during holds, which is the tradeoff. `--css off` disables only the CSS half.

---

# Part 2: changing srp

## Architecture

Entry is `src/cli.js`. Data flows: flags and an optional plan file compile to one normalised plan,
the plan plus measured page geometry compile to an explicit list of frames, and the recorder walks
that list. Both entry points land on the same plan object, so there is one execution engine.

| File | Responsibility |
|---|---|
| `src/options.js` | The one option-spec table. Defaults, parsing and help are derived from it |
| `src/targets.js` | Parsing scroll targets and pauses, resolving them to pixels. Pure |
| `src/plan.js` | Flags plus a plan file, compiled into one normalised plan. Pure |
| `src/easing.js` | Ease curves and ramp profiles, plus the cubic-bezier solver. Pure |
| `src/schedule.js` | A plan plus page geometry, turned into an explicit frame list. Pure |
| `src/loader.js` | Loading a user's CJS or ESM file |
| `src/clock.js` | The deterministic clock, the frame stepper, the paint barrier |
| `src/animations.js` | Freezing and seeking CSS animations through the Web Animations API |
| `src/hooks.js` | Running user code safely: the ctx object, timeouts, error policy |
| `src/browser.js` | Everything that touches Playwright |
| `src/encoder.js` | ffmpeg |
| `src/recorder.js` | The frame loop |

## Invariants, and why each exists

Break one of these and the failure is silent or a hang, not a test error. They were each established
by measurement against the installed Playwright, not from documentation.

- **`src/options.js` `OPTIONS` is the only place an option is described.** Defaults, the parseArgs
  config, the help text and the README table are all derived. Adding a flag anywhere else
  reintroduces the three-places drift the rewrite removed. Drift-tested.
- **`playwright` and `ffmpeg-static` are required lazily**, inside the functions that use them, so
  `--help` works before `npm install`. A test asserts `require.cache` stays clean after loading the
  CLI.
- **The paint barrier must use `window.__srpRaf`.** `clock.install()` mocks
  `requestAnimationFrame`, so the obvious `rAF(() => rAF(resolve))` barrier hangs **forever** once
  the clock is paused, and `page.evaluate` has no default timeout, so it hangs the whole process.
  `src/clock.js` stashes the native function in an init script registered before `install()`.
- **`pauseAt` is the only exact frame stepper.** `runFor` leaves rAF on a hard 16ms grid, up to a
  frame stale. `fastForward` truncates its argument. Do not "simplify" to either.
- **The clock installs before `goto` and pauses after the warm-up.** Before `goto` because libraries
  capture `Date.now` at module-evaluation time (GSAP's ticker does exactly this). After the warm-up
  because the warm-up needs in-page timers to keep firing. `install()` also leaves the clock
  running, so the pause target must be ahead of the current fake time or it throws.
- **The WAAPI pass must keep both guards.** Skip anything whose timeline is not `document.timeline`
  (a scroll-driven animation reports a `ScrollTimeline`, and freezing it kills the exact effect
  being recorded) and anything whose `currentTime` is not a number (it reports a `CSSUnitValue`, and
  assigning to it throws).
- **`videos.js` must only adopt media it has seen PLAYING.** A video that is already `paused` the
  first time we look is either deliberately stopped or scroll-scrubbed, and scroll-scrubbed is
  common: Apple's product pages pause their hero videos and drive `currentTime` from scroll.
  Membership lives in a `WeakSet` populated on seeing a video play. Never infer it from the current
  `paused` state, which adopts the scrubbed ones too and destroys the effect. Measured on
  apple.com/ae/airpods-pro: 7 videos correctly left alone, 2 adopted.
- **Waiting for a seek must use the native rAF and must be bounded.** With the clock frozen an
  in-page `setTimeout` never fires, and `page.evaluate` has no timeout, so an unbounded wait on a
  video seeking outside its buffered range hangs the process.
- **Three mechanisms, not two.** `page.clock` for JS time, WAAPI for CSS, pause-and-seek for
  `<video>` and SVG SMIL. SMIL is the sneaky one: Blink runs it off its own time container and
  `document.getAnimations()` does not report it, so it slips past both WAAPI guards by never being
  seen at all.
- **A ramp is resolved per run, a curve is not.** `--ease <curve>` is a pure normalised function and
  can be evaluated anywhere. A ramp is defined in absolute seconds, so it only becomes a curve once
  it knows the duration of the run it landed on: `schedule.js` calls `ease.curveFor(run.D)` once per
  run and caches it as `run.curve`. That is why `warpInRun` reads `run.curve.fn` and not
  `run.ease.fn`.
- **A ramp shape's `mean` must equal its own `G(1)`, and both must come from one source.** The cruise
  speed is `v = D / (T - (a+b)(1-F)(1-mean))` while position comes from `G`, so if the two disagree
  the scroll silently lands short of or past its target. The five named shapes are symmetric about
  their midpoints and so declare `mean: 0.5`, which is where the original hardcoded `/2` came from.
  A user-supplied `cubic-bezier` need not be symmetric (`.65,0,.25,.99` integrates to 0.528), so its
  `G` is a cumulative trapezoid table and its `mean` is read out of **that same table** as `G(1)`.
  Never estimate the mean separately: consistency is what makes the numeric integral land exactly.
  Drift-tested, so a new shape is checked automatically.
- **`scrollTo` snaps to whole CSS pixels, and `deviceScaleFactor` does not change that.** Measured,
  not assumed: 1, 2 and 3 all quantise identically, so rendering larger and downscaling is not a fix.
  Anything moving slower than 1px per frame renders as a hold and then a jump. This is why a ramp
  starts at `--ease-floor` px/frame rather than at zero, and why `--ease <curve>` mode judders at its
  ends and cannot be fixed (a curve has no ramp region to hold a floor in). Do not "simplify" the
  floor away because the schedule's `y` looks perfectly smooth: it is a float, and the browser is not.
- **Easing warps time, not position, and `linear` must bypass it entirely.** A frame's position is
  looked up by feeding warped time into the unchanged piecewise-linear position function. Easing each
  segment's own progress instead would decelerate to a dead stop at every waypoint between two
  adjacent scroll steps, which is the artifact the feature exists to remove. And `parseEase('linear')`
  returns the literal identity so `schedule.js` can skip the easing path, keeping the default output
  byte-identical: an algebraically-straight curve is not good enough, because the e2e pins the bytes.
- **Every curve snaps its endpoints to exactly 0 and 1.** `Math.cos(Math.PI / 2)` is 6.12e-17, so
  `sine.in(1)` computes to 0.9999999999999999 and the last frame would land short of the bottom of
  the page. The wrapper in `easing.js` is what stops that; do not remove it as redundant.
- **`schedule.js` and `targets.js` are pure and must stay pure.** They are the highest-value test
  surface: all the timing arithmetic is checkable without a browser, and `--dry-run` is just these
  two plus a printer.
- **The static fixture must keep re-recording byte-identically.** `test/fixtures/static.html` is a
  pure function of scroll position, and its output is pinned. That is the tripwire for any refactor
  of the capture path.

## Known non-determinism, already investigated

An element Chromium has promoted to its own compositor layer can rasterise a thin antialiasing halo
differently between runs, around 100 pixels on a 320x240 frame. Whether the element is still on that
layer at screenshot time is settled at page load. It is **not** an animation-phase bug: the
animation's `currentTime` is exactly right on every frame of every run.

This is why the e2e compares the animated fixture with a tolerance and keeps a strict byte
comparison for the static one. Do not "fix" it by tightening the tolerance, and do not conclude the
clock is broken when you see it.

## Verifying a change

```bash
npm test          # unit, no browser, seconds
npm run test:e2e  # records the fixture and checks the result
npm run test:all
```

The e2e skips itself with a clear message if Chromium is missing (`npx playwright install chromium`).

For anything touching the capture path, also record the static fixture twice and confirm the two
files are byte-identical. For anything touching the clock or animations, record
`test/fixtures/page.html` with `--dump-frames` and confirm `frames.json` shows the rAF probe and the
CSS animation both advancing by exactly `1000/fps` per frame.

For anything touching easing, the two checks that matter are both on `frames.json`: the last `y` must
equal the segment's `y1` **exactly** (the whole feature is worthless if easing loses the target), and
`Math.round(y)` must advance on every frame of a ramp (that is the judder fix, and it is invisible in
the float `y`, which always looks perfectly smooth).

Do not commit or push unless the user asks.
