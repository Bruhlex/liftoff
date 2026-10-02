// d21: B-tree (order 4) with insert / delete / range queries and invariant checks.
// Deterministic stress program for a VM decompiler.

var LOG_PREFIX = 'bt';
var logCount = 0;

function out() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    parts.push(typeof a === 'string' ? a : JSON.stringify(a));
  }
  logCount++;
  console.log(parts.join(' '));
}

// ---------- deterministic PRNG ----------
function makeRng(seed) {
  let s = seed >>> 0;
  const rng = {
    next() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s;
    },
    int(n) { return this.next() % n; },
    pick(arr) { return arr[this.int(arr.length)]; },
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return rng;
}

// ---------- comparator layer ----------
const Cmp = {
  numeric: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  reverse: (a, b) => Cmp.numeric(b, a),
  bigint: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  byKey(key) {
    return (a, b) => Cmp.numeric(a?.[key] ?? 0, b?.[key] ?? 0);
  },
};

class InvariantError extends Error {
  constructor(msg, detail) {
    super(msg);
    this.detail = detail ?? null;
    this.kind = new.target === InvariantError ? 'invariant' : 'derived';
  }
}
class OrderError extends InvariantError {}
class DepthError extends InvariantError {}

// ---------- nodes ----------
class BaseNode {
  static #created = 0;
  static get created() { return BaseNode.#created; }
  static resetCount() { BaseNode.#created = 0; }
  #id;
  constructor() {
    this.#id = ++BaseNode.#created;
    this.keys = [];
    this.vals = [];
  }
  get id() { return this.#id; }
  get size() { return this.keys.length; }
  static isNode(o) { return typeof o === 'object' && o !== null && #id in o; }
}

class Node extends BaseNode {
  constructor(leaf) {
    super();
    this.leaf = !!leaf;
    this.children = [];
  }
  get [Symbol.toStringTag]() { return this.leaf ? 'Leaf' : 'Inner'; }
  describe() {
    return `${Object.prototype.toString.call(this)}#${this.id}[${this.keys.join(',')}]`;
  }
}

// ---------- the tree ----------
class BTree {
  static ORDER = 4;
  static MAX_KEYS;
  static MIN_KEYS;
  static {
    BTree.MAX_KEYS = BTree.ORDER - 1;
    BTree.MIN_KEYS = Math.ceil(BTree.ORDER / 2) - 1;
  }
  #cmp;
  #count = 0;
  #ops = { insert: 0, remove: 0, split: 0, merge: 0, borrow: 0 };
  constructor(cmp = Cmp.numeric) {
    this.#cmp = cmp;
    this.root = new Node(true);
  }
  get count() { return this.#count; }
  get ops() { return { ...this.#ops }; }
  #bump(k) { this.#ops[k] = (this.#ops[k] || 0) + 1; }

  #search(node, key) {
    // binary search: returns index of first key >= key
    let lo = 0, hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#cmp(node.keys[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get(key) {
    let node = this.root;
    for (;;) {
      const i = this.#search(node, key);
      if (i < node.keys.length && this.#cmp(node.keys[i], key) === 0) return node.vals[i];
      if (node.leaf) return undefined;
      node = node.children[i];
    }
  }

  has(key) { return this.get(key) !== undefined; }

  set(key, val) {
    this.#bump('insert');
    const r = this.root;
    if (r.keys.length === BTree.MAX_KEYS) {
      const s = new Node(false);
      s.children.push(r);
      this.#splitChild(s, 0);
      this.root = s;
    }
    const added = this.#insertNonFull(this.root, key, val);
    if (added) this.#count++;
    return added;
  }

  #splitChild(parent, idx) {
    this.#bump('split');
    const full = parent.children[idx];
    const right = new Node(full.leaf);
    const mid = Math.floor(BTree.MAX_KEYS / 2);
    const upKey = full.keys[mid], upVal = full.vals[mid];
    right.keys = full.keys.splice(mid + 1);
    right.vals = full.vals.splice(mid + 1);
    full.keys.length = mid;
    full.vals.length = mid;
    if (!full.leaf) right.children = full.children.splice(mid + 1);
    parent.keys.splice(idx, 0, upKey);
    parent.vals.splice(idx, 0, upVal);
    parent.children.splice(idx + 1, 0, right);
  }

  #insertNonFull(node, key, val) {
    descend: for (;;) {
      let i = this.#search(node, key);
      if (i < node.keys.length && this.#cmp(node.keys[i], key) === 0) {
        node.vals[i] = val;
        return false;
      }
      if (node.leaf) {
        node.keys.splice(i, 0, key);
        node.vals.splice(i, 0, val);
        return true;
      }
      if (node.children[i].keys.length === BTree.MAX_KEYS) {
        this.#splitChild(node, i);
        const c = this.#cmp(key, node.keys[i]);
        if (c === 0) { node.vals[i] = val; return false; }
        if (c > 0) i++;
      }
      node = node.children[i];
      continue descend;
    }
  }

  delete(key) {
    this.#bump('remove');
    const removed = this.#remove(this.root, key);
    if (this.root.keys.length === 0 && !this.root.leaf) {
      this.root = this.root.children[0];
    }
    if (removed) this.#count--;
    return removed;
  }

  #remove(node, key) {
    const i = this.#search(node, key);
    const found = i < node.keys.length && this.#cmp(node.keys[i], key) === 0;
    if (node.leaf) {
      if (!found) return false;
      node.keys.splice(i, 1);
      node.vals.splice(i, 1);
      return true;
    }
    if (found) {
      const left = node.children[i], right = node.children[i + 1];
      if (left.keys.length > BTree.MIN_KEYS) {
        let p = left;
        while (!p.leaf) p = p.children[p.children.length - 1];
        const pk = p.keys[p.keys.length - 1], pv = p.vals[p.vals.length - 1];
        node.keys[i] = pk; node.vals[i] = pv;
        return this.#remove(left, pk);
      } else if (right.keys.length > BTree.MIN_KEYS) {
        let s = right;
        while (!s.leaf) s = s.children[0];
        const sk = s.keys[0], sv = s.vals[0];
        node.keys[i] = sk; node.vals[i] = sv;
        return this.#remove(right, sk);
      } else {
        this.#merge(node, i);
        return this.#remove(left, key);
      }
    }
    let idx = i;
    const child = node.children[idx];
    if (child.keys.length <= BTree.MIN_KEYS) {
      const leftSib = node.children[idx - 1];
      const rightSib = node.children[idx + 1];
      switch (true) {
        case !!leftSib && leftSib.keys.length > BTree.MIN_KEYS:
          this.#bump('borrow');
          child.keys.unshift(node.keys[idx - 1]);
          child.vals.unshift(node.vals[idx - 1]);
          node.keys[idx - 1] = leftSib.keys.pop();
          node.vals[idx - 1] = leftSib.vals.pop();
          if (!leftSib.leaf) child.children.unshift(leftSib.children.pop());
          break;
        case !!rightSib && rightSib.keys.length > BTree.MIN_KEYS:
          this.#bump('borrow');
          child.keys.push(node.keys[idx]);
          child.vals.push(node.vals[idx]);
          node.keys[idx] = rightSib.keys.shift();
          node.vals[idx] = rightSib.vals.shift();
          if (!rightSib.leaf) child.children.push(rightSib.children.shift());
          break;
        case !!rightSib:
          this.#merge(node, idx);
          break;
        default:
          this.#merge(node, idx - 1);
          idx--;
      }
    }
    return this.#remove(node.children[idx], key);
  }

  #merge(node, i) {
    this.#bump('merge');
    const left = node.children[i], right = node.children[i + 1];
    left.keys.push(node.keys[i], ...right.keys);
    left.vals.push(node.vals[i], ...right.vals);
    if (!left.leaf) left.children.push(...right.children);
    node.keys.splice(i, 1);
    node.vals.splice(i, 1);
    node.children.splice(i + 1, 1);
  }

  *entries(node = this.root) {
    if (node.leaf) {
      for (let i = 0; i < node.keys.length; i++) yield [node.keys[i], node.vals[i]];
      return node.keys.length;
    }
    let total = 0;
    for (let i = 0; i < node.keys.length; i++) {
      total += yield* this.entries(node.children[i]);
      yield [node.keys[i], node.vals[i]];
      total++;
    }
    total += yield* this.entries(node.children[node.keys.length]);
    return total;
  }

  *range(lo, hi, node = this.root) {
    let i = this.#search(node, lo);
    for (; i <= node.keys.length; i++) {
      if (!node.leaf) yield* this.range(lo, hi, node.children[i]);
      if (i === node.keys.length) break;
      const k = node.keys[i];
      if (this.#cmp(k, hi) > 0) return;
      yield [k, node.vals[i]];
    }
  }

  [Symbol.iterator]() { return this.entries(); }

  keys() { return Array.from(this, ([k]) => k); }

  height() {
    let h = 1, n = this.root;
    while (!n.leaf) { h++; n = n.children[0]; }
    return h;
  }

  check() {
    const cmp = this.#cmp;
    let leafDepth = -1;
    let counted = 0;
    const visit = (node, depth, lo, hi, isRoot) => {
      if (!BaseNode.isNode(node)) throw new InvariantError('not a node');
      if (!isRoot && node.keys.length < BTree.MIN_KEYS)
        throw new InvariantError('underflow', node.describe());
      if (node.keys.length > BTree.MAX_KEYS) throw new InvariantError('overflow', node.describe());
      for (let i = 0; i < node.keys.length; i++) {
        const k = node.keys[i];
        if (i > 0 && cmp(node.keys[i - 1], k) >= 0) throw new OrderError('unsorted', node.describe());
        if (lo !== undefined && cmp(k, lo) <= 0) throw new OrderError('below lo', { k, lo });
        if (hi !== undefined && cmp(k, hi) >= 0) throw new OrderError('above hi', { k, hi });
      }
      counted += node.keys.length;
      if (node.leaf) {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) throw new DepthError('uneven leaves', { leafDepth, depth });
        return;
      }
      if (node.children.length !== node.keys.length + 1)
        throw new InvariantError('child count', node.describe());
      node.children.forEach((c, i) =>
        visit(c, depth + 1, i === 0 ? lo : node.keys[i - 1], i === node.keys.length ? hi : node.keys[i], false));
    };
    visit(this.root, 0, undefined, undefined, true);
    if (counted !== this.#count) throw new InvariantError('count mismatch', { counted, count: this.#count });
    return true;
  }

  dump() {
    const lines = [];
    const q = [[this.root, 0]];
    while (q.length) {
      const [n, d] = q.shift();
      (lines[d] ||= []).push('[' + n.keys.join(',') + ']');
      if (!n.leaf) for (const c of n.children) q.push([c, d + 1]);
    }
    return lines.map((l, d) => d + ':' + l.join(' ')).join(' | ');
  }
}

// ---------- safe check wrapper using exceptions as control flow ----------
function verify(tree, label) {
  let status = 'ok';
  try {
    tree.check();
  } catch (e) {
    switch (true) {
      case e instanceof DepthError:
        status = 'depth:' + e.message;
        break;
      case e instanceof OrderError:
        status = 'order:' + e.message;
        break;
      case e instanceof InvariantError:
        status = 'inv:' + e.message + ':' + JSON.stringify(e.detail);
        break;
      default:
        throw e;
    }
  } finally {
    out(`verify ${label}: ${status} count=${tree.count} h=${tree.height()}`);
  }
  return status === 'ok';
}

// ---------- phase 1: basic inserts ----------
function phaseBasic() {
  out('== phase basic ==');
  BaseNode.resetCount();
  const t = new BTree();
  const seq = [10, 20, 5, 6, 12, 30, 7, 17, 3, 1, 25, 40, 35, 2, 4];
  for (const k of seq) {
    t.set(k, 'v' + k);
  }
  out('dump', t.dump());
  verify(t, 'basic');
  out('keys', t.keys());
  out('get 17', t.get(17), 'get 99', String(t.get(99)));
  out('ops', t.ops);
  out('nodes created', BaseNode.created);
  const r = [...t.range(6, 25)].map(([k]) => k);
  out('range 6..25', r);
  // overwrite
  const added = t.set(12, 'twelve');
  out('overwrite 12 added?', added, 'val', t.get(12));
  return t;
}

// ---------- phase 2: deletes covering all cases ----------
function phaseDelete(t) {
  out('== phase delete ==');
  const order = [6, 13, 7, 4, 2, 16, 1, 30, 25, 20];
  const results = [];
  outer: for (const k of order) {
    let tries = 0;
    do {
      tries++;
      if (tries > 1) continue outer;
      const ok = t.delete(k);
      results.push(`${k}:${ok ? 'del' : 'miss'}`);
      if (!verify(t, 'del' + k)) break outer;
    } while (tries < 2);
  }
  out('results', results.join(' '));
  out('dump', t.dump());
  out('ops', t.ops);
}

// ---------- phase 3: random stress with a shadow Map ----------
function phaseStress(seed, n) {
  out(`== phase stress seed=${seed} n=${n} ==`);
  const rng = makeRng(seed);
  const t = new BTree();
  const shadow = new Map();
  let mismatches = 0;
  const checkpoints = [];
  for (let step = 0; step < n; step++) {
    const k = rng.int(200);
    const op = rng.int(10);
    if (op < 6) {
      t.set(k, step);
      shadow.set(k, step);
    } else {
      const a = t.delete(k), b = shadow.delete(k);
      if (a !== b) mismatches++;
    }
    if (step % 250 === 249) {
      let ok;
      try { ok = t.check(); } catch (e) { ok = e.message; }
      checkpoints.push(`${step}:${ok}:${t.count}`);
    }
  }
  const sortedShadow = [...shadow.keys()].sort((a, b) => a - b);
  const treeKeys = t.keys();
  const same = sortedShadow.length === treeKeys.length && sortedShadow.every((k, i) => k === treeKeys[i]);
  out('checkpoints', checkpoints);
  out('mismatches', mismatches, 'same', same, 'count', t.count, 'height', t.height());
  let valuesOk = true;
  for (const [k, v] of shadow) if (t.get(k) !== v) { valuesOk = false; break; }
  out('values ok', valuesOk);
  const ops = t.ops;
  out('ops', ops.insert, ops.remove, ops.split, ops.merge, ops.borrow);
  // range sums
  const sums = [];
  for (let lo = 0; lo < 200; lo += 40) {
    let s = 0, c = 0;
    for (const [k] of t.range(lo, lo + 39)) { s += k; c++; }
    sums.push(`${lo}:${c}/${s}`);
  }
  out('range sums', sums.join(' '));
  return t;
}

// ---------- phase 4: generator protocol on tree iteration ----------
function phaseGenerators(t) {
  out('== phase generators ==');
  const it = t.entries();
  const first = [];
  for (let i = 0; i < 5; i++) {
    const { value, done } = it.next();
    if (done) break;
    first.push(value[0]);
  }
  out('first5', first);
  const ret = it.return('early');
  out('return', ret);
  out('after return', it.next());

  const it2 = t.entries();
  it2.next();
  let thrown = 'none';
  try {
    it2.throw(new Error('boom'));
  } catch (e) {
    thrown = e.message;
  }
  out('throw', thrown);

  // collect return value of yield*
  function* wrapper(tree) {
    const total = yield* tree.entries();
    return `total=${total}`;
  }
  const w = wrapper(t);
  let r, n = 0;
  while (!(r = w.next()).done) n++;
  out('wrapper yielded', n, r.value);

  // zipped iteration with labeled break
  const a = t.range(0, 100), b = t.range(100, 200);
  const pairs = [];
  zip: while (true) {
    const x = a.next(), y = b.next();
    switch (true) {
      case x.done && y.done: break zip;
      case x.done: pairs.push('-/' + y.value[0]); break;
      case y.done: pairs.push(x.value[0] + '/-'); break;
      default: pairs.push(x.value[0] + '/' + y.value[0]);
    }
    if (pairs.length >= 12) break zip;
  }
  out('zip', pairs.join(' '));
}

// ---------- phase 5: tree of composite keys, reverse comparator, bigint ----------
function phaseComparators() {
  out('== phase comparators ==');
  const rev = new BTree(Cmp.reverse);
  for (let i = 1; i <= 20; i++) rev.set((i * 7) % 23, i);
  out('reverse keys', rev.keys());
  verify(rev, 'rev');

  const big = new BTree(Cmp.bigint);
  let x = 1n;
  for (let i = 0; i < 25; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    big.set(x % 100000n, i);
  }
  out('big count', big.count, 'first', String(big.keys()[0]), 'last', String(big.keys().at(-1)));
  verify(big, 'big');
  const bigRange = [...big.range(20000n, 60000n)].map(([k, v]) => `${k}n:${v}`);
  out('big range', bigRange.join(','));

  // string keys
  const str = new BTree((a, b) => a.localeCompare === undefined ? 0 : (a < b ? -1 : a > b ? 1 : 0));
  const words = 'the quick brown fox jumps over the lazy dog and runs far away from here'.split(' ');
  words.forEach((w, i) => str.set(w, (str.get(w) ?? 0) + i));
  out('words', str.keys().join(' '));
  out('word vals', JSON.stringify(Object.fromEntries(str)));
  verify(str, 'str');
}

// ---------- phase 6: proxy-observed tree ----------
function observed(tree, log) {
  return new Proxy(tree, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, target);
      if (typeof v === 'function' && typeof prop === 'string' && ['set', 'delete', 'get'].includes(prop)) {
        return function (...args) {
          const res = v.apply(target, args);
          log.push(`${prop}(${args.map(a => JSON.stringify(a)).join(',')})=${JSON.stringify(res ?? null)}`);
          return res;
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      return prop === 'magic' || Reflect.has(target, prop);
    },
  });
}

function phaseProxy() {
  out('== phase proxy ==');
  const log = [];
  const p = observed(new BTree(), log);
  [5, 3, 8, 1, 4, 7, 9, 2, 6].forEach(k => p.set(k, k * k));
  p.get(4); p.delete(3); p.delete(100); p.get(3);
  out('log size', log.length);
  out('log tail', log.slice(-5));
  out('magic in', 'magic' in p, 'root in', 'root' in p, 'nope in', 'nope' in p);
  out('count via proxy', p.count, 'keys', p.keys());
  out('check via proxy', p.check());
}

// ---------- phase 7: bulk load + range queries with closures ----------
function phaseClosures() {
  out('== phase closures ==');
  const t = new BTree();
  for (let i = 0; i < 64; i++) t.set(i * 3, { id: i, sq: i * i });
  const queries = [];
  for (let lo = 0; lo < 150; lo += 30) {
    queries.push(() => [...t.range(lo, lo + 20)].map(([k, v]) => v.id));
  }
  const byKey = {};
  for (const k in { a: 0, b: 0, c: 0 }) {
    byKey[k] = () => k + ':' + t.get(k.charCodeAt(0) - 97 + 30)?.sq;
  }
  var fns = [];
  for (var v = 0; v < 3; v++) fns.push(() => v);
  out('queries', queries.map(q => q().join(',')));
  out('byKey', Object.keys(byKey).map(k => byKey[k]()));
  out('var closure', fns.map(f => f()));
  const hist = t.keys().reduce((acc, k) => {
    const bucket = (k / 50) | 0;
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, {});
  out('hist', hist);
}

// ---------- phase 8: deep recursion - sorted-array to tree and recursive sum ----------
function recursiveSum(arr, i) {
  if (i >= arr.length) return 0;
  return arr[i] + recursiveSum(arr, i + 1);
}
function isEvenR(n) { return n === 0 ? true : isOddR(n - 1); }
function isOddR(n) { return n === 0 ? false : isEvenR(n - 1); }

function phaseDeep() {
  out('== phase deep ==');
  const t = new BTree();
  for (let i = 0; i < 3000; i++) t.set((i * 7919) % 3001, i);
  verify(t, 'deep');
  const ks = t.keys();
  out('sum rec', recursiveSum(ks, 0));
  out('parity', isEvenR(2999), isOddR(2999), isEvenR(3000));
  // delete every other key
  let deleted = 0;
  for (const k of ks) {
    if (k % 2 === 0) continue;
    if (t.delete(k)) deleted++;
  }
  out('deleted odd', deleted);
  verify(t, 'deep-after');
  // delete everything, checking periodically
  const rng = makeRng(99);
  const remaining = rng.shuffle(t.keys());
  let checks = 0;
  for (let i = 0; i < remaining.length; i++) {
    t.delete(remaining[i]);
    if (i % 300 === 0) { t.check(); checks++; }
  }
  out('emptied', t.count, 'checks', checks, 'height', t.height(), 'dump', t.dump());
}

// ---------- phase 9: sloppy arguments, finally-return, void/delete/typeof ----------
function sloppyArgs(a, b) {
  arguments[0] = 'changed';
  var res = [a, b, arguments.length];
  return res;
}

function finallyOverride(t, k) {
  try {
    if (!t.has(k)) throw new RangeError('missing ' + k);
    return 'found ' + k;
  } catch (e) {
    return 'caught ' + e.message;
  } finally {
    if (k === 42) return 'finally-wins';
  }
}

function loopFinally(t) {
  const trace = [];
  for (let i = 0; i < 6; i++) {
    try {
      if (i === 1) continue;
      if (i === 4) break;
      trace.push('body' + i);
    } finally {
      trace.push('fin' + i);
    }
  }
  return trace;
}

function phaseMisc() {
  out('== phase misc ==');
  const t = new BTree();
  [1, 2, 3, 42].forEach(k => t.set(k, true));
  out('sloppy', sloppyArgs(1, 2), sloppyArgs(1));
  out('finally', finallyOverride(t, 2), finallyOverride(t, 9), finallyOverride(t, 42));
  out('loopFinally', loopFinally(t));
  const o = { a: 1, b: 2 };
  const deleted = delete o.a;
  out('delete', deleted, JSON.stringify(o), 'void', typeof void 0, 'typeof t', typeof t, typeof BTree);
  out('instanceof', t.root instanceof Node, t.root instanceof BaseNode, t instanceof Node);
  const Evenish = { [Symbol.hasInstance]: (x) => typeof x === 'number' && x % 2 === 0 };
  out('hasInstance', 4 instanceof Evenish, 5 instanceof Evenish);
  const money = { amount: 12, [Symbol.toPrimitive](hint) { return hint === 'number' ? this.amount : `$${this.amount}`; } };
  out('toPrimitive', `${money}`, +money + 1, money * 2);
  let seq = (t.set(5, 1), t.set(6, 1), t.count);
  out('comma', seq);
  lbl: {
    if (t.has(5)) break lbl;
    out('unreachable');
  }
  const cfg = { depth: null, opts: { v: 0 } };
  cfg.depth ??= 3;
  cfg.opts.v ||= 9;
  cfg.opts.w &&= 1;
  cfg.name ||= 'tree';
  out('logical assign', JSON.stringify(cfg));
  out('optional call', t.nothing?.(), t.keys?.().length, cfg.opts?.missing?.deep ?? 'dflt');
}

// ---------- phase 10: serialization with reviver/replacer ----------
function serialize(tree) {
  const walk = (n) => (n.leaf ? { k: n.keys, v: n.vals } : { k: n.keys, v: n.vals, c: n.children.map(walk) });
  return JSON.stringify(walk(tree.root), (key, value) => (typeof value === 'bigint' ? { $big: String(value) } : value));
}

function deserialize(json, cmp) {
  const t = new BTree(cmp);
  const obj = JSON.parse(json, (key, value) => (value && typeof value === 'object' && '$big' in value ? BigInt(value.$big) : value));
  const build = ({ k, v, c }) => {
    const n = new Node(!c);
    n.keys = k; n.vals = v;
    if (c) n.children = c.map(build);
    return n;
  };
  t.root = build(obj);
  let cnt = 0;
  for (const _ of t) cnt++;
  // fix count via inserting into fresh tree to test equality
  const fresh = new BTree(cmp);
  for (const [k, v] of t) fresh.set(k, v);
  return { cnt, fresh };
}

function phaseSerialize() {
  out('== phase serialize ==');
  const t = new BTree(Cmp.bigint);
  for (let i = 0n; i < 30n; i++) t.set(i * i % 97n, Number(i));
  const json = serialize(t);
  out('json length', json.length);
  out('json head', json.slice(0, 80));
  const { cnt, fresh } = deserialize(json, Cmp.bigint);
  out('roundtrip count', cnt, fresh.count);
  verify(fresh, 'fresh');
  out('same dump', serialize(fresh) === json);
}

// ---------- main ----------
function main() {
  const t = phaseBasic();
  phaseDelete(t);
  phaseStress(12345, 2000);
  const t2 = phaseStress(777, 1500);
  phaseGenerators(t2);
  phaseComparators();
  phaseProxy();
  phaseClosures();
  phaseDeep();
  phaseMisc();
  phaseSerialize();
  out(`${LOG_PREFIX} done, lines=${logCount + 1}`);
}

main();
