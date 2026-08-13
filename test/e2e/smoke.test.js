'use strict';

/*
 * The one end-to-end test: record the fixture for real and check the output.
 *
 * The fixture is loaded over file:// so this needs no server. It deliberately
 * contains all four things that interact badly with frame-by-frame capture:
 * a CSS keyframe animation, a CSS transition, a requestAnimationFrame loop,
 * and a scroll-driven (ScrollTimeline) animation.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { probeVideo, pixelDiff } = require('../helpers/probe');

const BIN = path.join(__dirname, '..', '..', 'bin', 'srp.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'page.html');
const STATIC_FIXTURE = path.join(__dirname, '..', 'fixtures', 'static.html');

// 1s of scroll + a 0.5s hold, at 10fps.
const EXPECTED_FRAMES = 15;
const ARGS = [
  FIXTURE, '1',
  '--fps', '10', '--width', '320', '--height', '240',
  '--wait', '0', '--no-warmup',
  '--pause', '50%:0.5',
  '--restart-animations',
];

function chromiumMissing() {
  try {
    return !fs.existsSync(require('playwright').chromium.executablePath());
  } catch {
    return true;
  }
}

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

describe('end-to-end recording', { skip: chromiumMissing() && 'chromium is not installed (npx playwright install chromium)' }, () => {
  let tmp;
  let runs;
  let statics;
  let eased;
  let ramped;

  const record = (tag, args) => {
    const out = path.join(tmp, `${tag}.mp4`);
    const dir = path.join(tmp, tag);
    execFileSync(process.execPath, [BIN, ...args, '--out', out, '--dump-frames', dir], {
      encoding: 'utf8',
      timeout: 150000,
    });
    return { out, dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')) };
  };

  before(
    () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srp-e2e-'));
      runs = ['a', 'b'].map((tag) => record(tag, ARGS));
      // A fixture with no animation at all, where byte-identical output is a
      // guarantee rather than an aspiration.
      statics = ['sa', 'sb'].map((tag) =>
        record(tag, [STATIC_FIXTURE, '0.5', '--fps', '10', '--width', '320', '--height', '240', '--wait', '0', '--no-warmup'])
      );
      // The same static fixture on a curve. Still a pure function of scroll
      // position, so easing must not cost anything in determinism.
      eased = ['ea', 'eb'].map((tag) =>
        record(tag, [
          STATIC_FIXTURE, '2',
          '--fps', '10', '--width', '320', '--height', '240', '--wait', '0', '--no-warmup',
          '--ease', 'power2.inOut',
        ])
      );
      // And on a ramp: 0.5s up, 3s of constant speed, 0.5s down.
      ramped = record('ra', [
        STATIC_FIXTURE, '4',
        '--fps', '10', '--width', '320', '--height', '240', '--wait', '0', '--no-warmup',
        '--ease-in', '0.5', '--ease-out', '0.5',
      ]);
    },
    { timeout: 300000 }
  );

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('produces a video with exactly the frames the schedule promised', () => {
    const p = probeVideo(runs[0].out);
    assert.equal(p.exitCode, 0, p.raw.slice(-500));
    assert.equal(p.frames, EXPECTED_FRAMES, 'an exact frame count is the strongest determinism check there is');
    assert.equal(p.width, 320);
    assert.equal(p.height, 240);
    assert.equal(p.fps, 10);
    assert.equal(p.codec, 'h264');
    assert.ok(Math.abs(p.durationS - 1.5) < 0.05, `duration was ${p.durationS}, expected 1.5`);
  });

  it('a page with no animation records byte-identically twice over', () => {
    // The hard determinism guarantee, on content that is a pure function of
    // scroll position: no compositor layers in play, so the bytes must match.
    const [a, b] = statics.map((r) => r.meta.frames.map((f) => md5(path.join(r.dir, f.file))));
    assert.equal(a.length, 5);
    assert.deepEqual(a, b, 'a static page must record identically every time');
    assert.equal(md5(statics[0].out), md5(statics[1].out), 'and encode identically too');
  });

  it('easing keeps the determinism guarantee, to the byte', () => {
    const [a, b] = eased.map((r) => r.meta.frames.map((f) => md5(path.join(r.dir, f.file))));
    assert.equal(a.length, 20);
    assert.deepEqual(a, b, 'an eased recording must reproduce exactly, same as a linear one');
    assert.equal(md5(eased[0].out), md5(eased[1].out), 'and encode identically too');
  });

  it('an eased scroll really accelerates and decelerates, through the browser', () => {
    const meta = eased[0].meta;
    assert.equal(meta.ease, 'power2.inOut');
    assert.deepEqual(meta.runs.map((r) => r.ease), ['power2.inOut']);

    const ys = meta.frames.map((f) => f.y);
    assert.equal(ys[0], 0, 'starts at the top');
    assert.equal(ys[ys.length - 1], meta.segments[0].y1, 'and lands exactly on the target, not near it');

    const dy = ys.slice(1).map((y, i) => y - ys[i]);
    const mean = dy.reduce((a, b) => a + b, 0) / dy.length;
    assert.ok(dy.every((v) => v >= 0), 'never scrolls backwards');
    assert.ok(Math.max(...dy) / mean > 2.5, `a cubic inOut peaks near 3x the mean rate, got ${Math.max(...dy) / mean}`);
    assert.ok(dy[0] < mean / 10, `starts from rest, first step was ${dy[0]}px against a mean of ${mean}px`);

    // Deliberately NOT asserted here: that the head frames are pixel-identical.
    // They are at any real setting (60fps over 1760px puts the first step at
    // 0.004px) but this run is 20 frames on purpose, which makes the first step
    // 1.03px and moves a real pixel. The claim is about sub-pixel steps, not
    // about easing, so pinning it here would only pin the toy frame count.
    const hashes = meta.frames.map((f) => md5(path.join(eased[0].dir, f.file)));
    const peak = dy.indexOf(Math.max(...dy));
    const middle = [peak - 1, peak, peak + 1].map((i) => hashes[i]);
    assert.equal(new Set(middle).size, 3, 'every frame through the fast middle must be distinct');
  });

  it('a ramp really does cruise at one constant speed, through the browser', () => {
    const meta = ramped.meta;
    const [run] = meta.runs;
    assert.equal(run.ramp.inS, 0.5);
    assert.equal(run.ramp.outS, 0.5);
    assert.equal(run.ramp.clamped, false);
    assert.ok(Math.abs(run.ramp.cruiseS - 3) < 1e-9);

    const ys = meta.frames.map((f) => f.y);
    assert.equal(ys[0], 0, 'starts at the top');
    assert.equal(ys[ys.length - 1], meta.segments[0].y1, 'lands exactly on the target');

    const dy = ys.slice(1).map((y, i) => y - ys[i]);
    // 40 frames over 4s: 0.5s of ramp is 5 frames at each end. Sample well
    // inside the flat part so the corners cannot leak in.
    const cruise = dy.slice(7, dy.length - 7);
    assert.ok(cruise.length > 20, `only ${cruise.length} cruise frames`);
    assert.ok(Math.max(...cruise) - Math.min(...cruise) < 1e-9, 'the middle must be dead flat');
    assert.ok(dy[0] < cruise[0] / 5, `and it starts from rest (${dy[0]}px vs ${cruise[0]}px cruising)`);
    assert.ok(dy[dy.length - 1] < cruise[0] / 5, 'and settles to a stop');

    // The quoted px/s must match what the frames actually do. The interval is
    // totalS/(N-1), not 1/fps: frames are inclusive endpoints of the timeline.
    const interval = 4 / (meta.frames.length - 1);
    assert.ok(Math.abs(cruise[0] / interval - run.ramp.speed) < 0.01, `${cruise[0] / interval} vs ${run.ramp.speed}`);
  });

  it('THE JUDDER FIX: no two frames of a ramp render the same pixels', () => {
    /*
     * scrollTo snaps to whole CSS pixels (deviceScaleFactor does not change
     * that), so a ramp crawling below 1px/frame produces literally identical
     * screenshots, then a jump. That is the judder. The velocity floor starts
     * the ramp at 2px/frame instead of zero, so every frame moves.
     *
     * On a static fixture the pixels are a pure function of scroll position, so
     * "the bytes differ" is exactly "the scroll moved".
     */
    assert.equal(ramped.meta.runs[0].ramp.floorPx, 2, 'the floor should be on by default');

    const hashes = ramped.meta.frames.map((f) => md5(path.join(ramped.dir, f.file)));
    const repeats = hashes.filter((h, i) => i > 0 && h === hashes[i - 1]).length;
    assert.equal(repeats, 0, `${repeats} consecutive frames are byte-identical, i.e. the scroll stalled`);
    assert.equal(new Set(hashes).size, hashes.length, 'every frame should be distinct');

    // And the rendered scroll positions really do advance a whole pixel each time.
    const px = ramped.meta.frames.map((f) => Math.round(f.y));
    for (let i = 1; i < px.length; i++) {
      assert.ok(px[i] > px[i - 1], `frame ${i} did not advance a pixel (${px[i - 1]} -> ${px[i]})`);
    }
  });

  it('an animated page reproduces frame for frame', () => {
    // Not a byte comparison. Whether Chromium keeps a compositor-promoted
    // element on its own layer at screenshot time is settled at page load, and
    // the two paths rasterise edge antialiasing slightly differently — a thin
    // halo of a hundred-odd pixels. What must not vary is the animation phase,
    // and that moves thousands of pixels when it goes wrong.
    const [a, b] = runs;
    assert.equal(a.meta.frames.length, EXPECTED_FRAMES);
    const budget = 320 * 240 * 0.005; // 0.5% of the frame
    a.meta.frames.forEach((f, i) => {
      const d = pixelDiff(path.join(a.dir, f.file), path.join(b.dir, b.meta.frames[i].file));
      assert.ok(
        d.differing <= budget,
        `frame ${i}: ${d.differing} pixels differ (max delta ${d.maxDelta}), budget ${Math.round(budget)}`
      );
    });
    const hashes = a.meta.frames.map((f) => md5(path.join(a.dir, f.file)));
    assert.equal(new Set(hashes).size, EXPECTED_FRAMES, 'every frame should be distinct — nothing is stalled');
  });

  it('frame-locks page time: rAF timestamps advance by exactly 1000/fps', () => {
    const t = runs[0].meta.frames.map((f) => Number(/t=(-?\d+)/.exec(f.probe)[1]));
    const base = t[0];
    t.forEach((v, i) => assert.equal(v, base + i * 100, `frame ${i} rAF timestamp`));
  });

  it('frame-locks CSS keyframe animations, which page.clock cannot reach', () => {
    const spin = runs[0].meta.frames.map((f) => f.animations.find((a) => a.name === 'spin'));
    spin.forEach((a, i) => {
      assert.ok(a, `frame ${i} lost the spin animation`);
      assert.equal(a.t, i * 100, `frame ${i} CSS animation time`);
      assert.equal(a.state, 'paused');
    });
  });

  it('GUARD: leaves scroll-driven animations alone', () => {
    // Freezing a ScrollTimeline animation would kill exactly the scroll-linked
    // effect srp exists to record, so it must still track scroll.
    const grow = runs[0].meta.frames.map((f) => f.animations.find((a) => a.name === 'grow'));
    grow.forEach((a, i) => assert.equal(a.timeline, 'ScrollTimeline', `frame ${i}`));
    const pct = grow.map((a) => parseFloat(a.t));
    assert.equal(pct[0], 0);
    assert.equal(pct[pct.length - 1], 100);
    for (let i = 1; i < pct.length; i++) assert.ok(pct[i] >= pct[i - 1], 'scroll progress went backwards');
  });

  it('a hold freezes the scroll but not time', () => {
    const held = runs[0].meta.frames.filter((f) => f.segment === 1);
    assert.equal(held.length, 5, '0.5s at 10fps');
    assert.equal(new Set(held.map((f) => f.y)).size, 1, 'the scroll position must not move');
    const hashes = held.map((f) => md5(path.join(runs[0].dir, f.file)));
    assert.equal(new Set(hashes).size, held.length, 'but the animation must keep playing');
  });

  it('the schedule and the dump agree', () => {
    const meta = runs[0].meta;
    assert.equal(meta.segments.reduce((a, s) => a + s.frameCount, 0), EXPECTED_FRAMES);
    meta.frames.forEach((f, i) => assert.equal(f.i, i));
    assert.equal(meta.frames[0].y, 0);
    assert.equal(meta.frames[meta.frames.length - 1].y, meta.segments[meta.segments.length - 1].y1);
  });
});
