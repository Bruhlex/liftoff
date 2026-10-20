# obfuscator.io v8.4.0 — "VM Low" preset

Eleven builds made on the hosted dashboard (free tier: the only free VM preset is **VM Low**,
"pure VM, no advanced defenses", Target=Node). The first eight are the usual a-series test
programs; `a18_kitchen_sink`, `t_test15` and `d13_sat_solver` are the hard, variation-dense ones.

    node test/corpus.js samples/v840_vmlow

**Status (2026-10-21): 11/11 clean pass, 11/11 stdout match, 0 decompiler errors**, every
opcode identified by handler shape (no behavioural inference needed). Older builds unchanged:
116/120 clean pass, 120/120 stdout match, 0 errors (`node test/corpus.js`).

Starting point on 2026-10-20 was 0/8: 3 of 118 opcodes classified, every build an ERROR.

Caveat: 8.2.1 was tested at the old default (incl. Dynamic Opcodes), which now maps to the
Pro-locked "VM Default". VM Low is a different, lighter preset, so this is not a pure
version-to-version comparison.

---

## What changed in 8.4.0, and how Liftoff handles it

Everything is detected from the code's shape, and every new path is guarded so it only engages
when the older detection finds nothing (or on the 8.4 frame layout, `roles.resumeFrame`).

### Interpreter state and roles (`src/locate/`)

- **Handler-local aliases of the state.** Most opcodes moved into secondary dispatch functions
  that bind stack/sp/pc/consts/regs to fresh locals (`pN = OT; ... pN[--pn]`). `attachStateAliases`
  resolves each name back to its root role (declarator init is authoritative, shuffled sp/pc
  registers by role consensus); the canonicalizer merges the result.
- **Two program parameters.** The interpreter now takes the fresh program data *and* a saved
  resume frame: `if (F === undefined) { init from P[...] } else { resume from F[...] }`. The frame
  is indexed more often, so it used to be taken for the program, and extraction ran every program
  down the resume branch. The program is now the parameter read in the fresh branch
  (`roles.prog`), the frame is `roles.resumeFrame`.
- **Registers share the stack array** (`PR = Pg`), the lexical `this` is captured by assignment,
  the try table is only loaded in the fresh branch and indexed with an aliased pc, the jump table
  and the scope object (now built in a handler, obfuscated keys) are found from handler shapes,
  `new.target` and the callee are found from the push / self-binding handlers.
- **No generator copy of the interpreter.** Yield/await/yield* are handled inline:
  `if (op === A || op === B || op === C) { save frame; rec.tag = op === A ? t1 : ...; return rec }`
  (`inlineYieldOpcodes`), tags resolved as before.
- **Namespace aliases and records.** The export target is `let X = this === G ? G : NS`, and VM
  bookkeeping (TDZ sets of hoisted functions, call flags) lives in records `let R = NS.k ||= {...}`.
  Both are recognized so host statements on them are dropped like statements on `NS`.

### Handler shapes (`src/classify/rules.js`, section ">= 8.4 handler variants")

New rules map the changed shapes onto existing mnemonics: `PUSH_THIS` (plain and derived-ctor),
`===`/`!==` written with a nullish fast path (also inside the `BINOP_MEGA` ladder), flat
`LOAD_SCOPE`/`STORE_SCOPE` with a `names` TDZ record, global load/store/decl/delete with a separate
TDZ record object, `CALL`/`CALL_METHOD`/`NEW` with the arguments *above* the callee, wrapped
`THROW`, accessor/method/data/field defines (inserted `name`, private brand bit, masked key
`OP & 0xffffff` via `operandMask`), mode-selector object spread, lazily built `arguments`,
`STORE_ARG`, `MAKE_CLOSURE`, and a new `REST_ARGS` op (lifted as `Array.prototype.slice.call(arguments, n)`
so the existing rest-parameter recovery applies).

### Extraction (`src/extract/`)

- The single-step sandbox rebinds prologue aliases of overridden state (`OT = stack`), otherwise
  the secondary dispatch functions act on the prologue's stack.
- Every closure is now the same non-constructible wrapper and carries the source's *inferred* name
  (`const f = function () {}` has `f.name === 'f'`), so neither kind nor name can be read off it.
  The kind comes from the VM's own `MAKE_CLOSURE` flags (a step-function variant records the
  generator/async/arrow tests of its builder chain); the inferred name is kept as `inferredName`
  only.
- Behavioural probes run under the sandbox watchdog (`X.guard`), so a handler that loops on
  synthetic state times out instead of hanging.

### Lifting and emit (`src/lift/`, `src/emit/`)

- for-of heads without the trailing `DROP`; for-in with the index increment before the skip target.
- `var {} = (NS.x = x, 0)` export leftovers, host TDZ guards on records, inlined `#x in o` helpers.
- `const f = function f() {}` -> declaration no longer collides with the crawled scope binding.

---

## History

- 2026-10-20: 0/8, 3 of 118 opcodes classified. Alias resolution, jump table and scope detection
  brought shape classification to ~90-101 of 118-136.
- 2026-10-21: remaining roles, rules, extraction and lifting fixes as above: 11/11.
