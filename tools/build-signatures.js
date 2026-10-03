#!/usr/bin/env node
'use strict';
/**
 * Build / extend the normal-form signature database (src/classify/signatures.json)
 * from VM-protected samples whose handlers the rules classify.
 *
 *   node tools/build-signatures.js ../out.js ../test*.js ../fib.js
 *
 * Every rule-classified handler contributes its normal form -> mnemonic
 * (+ extracted details). Later, a handler from a different build whose text
 * matches no rule but whose normal form is known is classified by lookup.
 * Normal forms that map to conflicting mnemonics are dropped.
 */
const fs = require('fs');
const path = require('path');
const { normalize } = require('../src/normalize');
const { locate } = require('../src/locate');
const { canonicalize, classifyHandler } = require('../src/classify');

const DB = path.join(__dirname, '..', 'src', 'classify', 'signatures.json');

async function main() {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('-o');
  const dbFile = oi >= 0 ? argv[oi + 1] : DB;
  const files = argv.filter((a, i) => oi < 0 || (i !== oi && i !== oi + 1));
  const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { signatures: {}, conflicts: [] };
  const conflicts = new Set(db.conflicts || []);
  let added = 0;
  for (const f of files) {
    const vm = locate(await normalize(fs.readFileSync(f, 'utf8')));
    for (const h of vm.handlers) {
      const text = canonicalize(h, vm.roles, vm.helpers);
      const cls = classifyHandler(text, { handler: h, roles: vm.roles, helpers: vm.helpers });
      if (!cls || cls.mnemonic === 'BINOP_MEGA') continue; // mask / ladder are build-specific
      const nf = canonicalize(h, vm.roles, vm.helpers, { normal: true });
      if (conflicts.has(nf)) continue;
      const entry = { ...cls };
      const prev = db.signatures[nf];
      if (prev && JSON.stringify(prev) !== JSON.stringify(entry)) { delete db.signatures[nf]; conflicts.add(nf); continue; }
      if (!prev) { db.signatures[nf] = entry; added++; }
    }
    console.log(`${path.basename(f)}: ${Object.keys(db.signatures).length} signatures so far`);
  }
  db.conflicts = [...conflicts];
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 1));
  console.log(`added ${added}, total ${Object.keys(db.signatures).length}, conflicting normal forms ${conflicts.size}`);
}
main();
