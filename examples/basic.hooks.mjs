/*
 * The same file as basic.hooks.cjs, written as an ES module.
 *
 *   srp https://my-site.com 20 --script examples/basic.hooks.mjs
 *
 * srp loads your file with a dynamic import(), so the format is decided by
 * your file's extension and the nearest package.json to it, not by srp. All of
 * these work and normalise to the same thing:
 *
 *   module.exports = {...}    CommonJS (.cjs, or .js outside a module package)
 *   export default {...}      ESM with a default export
 *   export const before = …   ESM with named exports and no default
 */
export const before = async (page) => {
  const consent = page.locator('#accept-cookies');
  if (await consent.count()) await consent.first().click();
};

export const after = async (page, ctx) => {
  const cta = page.locator('.cta').first();
  if (await cta.count()) await cta.hover();
  ctx.log('done');
};
