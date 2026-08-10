'use strict';

/*
 * The normalised plan is the one thing the recorder understands. Both entry
 * points compile to it — CLI flags and a user's --plan file — so there is one
 * execution engine, never two.
 *
 * Precedence: an explicitly typed CLI flag beats a plan-file value beats the
 * default. That is why options.parse() hands back the set of keys the user
 * actually typed.
 */

const path = require('path');
const { UsageError } = require('./errors');
const { parseTarget, parsePause, selectorsOf } = require('./targets');
const { OPTIONS, coerceOption } = require('./options');

const WHOLE_PAGE = { kind: 'percent', value: 100, align: 'top', offset: 0 };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const STEP_KEYS = ['scrollTo', 'hold', 'at', 'duration', 'action', 'actionAt', 'label', 'resolveAt'];

function normalizeStep(raw, i) {
  const at = `timeline[${i}]`;
  if (!raw || typeof raw !== 'object') throw new UsageError(`${at} must be an object`);

  const unknown = Object.keys(raw).filter((k) => !STEP_KEYS.includes(k));
  if (unknown.length) {
    throw new UsageError(`${at} has unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  if (raw.scrollTo !== undefined && raw.hold !== undefined) {
    throw new UsageError(`${at} cannot be both a scroll and a hold`);
  }
  if (raw.resolveAt) throw new UsageError(`${at}.resolveAt is reserved and not yet supported`);

  const common = {
    action: raw.action != null ? raw.action : null,
    actionAt: raw.actionAt || 'start',
  };

  if (raw.scrollTo !== undefined) {
    return {
      type: 'scroll',
      to: parseTarget(raw.scrollTo),
      duration: raw.duration == null ? null : raw.duration,
      label: raw.label || `scroll to ${raw.scrollTo}`,
      ...common,
    };
  }
  if (raw.hold !== undefined) {
    if (raw.duration !== undefined) throw new UsageError(`${at} uses "hold" for its length; drop "duration"`);
    return {
      type: 'hold',
      at: raw.at != null ? parseTarget(raw.at) : null,
      duration: raw.hold,
      label: raw.label || `hold ${raw.hold}s`,
      ...common,
    };
  }
  throw new UsageError(`${at} needs either "scrollTo" or "hold"`);
}

/** Which keys a --plan file may set. */
function planFileKeys() {
  const keys = new Set(['timeline', 'before', 'after']);
  for (const o of OPTIONS) {
    if (o.name === 'help' || o.name === 'version' || o.name === 'plan' || o.name === 'script') continue;
    keys.add(o.name);
    keys.add(camel(o.name));
  }
  return keys;
}

/**
 * @param config        parsed CLI config
 * @param explicit      Set of option names the user typed
 * @param planModule    the --plan file's exports, or null
 * @param scriptModule  the --script file's exports, or null
 */
function build({ config, explicit = new Set(), planModule = null, scriptModule = null, cwd = process.cwd() }, warn = () => {}) {
  const merged = { ...config };

  if (planModule) {
    const allowed = planFileKeys();
    const unknown = Object.keys(planModule).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new UsageError(`the plan file sets unknown key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    }
    for (const o of OPTIONS) {
      if (explicit.has(o.name)) continue; // a typed flag beats the file
      const v = planModule[o.name] !== undefined ? planModule[o.name] : planModule[camel(o.name)];
      if (v === undefined) continue;
      merged[o.name] = coerceOption(v, o, cwd);
    }
  }

  if (!merged.clock && explicit.has('css') && merged.css !== 'off') {
    warn('--css needs the deterministic clock; it is ignored under --no-clock');
  }

  const pauses = (merged.pause || []).map(parsePause);
  let timeline;

  if (planModule && planModule.timeline !== undefined) {
    if (!Array.isArray(planModule.timeline) || planModule.timeline.length === 0) {
      throw new UsageError('the plan file\'s timeline must be a non-empty array');
    }
    if (pauses.length) {
      throw new UsageError('--pause cannot be combined with a plan file that already has a timeline; put the holds in the timeline');
    }
    timeline = planModule.timeline.map(normalizeStep);
  } else {
    // The synthetic timeline the CLI form desugars into. `--pause` splits it in
    // schedule.expandPauses, once targets have pixel values.
    timeline = [{ type: 'scroll', to: WHOLE_PAGE, duration: null, action: null, actionAt: 'start', label: 'scroll' }];
  }

  let before = planModule ? planModule.before || null : null;
  let after = planModule ? planModule.after || null : null;
  if (scriptModule) {
    const clash = ['before', 'after'].filter((h) => scriptModule[h] && (h === 'before' ? before : after));
    if (clash.length) warn(`--script overrides the plan file's ${clash.join(' and ')} hook${clash.length > 1 ? 's' : ''}`);
    if (scriptModule.before) before = scriptModule.before;
    if (scriptModule.after) after = scriptModule.after;
    const extra = Object.keys(scriptModule).filter((k) => k !== 'before' && k !== 'after' && k !== 'default');
    if (extra.length) warn(`--script only uses before/after; ignoring ${extra.join(', ')}`);
  }

  return {
    url: merged.url,
    out: path.resolve(cwd, merged.out),
    fps: merged.fps,
    viewport: { width: merged.width, height: merged.height },
    headless: !merged.headed,
    waitS: merged.wait,
    warmup: merged.warmup,

    fixedDuration: Boolean(merged['fixed-duration']),
    scrollDurationS: merged.duration,
    pauses,
    timeline,

    before,
    after,

    clock: {
      enabled: Boolean(merged.clock),
      // Freezing CSS to frame time while JS still runs at wall-clock would be
      // worse than doing neither, so --no-clock turns this off too.
      css: merged.clock ? merged.css : 'off',
      restartAnimations: Boolean(merged['restart-animations']),
      shadow: Boolean(merged['shadow-animations']),
    },
    hookTimeoutMs: Math.round((merged['hook-timeout'] || 15) * 1000),
    strictHooks: Boolean(merged['strict-hooks']),
    dumpFrames: merged['dump-frames'] ? path.resolve(cwd, merged['dump-frames']) : null,
    dryRun: Boolean(merged['dry-run']),
  };
}

/** CLI-only shorthand, used by tests. */
function fromConfig(config, cwd = process.cwd()) {
  return build({ config, cwd });
}

/** Every Target the plan refers to, so the browser can measure them in one go. */
function collectTargets(plan) {
  const out = [];
  for (const p of plan.pauses || []) out.push(p.target);
  for (const s of plan.timeline) {
    if (s.type === 'scroll' && s.to) out.push(s.to);
    if (s.type === 'hold' && s.at) out.push(s.at);
  }
  return out;
}

function collectSelectors(plan) {
  return selectorsOf(collectTargets(plan));
}

function validate(plan) {
  if (!Array.isArray(plan.timeline) || plan.timeline.length === 0) {
    throw new UsageError('the plan has no timeline');
  }
  plan.timeline.forEach((s, i) => {
    const at = `timeline[${i}]`;
    if (s.type === 'scroll') {
      if (!s.to) throw new UsageError(`${at}.scrollTo is required`);
      if (s.duration != null && !(s.duration > 0)) throw new UsageError(`${at}.duration must be greater than 0`);
    } else if (s.type === 'hold') {
      if (!(s.duration > 0)) throw new UsageError(`${at}.hold must be a number of seconds greater than 0`);
    } else {
      throw new UsageError(`${at} must be a scroll or a hold`);
    }
    if (s.action != null && typeof s.action !== 'function') throw new UsageError(`${at}.action must be a function`);
    if (s.actionAt !== 'start' && s.actionAt !== 'end') {
      throw new UsageError(`${at}.actionAt must be "start" or "end"`);
    }
  });
  for (const hook of ['before', 'after']) {
    if (plan[hook] != null && typeof plan[hook] !== 'function') {
      throw new UsageError(`${hook} must be a function`);
    }
  }
  return plan;
}

module.exports = { build, fromConfig, collectTargets, collectSelectors, validate, WHOLE_PAGE, normalizeStep };
