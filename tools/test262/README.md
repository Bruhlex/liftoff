# test262 campaign

Checks Liftoff against the language tests of [test262](https://github.com/tc39/test262): every
runtime test is wrapped in a function, about 500 tests go into one bundle, the bundles are
virtualized on the obfuscator.io dashboard, and source, obfuscated build and decompiled output
are compared test by test. Only tests the obfuscated build itself gets right count; when the build
is wrong, the report also says whether the decompiled program matches the source instead.

    git clone --depth 1 --filter=blob:none --sparse https://github.com/tc39/test262.git repo
    (cd repo && git sparse-checkout set harness test/language/statements test/language/expressions)
    node bundle.js select && node bundle.js probe && node bundle.js build 480000   # -> bundles/
    # obfuscate bundles/*.js on the dashboard, save the results as camp/out/<same name>,
    # and copy the bundles to camp/src/
    ./all.sh            # all bundles, 4 in parallel; per-test differences in camp/diffs/
    node diff.js t262_001.js   # one bundle, with the differing tests listed

`preload.js` makes Node's read-only global `crypto` writable (the builds assign top-level
bindings to globals). The builds are not in the repository (about 37 MB per run).

Results:

| obfuscator.io | builds | tests | build itself right | decompiled = build |
|---|---|---|---|---|
| 8.0.8 (2026-10-03) | 17 bundles: half VM only, half + string array, split strings, numbers to expressions, transform keys | 9,512 | 8,824 | all 8,824 |
| 8.4.0 (2026-10-21, test262 d53ebc8b) | same split, Node target | 9,512 | 8,953 | all 8,953 |
