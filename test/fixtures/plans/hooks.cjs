// A --script file: only before/after are used.
module.exports = {
  before: async (page) => page.evaluate(() => document.body.setAttribute('data-script-before', '1')),
  after: async (page) => page.evaluate(() => document.body.setAttribute('data-script-after', '1')),
};
