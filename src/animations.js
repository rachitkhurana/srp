'use strict';

/*
 * CSS animations and transitions, frame-locked.
 *
 * page.clock does not reach these: a CSS keyframe animation runs on the
 * compositor's own timeline, so with the clock frozen its currentTime still
 * crawls forward in real time. We drive them through the Web Animations API
 * instead — pause every animation and set its currentTime to the frame time.
 *
 * WAAPI over the CDP Animation domain, on the evidence:
 *   - it seeks exactly (a 4s 0->300px translate seeked to t=1000 renders
 *     matrix(1,0,0,1,75,0), the exact analytic value), where CDP's
 *     setPlaybackRate(0) corrupted currentTime to a large negative number;
 *   - getAnimations() reports CSS transitions too, with no bookkeeping;
 *   - it is the same mechanism playwright itself uses for
 *     screenshot({ animations: 'disabled' }).
 *
 * TWO GUARDS THAT ARE NOT OPTIONAL
 *   1. Skip anything whose timeline is not document.timeline. A scroll-driven
 *      animation (`animation-timeline: scroll()`) has a ScrollTimeline, and
 *      freezing it would kill exactly the scroll-linked effect srp exists to
 *      record.
 *   2. Skip anything whose currentTime is not a number. Scroll-driven
 *      animations report a CSSUnitValue like "0%", and assigning to it throws.
 */

/**
 * The in-page pass. Deliberately self-contained — no closures, no imports —
 * because it is stringified into an init script. Exported so the tests can
 * drive it with fake roots and no browser.
 *
 * @param roots     things with .getAnimations() (document, plus shadow roots)
 * @param nowMs     the frame time to seek to
 * @param births    a WeakMap of animation -> the frame time it first appeared
 * @param opts      { documentTimeline, firstScan, restart }
 */
function scanAndSeek(roots, nowMs, births, opts) {
  var seeked = 0;
  var skipped = 0;
  for (var r = 0; r < roots.length; r++) {
    var list;
    try {
      list = roots[r].getAnimations();
    } catch (e) {
      continue;
    }
    for (var i = 0; i < list.length; i++) {
      var a = list[i];

      // Guard 1: only the document timeline. Leave scroll-driven work alone.
      if (a.timeline !== opts.documentTimeline) {
        skipped++;
        continue;
      }
      // Guard 2: a numeric currentTime. null means "not started yet"; a
      // CSSUnitValue means this is not something we can seek.
      var ct = a.currentTime;
      if (ct !== null && typeof ct !== 'number') {
        skipped++;
        continue;
      }
      var current = ct === null ? 0 : ct;

      var birth;
      if (births.has(a)) {
        birth = births.get(a);
      } else {
        // First scan: keep whatever phase the animation is already in, unless
        // asked to restart. Later scans: we look every frame, so an animation
        // we have not seen was born this frame — which is more accurate than
        // now - currentTime, that being up to one real frame stale.
        birth = opts.firstScan ? (opts.restart ? nowMs : nowMs - current) : nowMs;
        births.set(a, birth);
      }

      try {
        a.pause();
        a.currentTime = nowMs - birth;
        seeked++;
      } catch (e) {
        skipped++;
      }
    }
  }
  return { seeked: seeked, skipped: skipped };
}

/** Collect document plus every shadow root, however deeply nested. */
function collectRoots(includeShadow) {
  var roots = [document];
  if (!includeShadow) return roots;
  var stack = [document];
  while (stack.length) {
    var root = stack.pop();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var node = walker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        stack.push(node.shadowRoot);
      }
      node = walker.nextNode();
    }
  }
  return roots;
}

/** Init-script source: installs both helpers before any page script runs. */
const INIT_SCRIPT = `(() => {
  if (window.__srpSeek) return;
  Object.defineProperty(window, '__srpSeek',  { value: ${scanAndSeek.toString()},  enumerable: false });
  Object.defineProperty(window, '__srpRoots', { value: ${collectRoots.toString()}, enumerable: false });
})()`;

/** One pass, for one frame. */
async function seek(page, tMs, opts) {
  return page.evaluate(
    (o) =>
      window.__srpSeek(window.__srpRoots(o.shadow), o.t, window.__srpBirth, {
        documentTimeline: document.timeline,
        firstScan: o.firstScan,
        restart: o.restart,
      }),
    { t: tMs, shadow: opts.shadow, firstScan: opts.firstScan, restart: opts.restart }
  );
}

module.exports = { scanAndSeek, collectRoots, seek, INIT_SCRIPT };
