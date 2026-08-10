'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codecArgsFor, ffmpegArgs } = require('../../src/encoder');

test('codec is chosen by output extension, case-insensitively', () => {
  assert.ok(codecArgsFor('a.mp4').includes('libx264'));
  assert.ok(codecArgsFor('a.MP4').includes('libx264'));
  assert.ok(codecArgsFor('/x/y/no-extension').includes('libx264'), 'mp4 is the fallback');
  assert.ok(codecArgsFor('a.webm').includes('libvpx-vp9'));
  assert.ok(codecArgsFor('a.WebM').includes('libvpx-vp9'));
});

test('REGRESSION: +faststart is an MP4 flag and must not be passed for webm', () => {
  assert.ok(ffmpegArgs({ outAbs: '/o/x.mp4', fps: 60 }).join(' ').includes('-movflags +faststart'));
  assert.ok(!ffmpegArgs({ outAbs: '/o/x.webm', fps: 60 }).join(' ').includes('faststart'));
});

test('input and output frame rates are both locked to fps', () => {
  const args = ffmpegArgs({ outAbs: '/o/x.mp4', fps: 24 });
  assert.equal(args[args.indexOf('-framerate') + 1], '24');
  assert.equal(args[args.indexOf('-r') + 1], '24');
});

test('the full mp4 argument list is stable', () => {
  assert.deepEqual(ffmpegArgs({ outAbs: '/o/x.mp4', fps: 60 }), [
    '-y',
    '-f', 'image2pipe',
    '-framerate', '60',
    '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', '60',
    '-movflags', '+faststart',
    '/o/x.mp4',
  ]);
});
