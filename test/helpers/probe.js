'use strict';

/*
 * Read a video's properties back using the ffmpeg binary we already ship.
 * ffmpeg-static does NOT include ffprobe, so we run ffmpeg as a decoder and
 * parse its stderr. The "-f null -" output is required: a bare `ffmpeg -i F`
 * exits non-zero with "At least one output file must be specified".
 */

const { spawnSync } = require('child_process');

function probeVideo(file) {
  const ffmpeg = require('ffmpeg-static');
  const res = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const out = res.stderr || '';

  // Progress is printed repeatedly; the final one is the real frame count.
  const frameMatches = [...out.matchAll(/frame=\s*(\d+)/g)];
  const durMatch = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(out);

  // Two "Video:" lines appear (the input stream and the wrapped_avframe
  // output). The first is the file being probed.
  const videoLine = out.split('\n').find((l) => /Stream #.*Video:/.test(l)) || '';
  const codec = /Video:\s*([\w]+)/.exec(videoLine);
  const size = /,\s*(\d{2,5})x(\d{2,5})(?:\s*\[[^\]]*\])?\s*,/.exec(videoLine);
  const fps = /,\s*([\d.]+)\s*fps\b/.exec(videoLine);

  return {
    exitCode: res.status,
    frames: frameMatches.length ? Number(frameMatches[frameMatches.length - 1][1]) : null,
    durationS: durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : null,
    codec: codec ? codec[1] : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    raw: out,
  };
}

/** Decode a PNG to a raw RGB buffer so frames can be compared with a tolerance. */
function rawPixels(file) {
  const ffmpeg = require('ffmpeg-static');
  const res = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`could not decode ${file}: ${res.stderr}`);
  return res.stdout;
}

/**
 * Compare two frames. Returns the number of pixels differing by more than
 * `threshold` on any channel, and the largest channel delta seen.
 *
 * Byte comparison is too strict for a page with a compositor-promoted element:
 * whether Chromium still has it on its own layer at screenshot time is settled
 * at load, and the two paths rasterise edge antialiasing a shade differently.
 * That shows up as a thin halo worth a few dozen pixels. A real timing
 * regression moves thousands.
 */
function pixelDiff(fileA, fileB, threshold = 8) {
  const a = rawPixels(fileA);
  const b = rawPixels(fileB);
  if (a.length !== b.length) throw new Error('frames differ in size');
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > maxDelta) maxDelta = d;
    if (d > threshold) differing++;
  }
  return { differing, maxDelta, totalPixels: a.length / 3 };
}

module.exports = { probeVideo, rawPixels, pixelDiff };
