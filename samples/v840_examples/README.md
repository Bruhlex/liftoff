# obfuscator.io v8.4.0: the dashboard's built-in examples

The five example programs the obfuscator.io dashboard offers next to the editor ("Hello World",
"Fibonacci", "Array Operations", "Simple Calculator", "String Utilities"), each obfuscated
unchanged with the free **VM Low** preset (Target=Node) on 2026-10-28.

    node test/corpus.js samples/v840_examples

These are the smallest builds in the samples. obfuscator.io only emits the handlers a program
uses, so these interpreters lack parts that every larger build has:

- **No scope object.** None of the programs creates a closure scope, so no handler builds the
  `{ slots: new Array(n), parent, ... }` literal and `roles.scopeProps` stays unset. Liftoff used
  to assume it was always found and crashed in the emit stage
  (`Cannot read properties of undefined (reading 'slots')`) on Hello World, Array Operations
  and Simple Calculator.
- **No try handler.** Without try/catch there is no `X.push({ ... })` that names the try-frame
  stack, but the two unwinding jumps (`JMP_UNWIND`) are still emitted. Their frame stack and
  frame keys are now taken from the unwinding loop itself
  (`while (X && X.length > 0) { let f = X[X.length - 1]; if (f.FIN !== undefined || ...) break; X.pop(); }`).
  Before, those two opcodes stayed unclassified in all five builds (unused, but reported).
- **Global shim descriptor in its own declaration.** In Hello World the
  `try { console; Object.defineProperty(NS, "console", ...) } catch {}` block keeps the
  descriptor in a separate `var`; it is now dropped like the inline form.

**Status (2026-10-28): 5/5 decompile, 5/5 stdout match, every opcode identified by handler shape.**
