'use strict';

/*
 * ffmpeg, reading a PNG stream on stdin and writing at a hard-locked frame
 * rate. The argument builders are pure so the codec choice is testable without
 * spawning anything.
 */

const { RecordError } = require('./errors');

function codecArgsFor(outPath) {
  const isWebm = String(outPath).toLowerCase().endsWith('.webm');
  return isWebm
    ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p'];
}

function ffmpegArgs({ outAbs, fps }) {
  const isWebm = String(outAbs).toLowerCase().endsWith('.webm');
  return [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps), // input frame rate
    '-i', '-', // PNGs on stdin
    ...codecArgsFor(outAbs),
    '-r', String(fps), // output frame rate, locked
    // faststart is an MP4 container thing; on webm ffmpeg just warns about it.
    ...(isWebm ? [] : ['-movflags', '+faststart']),
    outAbs,
  ];
}

/** Spawn ffmpeg. Returns { write, finish, kill }. */
function start({ outAbs, fps }) {
  const { spawn } = require('child_process');
  const ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath) throw new RecordError('ffmpeg-static did not supply a binary; try reinstalling dependencies');

  const proc = spawn(ffmpegPath, ffmpegArgs({ outAbs, fps }));
  let log = '';
  let exitCode = null;

  proc.stderr.on('data', (d) => {
    log += d.toString();
  });
  // Without this an EPIPE (ffmpeg died early) becomes an uncaught exception
  // instead of the real "ffmpeg exited N" error below.
  proc.stdin.on('error', () => {});

  const done = new Promise((resolve, reject) => {
    proc.on('close', (code, signal) => {
      // A signal kill reports code === null, so normalise to a non-null
      // sentinel: exitCode doubles as the "is it dead" flag.
      exitCode = code === null ? -1 : code;
      if (code === 0) resolve();
      else reject(new RecordError(`ffmpeg ${signal ? `was killed by ${signal}` : `exited ${code}`}\n${log.slice(-1200)}`));
    });
    proc.on('error', (e) => reject(new RecordError(`could not run ffmpeg: ${e.message}`)));
  });
  done.catch(() => {}); // keep an early rejection from going unhandled before finish()

  // If ffmpeg is gone, surface WHY. `done` rejects with the real
  // "ffmpeg exited N" plus its stderr; a clean exit mid-stream is its own bug,
  // because frames we still have to write would be silently dropped.
  const ensureAlive = async () => {
    if (exitCode === null) return;
    await done;
    throw new RecordError('ffmpeg exited before every frame had been written');
  };

  return {
    async write(png) {
      await ensureAlive();
      if (proc.stdin.write(png)) return;
      // A destroyed pipe never emits 'drain', so waiting on it alone hangs the
      // whole recorder. ffmpeg dying mid-stream (disk full, OOM, killed) used
      // to wedge the run forever, browser open, nothing printed. Racing `done`
      // turns that into the real error.
      await Promise.race([new Promise((r) => proc.stdin.once('drain', r)), done]);
      await ensureAlive();
    },
    async finish() {
      proc.stdin.end();
      await done;
    },
    kill() {
      if (exitCode !== null) return;
      try {
        proc.stdin.destroy();
      } catch {}
      proc.kill('SIGKILL');
    },
  };
}

module.exports = { start, codecArgsFor, ffmpegArgs };
