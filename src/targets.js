'use strict';

/*
 * Scroll targets: parsing the strings a user types, and turning them into a
 * pixel offset once the page has been measured. Everything here is pure — no
 * browser — which is why the geometry rules are testable.
 *
 * Grammar
 *   40%              percent of the scrollable extent
 *   1200px | 1200    absolute pixels
 *   top | bottom     0% | 100%
 *   #pricing         a CSS selector; scrolls that element to the viewport top
 *   #hero@center     ... centred in the viewport instead
 *   #hero@+120       ... offset 120px further down
 *   #hero@center-40  ... both
 *
 * Modifiers live behind "@" so a bare selector is never reinterpreted:
 * "#hero-40" is the element #hero-40, not #hero offset by -40.
 */

const { UsageError } = require('./errors');

const mk = (kind, value, align = 'top', offset = 0) => ({ kind, value, align, offset });

function parseTarget(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) throw new UsageError('scroll target must not be empty');

  if (/^top$/i.test(s)) return mk('percent', 0);
  if (/^bottom$/i.test(s)) return mk('percent', 100);

  let m = /^(\d+(?:\.\d+)?)%$/.exec(s);
  if (m) {
    const v = Number(m[1]);
    if (v > 100) throw new UsageError(`scroll target "${s}" is over 100%`);
    return mk('percent', v);
  }

  m = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(s);
  if (m) return mk('pixels', Number(m[1]));

  // Anything else that starts like a NUMBER is a malformed number, not a
  // selector. The leading dot must be followed by a digit, or ".card" would be
  // rejected instead of being read as a class selector.
  if (/^[-+]?(\d|\.\d)/.test(s)) throw new UsageError(`invalid scroll target "${s}"`);

  const at = s.lastIndexOf('@');
  if (at > 0) {
    const mod = /^(center|top)?([-+]\d+(?:\.\d+)?)?$/.exec(s.slice(at + 1));
    if (mod && (mod[1] || mod[2])) {
      return mk('selector', s.slice(0, at), mod[1] === 'center' ? 'center' : 'top', Number(mod[2] || 0));
    }
  }
  return mk('selector', s);
}

/** "40%:2" -> { target, seconds }. See the last-colon rule below. */
function parsePause(str) {
  const s = String(str == null ? '' : str).trim();
  // Scan for ":" from the right and split at the first one whose right-hand
  // side is a plain number. This is unambiguous for "#a:nth-child(2):1.5"
  // and '[data-x="a:b"]:2' without needing an escape syntax.
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] !== ':') continue;
    const rhs = s.slice(i + 1);
    if (!/^\d+(?:\.\d+)?$/.test(rhs)) continue;
    const seconds = Number(rhs);
    if (seconds <= 0) throw new UsageError(`pause seconds must be greater than 0 (got "${s}")`);
    return { target: parseTarget(s.slice(0, i)), seconds };
  }
  throw new UsageError(`--pause "${s}" must end with ":<seconds>", e.g. "40%:2"`);
}

/** Stable identity for dedupe and for keying resolved pixel values. */
function targetKey(t) {
  return `${t.kind}:${t.value}:${t.align}:${t.offset}`;
}

/** Selectors the browser has to measure, deduped. */
function selectorsOf(targets) {
  return [...new Set(targets.filter((t) => t && t.kind === 'selector').map((t) => t.value))];
}

/**
 * @param {object} t       a Target
 * @param {object} ctx     { maxScroll, viewportH, rects: { [sel]: {top, height} | null } }
 */
function resolveTargetPx(t, ctx) {
  const clamp = (n) => Math.max(0, Math.min(ctx.maxScroll, n));
  switch (t.kind) {
    case 'percent':
      return clamp((ctx.maxScroll * t.value) / 100);
    case 'pixels':
      return clamp(t.value);
    case 'selector': {
      const rect = ctx.rects && ctx.rects[t.value];
      if (!rect) throw new UsageError(`no element matches the scroll target "${t.value}"`);
      const centring = t.align === 'center' ? (ctx.viewportH - rect.height) / 2 : 0;
      return clamp(rect.top - centring + t.offset);
    }
    default:
      throw new UsageError(`unknown scroll target kind "${t.kind}"`);
  }
}

module.exports = { parseTarget, parsePause, targetKey, selectorsOf, resolveTargetPx };
