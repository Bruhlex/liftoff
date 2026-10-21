// The obfuscated builds turn a top-level `crypto` binding into a global assignment, which fails
// against Node's read-only global `crypto`; make it writable for both the build and the output.
Object.defineProperty(globalThis, 'crypto', { value: globalThis.crypto, writable: true, configurable: true });
