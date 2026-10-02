// Spreadsheet evaluator: formulas, cell references, ranges, dependency ordering, cycle detection
'use strict';

class SheetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  toString() { return `#${this.code}`; }
}

const ERR = Object.freeze({ REF: 'REF!', CYCLE: 'CYCLE!', DIV0: 'DIV/0!', NAME: 'NAME?', VALUE: 'VALUE!', PARSE: 'PARSE!' });

function colToIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i) {
  let s = '';
  i++;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new SheetError(ERR.REF, `bad ref ${ref}`);
  return { col: colToIndex(m[1]), row: Number(m[2]) - 1 };
}

function expandRange(a, b) {
  const p = parseRef(a), q = parseRef(b);
  const refs = [];
  for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r++) {
    for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c++) refs.push(indexToCol(c) + (r + 1));
  }
  return refs;
}

// ---------- tokenizer ----------
const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Z]+\d+(?::[A-Z]+\d+)?)|([A-Z]+)(?=\()|("(?:[^"]*)")|(<=|>=|<>|[-+*/^(),:<>=&]))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new SheetError(ERR.PARSE, `unexpected '${src.slice(pos).trimStart()[0]}' at ${pos}`);
    const [whole, num, ref, fn, str, op] = m;
    if (num !== undefined) tokens.push({ t: 'num', v: parseFloat(num) });
    else if (ref !== undefined) tokens.push(ref.includes(':') ? { t: 'range', v: ref.split(':') } : { t: 'ref', v: ref });
    else if (fn !== undefined) tokens.push({ t: 'fn', v: fn });
    else if (str !== undefined) tokens.push({ t: 'str', v: str.slice(1, -1) });
    else tokens.push({ t: 'op', v: op });
    pos += whole.length;
  }
  return tokens;
}

// ---------- parser (precedence climbing) ----------
const BINARY = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

function parseFormula(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (v) => {
    const tk = next();
    if (tk?.v !== v) throw new SheetError(ERR.PARSE, `expected '${v}' got '${tk?.v ?? 'EOF'}'`);
  };

  function primary() {
    const tk = next();
    if (!tk) throw new SheetError(ERR.PARSE, 'unexpected end');
    switch (tk.t) {
      case 'num': return { type: 'num', value: tk.v };
      case 'str': return { type: 'str', value: tk.v };
      case 'ref': return { type: 'ref', ref: tk.v };
      case 'range': return { type: 'range', from: tk.v[0], to: tk.v[1] };
      case 'fn': {
        expect('(');
        const args = [];
        if (peek()?.v !== ')') {
          do {
            args.push(expr(0));
          } while (peek()?.v === ',' && next());
        }
        expect(')');
        return { type: 'call', name: tk.v, args };
      }
      case 'op':
        if (tk.v === '(') {
          const e = expr(0);
          expect(')');
          return e;
        }
        if (tk.v === '-') return { type: 'neg', arg: expr(4.5) };
        if (tk.v === '+') return expr(4.5);
    }
    throw new SheetError(ERR.PARSE, `unexpected token ${tk.v}`);
  }

  function expr(minPrec) {
    let left = primary();
    for (;;) {
      const tk = peek();
      const prec = tk?.t === 'op' ? BINARY[tk.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      next();
      const right = expr(tk.v === '^' ? prec : prec + 1);
      left = { type: 'bin', op: tk.v, left, right };
    }
    return left;
  }

  const ast = expr(0);
  if (i < tokens.length) throw new SheetError(ERR.PARSE, `trailing token ${tokens[i].v}`);
  return ast;
}

function collectRefs(ast, out = new Set()) {
  switch (ast?.type) {
    case 'ref': out.add(ast.ref); break;
    case 'range': expandRange(ast.from, ast.to).forEach((r) => out.add(r)); break;
    case 'bin': collectRefs(ast.left, out); collectRefs(ast.right, out); break;
    case 'neg': collectRefs(ast.arg, out); break;
    case 'call': ast.args.forEach((a) => collectRefs(a, out)); break;
  }
  return out;
}

const flat = (args) => args.flat(Infinity).filter((v) => typeof v === 'number');

const FUNCTIONS = {
  SUM: (...a) => flat(a).reduce((x, y) => x + y, 0),
  AVG(...a) {
    const xs = flat(a);
    if (!xs.length) throw new SheetError(ERR.DIV0, 'avg of nothing');
    return FUNCTIONS.SUM(xs) / xs.length;
  },
  MIN: (...a) => Math.min(...flat(a)),
  MAX: (...a) => Math.max(...flat(a)),
  COUNT: (...a) => flat(a).length,
  IF: (c, t, f = 0) => (c ? t : f),
  ABS: (x) => Math.abs(x),
  ROUND: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  CONCAT: (...a) => a.flat().join(''),
  LEN: (s) => String(s).length,
  UPPER: (s) => String(s).toUpperCase(),
};

class Sheet {
  #raw = new Map();
  #ast = new Map();
  #values = new Map();
  #deps = new Map();
  evalCount = 0;

  set(ref, content) {
    this.#raw.set(ref, content);
    this.#values.clear();
    if (typeof content === 'string' && content.startsWith('=')) {
      try {
        const ast = parseFormula(content.slice(1));
        this.#ast.set(ref, ast);
        this.#deps.set(ref, collectRefs(ast));
      } catch (e) {
        this.#ast.set(ref, { type: 'error', error: e });
        this.#deps.set(ref, new Set());
      }
    } else {
      this.#ast.delete(ref);
      this.#deps.set(ref, new Set());
    }
    return this;
  }

  load(obj) {
    for (const [k, v] of Object.entries(obj)) this.set(k, v);
    return this;
  }

  dependents(ref) {
    const out = [];
    for (const [cell, deps] of this.#deps) if (deps.has(ref)) out.push(cell);
    return out.sort();
  }

  order() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const result = [];
    const cycles = new Set();
    const visit = (ref, stack) => {
      const c = color.get(ref) ?? WHITE;
      if (c === BLACK) return;
      if (c === GRAY) {
        stack.slice(stack.indexOf(ref)).forEach((r) => cycles.add(r));
        return;
      }
      color.set(ref, GRAY);
      stack.push(ref);
      for (const d of [...(this.#deps.get(ref) ?? [])].sort()) visit(d, stack);
      stack.pop();
      color.set(ref, BLACK);
      result.push(ref);
    };
    for (const ref of [...this.#raw.keys()].sort()) visit(ref, []);
    return { order: result.filter((r) => this.#raw.has(r)), cycles };
  }

  #evalAst(ast) {
    this.evalCount++;
    switch (ast.type) {
      case 'num':
      case 'str':
        return ast.value;
      case 'error':
        throw ast.error;
      case 'ref': {
        const v = this.#values.get(ast.ref);
        if (v instanceof SheetError) throw v;
        return v ?? 0;
      }
      case 'range':
        return expandRange(ast.from, ast.to).map((r) => {
          const v = this.#values.get(r);
          if (v instanceof SheetError) throw v;
          return v;
        });
      case 'neg':
        return -this.#num(this.#evalAst(ast.arg));
      case 'call': {
        const fn = FUNCTIONS[ast.name];
        if (!fn) throw new SheetError(ERR.NAME, `unknown function ${ast.name}`);
        return fn(...ast.args.map((a) => this.#evalAst(a)));
      }
      case 'bin': {
        const l = this.#evalAst(ast.left), r = this.#evalAst(ast.right);
        switch (ast.op) {
          case '+': return this.#num(l) + this.#num(r);
          case '-': return this.#num(l) - this.#num(r);
          case '*': return this.#num(l) * this.#num(r);
          case '/':
            if (this.#num(r) === 0) throw new SheetError(ERR.DIV0, 'division by zero');
            return l / r;
          case '^': return this.#num(l) ** this.#num(r);
          case '&': return `${l}${r}`;
          case '=': return l === r;
          case '<>': return l !== r;
          case '<': return l < r;
          case '>': return l > r;
          case '<=': return l <= r;
          case '>=': return l >= r;
        }
      }
    }
    throw new SheetError(ERR.VALUE, `cannot eval ${ast.type}`);
  }

  #num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return +v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    throw new SheetError(ERR.VALUE, `not a number: ${JSON.stringify(v)}`);
  }

  recalc() {
    const { order, cycles } = this.order();
    this.#values.clear();
    for (const ref of order) {
      if (cycles.has(ref)) {
        this.#values.set(ref, new SheetError(ERR.CYCLE, `cycle at ${ref}`));
        continue;
      }
      const ast = this.#ast.get(ref);
      if (!ast) {
        const raw = this.#raw.get(ref);
        this.#values.set(ref, typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
        continue;
      }
      try {
        this.#values.set(ref, this.#evalAst(ast));
      } catch (e) {
        this.#values.set(ref, e instanceof SheetError ? e : new SheetError(ERR.VALUE, e.message));
      }
    }
    return { order, cycles: [...cycles].sort() };
  }

  get(ref) {
    if (!this.#values.size) this.recalc();
    return this.#values.get(ref);
  }

  display(ref) {
    const v = this.get(ref);
    if (v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  render(cols, rows) {
    const width = 10;
    const lines = ['    |' + cols.map((c) => c.padStart(width)).join('|')];
    lines.push('-'.repeat(lines[0].length));
    for (let r = 1; r <= rows; r++) {
      lines.push(String(r).padStart(4) + '|' + cols.map((c) => this.display(c + r).slice(0, width).padStart(width)).join('|'));
    }
    return lines;
  }
}

function astToString(ast) {
  switch (ast.type) {
    case 'num': return String(ast.value);
    case 'str': return JSON.stringify(ast.value);
    case 'ref': return ast.ref;
    case 'range': return `${ast.from}:${ast.to}`;
    case 'neg': return `(-${astToString(ast.arg)})`;
    case 'call': return `${ast.name}(${ast.args.map(astToString).join(', ')})`;
    case 'bin': return `(${astToString(ast.left)} ${ast.op} ${astToString(ast.right)})`;
    default: return '?';
  }
}

function main() {
  console.log('--- helpers ---');
  console.log([0, 25, 26, 51, 701, 702].map((i) => `${i}->${indexToCol(i)}->${colToIndex(indexToCol(i))}`).join(' '));
  console.log('range', expandRange('B3', 'A1').join(','));

  console.log('--- parsing ---');
  const formulas = ['1+2*3', '(1+2)*3', '2^3^2', '-A1+B2*2', 'SUM(A1:A3, 10)/COUNT(A1:A3)', 'IF(A1>=2, "big", "small")', 'CONCAT("x", 1+1, "y")', '1 +', '3 $ 4'];
  for (const f of formulas) {
    try {
      const ast = parseFormula(f);
      console.log(`${f.padEnd(28)} => ${astToString(ast)} refs=[${[...collectRefs(ast)]}]`);
    } catch (e) {
      console.log(`${f.padEnd(28)} => ${e} ${e.message}`);
    }
  }

  console.log('--- budget sheet ---');
  const sheet = new Sheet().load({
    A1: 'Item', B1: 'Qty', C1: 'Price', D1: 'Total',
    A2: 'Apples', B2: '12', C2: '0.5', D2: '=B2*C2',
    A3: 'Bread', B3: '2', C3: '2.25', D3: '=B3*C3',
    A4: 'Cheese', B4: '1', C4: '7.8', D4: '=B4*C4',
    A5: 'Sum', B5: '=SUM(B2:B4)', D5: '=SUM(D2:D4)',
    A6: 'Avg', D6: '=ROUND(AVG(D2:D4), 2)',
    A7: '=UPPER(A2) & "!"', B7: '=MAX(C2:C4)-MIN(C2:C4)', C7: '=IF(D5>20, "over", "ok")', D7: '=LEN(A4)',
  });
  const info = sheet.recalc();
  console.log('eval order', info.order.join(' '));
  console.log('cycles', info.cycles.length ? info.cycles.join(',') : 'none');
  sheet.render(['A', 'B', 'C', 'D'], 7).forEach((l) => console.log(l));
  console.log('dependents of B2:', sheet.dependents('B2').join(','), '| of D2:', sheet.dependents('D2').join(','));

  console.log('--- update propagation ---');
  sheet.set('B2', '30');
  console.log(`B2=30 -> D2=${sheet.display('D2')} D5=${sheet.display('D5')} C7=${sheet.display('C7')} D6=${sheet.display('D6')}`);
  sheet.set('C4', '=C2+C3');
  console.log(`C4 formula -> C4=${sheet.display('C4')} D4=${sheet.display('D4')} B7=${sheet.display('B7')}`);

  console.log('--- errors & cycles ---');
  const bad = new Sheet().load({
    A1: '=B1+1', B1: '=C1*2', C1: '=A1',
    A2: '5', B2: '=A2/0', C2: '=B2+1',
    A3: '=NOPE(1)', B3: '=A2 + "abc"', C3: '=1 +',
    A4: '=A4', B4: '=SUM(A2:A2, 3)', C4: '=IF(A2=5, "five", "other")',
    D1: '=D2', D2: '=D3', D3: '=10',
  });
  const r2 = bad.recalc();
  console.log('cycles', r2.cycles.join(','));
  for (const ref of ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3', 'A4', 'B4', 'C4', 'D1']) {
    const v = bad.get(ref);
    console.log(`  ${ref}: ${bad.display(ref).padEnd(8)} ${v instanceof SheetError ? v.message : typeof v}`);
  }
  bad.set('C1', '7');
  const r3 = bad.recalc();
  console.log('after breaking cycle:', r3.cycles.join(',') || 'none', 'A1 =', bad.display('A1'));

  console.log('--- big chain ---');
  const chain = new Sheet();
  chain.set('A1', '1');
  for (let i = 2; i <= 30; i++) chain.set(`A${i}`, `=A${i - 1}*2 - ${i % 3}`);
  chain.set('B1', '=SUM(A1:A30)');
  chain.set('B2', '=COUNT(A1:A30)');
  chain.set('B3', '=A30 / A29');
  const r4 = chain.recalc();
  console.log('order head', r4.order.slice(0, 5).join(','), 'tail', r4.order.slice(-4).join(','));
  console.log(`A10=${chain.display('A10')} A30=${chain.display('A30')} B1=${chain.display('B1')} B2=${chain.display('B2')} B3=${chain.display('B3')}`);
  console.log('eval count', chain.evalCount);
}

main();
