/*
 * record-scroll.js — record a perfectly smooth, dead-linear scroll of a webpage to video.
 * ---------------------------------------------------------------------------------------
 * HOW IT WORKS (why it's jitter-free):
 *   Real-time screen recorders drop/duplicate frames when the page hitches, so the motion
 *   is never truly smooth. This script does NOT record in real time. It computes the exact
 *   scroll position for every single output frame (600 frames = 10s @ 60fps), screenshots
 *   each one, and pipes the PNGs straight into ffmpeg at a locked 60fps. The scroll offset
 *   is a pure linear function of the frame index, so the motion has zero easing and zero
 *   jitter by construction. Capture is decoupled from wall-clock time, so a slow machine
 *   just takes longer to render — the resulting video is always a flawless 10.000s / 60fps.
 *
 * INSTALL (needs Node 18+):
 *   mkdir -p ~/srp && cd ~/srp                              # or just use this folder
 *   npm install playwright ffmpeg-static                    # ffmpeg ships bundled, no system install
 *   npx playwright install chromium                         # one-time browser download
 *
 * RUN (output lands in your CURRENT directory):
 *   node record-scroll.js <url> <duration-seconds>              # positional args
 *   node record-scroll.js --url http://localhost:3000 --duration 15
 *   node record-scroll.js --help                                # every option
 *
 *   All args are optional and fall back to the DEFAULTS below (url localhost:3000,
 *   10s, 1920x1080, 60fps, 3s settle → ./scroll.mp4). Use --out clip.webm for WebM.
 *   A pre-scroll "warm-up" pass loads lazy content first so tall/heavy pages aren't
 *   clipped at the footer; pass --no-warmup to skip it on simple static pages.
 */

'use strict';

const path = require('path');
const { parseArgs } = require('node:util');
const { spawn } = require('child_process');
// playwright + ffmpeg-static are require()'d inside main() so --help / bad args
// give a clean message even before `npm install`.

// ─── DEFAULTS (used when the matching CLI arg is omitted) ─────────────────────
const DEFAULTS = {
  url: 'http://localhost:3000', // page to record
  duration: 10,                 // seconds — top→bottom scroll AND final video length
  out: 'scroll.mp4',            // .mp4 (H.264) or .webm (VP9)
  fps: 60,                      // locked output frame rate
  width: 1920,
  height: 1080,
  wait: 3,                      // settle seconds after load, before capture
  headed: false,                // true = show the browser window
  warmup: true,                 // pre-scroll to load lazy content (avoids clipped footers)
};
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
record-scroll — perfectly smooth, dead-linear scroll recorder

Usage:
  node record-scroll.js [url] [duration] [options]
  node record-scroll.js --url <url> --duration <seconds> [options]

Positional (both optional):
  url                       page to record         (default: ${DEFAULTS.url})
  duration                  scroll + video seconds (default: ${DEFAULTS.duration})

Options:
      --url <url>
  -d, --duration <seconds>  top→bottom scroll time = video length
  -o, --out <file>          output; .mp4 (H.264) or .webm (VP9)  (default: ${DEFAULTS.out})
      --fps <n>             (default: ${DEFAULTS.fps})
      --width <px>          (default: ${DEFAULTS.width})
      --height <px>         (default: ${DEFAULTS.height})
      --wait <seconds>      settle time after page load           (default: ${DEFAULTS.wait})
      --no-warmup           skip the pre-scroll that loads lazy content (faster; may clip footers)
      --headed              show the browser window instead of running headless
  -h, --help

Examples:
  node record-scroll.js http://localhost:3000 15
  node record-scroll.js --url https://rachitkay.com --duration 8 --out hero.webm
  node record-scroll.js localhost:5173 12 --headed
`);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        url:      { type: 'string' },
        duration: { type: 'string', short: 'd' },
        out:      { type: 'string', short: 'o' },
        fps:      { type: 'string' },
        width:    { type: 'string' },
        height:   { type: 'string' },
        wait:        { type: 'string' },
        headed:      { type: 'boolean' },
        'no-warmup': { type: 'boolean' },
        help:        { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error('✖ ' + e.message + '\n');
    printHelp();
    process.exit(1);
  }
  const { values: v, positionals: p } = parsed;
  if (v.help) { printHelp(); process.exit(0); }

  // positive-number parser with a clear error
  const num = (val, def, name) => {
    if (val === undefined) return def;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`✖ --${name} must be a positive number (got "${val}")`);
      process.exit(1);
    }
    return n;
  };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2); // H.264/VP9 need even dimensions

  let url = v.url ?? p[0] ?? DEFAULTS.url;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url; // allow "localhost:3000"

  return {
    url,
    duration: num(v.duration ?? p[1], DEFAULTS.duration, 'duration'),
    out:      v.out ?? DEFAULTS.out,
    fps:      Math.round(num(v.fps, DEFAULTS.fps, 'fps')),
    width:    even(num(v.width, DEFAULTS.width, 'width')),
    height:   even(num(v.height, DEFAULTS.height, 'height')),
    wait:     v.wait !== undefined ? num(v.wait, DEFAULTS.wait, 'wait') : DEFAULTS.wait,
    headed:   v.headed ?? DEFAULTS.headed,
    warmup:   v['no-warmup'] ? false : DEFAULTS.warmup,
  };
}

const cfg = parseCli();
const TARGET_URL        = cfg.url;
const OUTPUT_FILE       = cfg.out;
const VIEWPORT          = { width: cfg.width, height: cfg.height };
const FPS               = cfg.fps;
const SCROLL_DURATION_S = cfg.duration;
const PRE_SCROLL_WAIT_S = cfg.wait;
const HEADLESS          = !cfg.headed;
const WARMUP            = cfg.warmup;

const TOTAL_FRAMES = Math.round(FPS * SCROLL_DURATION_S); // e.g. 60 * 10 = 600
const OUT_ABS = path.resolve(process.cwd(), OUTPUT_FILE);

(async () => {
  const { chromium } = require('playwright');
  const ffmpegPath = require('ffmpeg-static');

  console.log(`▶ Recording ${TARGET_URL}`);
  console.log(`  ${VIEWPORT.width}x${VIEWPORT.height} · ${FPS}fps · ${SCROLL_DURATION_S}s scroll · ${TOTAL_FRAMES} frames`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1, // 1:1 pixels so the video is exactly VIEWPORT-sized
  });
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'load' });

    // Force instant programmatic scrolling — kill any `scroll-behavior: smooth` that would
    // fight our per-frame positioning.
    await page.addStyleTag({ content: `*, html, body { scroll-behavior: auto !important; }` });

    // Requirement: wait exactly 3s after load so late assets / intro animations settle.
    console.log(`  waiting ${PRE_SCROLL_WAIT_S}s for the page to settle…`);
    await page.waitForTimeout(PRE_SCROLL_WAIT_S * 1000);

    // Many sites lazy-load content (and grow taller) as you scroll into it, so a height
    // measured right now would stop the scroll short of the real footer. Warm up first:
    // step through the whole page to trigger all lazy loading, let it settle, then measure
    // the now-stable height. (Skip with --no-warmup for simple static pages.)
    const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
    if (WARMUP) {
      console.log('  warming up (loading lazy content so the footer is not clipped)…');
      await page.evaluate(async (vh) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const step = Math.max(200, Math.floor(vh * 0.8));
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await sleep(150);
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(400);
      }, VIEWPORT.height);
      await page.waitForLoadState('networkidle').catch(() => {}); // let late loads finish
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300); // re-settle at the top before capture
    }

    // Measure the (now stable) scrollable extent.
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const maxScroll = Math.max(0, pageHeight - VIEWPORT.height);
    const grew = pageHeight - heightBefore;
    if (maxScroll === 0) {
      console.warn('  ⚠ page is not taller than the viewport — the scroll will be static.');
    } else {
      console.log(`  scroll extent: ${maxScroll}px` + (grew > 0 ? ` (page grew ${grew}px during warm-up)` : ''));
    }

    // Spin up ffmpeg reading a PNG stream on stdin, writing at a hard-locked FPS.
    const isWebm = OUTPUT_FILE.toLowerCase().endsWith('.webm');
    const codecArgs = isWebm
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p'];
    const ff = spawn(ffmpegPath, [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(FPS),   // input frame rate
      '-i', '-',                   // read PNGs from stdin
      ...codecArgs,
      '-r', String(FPS),           // output frame rate (locked 60fps)
      '-movflags', '+faststart',   // web-friendly MP4 (harmless for webm)
      OUT_ABS,
    ]);

    let ffLog = '';
    ff.stderr.on('data', (d) => { ffLog += d.toString(); });
    const ffDone = new Promise((resolve, reject) => {
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${ffLog.slice(-1200)}`)));
      ff.on('error', reject);
    });

    // Capture loop — one deterministic frame at a time.
    console.log('  capturing frames…');
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      // Linear map: frame 0 → top, last frame → bottom. No easing anywhere.
      const y = TOTAL_FRAMES > 1 ? (maxScroll * i) / (TOTAL_FRAMES - 1) : 0;

      // Set the scroll position, then wait for two animation frames so the browser has
      // actually painted (and scroll-driven effects like GSAP ScrollTrigger have updated)
      // before we screenshot.
      await page.evaluate((targetY) => new Promise((resolve) => {
        window.scrollTo(0, targetY);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }), y);

      const png = await page.screenshot({ type: 'png' }); // current viewport, lossless
      if (!ff.stdin.write(png)) {
        await new Promise((r) => ff.stdin.once('drain', r)); // respect backpressure
      }

      if ((i + 1) % FPS === 0 || i === TOTAL_FRAMES - 1) {
        process.stdout.write(`\r  frame ${i + 1}/${TOTAL_FRAMES}   `);
      }
    }
    process.stdout.write('\n');

    // Sanity: confirm the final frame actually reached the very bottom.
    const reachedBottom = await page.evaluate(() =>
      Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2);
    if (!reachedBottom) {
      console.warn('  ⚠ final frame did not reach the bottom — the page is still growing; try a longer --wait.');
    }

    ff.stdin.end();
    await ffDone;
    console.log(`✔ Saved ${OUT_ABS}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('\n✖ Failed:', err.message);
  process.exit(1);
});
