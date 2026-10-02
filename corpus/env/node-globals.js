// obfuscator.io exports every top-level binding to globalThis; in Node some names (crypto, ...)
// are getter-only globals, which makes an obfuscated build of a Node program throw at start-up.
// Preloading this makes them writable so the build can run at all (used for n* programs).
for (const k of ['crypto', 'navigator', 'performance', 'fetch']) {
  const d = Object.getOwnPropertyDescriptor(globalThis, k);
  if (d && d.configurable) Object.defineProperty(globalThis, k, { value: globalThis[k], writable: true, configurable: true, enumerable: d.enumerable });
}
