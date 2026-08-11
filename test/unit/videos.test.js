'use strict';

/*
 * scanAndSeekVideos runs inside the page, but is written self-contained so it
 * can be driven here with fake media objects and no browser. The guard about
 * which videos to adopt is the whole ballgame: adopting a scroll-scrubbed
 * video destroys the effect srp exists to record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanAndSeekVideos } = require('../../src/videos');

const video = (over = {}) => ({
  tagName: 'VIDEO',
  paused: false,
  readyState: 4,
  duration: 10,
  loop: false,
  currentTime: 0,
  seeking: false,
  pause() {
    this.paused = true;
  },
  ...over,
});

const root = (media, svgs = []) => ({
  querySelectorAll: (sel) => (sel === 'svg' ? svgs : media),
});

const run = (media, nowMs, births = new WeakMap(), managed = new WeakSet(), opts = {}) =>
  scanAndSeekVideos([root(media)], nowMs, births, managed, { restart: false, ...opts });

test('GUARD: a video already paused on first sight is never touched', () => {
  // This is the scroll-scrubbed case: Apple drives these from scroll position.
  const scrubbed = video({ paused: true, currentTime: 5.12 });
  const r = run([scrubbed], 1000);
  assert.equal(scrubbed.currentTime, 5.12, 'seeking this would break scroll scrubbing');
  assert.equal(r.adopted, 0);
  assert.equal(r.skipped, 1);
});

test('a playing video is adopted, paused, and keeps its phase', () => {
  const v = video({ currentTime: 2 });
  const r = run([v], 5000);
  assert.equal(v.paused, true, 'must be paused so the media pipeline stops advancing it');
  assert.equal(v.currentTime, 2, 'birth = now - currentTime, so it stays where it was');
  assert.equal(r.adopted, 1);
});

test('restart pins an adopted video to 0', () => {
  const v = video({ currentTime: 2 });
  run([v], 5000, new WeakMap(), new WeakSet(), { restart: true });
  assert.equal(v.currentTime, 0);
});

test('THE BUG: currentTime advances by exactly one frame per frame', () => {
  const births = new WeakMap();
  const managed = new WeakSet();
  const v = video({ currentTime: 0 });
  // 60fps: 0, 16.67, 33.33 ... ms of page time
  for (let i = 0; i < 5; i++) run([v], (i * 1000) / 60, births, managed);
  // Five frames at 60fps is 4/60s of elapsed time, not 5 seconds of wall clock.
  assert.ok(Math.abs(v.currentTime - 4 / 60) < 1e-9, `got ${v.currentTime}`);
});

test('a looping video wraps at its duration', () => {
  const births = new WeakMap();
  const managed = new WeakSet();
  const v = video({ loop: true, duration: 7.5, currentTime: 0 });
  run([v], 0, births, managed);
  run([v], 7000, births, managed);
  assert.ok(Math.abs(v.currentTime - 7) < 1e-9);
  run([v], 8000, births, managed);
  assert.ok(Math.abs(v.currentTime - 0.5) < 1e-9, `wrapped to ${v.currentTime}, expected 0.5`);
});

test('a non-looping video clamps at its duration instead of wrapping', () => {
  const births = new WeakMap();
  const managed = new WeakSet();
  const v = video({ loop: false, duration: 3, currentTime: 0 });
  run([v], 0, births, managed);
  run([v], 9000, births, managed);
  assert.equal(v.currentTime, 3);
});

test('videos that cannot be seeked are skipped, not adopted', () => {
  const noMetadata = video({ readyState: 0, duration: NaN });
  const liveStream = video({ duration: Infinity });
  const zeroLength = video({ duration: 0 });
  const r = run([noMetadata, liveStream, zeroLength], 1000);
  assert.equal(r.adopted, 0);
  assert.equal(r.skipped, 3);
  assert.equal(noMetadata.paused, false, 'left alone entirely');
});

test('a video that refuses to seek is counted, and its neighbours still work', () => {
  const bad = video();
  // defineProperty, not a spread: spreading an object with a getter copies the
  // value it returns, so the throwing accessor would never reach the fake.
  Object.defineProperty(bad, 'currentTime', {
    get: () => 0,
    set: () => {
      throw new Error('nope');
    },
  });
  const good = video({ currentTime: 0 });
  const births = new WeakMap();
  const managed = new WeakSet();

  // On the frame a video is adopted the target equals where it already is, so
  // nothing is written and nothing can throw. The seek only happens later.
  run([bad, good], 0, births, managed);
  const r = run([bad, good], 2000, births, managed);

  assert.equal(r.skipped, 1, 'the throwing one is counted as skipped');
  assert.equal(r.seeked, 1, 'the other one still gets through');
  assert.equal(good.currentTime, 2);
});

test('a root whose querySelectorAll throws is skipped, not fatal', () => {
  const good = video({ currentTime: 0 });
  const r = scanAndSeekVideos(
    [
      {
        querySelectorAll() {
          throw new Error('detached');
        },
      },
      root([good]),
    ],
    1000,
    new WeakMap(),
    new WeakSet(),
    { restart: false }
  );
  assert.equal(r.seeked, 1);
});

test('SVG SMIL is paused and seeked, because getAnimations() cannot see it', () => {
  const svg = {
    paused: false,
    _t: 0.5,
    getCurrentTime() {
      return this._t;
    },
    setCurrentTime(t) {
      this._t = t;
    },
    pauseAnimations() {
      this.paused = true;
    },
    querySelector: (sel) => (/animate/.test(sel) ? {} : null),
  };
  const births = new WeakMap();
  const managed = new WeakSet();
  scanAndSeekVideos([root([], [svg])], 1000, births, managed, { restart: false });
  assert.equal(svg.paused, true);
  assert.ok(Math.abs(svg._t - 0.5) < 1e-9, 'phase preserved on adoption');
  scanAndSeekVideos([root([], [svg])], 2000, births, managed, { restart: false });
  assert.ok(Math.abs(svg._t - 1.5) < 1e-9, 'advances with page time');
});

test('an SVG with no SMIL element is left alone', () => {
  const svg = {
    setCurrentTime() {
      throw new Error('should not be called');
    },
    pauseAnimations() {
      throw new Error('should not be called');
    },
    querySelector: () => null,
  };
  const r = scanAndSeekVideos([root([], [svg])], 1000, new WeakMap(), new WeakSet(), { restart: false });
  assert.equal(r.adopted, 0);
});

test('the injected source carries no closure over srp internals', () => {
  const { INIT_SCRIPT } = require('../../src/videos');
  assert.ok(INIT_SCRIPT.includes('__srpSeekVideos'));
  assert.ok(INIT_SCRIPT.includes('__srpMediaManaged'));
  assert.ok(!/require\(|module\.exports/.test(INIT_SCRIPT), 'would throw once injected into a page');
});
