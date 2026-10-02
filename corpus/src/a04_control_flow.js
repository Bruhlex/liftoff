// a04: control flow

function labeledBreak() {
  const found = [];
  outer: for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (i * j === 6) {
        found.push(i + 'x' + j);
        break outer;
      }
      if (j > i) continue outer;
      found.push(i + '' + j);
    }
  }
  console.log('labeled break/continue', found.join(','));
  let n = 0;
  block: {
    n++;
    if (n > 0) break block;
    n = 999;
  }
  console.log('labeled block', n);
}

function nestedLoops() {
  const grid = [];
  for (let r = 0; r < 4; r++) {
    let row = '';
    for (let c = 0; c < 6; c++) {
      row += (r + c) % 3 === 0 ? '#' : '.';
    }
    grid.push(row);
  }
  grid.forEach((row) => console.log('  ' + row));
  let triples = 0;
  for (let a = 1; a < 20; a++)
    for (let b = a; b < 20; b++)
      for (let c = b; c < 30; c++) if (a * a + b * b === c * c) triples++;
  console.log('pythagorean triples', triples);
}

function classify(x) {
  const out = [];
  switch (x) {
    case 0:
      out.push('zero');
    // fallthrough
    case 1:
      out.push('small');
      break;
    default:
      out.push('default');
    // fallthrough
    case 5:
      out.push('five-ish');
      break;
    case 'str':
      out.push('string');
      return out.join('+') + '(early)';
    case 10:
    case 11:
    case 12:
      out.push('teen-ish');
  }
  return out.join('+');
}

function switchTests() {
  [0, 1, 5, 7, 'str', 10, 11, 12, '5', null].forEach((v) => console.log('switch', JSON.stringify(v), '->', classify(v)));
  function sw2(x) {
    switch (true) {
      case x < 0:
        return 'neg';
      case x === 0:
        return 'zero';
      case x < 10:
        return 'digit';
      default:
        return 'big';
    }
  }
  console.log('switch(true)', [-3, 0, 4, 40].map(sw2).join(' '));
  function sw3(k) {
    let r = 0;
    switch (k) {
      case 'a': {
        let t = 1;
        r += t;
      }
      case 'b': {
        let t = 10;
        r += t;
        break;
      }
    }
    return r;
  }
  console.log('switch block scopes', sw3('a'), sw3('b'), sw3('c'));
}

function doWhile() {
  let i = 10;
  let steps = 0;
  do {
    steps++;
    i = i % 2 === 0 ? i / 2 : 3 * i + 1;
  } while (i !== 1);
  console.log('collatz(10) steps', steps);
  let ran = 0;
  do {
    ran++;
  } while (false);
  console.log('do-while once', ran);
  let w = 0;
  while (true) {
    w += 7;
    if (w > 50) break;
  }
  console.log('while-true', w);
  const digits = [];
  let num = 90210;
  do {
    digits.unshift(num % 10);
    num = Math.floor(num / 10);
  } while (num > 0);
  console.log('digits', digits.join('-'));
}

function forInInherited() {
  const base = { inherited: 1, shared: 'base' };
  const child = Object.create(base);
  child.own = 2;
  child.shared = 'child';
  Object.defineProperty(child, 'hidden', { value: 3, enumerable: false });
  const all = [];
  for (const k in child) all.push(k + (Object.prototype.hasOwnProperty.call(child, k) ? '(own)' : '(inh)'));
  console.log('for-in', all.join(' '));
  const arr = [10, 20, 30];
  arr.extra = 'x';
  const ak = [];
  for (const k in arr) ak.push(k);
  console.log('for-in array', ak.join(','));
  const numericOrder = { b: 1, 2: 'two', a: 2, 1: 'one', '-1': 'neg' };
  const ko = [];
  for (const k in numericOrder) ko.push(k);
  console.log('key order', ko.join(','));
}

function commaOperator() {
  let a = 0;
  let b = (a++, a++, a * 10);
  console.log('comma', a, b);
  const pairs = [];
  for (let i = 0, j = 10; i < j; i += 3, j -= 2) pairs.push(i + ':' + j);
  console.log('for comma', pairs.join(' '));
  const f = (x) => (console.log('  side effect', x), x * 2);
  console.log('arrow comma', f(21));
}

function conditionalChains() {
  const grade = (s) => (s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F');
  console.log('grades', [95, 85, 75, 65, 55, 90, 60].map(grade).join(''));
  const pick = (a, b, c) => (a && b) || c;
  console.log('logic', pick(1, 2, 3), pick(0, 2, 3), pick(1, 0, 'c'), pick('', '', ''));
  let x = 5;
  if (x > 3) if (x > 4) console.log('dangling else: inner-if');
  else console.log('dangling else: else');
  if (x < 0) {
    console.log('neg');
  } else if (x === 0) {
    console.log('zero');
  } else if (x < 10) {
    console.log('single digit');
  } else {
    console.log('big');
  }
}

function shortCircuitEffects() {
  const log = [];
  const t = (v) => (log.push('t' + v), true);
  const f = (v) => (log.push('f' + v), false);
  const r1 = f(1) && t(2);
  const r2 = t(3) || f(4);
  const r3 = f(5) || (t(6) && f(7)) || t(8);
  console.log('short circuit', r1, r2, r3, log.join(','));
}

function loopWithComplexExit() {
  const data = [3, 8, -1, 4, 0, 9, 12, 5];
  let sum = 0;
  let idx = 0;
  let reason = 'end';
  while (idx < data.length) {
    const v = data[idx++];
    if (v < 0) continue;
    if (v === 0) {
      reason = 'zero at ' + (idx - 1);
      break;
    }
    sum += v;
  }
  console.log('complex exit', sum, reason);
  let count = 0;
  for (;;) {
    if (++count >= 7) break;
  }
  console.log('for(;;)', count);
}

labeledBreak();
nestedLoops();
switchTests();
doWhile();
forInInherited();
commaOperator();
conditionalChains();
shortCircuitEffects();
loopWithComplexExit();
console.log('done a04');
