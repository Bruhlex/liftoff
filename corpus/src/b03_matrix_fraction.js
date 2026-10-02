// Matrix library over exact rationals: multiply, determinant, inverse, solve, rank.
'use strict';

function bgcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

class Fraction {
  #n;
  #d;
  static created = 0;
  static ZERO;
  static ONE;

  constructor(n, d = 1n) {
    n = BigInt(n);
    d = BigInt(d);
    if (d === 0n) throw new RangeError('zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bgcd(n, d) || 1n;
    this.#n = n / g;
    this.#d = d / g;
    Fraction.created++;
  }

  static from(x) {
    if (x instanceof Fraction) return x;
    if (typeof x === 'bigint') return new Fraction(x);
    if (typeof x === 'number') {
      if (Number.isInteger(x)) return new Fraction(BigInt(x));
      const s = String(x);
      const dot = s.indexOf('.');
      const decimals = s.length - dot - 1;
      return new Fraction(BigInt(s.replace('.', '')), 10n ** BigInt(decimals));
    }
    if (typeof x === 'string') {
      const m = /^\s*(-?\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(x);
      if (!m) throw new SyntaxError(`bad fraction "${x}"`);
      return new Fraction(BigInt(m[1]), BigInt(m[2] ?? 1));
    }
    throw new TypeError('cannot convert ' + typeof x);
  }

  get num() {
    return this.#n;
  }
  get den() {
    return this.#d;
  }
  get isZero() {
    return this.#n === 0n;
  }
  get isInteger() {
    return this.#d === 1n;
  }

  add(o) {
    o = Fraction.from(o);
    return new Fraction(this.#n * o.den + o.num * this.#d, this.#d * o.den);
  }
  sub(o) {
    o = Fraction.from(o);
    return new Fraction(this.#n * o.den - o.num * this.#d, this.#d * o.den);
  }
  mul(o) {
    o = Fraction.from(o);
    return new Fraction(this.#n * o.num, this.#d * o.den);
  }
  div(o) {
    o = Fraction.from(o);
    if (o.isZero) throw new RangeError('division by zero');
    return new Fraction(this.#n * o.den, this.#d * o.num);
  }
  neg() {
    return new Fraction(-this.#n, this.#d);
  }
  equals(o) {
    o = Fraction.from(o);
    return this.#n === o.num && this.#d === o.den;
  }
  compare(o) {
    o = Fraction.from(o);
    const l = this.#n * o.den;
    const r = o.num * this.#d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  toString() {
    return this.isInteger ? `${this.#n}` : `${this.#n}/${this.#d}`;
  }
  toJSON() {
    return this.toString();
  }
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return Number(this.#n) / Number(this.#d);
    return this.toString();
  }
}
Fraction.ZERO = new Fraction(0n);
Fraction.ONE = new Fraction(1n);

class MatrixError extends Error {}

class Matrix {
  constructor(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new MatrixError('empty matrix');
    const w = rows[0].length;
    for (const r of rows) if (r.length !== w) throw new MatrixError('ragged rows');
    this.rows = rows.map((r) => r.map((x) => Fraction.from(x)));
  }
  get m() {
    return this.rows.length;
  }
  get n() {
    return this.rows[0].length;
  }
  get isSquare() {
    return this.m === this.n;
  }
  static identity(n) {
    return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  }
  static parse(text) {
    return new Matrix(
      text
        .trim()
        .split(/\s*;\s*/)
        .map((row) => row.split(/[\s,]+/).filter(Boolean))
    );
  }
  at(i, j) {
    return this.rows[i]?.[j] ?? null;
  }
  clone() {
    return new Matrix(this.rows.map((r) => [...r]));
  }
  transpose() {
    return new Matrix(this.rows[0].map((_, j) => this.rows.map((r) => r[j])));
  }
  map(fn) {
    return new Matrix(this.rows.map((r, i) => r.map((x, j) => fn(x, i, j))));
  }
  add(o) {
    if (o.m !== this.m || o.n !== this.n) throw new MatrixError('shape mismatch in add');
    return this.map((x, i, j) => x.add(o.rows[i][j]));
  }
  scale(k) {
    return this.map((x) => x.mul(k));
  }
  mul(o) {
    if (this.n !== o.m) throw new MatrixError(`cannot multiply ${this.m}x${this.n} by ${o.m}x${o.n}`);
    const out = [];
    for (let i = 0; i < this.m; i++) {
      const row = [];
      for (let j = 0; j < o.n; j++) {
        let acc = Fraction.ZERO;
        for (let k = 0; k < this.n; k++) acc = acc.add(this.rows[i][k].mul(o.rows[k][j]));
        row.push(acc);
      }
      out.push(row);
    }
    return new Matrix(out);
  }
  pow(e) {
    if (!this.isSquare) throw new MatrixError('pow requires square');
    let result = Matrix.identity(this.n);
    let base = this;
    while (e > 0) {
      if (e & 1) result = result.mul(base);
      base = base.mul(base);
      e >>= 1;
    }
    return result;
  }
  determinant() {
    if (!this.isSquare) throw new MatrixError('determinant requires square');
    const a = this.rows.map((r) => [...r]);
    const n = this.n;
    let det = Fraction.ONE;
    for (let c = 0; c < n; c++) {
      let p = c;
      while (p < n && a[p][c].isZero) p++;
      if (p === n) return Fraction.ZERO;
      if (p !== c) {
        [a[p], a[c]] = [a[c], a[p]];
        det = det.neg();
      }
      det = det.mul(a[c][c]);
      for (let r = c + 1; r < n; r++) {
        const f = a[r][c].div(a[c][c]);
        if (f.isZero) continue;
        for (let k = c; k < n; k++) a[r][k] = a[r][k].sub(f.mul(a[c][k]));
      }
    }
    return det;
  }
  determinantLaplace() {
    if (this.n === 1) return this.rows[0][0];
    if (this.n === 2) {
      const [[a, b], [c, d]] = this.rows;
      return a.mul(d).sub(b.mul(c));
    }
    let sum = Fraction.ZERO;
    for (let j = 0; j < this.n; j++) {
      const minor = new Matrix(this.rows.slice(1).map((r) => r.filter((_, k) => k !== j)));
      const term = this.rows[0][j].mul(minor.determinantLaplace());
      sum = j % 2 === 0 ? sum.add(term) : sum.sub(term);
    }
    return sum;
  }
  rref() {
    const a = this.rows.map((r) => [...r]);
    const pivots = [];
    let lead = 0;
    rowLoop: for (let r = 0; r < this.m; r++) {
      if (lead >= this.n) break;
      let i = r;
      while (a[i][lead].isZero) {
        i++;
        if (i === this.m) {
          i = r;
          lead++;
          if (lead === this.n) break rowLoop;
        }
      }
      [a[i], a[r]] = [a[r], a[i]];
      const lv = a[r][lead];
      a[r] = a[r].map((x) => x.div(lv));
      for (let k = 0; k < this.m; k++) {
        if (k === r) continue;
        const f = a[k][lead];
        a[k] = a[k].map((x, j) => x.sub(f.mul(a[r][j])));
      }
      pivots.push(lead);
      lead++;
    }
    return { matrix: new Matrix(a), pivots };
  }
  rank() {
    return this.rref().pivots.length;
  }
  inverse() {
    if (!this.isSquare) throw new MatrixError('inverse requires square');
    const n = this.n;
    const aug = new Matrix(this.rows.map((r, i) => [...r, ...Matrix.identity(n).rows[i]]));
    const { matrix, pivots } = aug.rref();
    if (pivots.length < n || pivots[n - 1] !== n - 1) throw new MatrixError('matrix is singular');
    return new Matrix(matrix.rows.map((r) => r.slice(n)));
  }
  solve(b) {
    const col = b.map((x) => [x]);
    return this.inverse().mul(new Matrix(col)).rows.map((r) => r[0]);
  }
  equals(o) {
    return this.m === o.m && this.n === o.n && this.rows.every((r, i) => r.every((x, j) => x.equals(o.rows[i][j])));
  }
  toString() {
    const cells = this.rows.map((r) => r.map(String));
    const width = Math.max(...cells.flat().map((s) => s.length));
    return cells.map((r) => '[ ' + r.map((s) => s.padStart(width)).join(' ') + ' ]').join('\n');
  }
}

function show(label, mat) {
  console.log(label + ':');
  for (const line of mat.toString().split('\n')) console.log('  ' + line);
}

function tryOp(label, fn) {
  try {
    const r = fn();
    console.log(`${label}: ${r}`);
    return r;
  } catch (e) {
    console.log(`${label}: ${e.constructor.name} ${e.message}`);
    return null;
  } finally {
    // count every attempt
    tryOp.calls = (tryOp.calls ?? 0) + 1;
  }
}

function hilbert(n) {
  return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => new Fraction(1n, BigInt(i + j + 1)))));
}

function vandermonde(xs) {
  return new Matrix(xs.map((x) => xs.map((_, j) => Fraction.from(x ** j))));
}

function fractionDemo() {
  const a = Fraction.from('3/4');
  const b = Fraction.from(0.125);
  const c = new Fraction(-10n, 4n);
  console.log(`a=${a} b=${b} c=${c}`);
  console.log(`a+b=${a.add(b)} a-b=${a.sub(b)} a*c=${a.mul(c)} a/c=${a.div(c)}`);
  console.log(`numeric a=${+a} c=${+c} cmp(a,b)=${a.compare(b)} cmp(c,a)=${c.compare(a)}`);
  const harmonic = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((acc, k) => acc.add(new Fraction(1n, BigInt(k))), Fraction.ZERO);
  console.log(`H(10) = ${harmonic}`);
  const sorted = ['5/7', '2/3', '-1/2', '7/10', '3/5'].map(Fraction.from).sort((x, y) => x.compare(y));
  console.log('sorted:', sorted.join(' < '));
  tryOp('bad parse', () => Fraction.from('1/x'));
  tryOp('div zero', () => a.div(0));
}

function main() {
  fractionDemo();

  const A = Matrix.parse('2 1 1; 1 3 2; 1 0 0');
  const B = Matrix.parse('1 2; 0 1; 4 0');
  show('A', A);
  show('B', B);
  show('A*B', A.mul(B));
  show('A^T', A.transpose());
  console.log('det(A) gauss   =', String(A.determinant()));
  console.log('det(A) laplace =', String(A.determinantLaplace()));
  const Ai = A.inverse();
  show('inv(A)', Ai);
  console.log('A*inv(A) == I ?', A.mul(Ai).equals(Matrix.identity(3)));

  const H = hilbert(4);
  show('Hilbert(4)', H);
  console.log('det(H4) =', String(H.determinant()));
  const Hi = H.inverse();
  show('inv(H4)', Hi);
  console.log('H*inv(H) == I ?', H.mul(Hi).equals(Matrix.identity(4)));

  const V = vandermonde([1, 2, 3, 5]);
  console.log('det(Vandermonde[1,2,3,5]) =', String(V.determinant()), '=', String(V.determinantLaplace()));

  // solve: x + 2y - z = 3/2, 2x - y + 3z = 7, -x + y + z = 1/3
  const S = new Matrix([[1, 2, -1], [2, -1, 3], [-1, 1, 1]]);
  const sol = S.solve(['3/2', 7, '1/3'].map(Fraction.from));
  console.log('solution:', sol.map(String).join(', '));
  const check = S.mul(new Matrix(sol.map((x) => [x]))).rows.map((r) => String(r[0]));
  console.log('check   :', check.join(', '));

  const fib = new Matrix([[1, 1], [1, 0]]);
  for (const k of [10, 30, 60]) {
    console.log(`fib(${k}) via matrix power = ${fib.pow(k).at(0, 1)}`);
  }

  const singular = Matrix.parse('1 2 3; 2 4 6; 1 1 1');
  console.log('rank(singular) =', singular.rank(), 'det =', String(singular.determinant()));
  tryOp('inverse singular', () => singular.inverse());
  tryOp('bad multiply', () => A.mul(A.mul(B).transpose().transpose().transpose()));
  tryOp('ragged', () => new Matrix([[1, 2], [3]]));
  const { matrix: R, pivots } = singular.rref();
  show('rref(singular)', R);
  console.log('pivots:', pivots.join(','));

  const rot = new Matrix([['0', '-1'], ['1', '0']]);
  console.log('rot^4 == I ?', rot.pow(4).equals(Matrix.identity(2)));
  show('A + 1/2*A^T', A.add(A.transpose().scale('1/2')));
  console.log('JSON:', JSON.stringify({ inv: Ai.rows }));
  console.log(`tryOp calls=${tryOp.calls}, fractions created > 1000: ${Fraction.created > 1000}`);
}

main();
