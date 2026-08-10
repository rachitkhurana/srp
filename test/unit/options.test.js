'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { OPTIONS, parse, defaultsOf, renderHelp, normalizeUrl, even } = require('../../src/options');
const { UsageError } = require('../../src/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

test('defaults match the documented ones', () => {
  const d = defaultsOf();
  assert.equal(d.duration, 10);
  assert.equal(d.fps, 60);
  assert.equal(d.width, 1920);
  assert.equal(d.height, 1080);
  assert.equal(d.wait, 3);
  assert.equal(d.warmup, true);
  assert.equal(d.headed, false);
  assert.equal(d.out, 'scroll.mp4');
});

test('positionals and flags both work, with the flag winning', () => {
  assert.equal(parse(['example.com', '5']).config.url, 'http://example.com');
  assert.equal(parse(['example.com', '5']).config.duration, 5);
  assert.equal(parse(['example.com', '5', '--duration', '9']).config.duration, 9);
  assert.equal(parse(['a.com', '5', '--url', 'b.com']).config.url, 'http://b.com');
});

test('an unexpected third positional is rejected', () => {
  assert.throws(() => parse(['a.com', '5', 'extra']), /unexpected argument "extra"/);
});

test('numeric validation keeps the original message format', () => {
  assert.throws(() => parse(['--fps', 'abc']), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.message, '--fps must be a positive number (got "abc")');
    return true;
  });
  assert.throws(() => parse(['--duration', '0']), /--duration must be a positive number/);
  // Negative values need the "=" form; parseArgs otherwise reads "-3" as a flag.
  assert.throws(() => parse(['--fps=-3']), /--fps must be a positive number/);
  assert.throws(() => parse(['--fps', '-3']), /argument is ambiguous/);
});

test('--wait 0 is allowed (it was rejected before)', () => {
  assert.equal(parse(['--wait', '0']).config.wait, 0);
  assert.throws(() => parse(['--wait=-1']), /--wait must be 0 or greater/);
});

test('dimensions are forced even, with a floor of 2', () => {
  assert.equal(even(1919), 1920);
  assert.equal(even(1), 2);
  assert.equal(even(0.4), 2);
  assert.equal(parse(['--width', '1921']).config.width, 1922);
  assert.equal(parse(['--height', '721']).config.height, 722);
});

test('--no-warmup is the only warmup flag and it clears the default', () => {
  assert.equal(parse([]).config.warmup, true);
  assert.equal(parse(['--no-warmup']).config.warmup, false);
});

test('explicit tracks only what the user actually typed', () => {
  const { explicit } = parse(['x.com', '--fps', '30']);
  assert.ok(explicit.has('url'));
  assert.ok(explicit.has('fps'));
  assert.ok(!explicit.has('width'));
  assert.ok(!explicit.has('duration'));
});

test('normalizeUrl: hosts, schemes and local paths', () => {
  assert.equal(normalizeUrl('https://x.com/a'), 'https://x.com/a');
  assert.equal(normalizeUrl('http://x.com'), 'http://x.com');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000', 'a port is not a scheme');
  assert.equal(normalizeUrl('example.com'), 'http://example.com');
  assert.equal(normalizeUrl('file:///tmp/a.html'), 'file:///tmp/a.html');
});

test('REGRESSION: a relative local path becomes a file URL, not http://./x', () => {
  // The old parser turned "./index.html" into "http://./index.html", which the
  // README advertised as a working example.
  const url = normalizeUrl('./static.html', FIXTURES);
  assert.ok(url.startsWith('file://'), url);
  assert.ok(url.endsWith('/test/fixtures/static.html'), url);
  assert.equal(normalizeUrl('static.html', FIXTURES), url, 'a bare name that exists on disk too');
  assert.ok(normalizeUrl('/tmp/nope.html').startsWith('file:///tmp/'), 'an absolute path even if missing');
});

test('help text mentions every option and short flag', () => {
  const help = renderHelp();
  for (const o of OPTIONS) {
    const flag = o.negatedOnly ? `--no-${o.name}` : `--${o.name}`;
    assert.match(help, new RegExp(flag.replace(/[-]/g, '\\-')), `help is missing ${flag}`);
    if (o.short) assert.match(help, new RegExp(`-${o.short}[,\\s]`), `help is missing -${o.short}`);
  }
});

test('DRIFT GUARD: every option carries help text and a group', () => {
  for (const o of OPTIONS) {
    assert.ok(o.help && o.help.trim().length > 0, `${o.name} has no help`);
    assert.ok(o.group, `${o.name} has no group`);
    assert.ok(/^[a-z][a-z0-9-]*$/.test(o.name), `${o.name} is not kebab-case`);
  }
  const names = OPTIONS.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, 'duplicate option name');
  const shorts = OPTIONS.filter((o) => o.short).map((o) => o.short);
  assert.equal(new Set(shorts).size, shorts.length, 'duplicate short flag');
});
