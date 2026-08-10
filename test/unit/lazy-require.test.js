'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const HEAVY = /node_modules[\\/](playwright|playwright-core|ffmpeg-static)[\\/]/;
const loadedHeavy = () => Object.keys(require.cache).filter((k) => HEAVY.test(k));

test('requiring the CLI does not pull in playwright or ffmpeg-static', () => {
  require('../../src/cli');
  assert.deepEqual(loadedHeavy(), [], 'a top-level require of a heavy dep would break `srp --help` before npm install');
});

test('running --help and --version stays dependency-free', async () => {
  const { main } = require('../../src/cli');
  const realLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(['--help']), 0);
    assert.equal(await main(['--version']), 0);
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(loadedHeavy(), []);
});

test('a usage error is reported without loading a browser', async () => {
  const { main } = require('../../src/cli');
  const realLog = console.log;
  const realErr = console.error;
  let stderr = '';
  console.log = () => {};
  console.error = (m) => {
    stderr += m;
  };
  try {
    assert.equal(await main(['--fps', 'nope']), 1);
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  assert.match(stderr, /--fps must be a positive number/);
  assert.deepEqual(loadedHeavy(), []);
});
