#!/usr/bin/env node
'use strict';

require('../src/cli')
  .main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Anything that escapes main() would otherwise be an unhandled rejection.
    console.error('\n✖ Failed:', (err && err.stack) || err);
    process.exitCode = 1;
  });
