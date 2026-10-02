// Graph algorithms: BFS, DFS, Dijkstra with binary heap, topological sort, union-find, MST.
'use strict';

class BinaryHeap {
  #items = [];
  #cmp;
  static pushes = 0;
  static pops = 0;

  constructor(cmp = (a, b) => a - b) {
    this.#cmp = cmp;
  }
  get size() {
    return this.#items.length;
  }
  get isEmpty() {
    return this.#items.length === 0;
  }
  peek() {
    return this.#items[0];
  }
  push(value) {
    BinaryHeap.pushes++;
    const a = this.#items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.#cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
    return this;
  }
  pop() {
    BinaryHeap.pops++;
    const a = this.#items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.#cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.#cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  *drain() {
    while (!this.isEmpty) yield this.pop();
  }
}

class Graph {
  constructor(directed = false) {
    this.directed = directed;
    this.adj = new Map();
    this.edgeCount = 0;
  }
  addVertex(v) {
    if (!this.adj.has(v)) this.adj.set(v, []);
    return this;
  }
  addEdge(u, v, w = 1) {
    this.addVertex(u).addVertex(v);
    this.adj.get(u).push({ to: v, w });
    if (!this.directed) this.adj.get(v).push({ to: u, w });
    this.edgeCount++;
    return this;
  }
  get vertices() {
    return [...this.adj.keys()];
  }
  neighbors(v) {
    return this.adj.get(v)?.map((e) => e.to) ?? [];
  }
  *edges() {
    const seen = new Set();
    for (const [u, list] of this.adj) {
      for (const { to, w } of list) {
        const key = this.directed ? `${u}>${to}` : [u, to].sort().join('~');
        if (seen.has(key)) continue;
        seen.add(key);
        yield [u, to, w];
      }
    }
  }
  static fromEdgeList(spec, directed = false) {
    const g = new Graph(directed);
    for (const line of spec.trim().split(/\n/)) {
      const m = /^\s*(\w+)\s*(->|--)\s*(\w+)(?:\s*:\s*(\d+))?\s*$/.exec(line);
      if (!m) continue;
      const [, u, , v, w] = m;
      g.addEdge(u, v, w ? Number(w) : 1);
    }
    return g;
  }
}

function bfs(graph, start) {
  const dist = new Map([[start, 0]]);
  const order = [];
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    order.push(u);
    for (const v of graph.neighbors(u)) {
      if (!dist.has(v)) {
        dist.set(v, dist.get(u) + 1);
        queue.push(v);
      }
    }
  }
  return { order, dist };
}

function dfsRecursive(graph, start, visited = new Set(), out = []) {
  visited.add(start);
  out.push(start);
  for (const v of graph.neighbors(start)) {
    if (!visited.has(v)) dfsRecursive(graph, v, visited, out);
  }
  return out;
}

function dfsIterative(graph, start) {
  const visited = new Set();
  const stack = [start];
  const out = [];
  do {
    const u = stack.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    out.push(u);
    const ns = graph.neighbors(u);
    for (let i = ns.length - 1; i >= 0; i--) {
      if (!visited.has(ns[i])) stack.push(ns[i]);
    }
  } while (stack.length > 0);
  return out;
}

function dijkstra(graph, source) {
  const dist = new Map();
  const prev = new Map();
  for (const v of graph.vertices) dist.set(v, Infinity);
  dist.set(source, 0);
  const heap = new BinaryHeap((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  heap.push([0, source]);
  let relaxations = 0;
  while (!heap.isEmpty) {
    const [d, u] = heap.pop();
    if (d > dist.get(u)) continue;
    for (const { to, w } of graph.adj.get(u)) {
      const nd = d + w;
      if (nd < dist.get(to)) {
        dist.set(to, nd);
        prev.set(to, u);
        heap.push([nd, to]);
        relaxations++;
      }
    }
  }
  return { dist, prev, relaxations };
}

function pathTo(prev, target) {
  const path = [];
  let cur = target;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return path;
}

function topoSortKahn(graph) {
  const indeg = new Map(graph.vertices.map((v) => [v, 0]));
  for (const [, list] of graph.adj) for (const { to } of list) indeg.set(to, indeg.get(to) + 1);
  const ready = new BinaryHeap((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [v, d] of indeg) if (d === 0) ready.push(v);
  const out = [];
  while (!ready.isEmpty) {
    const u = ready.pop();
    out.push(u);
    for (const { to } of graph.adj.get(u)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) ready.push(to);
    }
  }
  if (out.length !== graph.vertices.length) {
    throw new Error(`cycle detected; sorted ${out.length}/${graph.vertices.length}`);
  }
  return out;
}

function topoSortDfs(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const out = [];
  let cycle = null;
  const visit = (u, trail) => {
    color.set(u, GRAY);
    for (const v of graph.neighbors(u)) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        cycle ??= [...trail, u, v];
        return;
      }
      if (c === WHITE) visit(v, [...trail, u]);
    }
    color.set(u, BLACK);
    out.push(u);
  };
  for (const v of graph.vertices) if ((color.get(v) ?? WHITE) === WHITE) visit(v, []);
  return cycle ? { cycle } : { order: out.reverse() };
}

class UnionFind {
  constructor(items) {
    this.parent = new Map();
    this.rank = new Map();
    this.finds = 0;
    for (const it of items) {
      this.parent.set(it, it);
      this.rank.set(it, 0);
    }
  }
  find(x) {
    this.finds++;
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (x !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank.get(ra) < this.rank.get(rb)) [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
    if (this.rank.get(ra) === this.rank.get(rb)) this.rank.set(ra, this.rank.get(ra) + 1);
    return true;
  }
  groups() {
    const g = new Map();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(k);
    }
    return [...g.values()].map((xs) => xs.sort()).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  }
}

function kruskal(graph) {
  const uf = new UnionFind(graph.vertices);
  const edges = [...graph.edges()].sort((a, b) => a[2] - b[2] || String(a).localeCompare(String(b)));
  const mst = [];
  let total = 0;
  for (const [u, v, w] of edges) {
    if (uf.union(u, v)) {
      mst.push(`${u}-${v}(${w})`);
      total += w;
    }
  }
  return { mst, total, finds: uf.finds };
}

function countComponents(graph) {
  const seen = new Set();
  let n = 0;
  for (const v of graph.vertices) {
    if (seen.has(v)) continue;
    n++;
    for (const x of bfs(graph, v).order) seen.add(x);
  }
  return n;
}

function gridGraph(rows, cols, walls) {
  const g = new Graph(false);
  const blocked = new Set(walls);
  const id = (r, c) => `${r},${c}`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (blocked.has(id(r, c))) continue;
      g.addVertex(id(r, c));
      if (c + 1 < cols && !blocked.has(id(r, c + 1))) g.addEdge(id(r, c), id(r, c + 1), 1 + ((r * 7 + c) % 3));
      if (r + 1 < rows && !blocked.has(id(r + 1, c))) g.addEdge(id(r, c), id(r + 1, c), 1 + ((r + c * 5) % 4));
    }
  }
  return g;
}

function renderGridPath(rows, cols, walls, path) {
  const onPath = new Set(path);
  const blocked = new Set(walls);
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const k = `${r},${c}`;
      line += blocked.has(k) ? '#' : onPath.has(k) ? '*' : '.';
    }
    lines.push(line);
  }
  return lines;
}

function main() {
  const city = Graph.fromEdgeList(`
    A -- B : 4
    A -- C : 2
    B -- C : 5
    B -- D : 10
    C -- E : 3
    E -- D : 4
    D -- F : 11
    E -- F : 9
    G -- H : 1
  `);
  console.log(`city: ${city.vertices.length} vertices, ${city.edgeCount} edges`);
  const { order, dist } = bfs(city, 'A');
  console.log('BFS order:', order.join(' '));
  console.log('BFS hops:', [...dist].map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('DFS rec :', dfsRecursive(city, 'A').join(' '));
  console.log('DFS iter:', dfsIterative(city, 'A').join(' '));
  console.log('components:', countComponents(city));

  const dj = dijkstra(city, 'A');
  for (const v of city.vertices) {
    const d = dj.dist.get(v);
    const p = Number.isFinite(d) ? pathTo(dj.prev, v).join('->') : 'unreachable';
    console.log(`  dist(A,${v}) = ${d} via ${p}`);
  }
  console.log('relaxations:', dj.relaxations);

  const mst = kruskal(city);
  console.log('MST:', mst.mst.join(' '), 'total', mst.total, 'finds', mst.finds);

  const build = Graph.fromEdgeList(`
    utils -> core
    core -> net
    core -> db
    net -> api
    db -> api
    api -> app
    ui -> app
    config -> core
    config -> ui
  `, true);
  console.log('Kahn topo:', topoSortKahn(build).join(' < '));
  const dfsTopo = topoSortDfs(build);
  console.log('DFS topo :', dfsTopo.order?.join(' < ') ?? 'n/a');

  build.addEdge('app', 'utils');
  try {
    topoSortKahn(build);
  } catch (e) {
    console.log('Kahn error:', e.message);
  } finally {
    console.log('after cycle check, edges =', build.edgeCount);
  }
  const cyc = topoSortDfs(build);
  console.log('DFS cycle:', cyc.cycle ? cyc.cycle.join(' -> ') : 'none');

  const uf = new UnionFind('abcdefghij'.split(''));
  const pairs = [['a', 'b'], ['c', 'd'], ['b', 'd'], ['e', 'f'], ['g', 'h'], ['h', 'i'], ['a', 'c'], ['i', 'g']];
  for (const [x, y] of pairs) console.log(`  union(${x},${y}) -> ${uf.union(x, y)}`);
  console.log('groups:', uf.groups().map((g) => `{${g.join('')}}`).join(' '));
  console.log('same(a,d)?', uf.find('a') === uf.find('d'), 'same(a,e)?', uf.find('a') === uf.find('e'));

  const walls = ['1,1', '1,2', '1,3', '3,0', '3,1', '3,2', '2,4', '4,3', '0,5'];
  const grid = gridGraph(5, 7, walls);
  const gd = dijkstra(grid, '0,0');
  const target = '4,6';
  const gpath = pathTo(gd.prev, target);
  console.log(`grid shortest ${target}: cost=${gd.dist.get(target)} steps=${gpath.length - 1}`);
  for (const line of renderGridPath(5, 7, walls, gpath)) console.log('  ' + line);

  const heap = new BinaryHeap((a, b) => b - a);
  [5, 3, 17, 10, 84, 19, 6, 22, 9].forEach((n) => heap.push(n));
  console.log('max-heap drain:', [...heap.drain()].join(','));
  console.log(`heap stats: pushes=${BinaryHeap.pushes} pops=${BinaryHeap.pops}`);

  const degree = {};
  for (const [v, list] of city.adj) degree[v] = list.length;
  console.log('degrees:', JSON.stringify(degree));
}

main();
