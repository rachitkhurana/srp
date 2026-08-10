'use strict';

/** Bad input from the user. Printed with the help text; exit 1. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Something went wrong while recording. Printed alone; exit 1. */
class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordError';
  }
}

module.exports = { UsageError, RecordError };
