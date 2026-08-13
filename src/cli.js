'use strict';

/*
 * Entry point. Only pure modules are required at the top level; the recorder
 * (and through it playwright and ffmpeg-static) is pulled in lazily, after
 * --help / --version / argument validation, so those still work before
 * `npm install`.
 */

const { UsageError } = require('./errors');
const { parse, renderHelp } = require('./options');
const planning = require('./plan');
const { describeSchedule } = require('./schedule');

const io = {
  log: (m) => console.log(m),
  warn: (m) => console.warn('  ⚠ ' + m),
  progress: (m) => process.stdout.write(`\r${m}   `),
  progressDone: () => process.stdout.write('\n'),
};

async function main(argv) {
  let config;
  let explicit;
  try {
    ({ config, explicit } = parse(argv));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error('✖ ' + err.message + '\n');
    console.log(renderHelp());
    return 1;
  }

  if (config.help) {
    console.log(renderHelp());
    return 0;
  }
  if (config.version) {
    console.log(require('../package.json').version);
    return 0;
  }

  try {
    const { loadUserModule } = require('./loader');
    const planModule = config.plan ? await loadUserModule(config.plan) : null;
    const scriptModule = config.script ? await loadUserModule(config.script) : null;

    const plan = planning.validate(planning.build({ config, explicit, planModule, scriptModule }, io.warn));

    io.log(`▶ Recording ${plan.url}`);
    io.log(
      `  ${plan.viewport.width}x${plan.viewport.height} · ${plan.fps}fps` +
        (plan.ease.linear ? '' : ` · ease ${plan.ease.name}`)
    );

    const result = await require('./recorder').run(plan, io);

    if (result.dryRun) {
      console.log(describeSchedule(result.schedule));
      return 0;
    }
    if (result.warnings && result.warnings.length) {
      console.warn(`  ⚠ ${result.warnings.length} action${result.warnings.length > 1 ? 's' : ''} failed during capture:`);
      for (const w of result.warnings.slice(0, 10)) console.warn(`      ${w}`);
      if (result.warnings.length > 10) console.warn(`      … and ${result.warnings.length - 10} more`);
    }
    console.log(`✔ Saved ${result.outAbs}`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error('✖ ' + err.message);
      return 1;
    }
    console.error('\n✖ Failed:', err && err.message ? err.message : err);
    return 1;
  }
}

module.exports = { main };
