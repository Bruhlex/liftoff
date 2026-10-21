#!/bin/zsh
# all.sh: evaluate all bundles (4 in parallel), print per-bundle lines and the totals
cd "$(dirname "$0")"
ls camp/out | grep '^t262_' | xargs -P4 -I{} node diff.js {} --quiet > eval_all.txt 2>&1
sort eval_all.txt | cut -c1-200
node -e "
const L=require('fs').readFileSync('eval_all.txt','utf8').split('\n').filter(l=>/^t262_/.test(l));
let tests=0,wrong=0,diffs=0,closer=0,bad=0;
for(const l of L){const m=l.match(/: (\d+) tests, build wrong (\d+) \(decompiled = source on (\d+)\), (\d+) diffs among (\d+); dec exit (\d+)/);if(!m){bad++;continue;}tests+=+m[1];wrong+=+m[2];closer+=+m[3];diffs+=+m[4];}
const ok=tests-wrong;console.log('TOTAL',L.length,'bundles,',tests,'tests; build itself wrong on',wrong,'(decompiled = source on',closer+');',diffs,'diffs among',ok,'->',((ok-diffs)/ok*100).toFixed(1)+'% match; decompiler errors',bad);"
