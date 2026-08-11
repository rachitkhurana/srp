'use strict';

/*
 * Documentation that lies is worse than none, so the examples are executed
 * against the real loader and the real validator rather than eyeballed, and
 * the agent docs are checked for flags that do not exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadUserModule } = require('../../src/loader');
const { build, validate } = require('../../src/plan');
const { parse, OPTIONS } = require('../../src/options');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const exampleFiles = fs
  .readdirSync(EXAMPLES)
  .filter((f) => /\.(cjs|mjs|js)$/.test(f))
  .sort();

test('there are examples to check', () => {
  assert.ok(exampleFiles.length >= 5, `only found ${exampleFiles.length} example files`);
});

for (const file of exampleFiles) {
  test(`examples/${file} loads and validates`, async () => {
    const mod = await loadUserModule(path.join(EXAMPLES, file));
    // A ".hooks." file is used as --script (before/after only); anything else
    // is a --plan file. Same distinction the CLI makes.
    const asScript = file.includes('.hooks.');
    const plan = build({
      ...parse([]),
      planModule: asScript ? null : mod,
      scriptModule: asScript ? mod : null,
    });
    validate(plan);

    if (asScript) {
      assert.ok(plan.before || plan.after, `${file} is a --script example but exports no hooks`);
    } else {
      assert.ok(Array.isArray(plan.timeline) && plan.timeline.length, `${file} has no timeline`);
    }
  });
}

test('the reference example really does cover every step key', () => {
  const src = read('examples/reference.plan.cjs');
  // resolveAt is deliberately excluded: it is reserved and rejected.
  for (const key of ['scrollTo', 'hold', 'at', 'duration', 'action', 'actionAt', 'label']) {
    assert.match(src, new RegExp(`\\b${key}\\b`), `reference.plan.cjs never mentions "${key}"`);
  }
});

test('agent docs exist and point at each other', () => {
  const agents = read('AGENTS.md');
  const claude = read('CLAUDE.md');
  assert.ok(agents.length > 1000, 'AGENTS.md is suspiciously short');
  assert.match(claude, /AGENTS\.md/, 'CLAUDE.md should defer to AGENTS.md');
});

test('DRIFT GUARD: AGENTS.md invents no flags', () => {
  const known = new Set(OPTIONS.flatMap((o) => [`--${o.name}`, o.negatedOnly ? `--no-${o.name}` : null]).filter(Boolean));
  // Long-form flags only; short ones like -o are too easy to false-positive on.
  const mentioned = new Set([...read('AGENTS.md').matchAll(/`?(--[a-z][a-z-]+)/g)].map((m) => m[1]));
  const unknown = [...mentioned].filter((f) => !known.has(f));
  assert.deepEqual(unknown, [], 'AGENTS.md mentions flags that do not exist');
});

test('every examples/ file the docs link to exists', () => {
  const docs = [read('README.md'), read('AGENTS.md'), read('examples/README.md'), read('hooks/README.md')].join('\n');
  const referenced = new Set([...docs.matchAll(/examples\/([\w.-]+\.(?:cjs|mjs|js))/g)].map((m) => m[1]));
  assert.ok(referenced.size > 0, 'the docs reference no examples at all');
  for (const f of referenced) {
    assert.ok(fs.existsSync(path.join(EXAMPLES, f)), `docs reference examples/${f}, which does not exist`);
  }
});

test('the demo media the README shows actually exists', () => {
  const readme = read('README.md');
  const refs = new Set([...readme.matchAll(/(?:src=")?(docs\/[\w.-]+\.(?:gif|mp4|png|webm))/g)].map((m) => m[1]));
  assert.ok(refs.size > 0, 'the README references no demo media at all');
  for (const f of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `README references ${f}, which does not exist`);
  }
});

test('DRIFT GUARD: every demo video the README shows survives the ignore rules', () => {
  // *.mp4 is ignored wholesale, so each demo needs its own negation or it is
  // simply absent for anyone who clones the repo.
  const readme = read('README.md');
  const ignore = read('.gitignore');
  const videos = new Set([...readme.matchAll(/(docs\/[\w.-]+\.(?:mp4|webm))/g)].map((m) => m[1]));
  assert.ok(videos.size > 0, 'the README links no demo video');
  for (const v of videos) {
    assert.match(
      ignore,
      new RegExp('^!' + v.replace(/[.]/g, '\\.') + '$', 'm'),
      `${v} is linked from the README but would be git-ignored`
    );
  }
});

test('no em dashes in the agent-facing docs', () => {
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'examples/README.md', 'hooks/README.md']) {
    const lines = read(f)
      .split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => l.includes('—'));
    assert.deepEqual(lines, [], `em dashes found in ${f}`);
  }
});

test('hooks/ is documented and git-ignores its contents', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^hooks\/\*$/m, 'hooks/* should be ignored');
  assert.match(ignore, /^!hooks\/README\.md$/m, 'but hooks/README.md should survive');
  assert.match(ignore, /^output\/\*$/m, 'output/* should be ignored');
  assert.ok(fs.existsSync(path.join(ROOT, 'hooks', 'README.md')));
});
