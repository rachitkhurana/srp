'use strict';

/*
 * Everything that touches Playwright. `require('playwright')` happens inside
 * launch(), not at module load, so `srp --help` still works before
 * `npm install` has run.
 */

const { UsageError, RecordError } = require('./errors');

async function launch(plan) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: plan.headless });
  const context = await browser.newContext({
    viewport: plan.viewport,
    deviceScaleFactor: 1, // 1:1 pixels so the video is exactly viewport-sized
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Load the page and get it into a stable, measurable state.
 * The `before` hook runs here, ahead of measurement, so that dismissing a
 * consent modal or expanding an accordion has already reflowed the page by the
 * time we snapshot element geometry.
 */
async function prepare(page, plan, log, runHook) {
  const clock = require('./clock');
  // Always: this stashes the real requestAnimationFrame (which install() would
  // otherwise replace) and the animation birth map. Cheap, and it keeps the
  // paint barrier identical in both modes.
  await clock.installEarly(page);
  // Before goto, because libraries capture Date.now/performance.now at
  // module-evaluation time — GSAP's ticker does exactly this.
  if (plan.clock.enabled) await clock.install(page);

  try {
    await page.goto(plan.url, { waitUntil: 'load' });
  } catch (err) {
    if (plan.clock.enabled) {
      throw new RecordError(
        `could not load ${plan.url}: ${err.message}\n` +
          `  The page's timers are being faked so it can be recorded deterministically.\n` +
          `  If the page depends on real time to finish loading, retry with --no-clock.`
      );
    }
    throw err;
  }

  // Kill any `scroll-behavior: smooth` that would fight per-frame positioning.
  await page.addStyleTag({ content: `*, html, body { scroll-behavior: auto !important; }` });

  if (plan.before && runHook) await runHook(plan.before, { label: 'before', phase: 'before' });

  if (plan.waitS > 0) {
    log(`  waiting ${plan.waitS}s for the page to settle…`);
    await page.waitForTimeout(plan.waitS * 1000);
  }

  const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);

  // Many sites lazy-load and grow taller as you scroll into them, so a height
  // measured now would stop the scroll short of the real footer. Step through
  // the page first, let it settle, then measure the stable height.
  if (plan.warmup) {
    log('  warming up (loading lazy content so the footer is not clipped)…');
    await page.evaluate(async (vh) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = Math.max(200, Math.floor(vh * 0.8));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await sleep(150);
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(400);
    }, plan.viewport.height);
    await page.waitForLoadState('networkidle').catch(() => {}); // let late loads finish
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300); // re-settle at the top before capture
  }

  return { heightBefore };
}

async function measure(page, viewport) {
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  return {
    pageHeight,
    viewportH: viewport.height,
    maxScroll: Math.max(0, pageHeight - viewport.height),
  };
}

/**
 * One batched round trip for every selector the plan mentions, taken with the
 * page scrolled to the top so `top` is a document-space offset.
 * Throws listing every missing selector, before ffmpeg is ever spawned.
 */
async function resolveSelectors(page, selectors) {
  if (!selectors.length) return {};
  const rects = await page.evaluate(
    (sels) =>
      Object.fromEntries(
        sels.map((s) => {
          let el = null;
          try {
            el = document.querySelector(s);
          } catch {
            return [s, 'invalid'];
          }
          if (!el) return [s, null];
          const r = el.getBoundingClientRect();
          return [s, { top: r.top + window.scrollY, height: r.height }];
        })
      ),
    selectors
  );

  const invalid = selectors.filter((s) => rects[s] === 'invalid');
  if (invalid.length) throw new UsageError(`not a valid CSS selector: ${invalid.map((s) => `"${s}"`).join(', ')}`);
  const missing = selectors.filter((s) => !rects[s]);
  if (missing.length) {
    throw new UsageError(
      `no element matches ${missing.map((s) => `"${s}"`).join(', ')}. ` +
        `check the selector, or dismiss whatever hides it in a --script before() hook`
    );
  }
  return rects;
}

/** Did the final frame actually reach the bottom? */
async function reachedBottom(page) {
  return page.evaluate(
    () => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2
  );
}

module.exports = { launch, prepare, measure, resolveSelectors, reachedBottom, RecordError };
