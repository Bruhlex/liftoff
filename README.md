# Liftoff

*A decompiler for obfuscator.io's Virtualization (VM) mode.*

Liftoff turns JavaScript protected with the **Virtualization (VM)** option of
[obfuscator.io](https://obfuscator.io) back into readable JavaScript. It comes as a
command-line tool for Node and as a static web page that runs the same pipeline
entirely in the browser.

**Try it online: <https://bruhlex.github.io/liftoff/>** (nothing is uploaded; the
decompiler runs in your browser).

```js
// a virtualized build of a small program, after decompilation
const factorial = y => y <= 1 ? 1 : y * factorial(y - 1);
const sum = (y, ...Q) => {
  const __args = [...Q];
  ...
};
```

The result is a readable program that behaves like the original, not the original
source: local names, comments and the choice between equivalent ways of writing
the same code are lost when the obfuscator compiles to bytecode.

## Supported versions

The VM mode of obfuscator.io's hosted service, **free tier** of the dashboard
(<https://obfuscator.io/dashboard>):

* the earlier code generator (July 2026);
* **versions 8.0.6 and 8.0.8**, preset *VM Low*, alone and combined with string arrays,
  control-flow flattening, numbers to expressions, split strings, transform object
  keys, raw output and the Browser or Node target.

The paid VM hardening options of the dashboard (encoded jumps, stateful opcodes, split
dispatcher, …) are untested. A later version may change the instruction set; unknown
handlers are then reported instead of guessed, and the recovery figure drops below
100 %.

## Recovery figure and files without a VM

Every result states how much of the bytecode came back as real code, for example
`recovered about 97.3 % of 872 VM instructions; 152 of 164 opcodes identified`. An
instruction counts as not recovered when its opcode could not be identified or when
the lifter had to emit a placeholder call such as `__UNKNOWN_12(...)`.

A file without an obfuscator.io VM is passed through webcrack only, which undoes
string arrays, control-flow flattening, constant hiding and formatting where it
recognises them. The output header says so.

## Command line

```
npm install --ignore-scripts
node index.js <input.js> [-o output.js] [--no-webcrack] [--raw-names] [--disasm] [--quiet]
```

| flag | meaning |
|---|---|
| `-o file` | write the result to `file` instead of stdout |
| `--no-webcrack` | skip the webcrack normalization pass |
| `--raw-names` | keep the decompiler's raw names (`r12`, `a0`, `s4_2`) instead of naming variables by their use |
| `--disasm` | print the recovered opcode listing of every program instead of decompiling |
| `--quiet` | suppress progress messages |

`--ignore-scripts` skips webcrack's optional native `isolated-vm` addon, which is
not needed. Node ≥ 18.

## How it works

| step | module | what it does |
|---|---|---|
| 0 | `src/normalize.js` | webcrack: string arrays, wrappers, formatting |
| 1 | `src/locate.js` | find the fetch–decode–execute loop and infer the role of every array (stack, registers, constant pool, …) from its use |
| 2 | `src/classify.js` | canonicalize each handler and map it to an instruction (about 130 rules plus learned signatures) |
| 3 | `src/extract.js`, `src/probe.js` | run the build's own loader to obtain the bytecode; explain still-unknown handlers by running one dispatch step |
| 4 | `src/lift.js` | lift the bytecode with a symbolic operand stack and recover loops, conditionals, `try`, classes and closures |
| 5 | `src/emit.js` | put the recovered functions back where the host script called them |

`src/pipeline.js` ties the steps together and is shared by the CLI (`index.js`) and
the web build (`web/worker-entry.js`). Nothing about a build is hard-coded: opcode
numbers, byte format, alphabet, slot layout and dispatcher are inferred from each
file. Details are in [DESIGN.md](DESIGN.md).

### Output conventions

* Parameters keep their host names when the stub passes `arguments` (partial
  builds); otherwise they are `a0, a1, …`.
* VM registers become `r1, r2, …`; compiler temporaries are inlined.
* Block-scoped variables use the name stored for the TDZ check when the
  obfuscator kept one, otherwise `s<frame>_<slot>`.
* `for..of` / `for..in` loop variables are `item`, `key` (numbered on clash).
* Programs present in the bytecode but never called by the host code are
  emitted as comments.

## Tests

```
npm test               # synthetic lifter tests + the samples in samples/
npm run test:corpus    # all 120 builds in corpus/builds (slow)
npm run test:web       # runs the pipeline with the browser shims and compares with the CLI
```

The tests run the obfuscated build and the decompiled program and compare their
output. The clean sources in `corpus/src/` are used only to tell quirks of the
obfuscated build itself from decompiler errors; they are never an input of the
decompiler. A sample whose build does not run as it is (`samples/http-client.js`)
is compared with its source `samples/http-client.src.js` instead.

| set | content | result |
|---|---|---|
| `corpus/builds/` | 120 builds of 83 programs (obfuscator.io 8.0.6, eight option sets: VM only, + string array, + control-flow flattening, + expression obfuscation, all, raw, Node target) | all 120 behave like the build; two carry a documented one-line difference (`corpus/expected-divergence.json`) |

## Layout

```
index.js            CLI
src/                decompiler (pipeline.js is the entry point)
web/                web app sources and browser shims for node:vm / worker_threads
docs/               built static site (deploy this)
samples/, corpus/   test inputs (corpus/src: clean sources of the corpus programs)
test/               tests
```

## Limitations

* Only obfuscator.io's VM mode is supported; other virtual machines need their own
  instruction-set analysis.
* Opcodes that manage VM runtime structures (scopes, try frames, generators) need a
  rule or signature; a genuinely new one is reported as `UNKNOWN_n` instead of
  being guessed.
* In the browser, inputs with extremely deep expression chains may skip webcrack's
  full deobfuscation (the CLI retries those in a large-stack worker thread); the
  decompiler then continues with the unminified source.
* To read the bytecode, Liftoff runs the file's own loader code (in the browser
  inside a Web Worker, with network and DOM globals hidden). This is not a security
  sandbox: only decompile files you are willing to run.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 bruhlex.
