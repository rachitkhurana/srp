'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTarget, parsePause, selectorsOf, resolveTargetPx } = require('../../src/targets');
const { UsageError } = require('../../src/errors');

test('parseTarget: percent, pixels and keywords', () => {
  assert.deepEqual(parseTarget('40%'), { kind: 'percent', value: 40, align: 'top', offset: 0 });
  assert.deepEqual(parseTarget('0%'), { kind: 'percent', value: 0, align: 'top', offset: 0 });
  assert.deepEqual(parseTarget('100%'), { kind: 'percent', value: 100, align: 'top', offset: 0 });
  assert.deepEqual(parseTarget('1200px'), { kind: 'pixels', value: 1200, align: 'top', offset: 0 });
  assert.deepEqual(parseTarget('1200'), { kind: 'pixels', value: 1200, align: 'top', offset: 0 });
  assert.equal(parseTarget('top').value, 0);
  assert.equal(parseTarget('bottom').value, 100);
  assert.equal(parseTarget('BOTTOM').kind, 'percent');
});

test('parseTarget: selectors, including ones that look numeric-ish', () => {
  assert.deepEqual(parseTarget('#pricing'), { kind: 'selector', value: '#pricing', align: 'top', offset: 0 });
  assert.equal(parseTarget('.card:nth-child(2)').value, '.card:nth-child(2)');
  assert.equal(parseTarget('[data-x="a:b"]').value, '[data-x="a:b"]');
  // A trailing "-40" is part of the id, NOT an offset. Offsets live behind "@".
  assert.deepEqual(parseTarget('#hero-40'), { kind: 'selector', value: '#hero-40', align: 'top', offset: 0 });
});

test('parseTarget: @ modifiers', () => {
  assert.deepEqual(parseTarget('#hero@center'), { kind: 'selector', value: '#hero', align: 'center', offset: 0 });
  assert.deepEqual(parseTarget('#hero@+120'), { kind: 'selector', value: '#hero', align: 'top', offset: 120 });
  assert.deepEqual(parseTarget('#hero@-40'), { kind: 'selector', value: '#hero', align: 'top', offset: -40 });
  assert.deepEqual(parseTarget('#hero@center-40'), { kind: 'selector', value: '#hero', align: 'center', offset: -40 });
  // An "@" that is not a modifier stays part of the selector.
  assert.equal(parseTarget('[href="mailto:a@b.com"]').value, '[href="mailto:a@b.com"]');
});

test('parseTarget: rejects malformed input', () => {
  assert.throws(() => parseTarget(''), UsageError);
  assert.throws(() => parseTarget('   '), UsageError);
  assert.throws(() => parseTarget('101%'), UsageError);
  assert.throws(() => parseTarget('-10%'), UsageError);
  assert.throws(() => parseTarget('50%%'), UsageError);
  assert.throws(() => parseTarget('12abc'), UsageError);
});

test('parsePause: splits at the LAST colon with a numeric right-hand side', () => {
  assert.deepEqual(parsePause('40%:2'), { target: parseTarget('40%'), seconds: 2 });
  assert.deepEqual(parsePause('1200px:1.5'), { target: parseTarget('1200px'), seconds: 1.5 });
  assert.deepEqual(parsePause('#pricing:1'), { target: parseTarget('#pricing'), seconds: 1 });
  assert.deepEqual(parsePause('bottom:2'), { target: parseTarget('bottom'), seconds: 2 });

  // The cases the naive split-on-":" gets wrong:
  assert.deepEqual(parsePause('#a:nth-child(2):1.5'), { target: parseTarget('#a:nth-child(2)'), seconds: 1.5 });
  assert.deepEqual(parsePause('[data-x="a:b"]:2'), { target: parseTarget('[data-x="a:b"]'), seconds: 2 });
  assert.deepEqual(parsePause('#a:hover:1'), { target: parseTarget('#a:hover'), seconds: 1 });
  assert.deepEqual(parsePause('#hero@center:2'), { target: parseTarget('#hero@center'), seconds: 2 });
});

test('parsePause: rejects missing or non-positive seconds', () => {
  assert.throws(() => parsePause('#pricing'), /must end with ":<seconds>"/);
  assert.throws(() => parsePause('40%:abc'), /must end with ":<seconds>"/);
  assert.throws(() => parsePause('#a:hover'), /must end with ":<seconds>"/);
  assert.throws(() => parsePause('40%:0'), /must be greater than 0/);
});

test('selectorsOf: only selectors, deduped', () => {
  const ts = [parseTarget('40%'), parseTarget('#a'), parseTarget('#a@center'), parseTarget('#b')];
  assert.deepEqual(selectorsOf(ts), ['#a', '#b']);
});

const ctx = { maxScroll: 1000, viewportH: 500, rects: { '#a': { top: 600, height: 100 }, '#tall': { top: 200, height: 900 } } };

test('resolveTargetPx: percent and pixels clamp to the scrollable extent', () => {
  assert.equal(resolveTargetPx(parseTarget('0%'), ctx), 0);
  assert.equal(resolveTargetPx(parseTarget('40%'), ctx), 400);
  assert.equal(resolveTargetPx(parseTarget('100%'), ctx), 1000);
  assert.equal(resolveTargetPx(parseTarget('250px'), ctx), 250);
  assert.equal(resolveTargetPx(parseTarget('99999px'), ctx), 1000, 'clamps to maxScroll');
});

test('resolveTargetPx: selector alignment and offsets', () => {
  assert.equal(resolveTargetPx(parseTarget('#a'), ctx), 600, 'element top to viewport top');
  // centre: 600 - (500 - 100)/2 = 400
  assert.equal(resolveTargetPx(parseTarget('#a@center'), ctx), 400);
  assert.equal(resolveTargetPx(parseTarget('#a@+120'), ctx), 720);
  assert.equal(resolveTargetPx(parseTarget('#a@-40'), ctx), 560);
  // An element taller than the viewport must not centre to a negative offset.
  assert.equal(resolveTargetPx(parseTarget('#tall@center'), ctx), 400);
});

test('resolveTargetPx: unscrollable page pins everything at 0', () => {
  const flat = { maxScroll: 0, viewportH: 500, rects: { '#a': { top: 600, height: 100 } } };
  assert.equal(resolveTargetPx(parseTarget('50%'), flat), 0);
  assert.equal(resolveTargetPx(parseTarget('#a'), flat), 0);
});

test('resolveTargetPx: a selector with no measurement is a usage error', () => {
  assert.throws(() => resolveTargetPx(parseTarget('#nope'), ctx), UsageError);
});
