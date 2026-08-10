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
    proc.on('close', (code) => {
      exitCode = code;
      if (code === 0) resolve();
      else reject(new RecordError(`ffmpeg exited ${code}\n${log.slice(-1200)}`));
    });
    proc.on('error', (e) => reject(new RecordError(`could not run ffmpeg: ${e.message}`)));
  });
  done.catch(() => {}); // keep an early rejection from going unhandled before finish()

  return {
    async write(png) {
      if (exitCode !== null) await done; // surfaces the real ffmpeg error, not EPIPE
      if (!proc.stdin.write(png)) await new Promise((r) => proc.stdin.once('drain', r));
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
