# obfuscator.io v8.4.0 — VM Low with the source-level options

28 builds made on the hosted dashboard on 2026-10-21 (free tier, preset VM Low, Dynamic
Opcodes as the preset sets them): four programs in seven option sets, the same sets as the 8.0.6
corpus (`corpus/builds/`, see DESIGN.md).

    node test/corpus.js samples/v840_options

| set | options on top of VM Low | target |
|---|---|---|
| `v840base` | none (string array, split strings, numbers to expressions, transform object keys, CFF off) | Browser |
| `v840sa` | string array, threshold 1 | Browser |
| `v840cff` | control-flow flattening, threshold 1 | Browser |
| `v840expr` | split strings, numbers to expressions, transform object keys | Browser |
| `v840all` | all of the above | Browser |
| `v840raw` | compact off, rename globals | Browser |
| `v840nodeall` | all of the above | Node |

Programs: `a01_classes`, `a07_generators`, `a18_kitchen_sink`, `d13_sat_solver` (sources in
`corpus/src/`). The VM Low builds with the preset's own defaults (Node target) are in
`samples/v840_vmlow/`.

**Result: 28/28 clean pass, 28/28 stdout match, 0 decompiler errors.**

Two things these builds exposed, both fixed:

- **Control-flow flattening without a string array.** 8.4.0 flattens the VM runtime itself
  (8.0.6 did not: there CFF only reached the source, which becomes bytecode anyway). webcrack
  undoes control-flow flattening only inside its string-array pass, so with CFF but no string
  array the interpreter stayed hidden in `"3|1|0".split("|")` dispatchers and Liftoff fell back
  to webcrack-only output (which "passed" only because that output still runs the VM).
  `unflattenControlFlow` in `src/normalize.js` now inlines the storage object and unflattens the
  dispatchers, mirroring webcrack's transforms.
- **Obfuscated export keys with Rename Globals.** 8.4.0 exports top-level bindings under
  obfuscated keys (`NS._0xa588fe = vmV`). Renaming the host binding to the key (right for 8.0.6,
  whose keys are the source names) changed the runtime `.name` of classes; for obfuscated keys the
  lifted programs' references are now pointed at the host binding instead.

`v840raw_a01_classes` is `PASS*`: the build names an anonymous class (`named:EI`) where the
source prints `anon`; the decompiled program prints `anon` like the source.
