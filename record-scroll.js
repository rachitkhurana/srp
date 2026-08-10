#!/usr/bin/env node
'use strict';

/*
 * Back-compat entry point. `srp` (bin/srp.js) is the real command; this file
 * stays so `node record-scroll.js …` keeps working. The implementation lives
 * in src/ — start at src/cli.js.
 */

require('./src/cli')
  .main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  });
