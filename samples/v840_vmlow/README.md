# obfuscator.io v8.4.0 — "VM Low" preset — Liftoff check (2026-10-20)

Built on the hosted dashboard (free tier, only free VM preset = **VM Low** = "pure VM,
no advanced defenses", Target=Node), captured via the Chrome extension.

Result: **0/8** — all 8 produce decompiler ERRORs. ops dropped 164 -> ~118-133,
warn ~95-117 ("unclassified opcode N"). The core VM handler encoding changed vs the
thesis-era version (8.0.6) and vs 8.2.1 (7/8). Liftoff's opcode classifier needs
updating for 8.4.0.

Caveat: 8.2.1 was tested at the old default (incl. locked Dynamic Opcodes), which now
maps to the Pro-locked "VM Default". VM Low is a *different, lighter* preset, so this is
not a pure version-to-version comparison — but VM Low is the simplest VM output, so the
failure points at the VM encoding itself, not added hardening.

---

## Root-cause analysis (2026-10-20): what changed in 8.4.0

Characterized on `v8_v840_a10_numbers.js` (VM Low).

**What still works (unchanged):**
- `locate` finds the interpreter: "1 copy, 118 handler bodies".
- Disassembly + program/const extraction are correct (sandbox-based, name-independent).
- Role inference finds the state vars: stack=`Pg`, sp=`Pn`, pc=`PF`, consts=`Pl`, operand, tryFrames, etc.

**What broke — the opcode CLASSIFIER only:**
- baseline a10:  164 opcodes, **153 classified by handler shape**, inference 11/11 -> full.
- 8.4.0  a10:  118 opcodes, **3 classified by handler shape**, inference 19/115 -> ~96 unclassified.

**Why.** Classification canonicalizes each handler (rename role vars stack->S, sp->SP, pc->PC;
others -> v0,v1,...) and matches regex/AST rules (rules.js, e.g. BIN_RE) against the canonical
text. For an 8.4.0 binop the canonical text comes out as:

    let v0=v1[--v2];let v3=v1[--v2];v1[v2++]=v3+v0;v4++;      (8.4.0, NOT matched)

but the rule expects:

    let v0=S[--SP];let v1=S[--SP];S[SP++]=v1 + v0;PC++;        (BIN_RE)

The stack/sp/pc stayed positional (`v1`/`v2`/`v4`) instead of `S`/`SP`/`PC`: the 8.4.0 binop
handlers reach the interpreter state through **local aliases** that role inference did not tie
back to Pg/Pn/PF. roleMap only renames direct occurrences of the role vars, so the shape rules
all miss. Semantics are identical (plain stack ADD/MUL/MOD/shift/eq/throw/store/scope-walk).

**Two concrete VM-generator changes vs the thesis version:**
1. Binary operators were a single `BINOP_MEGA` opcode (operator chosen by an operand ladder,
   `binopMegaInfo`/`evalLadder`); 8.4.0 emits **one opcode per operator** (op22=ADD, op43=MUL,
   op50=MOD, op0=>>, op8===, ...). Opcode space is sparse (values up to ~382).
2. Handlers alias the state registers into locals rather than using them by name, which is what
   defeats name-based canonicalization.

**Fix direction (not yet done):** extend canonicalize/roleMap with a small alias/def-use pass so
`let a = <stack>` (and parameter bindings) propagate the S/SP/PC roles to `a`. Then the existing
BIN_RE and friends match again and classification should recover toward the baseline rate. The
lifter, disassembler and extractor need no change.

---

## Fix implemented (2026-10-20): handler-local state-alias resolution

**Change (3 files, no behavior change for older builds):**
- `src/locate/interpreter.js` — `collectHandlers` now attaches a live `casePath` to each handler.
- `src/locate/index.js` — new `attachStateAliases(handlers, roles)`: for each handler, resolve the
  names it uses, in their own scope, back to a root role (stack/sp/pc/consts/regs) by following
  `let x = y` / `x = y` bindings transitively. Declarator-init from an identifier is authoritative
  for a register's identity; non-identifier mutations (jumps `pO = jumps[pO]`, `pO = 0`, try-frame
  pc) change the value not the role. sp/pc are shuffled between root and locals, so sources are
  accepted by *role consensus* (all resolve to the same role, cycles ignored). Result attached as
  `handler.stateAliases`.
- `src/classify/canonical.js` — `roleMap` merges `handler.stateAliases`.

**Effect:**
- 8.4.0 classification by handler shape: **3 -> ~78** (a10), ~78-86 on hard builds. State now
  canonicalizes to S/SP/PC/K/OP everywhere.
- Older builds: **unchanged** — full corpus still 120/120 stdout match, 116 clean pass, 0 errors;
  unit + samples pass. (No such aliases exist pre-8.4, so the pass is a no-op there.)

**Still failing: 0/8 clean** — ~42-50 opcodes per build remain unclassified because 8.4.0 also
introduced **new handler SHAPES** (not an aliasing issue). 47 distinct shapes catalogued in
`remaining_unclassified_shapes.txt`. Families:
  - scope-variable access with TDZ guards (`v.p0`/`v.p1` chains, "Cannot access before initialization")
  - property definition (defineProperty, get/set, "name", protoTarget) — split per kind
  - conditional jumps `if(S[--SP]){PC=J[PC]}else{PC++}`, try-frame unwinding (TF walking), super()/this
Next step (separate, larger): add ~47 classification rules to `src/classify/rules.js`. The shapes are
readable now, so each is a direct mapping. Lifter/extractor need no change.

Hard builds added here: a18_kitchen_sink, t_test15, d13_sat_solver (v8.4.0, VM Low).

---

## Status update (2026-10-20, after deeper investigation)

The handler-local alias resolution is limited to the **data-plane registers** (operand stack, sp,
pc, consts, regs). Extending it to control-plane roles (scope/ns/this/...) was tried and **reverted**:
it changed the canonical form of some *older*-build handlers and dropped the baseline from 116 to 0
clean passes (still 120/120 stdout match, but with warnings). So the shipped change is deliberately
conservative and verified no-regression (baseline unchanged: 116/120 clean, 120/120 match, 0 errors).

**Delivered:** 8.4.0 opcode classification 3 -> ~75-86 by handler shape; state canonicalizes to
S/SP/PC/K/OP everywhere.

**Remaining for full 8.4.0 PASS (a larger, separate effort):** role *inference* must be adapted to
8.4.0, where these come back null: `jumps`, `scope`, `scopeProps`, `regs`, `args`. Two root causes:
  1. Detectors for jumps/tries/newTarget scan handler text for the *root* register names, but 8.4.0
     handlers use aliases (needs alias-aware detection, threaded carefully to avoid baseline drift).
  2. The scope object moved from the prologue into a handler (opcode ~276) with obfuscated keys
     `{p0:slots, p1:constFlags, p2:selfIdx, p3:parent}`; `inferRoles` only scans the prologue.
Plus ~10 new rules for genuinely-changed shapes (ENTER_SCOPE new layout, `S[SP++]=THIS`, super-ctor,
spread/rest variants, masked operand `K[OP&16777215]`). Each inferRoles change needs a full 120-build
regression run, since it affects all builds.
