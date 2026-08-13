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
const { build, validate, STEP_KEYS, RESERVED_STEP_KEYS } = require('../../src/plan');
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

test('DRIFT GUARD: the reference example really does cover every step key', () => {
  // Derived from STEP_KEYS rather than listed here, so a new step key cannot be
  // added without the reference example growing to document it. Reserved keys
  // are excluded: they exist only to be rejected.
  const src = read('examples/reference.plan.cjs');
  const documented = STEP_KEYS.filter((k) => !RESERVED_STEP_KEYS.includes(k));
  assert.ok(documented.length >= 8, 'suspiciously few step keys');
  for (const key of documented) {
    // As a key, not merely as a word: "ease" appears in the prose of this file
    // ("teleports rather than eases"), which was enough to satisfy a \bkey\b
    // match and let a genuinely undocumented key through.
    assert.match(src, new RegExp(`\\b${key}:`), `reference.plan.cjs does not use "${key}:" as a step key`);
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

test('DRIFT GUARD: every docs/ asset any doc points at actually exists', () => {
  // Not just the README: examples/README.md and the example headers link to the
  // demo media too, and a renamed file rots those links silently. That is
  // exactly what happened to docs/demo.gif when it became airpods-pro.gif.
  const sources = [
    'README.md', 'AGENTS.md', 'examples/README.md', 'hooks/README.md',
    ...fs.readdirSync(EXAMPLES).filter((f) => /\.(cjs|mjs|js)$/.test(f)).map((f) => `examples/${f}`),
  ];
  let total = 0;
  for (const src of sources) {
    const refs = new Set(
      [...read(src).matchAll(/(?:\.\.\/)?(docs\/[\w.-]+\.(?:gif|mp4|png|webm))/g)].map((m) => m[1])
    );
    for (const f of refs) {
      total++;
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${src} references ${f}, which does not exist`);
    }
  }
  assert.ok(total > 0, 'the docs reference no demo media at all');
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
