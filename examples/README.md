# examples

Copy one of these, cut it down, and point srp at it. A unit test loads and
validates every file here, so none of them can drift out of sync with the
validator.

Your own files belong in [`../hooks/`](../hooks/), which is git-ignored.

## Which one do I want?

**Neither, probably.** A plain scroll with a couple of stops needs no file, and
neither does easing:

```bash
srp https://my-site.com 20 --pause 40%:2 --pause '#pricing:1.5'
srp https://my-site.com 20 --ease ramp
```

**`--script`** when you only need to prepare the page and tidy up afterwards.
It supplies `before` and `after`, nothing else.

```bash
srp https://my-site.com 20 --script examples/basic.hooks.cjs --pause 40%:2
```

**`--plan`** when the scroll is not one top-to-bottom sweep, or when you need
to do something *partway through* it. Only a timeline can attach an action to a
particular moment.

```bash
srp --plan examples/basic.plan.cjs --url https://my-site.com
```

## The files

| File | What it shows |
|---|---|
| `basic.hooks.cjs` | The smallest `--script` file: a `before` and an `after` |
| `basic.hooks.mjs` | The same thing as an ES module, since both formats load |
| `basic.plan.cjs` | The smallest `--plan` file: three steps and one hold |
| `reference.plan.cjs` | Every supported key, annotated with the rules the validator actually enforces |
| `recipes.plan.cjs` | The patterns worth copying, each with its reasoning |
| `airpods-pro.plan.cjs` | The recording in [`../docs/airpods-pro.gif`](../docs/airpods-pro.gif): hold on the hero, advance a carousel mid-capture, then scroll 27000px |
| `uh-ring.plan.cjs` | Click a replay button on frame 0, hold 6s while the hero video plays at true speed, then scroll 22000px |

Both of the real-page examples are worth reading for the same two reasons: the click has to be a
timeline **action** rather than a `before` hook (the warm-up scroll would undo it), and it has to be
a DOM `el.click()` rather than `page.click()` (which scrolls the element into view and would knock
frame 0 off the top of the page).

## Two things that catch people out

**`before` runs before the warm-up pass**, which scrolls the whole page and
back. Anything you do in `before` that a scroll would undo (replaying an
entrance animation, opening a menu) gets undone. Attach it to the first
timeline step's `action` instead, which fires on frame 0, after the warm-up.

**Inside an action, use `ctx.sleep(ms)`, never `page.waitForTimeout(ms)`.**
During capture page time is frozen and stepped one frame at a time.
`waitForTimeout` is a Node-side timer, so it burns real seconds while the page
sits still. An in-page `setTimeout` never fires at all.

Both are explained at the point of use in `recipes.plan.cjs`, and `airpods-pro.plan.cjs` is a real
page where both mattered.
