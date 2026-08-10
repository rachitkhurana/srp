// ES module plan file, default export. Must normalise identically to plan.cjs.
export default {
  duration: 4,
  timeline: [
    { scrollTo: '#features', duration: 1 },
    { hold: 0.5, action: async (page) => page.click('#tab-2') },
    { scrollTo: '100%', duration: 1 },
  ],
  before: async (page) => page.evaluate(() => document.body.setAttribute('data-before', '1')),
  after: async (page) => page.evaluate(() => document.body.setAttribute('data-after', '1')),
};
