'use strict';

/*
 * The single source of truth for the CLI.
 *
 * `OPTIONS` below is the ONLY place an option is described. The parseArgs
 * config, the defaults object, the help text and the README table are all
 * derived from it, so they cannot drift apart (the old file described every
 * option three times, in DEFAULTS, printHelp() and parseCli()).
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseArgs } = require('node:util');
const { UsageError } = require('./errors');

/** H.264 and VP9 both need even frame dimensions. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Turn a user-supplied target into something Chromium can navigate to.
 *   https://x.com     -> unchanged
 *   localhost:3000    -> http://localhost:3000
 *   ./index.html      -> file:///abs/path/index.html
 *   /abs/page.html    -> file:///abs/page.html
 * A bare word that names an existing file becomes a file URL; otherwise it is
 * assumed to be a host and gets http://.
 */
function normalizeUrl(raw, cwd = process.cwd()) {
  const s = String(raw).trim();
  if (!s) throw new UsageError('url must not be empty');
  // A real scheme needs "://" — this must NOT match "localhost:3000".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(data|about|blob):/i.test(s)) return s;
  const looksLikePath = /^[.~]{0,2}\//.test(s) || fs.existsSync(path.resolve(cwd, s));
  if (looksLikePath) return pathToFileURL(path.resolve(cwd, s)).href;
  return 'http://' + s;
}

const OPTIONS = [
  {
    name: 'url', group: 'Page', type: 'string', positional: 0,
    default: 'http://localhost:3000', meta: '<url>', coerce: normalizeUrl,
    help: 'page to record; a bare host or a local path is normalised',
  },
  {
    name: 'duration', group: 'Timing', type: 'number', short: 'd', positional: 1,
    default: 10, meta: '<seconds>',
    help: 'scroll-motion seconds; pauses add on top unless --fixed-duration',
  },
  {
    name: 'fixed-duration', group: 'Timing', type: 'bool', default: false,
    help: 'make --duration the hard total and compress the scroll to fit the pauses',
  },
  {
    name: 'pause', group: 'Timeline', type: 'string', multiple: true, default: [],
    meta: '<target>:<sec>',
    help: 'hold at a point, repeatable; target = 40% | 1200px | #selector | top | bottom',
  },
  {
    name: 'plan', group: 'Timeline', type: 'string', default: null, meta: '<file>',
    help: 'a .js file exporting { timeline, before, after } for full control',
  },
  {
    name: 'script', group: 'Timeline', type: 'string', default: null, meta: '<file>',
    help: 'a .js file exporting { before, after } Playwright hooks',
  },
  {
    name: 'hook-timeout', group: 'Timeline', type: 'number', default: 15, meta: '<seconds>',
    help: 'give up on a hook that has not returned in this long',
  },
  {
    name: 'strict-hooks', group: 'Timeline', type: 'bool', default: false,
    help: 'abort on a failing per-frame action instead of warning and carrying on',
  },
  {
    name: 'out', group: 'Output', type: 'string', short: 'o',
    default: 'scroll.mp4', meta: '<file>',
    help: 'output file; .mp4 (H.264) or .webm (VP9)',
  },
  {
    name: 'fps', group: 'Output', type: 'int', default: 60, meta: '<n>',
    help: 'locked output frame rate',
  },
  {
    name: 'width', group: 'Page', type: 'int', default: 1920, meta: '<px>',
    coerce: even, help: 'viewport width (rounded to an even number)',
  },
  {
    name: 'height', group: 'Page', type: 'int', default: 1080, meta: '<px>',
    coerce: even, help: 'viewport height (rounded to an even number)',
  },
  {
    name: 'wait', group: 'Page', type: 'number', default: 3, allowZero: true, meta: '<seconds>',
    help: 'settle time after page load, before capture',
  },
  {
    name: 'warmup', group: 'Page', type: 'bool', default: true, negatedOnly: true,
    help: 'skip the pre-scroll that loads lazy content (faster, but can clip footers)',
  },
  {
    name: 'headed', group: 'Page', type: 'bool', default: false,
    help: 'show the browser window instead of running headless',
  },
  {
    name: 'clock', group: 'Determinism', type: 'bool', default: true, negatedOnly: true,
    help: 'record at wall-clock time instead of frame-locking page time',
  },
  {
    name: 'css', group: 'Determinism', type: 'string', default: 'waapi', meta: '<waapi|off>',
    choices: ['waapi', 'off'],
    help: 'frame-lock CSS keyframes and transitions too (page.clock cannot reach them)',
  },
  {
    name: 'video', group: 'Determinism', type: 'string', default: 'seek', meta: '<seek|off>',
    choices: ['seek', 'off'],
    help: 'frame-lock <video> and SVG SMIL, which run on wall-clock time otherwise',
  },
  {
    name: 'restart-animations', group: 'Determinism', type: 'bool', default: false,
    help: 'start every animation, video and SMIL clip from 0 on the first frame, not from its phase',
  },
  {
    name: 'shadow-animations', group: 'Determinism', type: 'bool', default: false,
    help: 'also freeze animations inside shadow roots (walks the DOM every frame)',
  },
  {
    name: 'dry-run', group: 'Misc', type: 'bool', default: false,
    help: 'measure the page and print the frame schedule without recording',
  },
  {
    name: 'dump-frames', group: 'Misc', type: 'string', default: null, meta: '<dir>',
    help: 'also write every frame as a PNG plus a frames.json, for debugging',
  },
  { name: 'help', group: 'Misc', type: 'bool', short: 'h', default: false, help: 'show this help' },
  { name: 'version', group: 'Misc', type: 'bool', default: false, help: 'print the version' },
];

/** The `options` object for node:util parseArgs. */
function toParseArgsOptions(opts = OPTIONS) {
  const out = {};
  for (const o of opts) {
    const flag = o.negatedOnly ? 'no-' + o.name : o.name;
    const spec = { type: o.type === 'bool' ? 'boolean' : 'string' };
    if (o.short) spec.short = o.short;
    if (o.multiple) spec.multiple = true;
    out[flag] = spec;
  }
  return out;
}

/** The old DEFAULTS object, derived. */
function defaultsOf(opts = OPTIONS) {
  const out = {};
  for (const o of opts) out[o.name] = o.default;
  return out;
}

function renderHelp(opts = OPTIONS) {
  const groups = [];
  for (const o of opts) {
    if (o.name === 'url') continue; // documented as a positional above
    let g = groups.find((x) => x.name === o.group);
    if (!g) groups.push((g = { name: o.group, items: [] }));
    const flag = o.negatedOnly ? '--no-' + o.name : '--' + o.name;
    const lead = (o.short ? `-${o.short}, ` : '    ') + flag + (o.meta ? ' ' + o.meta : '');
    const def =
      o.default === undefined || o.default === null || o.default === false || o.negatedOnly || Array.isArray(o.default)
        ? ''
        : `  (default: ${o.default})`;
    g.items.push({ lead, text: o.help + def });
  }
  const width = Math.max(...groups.flatMap((g) => g.items.map((i) => i.lead.length)));
  const body = groups
    .map((g) => `${g.name}:\n` + g.items.map((i) => `  ${i.lead.padEnd(width)}  ${i.text}`).join('\n'))
    .join('\n\n');

  return `
srp: record a perfectly smooth, dead-linear scroll of a webpage to video

Usage:
  srp [url] [duration] [options]
  srp --url <url> --duration <seconds> [options]

Positional (both optional):
  url                       page to record         (default: ${defaultsOf(opts).url})
  duration                  scroll + video seconds (default: ${defaultsOf(opts).duration})

${body}

Examples:
  srp http://localhost:3000 15
  srp --url https://rachitkay.com --duration 8 --out hero.webm
  srp ./index.html 6 --width 1280 --height 720
`;
}

function coerceNumber(raw, o) {
  // Round BEFORE range-checking. The other way round, --fps 0.4 passes the
  // "> 0" test and then rounds to 0, which makes every frame time NaN.
  const raw_n = Number(raw);
  const n = o.type === 'int' && Number.isFinite(raw_n) ? Math.round(raw_n) : raw_n;
  const bad = !Number.isFinite(n) || (o.allowZero ? n < 0 : n <= 0);
  if (bad) {
    throw new UsageError(
      o.allowZero
        ? `--${o.name} must be 0 or greater (got "${raw}")`
        : `--${o.name} must be a positive number (got "${raw}")`
    );
  }
  return n;
}

/**
 * Coerce one raw value for one option. Shared by the CLI parser and the
 * --plan file merge, so a plan file gets the same validation a flag does.
 */
function coerceOption(raw, o, cwd = process.cwd()) {
  if (o.type === 'bool') return Boolean(raw);
  if (o.multiple) return (Array.isArray(raw) ? raw : [raw]).map(String);
  let v = o.type === 'number' || o.type === 'int' ? coerceNumber(raw, o) : raw;
  if (o.coerce) v = o.coerce(v, cwd);
  if (o.choices && !o.choices.includes(v)) {
    throw new UsageError(`--${o.name} must be one of ${o.choices.join(' | ')} (got "${raw}")`);
  }
  return v;
}

/**
 * Validate + coerce parseArgs output into a config object.
 * Also returns the set of keys the user actually typed, which the plan-file
 * merge needs so an explicit flag can beat a plan-file value.
 */
function applyValues({ values, positionals }, opts = OPTIONS, cwd = process.cwd()) {
  const config = defaultsOf(opts);
  const explicit = new Set();

  for (const o of opts) {
    const flag = o.negatedOnly ? 'no-' + o.name : o.name;
    let raw = values[flag];

    if (raw === undefined && o.positional !== undefined && positionals[o.positional] !== undefined) {
      raw = positionals[o.positional];
    }
    if (raw === undefined) continue;

    explicit.add(o.name);
    // `--no-warmup` is the only spelling of a negated flag, so its presence
    // means the underlying value is false.
    config[o.name] = o.negatedOnly ? !raw : coerceOption(raw, o, cwd);
  }

  // A default that still needs coercing (the url is normalised either way).
  if (!explicit.has('url')) config.url = normalizeUrl(config.url, cwd);

  const extra = positionals.slice(opts.filter((o) => o.positional !== undefined).length);
  if (extra.length) throw new UsageError(`unexpected argument "${extra[0]}"`);

  return { config, explicit };
}

/** parse(argv) -> { config, explicit }. Throws UsageError on anything bad. */
function parse(argv, opts = OPTIONS, cwd = process.cwd()) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: toParseArgsOptions(opts) });
  } catch (e) {
    throw new UsageError(e.message);
  }
  return applyValues(parsed, opts, cwd);
}

module.exports = {
  OPTIONS,
  even,
  normalizeUrl,
  toParseArgsOptions,
  defaultsOf,
  renderHelp,
  applyValues,
  coerceOption,
  parse,
};
