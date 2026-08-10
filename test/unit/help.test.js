'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'srp.js');

test('--help exits 0 and prints usage', () => {
  const out = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(out, /Usage:/);
  assert.match(out, /--duration/);
});

test('a bad numeric option exits 1 with a pointed message', () => {
  assert.throws(
    () => execFileSync(process.execPath, [BIN, '--fps', 'abc'], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /--fps must be a positive number \(got "abc"\)/);
      return true;
    }
  );
});
