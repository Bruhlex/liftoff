> Original notes from the thesis repository. Paths there were relative to the old layout:
> `../out.js`, `../test*.js` and `../fib.js` are now in `samples/`, and the tool lives at the
> repository root instead of `vmdecompiler/`.

# vmdecompile — decompiler for obfuscator.io "Virtualization" output

`vmdecompile` turns JavaScript that was protected with obfuscator.io's
Virtual-Machine option (bytecode for a stack VM embedded in the file) back into
plain, readable JavaScript.

```
$ node index.js ../test4.js -o test4.dec.js
[vmdecompile] normalizing test4.js (311009 bytes) with webcrack ...
[vmdecompile] interpreter found: 2 copies, 187 handler bodies, factory=(iife)
[vmdecompile] opcode table: 157 opcodes, 0 unclassified
[vmdecompile] 4 programs extracted (4 main, 0 nested, 0 embedded)
[vmdecompile] 4 host call site(s) replaced, 0 unreferenced program(s)
```

```js
// test4.dec.js
function isEven(M) {
  return M % 2 === 0;
}
function nextStep(M) {
  return isEven(M) ? M / 2 : 3 * M + 1;
}
function collatz(M) {
  let r1 = M;
  let r2 = 0;
  console.log(`Start: ${r1}`);
  while (r1 !== 1) {
    r1 = nextStep(r1);
    r2++;
    console.log(`Schritt ${r2}: ${r1}`);
  }
  console.log(`Fertig nach ${r2} Schritten.`);
  return r2;
}
```

Nothing in the tool is tied to one build: opcode numbers, the hashed slot
layout of program objects, byte-format tags, the base64 alphabet, variable
names, the dispatch structure and the argument order of the VM entry point
all change with every obfuscation run, and all of them are recovered from the
file itself. Opcode handlers are recognized in three tiers: shape rules,
normal-form signatures learned from known builds, and - for anything still
unknown - behavioural inference that executes the handler in a sandbox and
reconstructs its effect from observation (see [DESIGN.md](DESIGN.md)).

## Installation

```
cd vmdecompiler
npm install --ignore-scripts
```

`--ignore-scripts` skips the optional native `isolated-vm` addon that webcrack
would try to compile; it is not needed for VM-protected files. Node ≥ 18.

## Usage

```
node index.js <input.js> [-o output.js] [--no-webcrack] [--disasm] [--quiet]
```

| flag | meaning |
|---|---|
| `-o file` | write the result to `file` instead of stdout |
| `--no-webcrack` | skip the webcrack normalization pass (use when the input is already clean) |
| `--disasm` | print the recovered opcode listing of every program instead of decompiling |
| `--quiet` | suppress progress messages |

Warnings (e.g. an opcode handler that could not be classified) are printed to
stderr and repeated in the header comment of the output.

## Testing

```
npm test                 # synthetic lifter tests + end-to-end sample regression
npm run test:unit        # hand-assembled programs covering control-flow shapes
npm run test:samples     # decompile ../out.js, ../test1..7.js, ../fib.js and diff stdout vs. the originals
node test/robustness.js  # leave-one-out + handler-mutation robustness experiment (slow)
node test/mutate.js ../test7.js --level 3 -o /tmp/m.js   # one mutated build, decompiled and checked
```

The tests never look at original source code: they run the obfuscated file
and the decompiled file under Node and compare their output.

When a new VM-protected sample decompiles correctly, add it to the signature
database so later builds benefit from it:

```
node tools/build-signatures.js ../out.js ../test*.js ../fib.js
```

## Pipeline

| step | module | what it does |
|---|---|---|
| 0 | `src/normalize.js` | webcrack: hex numbers, `!![]`, `a["b"]` → `a.b`, string joins, pretty print |
| 1 | `src/locate.js` | find the fetch–decode–execute loop, collect handlers (plain, indirect `switch (MAP[op])`, dispatch functions), assign roles (stack, sp, pc, registers, constant pool, jump/try tables, scope object, `this`, `arguments`, …) by usage |
| 2 | `src/classify.js`, `src/normalform.js`, `src/signatures.json` | canonicalize each handler and label it with a mnemonic: shape rules, then normal-form signature lookup |
| 3 | `src/extract.js` | run the VM's own program loader and a synthesized single-step function in a Node `vm` sandbox |
| 3a | `src/probe.js` | behavioural inference for still-unknown opcodes (data / call / closure probes) |
| 3b | `src/extract.js` | every program's bytecode, layout, constants, jump/try tables, arity, scope size, name and function kind |
| 4 | `src/lift.js` | symbolic-stack lifting to a Babel AST with structural recovery of `if/else`, ternaries, `&&`/`\|\|`/`??`, loops, `for..of`/`for..in`, `switch`, `try/catch/finally`, array destructuring, classes and nested closures |
| 5 | `src/emit.js` | splice the decompiled bodies into the host script (full and partial builds, sync/async/generator stubs), remove VM boilerplate, cleanup passes |

Debugging helpers: `debug_locate.js` (inferred roles), `debug_classify.js --all`
(opcode table and unclassified handlers), `debug_extract.js` (disassembly),
`debug_probe.js <file> --cross` (behavioural inference, cross-checked against the rules).
They take a *normalized* file (run webcrack first or use `--disasm` on the CLI).

## Output conventions

* parameters keep their host names when the stub passes `arguments` (partial
  builds); otherwise they are `a0, a1, …`
* VM registers become `r1, r2, …`; compiler temporaries are inlined
* block-scoped variables use the name stored for the TDZ check when the
  obfuscator kept one, otherwise `s<frame>_<slot>`
* `for..of` / `for..in` loop variables are `item`, `key` (numbered on clash)
* programs present in the bytecode but never called by the host code are
  emitted as comments

## Limitations

* Verified on nine obfuscator.io builds from two code-generator versions and
  on mutated variants of each (see the robustness section of DESIGN.md).
* Behavioural inference covers data, control-flow, call and closure opcodes.
  Opcodes that manage VM runtime structures (scopes, try frames, classes,
  iterators, generator state) still need a rule or a signature; a genuinely
  new implementation of one of those is reported as `UNKNOWN_n` with its
  canonical text instead of being guessed.
* Object destructuring comes out as the equivalent property reads.
* Names of registers and of block variables without a stored name are synthetic.
