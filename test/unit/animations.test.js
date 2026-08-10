'use strict';

/*
 * scanAndSeek runs inside the page, but it is written self-contained so it can
 * be driven here with fake roots and no browser. getAnimations() semantics are
 * full of edge cases, and this is the cheapest place to pin them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanAndSeek } = require('../../src/animations');

const DOC_TL = { name: 'DocumentTimeline' };
const SCROLL_TL = { name: 'ScrollTimeline' };

const anim = (over = {}) => ({
  timeline: DOC_TL,
  currentTime: 0,
  playState: 'running',
  pause() {
    this.playState = 'paused';
  },
  ...over,
});

const root = (anims) => ({ getAnimations: () => anims });
const run = (anims, nowMs, births = new WeakMap(), opts = {}) =>
  scanAndSeek([root(anims)], nowMs, births, { documentTimeline: DOC_TL, firstScan: true, restart: false, ...opts });

test('GUARD: a scroll-driven animation is left alone', () => {
  const a = anim({ timeline: SCROLL_TL, currentTime: 5 });
  const r = run([a], 1000);
  assert.equal(a.currentTime, 5, 'freezing this would kill the scroll-linked effect');
  assert.equal(a.playState, 'running');
  assert.equal(r.skipped, 1);
  assert.equal(r.seeked, 0);
});

test('GUARD: a non-numeric currentTime (CSSUnitValue) is left alone', () => {
  const a = anim({ currentTime: { value: 0, unit: 'percent' } });
  const r = run([a], 1000);
  assert.deepEqual(a.currentTime, { value: 0, unit: 'percent' });
  assert.equal(r.skipped, 1);
});

test('first scan keeps the phase an animation is already in', () => {
  const a = anim({ currentTime: 250 });
  run([a], 1000);
  // birth = 1000 - 250 = 750, so it stays at 250 and advances from there.
  assert.equal(a.currentTime, 250);
  assert.equal(a.playState, 'paused');
});

test('first scan with restart pins everything to 0', () => {
  const a = anim({ currentTime: 250 });
  run([a], 1000, new WeakMap(), { restart: true });
  assert.equal(a.currentTime, 0);
});

test('an animation seen again advances by exactly the frame delta', () => {
  const births = new WeakMap();
  const a = anim({ currentTime: 0 });
  run([a], 1000, births, { firstScan: true });
  assert.equal(a.currentTime, 0);
  run([a], 1100, births, { firstScan: false });
  assert.equal(a.currentTime, 100);
  run([a], 1200, births, { firstScan: false });
  assert.equal(a.currentTime, 200);
});

test('an animation born mid-capture starts from 0, not from a stale currentTime', () => {
  const births = new WeakMap();
  const existing = anim({ currentTime: 0 });
  run([existing], 1000, births, { firstScan: true });

  // A click starts a transition; by the time we see it, it already reports a
  // few ms. On a later scan we know it was born this frame, so it starts at 0.
  const fresh = anim({ currentTime: 16.625, transitionProperty: 'transform' });
  run([existing, fresh], 1100, births, { firstScan: false });
  assert.equal(fresh.currentTime, 0);

  run([existing, fresh], 1200, births, { firstScan: false });
  assert.equal(fresh.currentTime, 100);
});

test('a negative currentTime from animation-delay is preserved', () => {
  const births = new WeakMap();
  const a = anim({ currentTime: -500 }); // delay: 500ms, not started yet
  run([a], 1000, births, { firstScan: true });
  assert.equal(a.currentTime, -500);
  run([a], 1400, births, { firstScan: false });
  assert.equal(a.currentTime, -100, 'still counting down towards its start');
  run([a], 1600, births, { firstScan: false });
  assert.equal(a.currentTime, 100, 'and then running');
});

test('a null currentTime counts as 0', () => {
  const a = anim({ currentTime: null });
  run([a], 1000);
  assert.equal(a.currentTime, 0);
});

test('an animation that refuses to pause is skipped, not fatal', () => {
  const bad = anim({
    pause() {
      throw new Error('nope');
    },
  });
  const good = anim({ currentTime: 0 });
  const r = run([bad, good], 1000);
  assert.equal(r.seeked, 1);
  assert.equal(r.skipped, 1);
  assert.equal(good.playState, 'paused', 'the good one is still handled');
});

test('a root whose getAnimations() throws is skipped, not fatal', () => {
  const good = anim({ currentTime: 0 });
  const r = scanAndSeek(
    [
      {
        getAnimations() {
          throw new Error('detached');
        },
      },
      root([good]),
    ],
    1000,
    new WeakMap(),
    { documentTimeline: DOC_TL, firstScan: true, restart: false }
  );
  assert.equal(r.seeked, 1);
});

test('several roots (shadow DOM) are all walked', () => {
  const a = anim({ currentTime: 0 });
  const b = anim({ currentTime: 0 });
  const r = scanAndSeek([root([a]), root([b])], 1000, new WeakMap(), {
    documentTimeline: DOC_TL,
    firstScan: true,
    restart: false,
  });
  assert.equal(r.seeked, 2);
});

test('the injected source carries no closure over srp internals', () => {
  const { INIT_SCRIPT } = require('../../src/animations');
  assert.ok(INIT_SCRIPT.includes('__srpSeek'));
  assert.ok(INIT_SCRIPT.includes('__srpRoots'));
  assert.ok(!/require\(|module\.exports/.test(INIT_SCRIPT), 'would throw once injected into a page');
});
