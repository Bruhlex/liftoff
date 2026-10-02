# Design notes: decompiling obfuscator.io's Virtualization VM

This document records what the VM looks like, which parts of it vary from
build to build, and how each stage of `vmdecompile` recovers what it needs
without depending on any of the varying parts. It is written to be usable as
methodology material for the thesis.

## 1. The protected file

An obfuscator.io VM build has three layers:

1. **Light obfuscation** of the whole file (hex literals, `!![]`, computed
   member access with string keys, occasionally pretty-printed). webcrack
   removes this layer completely; every later stage works on the resulting AST.
2. **The VM runtime**, an IIFE that returns the entry function. It contains
   (a) a byte reader and program decoder, (b) two copies of the interpreter —
   a plain one and a re-entrant one used for generators/async functions —
   (c) ~150 opcode handlers per copy, (d) helpers for closures, classes,
   iterators, `super`, `arguments` objects, and (e) the program tables: one
   array of base64-like strings for top-level programs and one for nested
   functions.
3. **Host code**. Two modes were observed:
   * *full*: a trailing IIFE `(function () { return vm(this, …, 0, …) })()`
     runs program 0, which is the whole script;
   * *partial*: the original top-level code stays in clear text and every
     virtualized function is a stub, e.g.
     `function collatz(F) { return vm(3, arguments, undefined, undefined, new.target, this) }`
     or `const factorial = F => vm(0, [F], { _$Hrn3Ms: [factorial], … }, …)`.
     The object literal is the parent *scope object* whose slots hold the
     free variables the program closes over.

### 1.1 Interpreter state

| role | shape in the source (one build) | purpose |
|---|---|---|
| bytecode | `Int32Array`, `len = code.length >> 1` | opcodes and operands in one of four layouts (interleaved either way, or split), selected by a hash of the program's arity and lengths |
| pc / len | `while (pc < len) { try { while (pc < len) {` | fetch loop; the outer loop restarts after a caught exception |
| stack / sp | `S[SP++] = v`, `S[--SP]` | operand stack (a plain array — the compiler emits drops that make `SP` negative, which JS arrays tolerate) |
| registers | `new Array(paramCount + localCount)` | parameters first, then non-captured locals |
| constants | array with `null` prototype | numbers, strings (XOR-encrypted per program), regexps, bigints, nested programs |
| jump table | `{ pc: target }` | every jump reads its target from here, never from the operand |
| try table | `{ pc: [catchPc, finallyPc, endPc] }` | consumed by `TRY_ENTER` |
| scope object | `{ slots: new Array(n), constFlags, selfIdx, parent }` | one per function plus one per entered block; closures capture it. Variable *names* are stored next to the slots for the TDZ error message ("Cannot access 'x' before initialization") and are reused by the decompiler |
| flags | `!!prog[slot]` | strict, arrow (lexical `this`), derived constructor, … |

### 1.2 What varies per build

Everything below changes with every obfuscation run and must therefore be
inferred, never hard-coded:

* all identifiers;
* opcode numbers (the ISA itself is stable: ~154–160 handlers, two code-generator
  versions seen);
* the slot layout of program objects: either `prog[perm[k]]` with a
  per-program permutation array or `prog[(h0 * k + h1) & 31]` with a hash pair;
* byte-format type tags, flag bits, varint layout, the base64 alphabet, XOR keys;
* the order of the entry function's parameters and of the interpreter's
  parameters;
* the mask of the generic binary-operator opcode and the order of its
  operator ladder;
* property names of the scope object and of try frames;
* the dispatch structure (one switch with fast paths plus two lazily created
  dispatch functions, or three range-bucketed dispatchers).

## 2. Locating the VM and assigning roles (`locate.js`)

The interpreter is found by shape: a `while (a < b)` whose body starts with a
`try` whose block starts with another `while (a < b)` with the same operands.
The first declarations of the inner loop are the fetch
(`idx = pc << shift; op = code[opBase + idx]; operand = code[operBase + idx]`).
Of the two copies, the one without `if (op === CONST) return {…}` guards is the
plain interpreter; the guards of the other copy give the opcodes for
`await`, `yield` and `yield*` (which tag means what is read from the
generator and async runners: the runner that throws
"Unexpected yield in async context" identifies the `await` tag, the one that
looks up `Symbol.iterator` identifies delegation).

Roles are then inferred from usage rather than names:

* `stack`/`sp`: the array written as `X[Y++] = …`;
* `registers`: the `new Array(a + b)` in the prologue; `a` and `b` are the
  arity slots;
* `program` parameter: the parameter most often indexed in the prologue;
  `args`: the parameter copied into the registers; `this`: the parameter
  replaced by the global object when nullish; `parentScope`: the identifier
  stored in the scope object literal; `newTarget`: the parameter pushed by a
  trivial handler; `callee`: the remaining one;
* `jumps`: the array `X` of a handler whose body is exactly `pc = X[pc]`;
  `tries`: the array indexed with `pc` in the handler that pushes a try
  frame; `consts`: the remaining slot-loaded array (the one most often indexed
  with the operand);
* scope-object and try-frame property roles from the literals that create them;
* flag roles: `strict` guards a `Reflect.set` check, `derived` appears next to
  "Must call super constructor", the arrow flag is the other flag in the
  `this = global` guard.

## 3. Classifying opcode handlers (`classify.js`)

Each case body is canonicalized: role identifiers become fixed tokens
(`S`, `SP`, `PC`, `OP`, `R`, `K`, `J`, `TT`, `SC`, …), factory-level aliases
such as `var K = Object.defineProperty` become `Object_defineProperty`,
remaining locals are renumbered `v0, v1, …` in order of appearance, obfuscated
property names with a known role become `sc_slots`, `tf_finallyPc`, etc., and
the trailing `break`/`continue` is dropped. The result is printed compactly,
e.g.

```
let v0=S[--SP];let v1=S[--SP];S[SP++]=v1<v0;PC++;        → BINOP <
if(!S[SP-1]){PC=J[PC];}else{S[--SP];PC++;}               → JMPF_KEEP   (a && b)
let v0=S[--SP];let v1=typeof v0==="object"?v0:v2(v0);…"length"…  → MAKE_CLOSURE
```

About 130 rules (regular expressions over the canonical text, most anchored on
both ends) map these shapes to mnemonics. Rules capture build-specific
details instead of assuming them: the binary operator, the XOR mask of the
generic `BINOP_MEGA` opcode together with its operator ladder (evaluated by
walking the nested `if`/`?:` tree for every selector value), the operand
packing (`OP & 65535`, `OP >>> 16`), whether an accessor is defined on the
prototype target, etc. Real ECMAScript error messages ("is not a function",
"Cannot read properties of", "Class extends value …") anchor the complex
handlers. Anything unmatched is reported as `UNKNOWN_n` and rendered as an
inert call in the output, never guessed.

Classification is three-tiered; each tier only sees what the previous one
left unknown:

1. **Shape rules** on the canonical text (above).
2. **Normal-form signatures** (`normalform.js`, `signatures.json`). The handler
   is first brought into a normal form that undoes syntactic variation a new
   code generator could introduce without changing semantics: `x += 1` and
   `x = x + 1` become `x++`; test polarity is fixed (`if (!c) A else B` and
   `if (a !== b) A else B` become `if (c) B else A` / `if (a === b) B else A`,
   likewise `>=`/`>` and `?:`); `b > a` becomes `a < b`; nested blocks are
   flattened and multi-declarations split; after the canonical renaming the
   operands of symmetric comparisons are ordered. The normal form is looked
   up in a database that `tools/build-signatures.js` builds automatically from
   every rule-classified handler of every known sample (208 entries from the
   nine samples, no conflicting entries). Each new sample extends it.
3. **Behavioural inference** (`probe.js`, section 4a) for whatever is still
   unknown.

Role inference in `locate.js` uses the same normal form, so the jump table,
`new.target` and similar roles are found even when their handlers are
rewritten.

## 4a. Behavioural inference (`probe.js`)

The key to independence from handler *text* is to execute the handler and
observe what it does. `extract.js` synthesizes a **step function** from the
interpreter itself: the prologue (which resolves a program exactly like the
VM), overrides for the state the caller wants to control, and exactly one
iteration of the real fetch/dispatch body. Because the real dispatch code
runs, it does not matter whether a build uses a plain `switch (op)`, an
indirection `switch (MAP[op])` (the test7 build), range-bucketed dispatch
functions or fast paths.

Three probe families run per unknown opcode:

* **Data probe.** Stack, registers, arguments, constants and a ten-level scope
  chain are replaced by index-logging proxies. The handler runs under 15 value
  environments (random integers and fractions, numeric strings, all-equal
  values, `"4"` vs `4` mixes, `0`, `null`, `undefined`, ...) and three
  operands. From the logs the tool derives which slots were read, how the
  read index depends on the operand (whole operand, low 16 bits, high 16
  bits), how many values were popped, and what was pushed or written. Every
  output is explained by the first consistent candidate from a fixed grammar:
  a copy of a read value, a unary operator (`-`, `+`, `!`, `~`, `typeof`,
  `void`, `+x+1`, `+x-1`, `|0`, `>>>0`, `String`, nullish tests), a binary
  operator over two read values, a literal, or a fresh `{}`/`[]`. If the
  program counter depends on the values, the jump condition is explained the
  same way. The result is either an existing mnemonic (e.g. exactly `JMPT`) or
  a generic `TEMPLATE` such as `push (ARGS[lo] - K[hi])` or
  `R[op] = +R[op] + 1`, which the lifter executes directly - a new fused opcode
  needs no new code.
* **Call probe.** Operands are callable/constructible proxies; the single
  `apply`/`construct` trap identifies callee, `this`, arguments and whether the
  argument count came from the stack or the constant pool (`CALL`,
  `CALL_METHOD`, `CALL_IMM`, `CALL_METHOD_IMM`, `NEW`).
* **Closure probe.** A real program object is pushed; a handler that pops it
  and pushes a fresh function is the closure constructor.

An inference is rejected - the opcode stays unknown rather than being guessed
- when the handler throws, returns, performs any property access or call on an
operand (proxy traps), or changes any other interpreter state. The latter is
detected by fingerprinting every interpreter local and the VM namespace
before and after the step (object contents to depth 3); `this`, `new.target`
and the callee are replaced by trap proxies so that reads of them are visible.
A cross-check against the rule-classified opcodes of test7 found no
disagreement other than equivalent formulations (`TO_NUMERIC` vs `+x`).

## 4. Extracting programs (`extract.js`)

Re-implementing the decoder would tie the tool to one byte format. Instead
the VM's own code is executed:

1. Keep the top-level statements up to and including the VM factory (host
   code never runs) and inject into the factory scope an export object with
   the two program loaders (found by the `let X = FN(TABLE); TABLE = null`
   pattern; the loader used by the entry function is the main one) and two
   synthesized functions.
2. `prologue(...)`: the plain interpreter with everything from the fetch loop
   on replaced by `return { <every local> }`. Called with a program object,
   256 sentinel arguments and a fresh callee, it yields — exactly as the VM
   would — the bytecode array and layout, constant pool, jump and try tables,
   flag values, the scope object (its slot count), the register array (the
   number of leading sentinels is the parameter count) and the function name
   (the prologue defines it on the callee).
3. `step(...)`: the single-step function described in section 4a. It is also
   used to run the `MAKE_CLOSURE` handler on every nested program; the created
   function is inspected (`toString()`, constructor name) to learn whether it
   is an arrow, method, async or generator function and whether it is strict.

Programs are enumerated from both loaders and from program objects embedded
in constant pools. Constants are serialized (nested programs by id).

## 5. Lifting (`lift.js`)

Bytecode produced by a compiler from structured source has reducible control
flow, so a recursive region walk over pc ranges suffices:

* a symbolic operand stack holds Babel expression nodes; `DUP` pushes the same
  node reference, which lets stores detect "value still needed" and become
  assignment *expressions*, and lets `x || 0` (compiled as `DUP; JMPT; DROP;
  PUSH 0`) be recognized without emitting the dropped copy;
* statements are appended to the current region; pending stack values that a
  statement could affect are spilled into `const _tN` temporaries first;
* a backward jump closes a loop: header condition → `while`, trailing
  conditional jump → `do/while`; the compiler's `for..of` idiom
  (`FOR_OF_NEXT` + try/finally that closes the iterator + done-flag stores)
  and `for..in` idiom (`FOR_IN_KEYS` + index loop + `in` check) are matched
  on the instruction sequence and emitted as the corresponding statements;
* a forward conditional jump opens a region; if both paths are statement-free
  and leave one extra value the result is a ternary or, when the jump keeps
  the tested value, `&&`/`||`/`??`; otherwise an `if`/`else`;
* a chain of `test; JMPT` followed by `JMP default` into consecutive bodies is
  a `switch` (`switch (true)` when the tests are not `x === c`);
* `TRY_ENTER` with the try table yields `try/catch/finally`; the pushed
  exception becomes the catch parameter;
* jumps leaving the current region resolve to `break`/`continue` (labelled
  when not innermost) against the enclosing loop and switch stack;
* `MAKE_CLOSURE` lifts the nested program recursively with the parent scope
  chain, so captured variables resolve to the same names; `MAKE_CLASS`,
  `CLASS_EXTENDS` and the `DEFINE_*` opcodes build a `class` expression.

Compiler temporaries (a register stored once with a simple expression before
all its reads) are substituted at their uses, which removes the callee copies
the compiler emits before argument evaluation.

Further details that matter for correctness:

* **Array destructuring** (`[a, , b = 1] = src`, also in `for..of` heads and
  parameters) compiles to a fixed idiom: iterator and done flag, a try block
  with one section per element (`next()`, test `done`, take `value` or
  `undefined`, store into the target; holes skip the store) and a finally
  block that closes the iterator. The idiom is matched and emitted as a
  destructuring pattern, folded into `for (const [k, v] of ...)` and arrow
  parameters where possible.
* **Parameters exist twice** in this VM: registers `0..n-1` start as copies of
  the arguments, but `LOAD_ARG`/`STORE_ARG` access a separate arguments array.
  When a program overwrites a parameter register and also accesses the same
  argument slot (destructured parameters do this), the register gets its own
  variable initialised from the parameter.
* **Evaluation order.** A `DUP; STORE_REG r` leaves `(r = v)` on the symbolic
  stack; if `r` is read before that expression is consumed, the emitted code
  would read the old value. Such pending assignments (also nested inside
  other expressions) are flushed as statements before the read.
* Generic `TEMPLATE` / `COND_TEMPLATE` opcodes from the behavioural inference
  are executed by building the AST from the template (pushes that equal a
  write become assignment expressions; pushes that read a location written by
  the same instruction are evaluated first).

## 6. Reassembly (`emit.js`)

Calls to the entry function in the host code are located; their arguments are
classified by shape (`arguments`/array literal, scope object literal, `this`,
`new.target`, the numeric program index at the parameter position the entry
function passes to the main loader). The enclosing host function receives the
decompiled statements in place of the `return vm(...)` statement (statements
before it, such as `super("Rect")`, are kept); host parameter names are used
for the program's parameters; the scope literal provides the names of the
captured variables. `return yield* vm(...)` and `return await vm(...)` stubs
are recognized; a host function whose decompiled body contains `await` or
`yield` becomes `async`/`function*` (the stub's `if (new.target) throw` guard is
dropped). VM boilerplate is removed only where a statement consists entirely
of VM bookkeeping (namespace/`globalThis` exports, registration calls,
`delete` of namespace entries, the global getter shims); references to
top-level bindings that the obfuscator routed through the namespace object
(`NS["memo"](...)`) are rewritten back to plain identifiers. A full-build IIFE
is inlined at top level. Cleanup passes then restore idioms
(`x++`, compound assignment, template literals, default parameters,
`let x = v`, `function name() {}` for named closures). Babel scope
information is re-crawled between mutating passes; binding rewrites are done
one at a time to avoid stale paths.

## 7. Validation

`test/samples.test.js` decompiles each sample and compares the standard
output of the original and the decompiled program (no original source is
consulted). All nine samples match: the seven small ones, the 20-function
partial build `out.js` (classes, getters, `for..of`/`for..in`,
`switch (true)`, `try/catch/finally`, closures over block variables, default
and rest parameters, spread, template literals) and `test7.js`, a build from a
newer code-generator version (indirect dispatch table, fused argument
operators, register/argument increment opcodes, a new call handler with an
inline fast path, a new closure handler) whose program adds static class
fields, `super.method()`, generators, async/await, array and object
destructuring, tagged templates, labelled `continue`, BigInt, symbols and
optional chaining. `test/synthetic.test.js` assembles programs by mnemonic to
cover control-flow shapes absent from the samples.

### Robustness against new code generators

To measure how much the tool depends on the exact handler text,
`test/robustness.js` runs a leave-one-out experiment: for each sample the
signature database is built from the *other* samples only, and the sample's
handlers are rewritten by `test/mutate.js` at three cumulative levels of
semantics-preserving change (1: `x++;` -> `x += 1;`, which alone defeats
almost every shape rule; 2: flipped comparisons and inverted `if/else`;
3: split declarations and extra blocks around each handler). The mutated
file is first checked to behave like the original, then decompiled, and the
decompiled program is run and compared.

Result (`shape` = shape rules + normal-form signatures, `inferred` =
behavioural inference, `unknown` = left unclassified):

| sample | level | opcodes | shape | inferred | unknown | decompiled program |
|---|---|---|---|---|---|---|
| test1-6, fib (7 builds) | 0 / 1 / 2 | 157 | 157 | 0 | 0 | behaves like original |
| test1-6, fib (7 builds) | 3 | 157 | 155 | 2 | 0 | behaves like original |
| out | 0 | 162 | 162 | 0 | 0 | behaves like original |
| out | 1 / 2 | 162 | 154 | 5 | 3 | behaves like original |
| out | 3 | 162 | 150 | 8 | 4 | behaves like original |
| test7 | 0 / 1 / 2 | 164 | 153 | 11 | 0 | behaves like original |
| test7 | 3 | 164 | 152 | 12 | 0 | behaves like original |

36 of 36 runs produce a program whose output equals the original's.

How to read this:

* Without the normal form, level 1 alone dropped the shape rules on test7 from
  153 to 53 recognized handlers; the normal form plus signatures learned from
  the other builds bring it back to 153, and the behavioural inference covers
  the rest.
* For test1-6 and fib the leave-one-out condition is weak: the remaining
  samples include builds of the same code-generator version, so their
  signatures are available. The informative rows are `out` (the only build of
  the older generator) and `test7` (the only build of the newer one).
* The unknown opcodes of the mutated `out` builds are not used by any of its
  programs, which is why the result still matches. They are handlers for VM
  runtime structures (see section 8); a program that used them would produce
  a warning and an `__UNKNOWN_n(...)` placeholder, not silently wrong code.
* The mutations are syntactic. They show that the tool no longer depends on
  the exact spelling of a handler; they do not prove that it handles a
  semantically new VM design.

## 8. Known gaps

* The VM compiler itself has bugs (e.g. default + rest parameters in the same
  signature); the decompiler reproduces the VM's behaviour, not the author's
  intent.
* Object destructuring is emitted as the equivalent property reads, and
  object rest as a small destructuring IIFE; `for await` is untested.
* Behavioural inference covers data, control-flow, call and closure opcodes.
  Opcodes that manipulate VM runtime structures (scope creation, try frames,
  class construction, iterator records, generator state) still depend on shape
  rules or signatures. A genuinely new implementation of one of those - not
  just a syntactic rewrite - surfaces as an `UNKNOWN_n` warning with its
  canonical text.
* A different VM design (other than a stack machine with this fetch loop)
  would need a new `locate` stage.


## 9. Version 8.0.6 corpus (September 2026)

The nine builds of section 7 came from two older code generators. To test how far the tool generalizes,
120 builds of 83 programs were produced with the obfuscator.io dashboard (version 8.0.6, VM preset "Low"):
option sets `base`, `sa` (string array), `cff` (control-flow flattening), `expr` (split strings, numbers to
expressions, transform object keys), `all`, `raw` (no compact, rename globals) and target "Node" for server
programs. The programs (`../corpus/src/`) were written for this purpose and are never an input of the
decompiler: `test/corpus.js` runs the obfuscated build and the decompiled program and compares stdout and
exit status. Where the obfuscated build itself misbehaves (stack overflow because a VM call needs far more
native stack; names of anonymous functions; the VM's own generic `TypeError` messages; a lowering bug for
`store?.#priv.set(...)`), the clean source serves as additional reference and every differing line has to
equal it (`PASS*`, `PASS~` for documented single lines).

Result: 120 of 120 builds decompile to programs with the same behaviour; the last 21 builds (complex
programs of 500-900 lines, all option sets, Node and browser targets) were decompiled without any change to
the tool after the previous fix round.

What the corpus exposed (all fixed, roughly in the order found):

* *Normalization.* webcrack's default sandbox needs a native addon (replaced by `node:vm`); the 8.0.6
  string-array decoder (`i = i - N; const a = ARR(); ...`) is not recognized until the array load is moved to
  the first statement; split-string builds overflow webcrack's recursion (run in a worker with a large
  stack); "Transform Object Keys" moves object literals into temporaries (merged back).
* *Loops.* `for (let ...)` with per-iteration scope copies is a real `for` again (closures otherwise share
  one binding); `for (;;)`, `continue` to the update clause behind a try/finally, labelled `break`/`continue`,
  `for..in` with captured variable, `break label` out of a labelled *block*.
* *Evaluation order and side effects.* Values that the VM evaluates once must be evaluated once in the
  output: property reads through getters/proxies (`x.y` used twice), short-circuit operands (`a ?? b` where `a`
  is a call), object-rest destructuring (the VM reads the named keys, then copies the rest: merged into one
  `const {k, ...rest} = o`), a value carried out of a try block, spills of sub-expressions shared with the
  stack, dropped reads of undeclared globals, TDZ semantics.
* *Classes.* Private members (`#x`, `#x in o`, static privates, brand checks in every syntactic form the
  lowering uses, async/generator private methods), class names bound inside the class body, static blocks,
  the `this` slot of derived constructors.
* *Naming.* Synthetic names (`r2`, `_t1`, `a0`) must not capture names of the program (a program that has its own
  function `r2`); readable names are derived from use (`i`, `key`, `entry`, property names of destructuring).

Known limits: the obfuscated build cannot be the reference when it crashes (see above); sloppy-mode
`arguments` aliasing is preserved only when the function is not turned into a rest-parameter function;
`fn.name` of anonymous closures cannot be reproduced (the VM names them after its own wrapper functions).
