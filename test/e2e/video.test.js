'use strict';

/*
 * The regression test for the bug that shipped: <video> played at wall-clock
 * rate instead of frame rate, so a 7.5s loop finished six times inside a six
 * second hold.
 *
 * The repo has no video fixture and *.mp4 is git-ignored, so the clip is
 * generated at test time with the ffmpeg already bundled as a dependency.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'srp.js');
const FPS = 10;
const HOLD_S = 2;
const SCROLL_S = 1;
const EXPECTED_FRAMES = (HOLD_S + SCROLL_S) * FPS;

function chromiumMissing() {
  try {
    return !fs.existsSync(require('playwright').chromium.executablePath());
  } catch {
    return true;
  }
}

describe('video is frame-locked', { skip: chromiumMissing() && 'chromium is not installed' }, () => {
  let tmp;
  let meta;

  before(
    () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srp-video-'));
      const clip = path.join(tmp, 'clip.mp4');

      // A 4s clip, deliberately longer than the recording, so a correct run
      // never reaches the end and a wall-clock run visibly overshoots.
      execFileSync(require('ffmpeg-static'), [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=64x64:rate=30',
        '-pix_fmt', 'yuv420p', clip,
      ], { stdio: 'ignore' });

      fs.writeFileSync(
        path.join(tmp, 'video.html'),
        `<meta charset=utf-8><style>*{margin:0}section{height:500px;background:repeating-linear-gradient(180deg,#222 0 8px,#444 8px 17px)}
         video{position:fixed;top:0;left:0;width:160px;height:120px}</style>
         <video src="clip.mp4" autoplay muted loop playsinline></video>
         <section></section><section></section><section></section><section></section>`
      );

      execFileSync(
        process.execPath,
        [
          BIN, path.join(tmp, 'video.html'), String(SCROLL_S),
          '--fps', String(FPS), '--width', '320', '--height', '240',
          '--wait', '1', '--no-warmup',
          '--pause', `top:${HOLD_S}`,
          '--restart-animations',
          '--out', path.join(tmp, 'out.mp4'),
          '--dump-frames', path.join(tmp, 'frames'),
        ],
        { encoding: 'utf8', timeout: 150000 }
      );
      meta = JSON.parse(fs.readFileSync(path.join(tmp, 'frames', 'frames.json'), 'utf8'));
    },
    { timeout: 300000 }
  );

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records the frames the schedule promised', () => {
    assert.equal(meta.frames.length, EXPECTED_FRAMES);
    assert.ok(meta.frames.every((f) => f.media && f.media.length === 1), 'every frame should report the video');
  });

  it('THE BUG: currentTime advances by exactly 1/fps per frame, not by wall clock', () => {
    const t = meta.frames.map((f) => f.media[0].t);
    const step = 1 / FPS;
    // With --restart-animations the clip starts at 0 and walks up in 0.1s steps.
    t.forEach((v, i) => {
      assert.ok(
        Math.abs(v - i * step) < 0.02,
        `frame ${i}: video is at ${v}s, expected ${(i * step).toFixed(3)}s. ` +
          `Series so far: ${t.slice(0, i + 1).join(', ')}`
      );
    });
    // The whole recording is 3s of output, so a 4s clip must not have looped.
    assert.ok(t[t.length - 1] < 4, 'the clip should not have run past its end');
  });

  it('the video is paused, so the media pipeline is not also advancing it', () => {
    assert.ok(meta.frames.every((f) => f.media[0].paused), 'srp must own playback');
    assert.ok(meta.frames.every((f) => f.media[0].managed), 'and must have adopted it');
  });

  it('time still advances during a hold, while the scroll does not', () => {
    const held = meta.frames.filter((f) => f.segment === 0);
    assert.equal(held.length, HOLD_S * FPS);
    assert.equal(new Set(held.map((f) => f.y)).size, 1, 'the page must not move');
    const t = held.map((f) => f.media[0].t);
    assert.ok(t[t.length - 1] - t[0] > 0, 'but the video must still play');
    assert.ok(
      Math.abs(t[t.length - 1] - t[0] - (held.length - 1) / FPS) < 0.02,
      `the hold advanced the video ${(t[t.length - 1] - t[0]).toFixed(3)}s, expected ${((held.length - 1) / FPS).toFixed(3)}s`
    );
  });
});
