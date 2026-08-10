'use strict';

/*
 * The README's option table is a fourth artifact derived from OPTIONS (after
 * the defaults, the parseArgs config and the help text). Nothing generates it,
 * so this test is what keeps it honest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { OPTIONS, defaultsOf } = require('../../src/options');

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

/** Flags named in the first column of the Options table. */
function documentedFlags() {
  const table = README.split('\n## Options')[1];
  assert.ok(table, 'the README has no "## Options" section');
  const rows = table.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l));
  const flags = new Set();
  for (const row of rows.slice(1)) {
    const firstCell = row.split('|')[1] || '';
    for (const m of firstCell.matchAll(/`(--[a-z-]+)/g)) flags.add(m[1]);
  }
  return flags;
}

test('DRIFT GUARD: the README documents every option, and invents none', () => {
  const documented = documentedFlags();
  const expected = new Set(OPTIONS.map((o) => (o.negatedOnly ? `--no-${o.name}` : `--${o.name}`)));

  const missing = [...expected].filter((f) => !documented.has(f));
  const extra = [...documented].filter((f) => !expected.has(f));
  assert.deepEqual(missing, [], 'options missing from the README table');
  assert.deepEqual(extra, [], 'the README documents options that do not exist');
});

test('DRIFT GUARD: documented defaults match the real ones', () => {
  const d = defaultsOf();
  for (const [flag, value] of [
    ['--duration', d.duration],
    ['--fps', d.fps],
    ['--width', d.width],
    ['--height', d.height],
    ['--wait', d.wait],
    ['--hook-timeout', d['hook-timeout']],
  ]) {
    const row = README.split('\n').find((l) => l.startsWith('|') && l.includes('`' + flag));
    assert.ok(row, `no README row for ${flag}`);
    assert.match(row, new RegExp('\\`' + value + '\\`'), `${flag} default should read ${value}`);
  }
});

test('the README no longer promises things that are now built', () => {
  assert.doesNotMatch(README, /ask if you need it/i, 'the page.clock note is stale');
  assert.doesNotMatch(README, /Node 18/, 'playwright 1.62 requires Node 20+');
});

test('no em dashes in the README', () => {
  // House style: they read as machine-written in anything public facing.
  const lines = README.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('—'));
  assert.deepEqual(lines, [], 'em dashes found');
});
