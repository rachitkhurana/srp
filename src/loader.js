'use strict';

/*
 * Loading a user's --plan / --script file.
 *
 * One dynamic import() covers every format: .cjs, .mjs, plain .js resolved as
 * CommonJS, and plain .js under a "type": "module" package. Which one applies
 * is decided by the nearest package.json to THEIR file, which is what they
 * expect — it is not affected by srp itself being CommonJS.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { UsageError } = require('./errors');

async function loadUserModule(specifier, cwd = process.cwd()) {
  const abs = path.resolve(cwd, specifier);
  if (!fs.existsSync(abs)) throw new UsageError(`cannot find ${abs}`);

  let ns;
  try {
    ns = await import(pathToFileURL(abs).href);
  } catch (err) {
    throw new UsageError(`could not load ${abs}\n  ${err.message}`);
  }

  //   CJS  module.exports = {…}   -> ns.default is the object
  //   ESM  export default {…}     -> ns.default is the object
  //   ESM  export const timeline  -> no default; the namespace IS the module
  const d = ns.default;
  const obj = d && (typeof d === 'object' || typeof d === 'function') ? d : ns;
  if (!obj || typeof obj !== 'object') throw new UsageError(`${abs} did not export an object`);
  return obj;
}

module.exports = { loadUserModule };
