// a14: recursion - mutual, deep, trees, permutations, backtracking

function isEven(n) {
  return n === 0 ? true : isOdd(n - 1);
}
function isOdd(n) {
  return n === 0 ? false : isEven(n - 1);
}

function mutualRecursion() {
  console.log('even/odd', isEven(10), isOdd(7), isEven(301), isOdd(1000));
  // Hofstadter female/male sequences
  function F(n) {
    return n === 0 ? 1 : n - M(F(n - 1));
  }
  function M(n) {
    return n === 0 ? 0 : n - F(M(n - 1));
  }
  console.log('F', Array.from({ length: 15 }, (_, i) => F(i)).join(','));
  console.log('M', Array.from({ length: 15 }, (_, i) => M(i)).join(','));
}

function sumTo(n) {
  return n === 0 ? 0 : n + sumTo(n - 1);
}

function deepRecursion() {
  console.log('sumTo(2000)', sumTo(2000));
  function depth(n, acc) {
    if (n === 0) return acc.length;
    acc.push(n);
    return depth(n - 1, acc);
  }
  console.log('depth 2000', depth(2000, []));
  function buildList(n) {
    return n === 0 ? null : { v: n, next: buildList(n - 1) };
  }
  function listLen(l) {
    return l === null ? 0 : 1 + listLen(l.next);
  }
  function listSum(l) {
    return l ? l.v + listSum(l.next) : 0;
  }
  const lst = buildList(1500);
  console.log('linked list', listLen(lst), listSum(lst));
  function ackermann(m, n) {
    if (m === 0) return n + 1;
    if (n === 0) return ackermann(m - 1, 1);
    return ackermann(m - 1, ackermann(m, n - 1));
  }
  console.log('ackermann(2,3)', ackermann(2, 3), 'ackermann(3,3)', ackermann(3, 3));
}

class TreeNode {
  constructor(value) {
    this.value = value;
    this.left = null;
    this.right = null;
  }
}

class BST {
  constructor() {
    this.root = null;
  }
  insert(v) {
    this.root = this._insert(this.root, v);
    return this;
  }
  _insert(node, v) {
    if (!node) return new TreeNode(v);
    if (v < node.value) node.left = this._insert(node.left, v);
    else node.right = this._insert(node.right, v);
    return node;
  }
  inorder(node = this.root, out = []) {
    if (node) {
      this.inorder(node.left, out);
      out.push(node.value);
      this.inorder(node.right, out);
    }
    return out;
  }
  preorder(node = this.root) {
    return node ? [node.value, ...this.preorder(node.left), ...this.preorder(node.right)] : [];
  }
  postorder(node = this.root) {
    return node ? [...this.postorder(node.left), ...this.postorder(node.right), node.value] : [];
  }
  height(node = this.root) {
    return node ? 1 + Math.max(this.height(node.left), this.height(node.right)) : 0;
  }
  contains(v, node = this.root) {
    if (!node) return false;
    if (v === node.value) return true;
    return v < node.value ? this.contains(v, node.left) : this.contains(v, node.right);
  }
  render(node = this.root, prefix = '', isLeft = true, lines = []) {
    if (!node) return lines;
    this.render(node.right, prefix + (isLeft ? '|   ' : '    '), false, lines);
    lines.push(prefix + (isLeft ? '\\-- ' : '/-- ') + node.value);
    this.render(node.left, prefix + (isLeft ? '    ' : '|   '), true, lines);
    return lines;
  }
}

function treeAlgorithms() {
  const t = new BST();
  [50, 30, 70, 20, 40, 60, 80, 35, 45, 65].forEach((v) => t.insert(v));
  console.log('inorder', t.inorder().join(' '));
  console.log('preorder', t.preorder().join(' '));
  console.log('postorder', t.postorder().join(' '));
  console.log('height', t.height(), 'contains 45/99', t.contains(45), t.contains(99));
  t.render().forEach((l) => console.log('  ' + l));
  const fs = {
    name: 'root',
    children: [
      { name: 'src', children: [{ name: 'a.js', size: 120 }, { name: 'b.js', size: 300 }, { name: 'lib', children: [{ name: 'c.js', size: 50 }] }] },
      { name: 'README', size: 10 },
      { name: 'empty', children: [] },
    ],
  };
  function totalSize(n) {
    return n.children ? n.children.reduce((s, c) => s + totalSize(c), 0) : n.size;
  }
  function paths(n, prefix = '') {
    const p = prefix + '/' + n.name;
    return n.children ? n.children.flatMap((c) => paths(c, p)) : [p];
  }
  console.log('fs size', totalSize(fs));
  console.log('fs paths', paths(fs).join(' '));
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function combinations(arr, k, start = 0, cur = [], out = []) {
  if (cur.length === k) {
    out.push(cur.slice());
    return out;
  }
  for (let i = start; i < arr.length; i++) {
    cur.push(arr[i]);
    combinations(arr, k, i + 1, cur, out);
    cur.pop();
  }
  return out;
}

function powerSet(arr) {
  if (arr.length === 0) return [[]];
  const rest = powerSet(arr.slice(1));
  return [...rest, ...rest.map((s) => [arr[0], ...s])];
}

function combinatorics() {
  const perms = permutations(['a', 'b', 'c', 'd']);
  console.log('perms count', perms.length, 'first5', perms.slice(0, 5).map((p) => p.join('')).join(' '), 'last', perms[perms.length - 1].join(''));
  console.log('C(5,3)', combinations([1, 2, 3, 4, 5], 3).map((c) => c.join('')).join(' '));
  console.log('powerset', powerSet(['x', 'y', 'z']).map((s) => '{' + s.join('') + '}').join(''));
}

function nQueens(n) {
  const solutions = [];
  const cols = new Set(), d1 = new Set(), d2 = new Set();
  const board = [];
  function place(r) {
    if (r === n) {
      solutions.push(board.slice());
      return;
    }
    for (let c = 0; c < n; c++) {
      if (cols.has(c) || d1.has(r - c) || d2.has(r + c)) continue;
      cols.add(c); d1.add(r - c); d2.add(r + c); board.push(c);
      place(r + 1);
      cols.delete(c); d1.delete(r - c); d2.delete(r + c); board.pop();
    }
  }
  place(0);
  return solutions;
}

function subsetSum(nums, target) {
  const res = [];
  (function bt(i, remaining, chosen) {
    if (remaining === 0) {
      res.push(chosen.join('+'));
      return;
    }
    if (i >= nums.length || remaining < 0) return;
    chosen.push(nums[i]);
    bt(i + 1, remaining - nums[i], chosen);
    chosen.pop();
    bt(i + 1, remaining, chosen);
  })(0, target, []);
  return res;
}

function backtracking() {
  const sols = nQueens(6);
  console.log('6-queens solutions', sols.length);
  sols.forEach((s, idx) => {
    console.log('solution', idx, s.join(''));
    s.forEach((c) => console.log('   ' + '.'.repeat(c) + 'Q' + '.'.repeat(6 - c - 1)));
  });
  console.log('8-queens count', nQueens(8).length);
  console.log('subsetSum', subsetSum([3, 34, 4, 12, 5, 2], 9).join(' | '));
}

function hanoi(n, from, to, via, moves) {
  if (n === 0) return moves;
  hanoi(n - 1, from, via, to, moves);
  moves.push(from + to);
  hanoi(n - 1, via, to, from, moves);
  return moves;
}

function misc() {
  const m = hanoi(4, 'A', 'C', 'B', []);
  console.log('hanoi(4)', m.length, m.join(' '));
  const flattenDeep = (a) => a.reduce((acc, x) => (Array.isArray(x) ? acc.concat(flattenDeep(x)) : acc.concat(x)), []);
  console.log('flattenDeep', flattenDeep([1, [2, [3, [4, [5, [6]]]]]]).join(','));
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  console.log('deepEqual', deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), deepEqual({ a: 1 }, { a: '1' }));
  function mergeSort(a) {
    if (a.length < 2) return a;
    const mid = a.length >> 1;
    const l = mergeSort(a.slice(0, mid)), r = mergeSort(a.slice(mid));
    const out = [];
    while (l.length && r.length) out.push(l[0] <= r[0] ? l.shift() : r.shift());
    return out.concat(l, r);
  }
  console.log('mergeSort', mergeSort([38, 27, 43, 3, 9, 82, 10, 1, 55]).join(','));
  function quickSort(a) {
    if (a.length < 2) return a;
    const [p, ...rest] = a;
    return [...quickSort(rest.filter((x) => x < p)), p, ...quickSort(rest.filter((x) => x >= p))];
  }
  console.log('quickSort', quickSort([5, 3, 8, 1, 9, 2, 7, 5]).join(','));
}

mutualRecursion();
deepRecursion();
treeAlgorithms();
combinatorics();
backtracking();
misc();
console.log('done a14');
