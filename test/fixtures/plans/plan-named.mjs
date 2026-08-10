// ES module plan file with named exports and no default. Must normalise
// identically to plan.cjs and plan.mjs.
export const duration = 4;
export const timeline = [
  { scrollTo: '#features', duration: 1 },
  { hold: 0.5, action: async (page) => page.click('#tab-2') },
  { scrollTo: '100%', duration: 1 },
];
export const before = async (page) => page.evaluate(() => document.body.setAttribute('data-before', '1'));
export const after = async (page) => page.evaluate(() => document.body.setAttribute('data-after', '1'));
