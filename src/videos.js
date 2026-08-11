'use strict';

/*
 * <video> playback and SVG SMIL, frame-locked.
 *
 * Neither page.clock nor the Web Animations API reaches these. A <video> is
 * driven by the media pipeline and SMIL by Blink's own SMILTimeContainer, so
 * both advance on wall-clock time. Because producing one frame costs far more
 * real time than the 1/fps it represents, they run fast by exactly
 * (real ms per frame) / (1000/fps): measured at roughly 6x on a 1080p capture,
 * where a 7.5s loop completed six times inside a six second hold.
 *
 * THE GUARD THAT MATTERS
 * ----------------------
 * Only manage a video we have seen PLAYING. A video that is already paused the
 * first time we look is either deliberately stopped or scroll-scrubbed, and
 * scroll-scrubbed is common: Apple's product pages pause their hero videos and
 * drive currentTime from scroll position. Seeking those would destroy the
 * effect srp exists to capture, exactly as freezing a ScrollTimeline animation
 * would in animations.js.
 *
 * So membership comes from a WeakSet populated only on seeing a video play. It
 * must never be inferred from the current paused state: filtering on
 * `v.paused` adopts the scroll-scrubbed ones too.
 */

/**
 * The in-page pass. Self-contained (no closures, no imports) because it is
 * stringified into an init script. Exported so tests can drive it with fake
 * objects and no browser.
 *
 * @param roots    things with .querySelectorAll (document, plus shadow roots)
 * @param nowMs    the frame time to seek to
 * @param births   WeakMap of media -> the frame time it was adopted
 * @param managed  WeakSet of media we paused and are now driving
 * @param opts     { restart, viewportH }
 */
function scanAndSeekVideos(roots, nowMs, births, managed, opts) {
  var seeked = 0;
  var skipped = 0;
  var adopted = 0;

  for (var r = 0; r < roots.length; r++) {
    var list;
    try {
      list = roots[r].querySelectorAll('video, audio');
    } catch (e) {
      continue;
    }

    for (var i = 0; i < list.length; i++) {
      var v = list[i];

      if (!managed.has(v)) {
        // Adopt only what is actually playing. Everything else is somebody
        // else's business, and that includes every scroll-scrubbed video.
        if (v.paused) {
          skipped++;
          continue;
        }
        // No metadata yet means duration is NaN and a seek would throw. A
        // non-finite duration is a live stream, which cannot be seeked.
        if (!(v.readyState >= 1) || !isFinite(v.duration) || !(v.duration > 0)) {
          skipped++;
          continue;
        }
        var at = typeof v.currentTime === 'number' ? v.currentTime : 0;
        births.set(v, opts.restart ? nowMs : nowMs - at * 1000);
        managed.add(v);
        adopted++;
        try {
          v.pause();
        } catch (e) {
          /* keep going; the seek below is what actually matters */
        }
      }

      var birth = births.get(v);
      var t = (nowMs - birth) / 1000;
      var target = v.loop ? ((t % v.duration) + v.duration) % v.duration : Math.min(Math.max(t, 0), v.duration);

      try {
        // A seek costs a decode, so skip one we do not need.
        if (Math.abs(v.currentTime - target) > 0.001) v.currentTime = target;
        seeked++;
      } catch (e) {
        skipped++;
      }
    }

    // SVG SMIL (<animate>, <animateTransform>, <animateMotion>). Blink runs
    // these off its own time container, and document.getAnimations() does not
    // report them, so they slip past both of animations.js's guards by never
    // being seen at all.
    var svgs;
    try {
      svgs = roots[r].querySelectorAll('svg');
    } catch (e) {
      continue;
    }
    for (var s = 0; s < svgs.length; s++) {
      var svg = svgs[s];
      if (typeof svg.setCurrentTime !== 'function') continue;
      if (!svg.querySelector('animate, animateTransform, animateMotion, set')) continue;
      try {
        if (!managed.has(svg)) {
          var cur = typeof svg.getCurrentTime === 'function' ? svg.getCurrentTime() : 0;
          births.set(svg, opts.restart ? nowMs : nowMs - cur * 1000);
          managed.add(svg);
          adopted++;
          svg.pauseAnimations();
        }
        svg.setCurrentTime((nowMs - births.get(svg)) / 1000);
        seeked++;
      } catch (e) {
        skipped++;
      }
    }
  }

  return { seeked: seeked, skipped: skipped, adopted: adopted };
}

/**
 * Wait for outstanding seeks to land, using the stashed NATIVE rAF. An in-page
 * setTimeout never fires once the clock is paused, and page.evaluate has no
 * default timeout, so this has to be bounded or a video seeking past its
 * buffered range would hang the whole process.
 */
function waitForSeeks(roots, maxTicks) {
  var pending = [];
  for (var r = 0; r < roots.length; r++) {
    var list;
    try {
      list = roots[r].querySelectorAll('video, audio');
    } catch (e) {
      continue;
    }
    for (var i = 0; i < list.length; i++) if (list[i].seeking) pending.push(list[i]);
  }
  if (!pending.length) return Promise.resolve(0);

  var raf =
    window.__srpRaf ||
    (globalThis.__pwClock && globalThis.__pwClock.builtins && globalThis.__pwClock.builtins.requestAnimationFrame) ||
    window.requestAnimationFrame;
  var call = raf.bind(window);

  return new Promise(function (resolve) {
    var ticks = 0;
    (function step() {
      if (ticks >= maxTicks) return resolve(ticks);
      var stillSeeking = false;
      for (var i = 0; i < pending.length; i++) if (pending[i].seeking) stillSeeking = true;
      if (!stillSeeking) return resolve(ticks);
      ticks++;
      call(step);
    })();
  });
}

const INIT_SCRIPT = `(() => {
  if (window.__srpSeekVideos) return;
  Object.defineProperty(window, '__srpSeekVideos', { value: ${scanAndSeekVideos.toString()}, enumerable: false });
  Object.defineProperty(window, '__srpWaitSeeks', { value: ${waitForSeeks.toString()},      enumerable: false });
  Object.defineProperty(window, '__srpMediaBirth',   { value: new WeakMap(), enumerable: false });
  Object.defineProperty(window, '__srpMediaManaged', { value: new WeakSet(), enumerable: false });
})()`;

/** One pass, for one frame, in one frame of the page. */
async function seek(frame, tMs, opts) {
  return frame.evaluate(
    async (o) => {
      const roots = window.__srpRoots(o.shadow);
      const r = window.__srpSeekVideos(roots, o.t, window.__srpMediaBirth, window.__srpMediaManaged, {
        restart: o.restart,
      });
      r.waitedTicks = await window.__srpWaitSeeks(roots, o.maxTicks);
      return r;
    },
    { t: tMs, shadow: opts.shadow, restart: opts.restart, maxTicks: opts.maxTicks || 10 }
  );
}

module.exports = { scanAndSeekVideos, waitForSeeks, seek, INIT_SCRIPT };
