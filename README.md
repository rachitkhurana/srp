# srp

*screen record playwright* — record a **perfectly smooth, dead-linear scroll** of any webpage to an
MP4 or WebM video.

Built for capturing marketing pages, portfolios, and scroll-driven animations cleanly — no jitter,
no dropped frames, exact duration every time.

---

## Why it's smooth

It does **not** screen-record in real time (which drops/duplicates frames whenever the page hitches).
Instead it captures **deterministically**:

1. It computes the exact scroll position for every output frame (`600 frames = 10s × 60fps`).
2. It sets that scroll position, waits for the browser to paint, and screenshots it.
3. It pipes the frames straight into **ffmpeg** at a hard-locked 60fps.

Because the scroll offset is a pure linear function of the frame index, the motion has **zero easing
and zero jitter by construction**. Capture is decoupled from wall-clock time, so a slow machine just
takes longer to render — the output is always a flawless, exact-length clip.

---

## Requirements

- **Node 18+** (uses the built-in `util.parseArgs`)
- That's it. **ffmpeg ships bundled** via `ffmpeg-static` — no system install needed.

---

## Install

```bash
cd srp
npm install          # installs playwright + ffmpeg-static, and downloads Chromium
```

> `npm install` runs `playwright install chromium` automatically. If it's ever missing, run
> `npx playwright install chromium` yourself.

---

## Usage

```bash
node record-scroll.js [url] [duration] [options]
# or with flags:
node record-scroll.js --url <url> --duration <seconds> [options]
```

The video is written to your **current working directory** (where you run the command).

### Options

| Option | Default | Description |
|---|---|---|
| `url` *(positional)* / `--url` | `http://localhost:3000` | Page to record. A bare host like `localhost:5173` is auto-prefixed with `http://`. |
| `duration` *(positional)* / `-d, --duration` | `10` | Seconds. This is **both** the top→bottom scroll time **and** the final video length. |
| `-o, --out` | `scroll.mp4` | Output file. `.mp4` → H.264, `.webm` → VP9. |
| `--fps` | `60` | Output frame rate (locked). |
| `--width` | `1920` | Viewport width (rounded to an even number). |
| `--height` | `1080` | Viewport height (rounded to an even number). |
| `--wait` | `3` | Seconds to settle after load, before capture. |
| `--no-warmup` | *(off)* | Skip the pre-scroll that loads lazy content. Faster, but can clip footers on heavy pages. |
| `--headed` | *(off)* | Show the browser window instead of running headless. |
| `-h, --help` | | Print the option list. |

Any argument you omit falls back to its default.

### Examples

```bash
# Local dev server, 15-second scroll
node record-scroll.js http://localhost:3000 15

# A live site to WebM, 8 seconds
node record-scroll.js --url https://rachitkay.com --duration 8 --out hero.webm

# Bare host + watch it happen live
node record-scroll.js localhost:5173 12 --headed

# Simple static page — skip warm-up for a faster run
node record-scroll.js ./index.html 6 --no-warmup
```

---

## How a run goes

```
▶ Recording https://your-site.com
  1920x1080 · 60fps · 10s scroll · 600 frames
  waiting 3s for the page to settle…
  warming up (loading lazy content so the footer is not clipped)…
  scroll extent: 12000px (page grew ~600px during warm-up)
  capturing frames…
  frame 600/600
✔ Saved /path/to/scroll.mp4
```

Steps: **load → wait (`--wait`) → warm-up scroll (loads lazy content) → measure the stable page height
→ deterministic frame capture → ffmpeg encode.**

---

## Notes & troubleshooting

- **Footer / bottom gets clipped?** Heavy pages lazy-load content as you scroll into it, so the page
  grows taller mid-scroll. The **warm-up pass** (on by default) scrolls through once to trigger all of
  it *before* measuring, so the scroll reaches the true bottom. If a page is still growing after
  warm-up, the run prints a warning — bump `--wait`.
- **Capture isn't real-time.** A 10s clip takes a couple of minutes to render (it's 600 screenshots).
  This is expected and is *why* the motion is perfect — the output is always exactly `duration` long.
- **Scroll-driven animations** (GSAP ScrollTrigger, reveal-on-scroll, etc.) are captured correctly,
  because the script sets the real scroll position each frame.
- **Independent, time-based animations** (a looping spinner, an autoplaying hero video) are *not*
  frame-locked to the scroll — they render at whatever their clock says when each frame is grabbed.
  For fully deterministic time, Playwright's `page.clock` API can be added; ask if you need it.
- **Crisp output at exactly the viewport size.** `deviceScaleFactor` is `1`, so a `1920×1080` viewport
  yields a `1920×1080` video. For 2× (retina) capture, that's a small code change — the output would
  then be `3840×2160`.
- **MP4 vs WebM.** MP4/H.264 (`yuv420p`, `+faststart`) plays everywhere; WebM/VP9 is smaller and great
  for the web. Pick via the `--out` extension.

---

## Files

- `record-scroll.js` — the script (its header comment is a quick-reference version of this README).
- `package.json` — deps + the `npm run record` shortcut.
