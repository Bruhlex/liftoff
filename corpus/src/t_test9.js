// Testprogramm für die obfuscator.io VM-Obfuskierung (kompakt):
// Ausdrucks-Parser mit Interpreter + Dijkstra. Deterministisch.

// ---------- Tokenizer (Generator) ----------
function* tokenize(src) {
  const re = /\s*(\d+\.?\d*|[a-z]+|\*\*|[-+*/%(),=])/gy;
  let m;
  while ((m = re.exec(src)) !== null) {
    const t = m[1];
    if (/^\d/.test(t)) yield { type: "num", value: parseFloat(t) };
    else if (/^[a-z]/.test(t)) yield { type: "id", value: t };
    else yield { type: "op", value: t };
  }
}

// ---------- Recursive-Descent-Parser ----------
class Parser {
  constructor(src) {
    this.tokens = [...tokenize(src)];
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos]?.value;
  }
  next() {
    return this.tokens[this.pos++];
  }
  expect(v) {
    if (this.next()?.value !== v) throw new SyntaxError(`erwartet ${v}`);
  }
  parse() {
    const node = this.assignment();
    if (this.pos < this.tokens.length) throw new SyntaxError(`unerwartet ${this.peek()}`);
    return node;
  }
  assignment() {
    const t = this.tokens[this.pos];
    if (t?.type === "id" && this.tokens[this.pos + 1]?.value === "=") {
      this.pos += 2;
      return { k: "set", name: t.value, value: this.assignment() };
    }
    return this.additive();
  }
  additive() {
    let left = this.term();
    while (this.peek() === "+" || this.peek() === "-") {
      left = { k: "bin", op: this.next().value, left, right: this.term() };
    }
    return left;
  }
  term() {
    let left = this.power();
    while (["*", "/", "%"].includes(this.peek())) {
      left = { k: "bin", op: this.next().value, left, right: this.power() };
    }
    return left;
  }
  power() {
    const base = this.unary();
    return this.peek() === "**" ? (this.next(), { k: "bin", op: "**", left: base, right: this.power() }) : base;
  }
  unary() {
    if (this.peek() === "-") {
      this.next();
      return { k: "neg", arg: this.unary() };
    }
    return this.primary();
  }
  primary() {
    const t = this.next();
    if (!t) throw new SyntaxError("Ende erreicht");
    if (t.type === "num") return { k: "num", value: t.value };
    if (t.type === "id") {
      if (this.peek() !== "(") return { k: "var", name: t.value };
      this.next();
      const args = [];
      while (this.peek() !== ")") {
        args.push(this.assignment());
        if (this.peek() === ",") this.next();
      }
      this.expect(")");
      return { k: "call", name: t.value, args };
    }
    if (t.value === "(") {
      const e = this.assignment();
      this.expect(")");
      return e;
    }
    throw new SyntaxError(`unerwartet ${t.value}`);
  }
}

// ---------- Interpreter ----------
const OPS = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, "%": (a, b) => a % b, "**": (a, b) => a ** b };
const FUNCS = { max: Math.max, min: Math.min, sqrt: Math.sqrt, sum: (...xs) => xs.reduce((a, b) => a + b, 0) };

function evaluate(node, env) {
  switch (node.k) {
    case "num": return node.value;
    case "var":
      if (!env.has(node.name)) throw new ReferenceError(`unbekannt: ${node.name}`);
      return env.get(node.name);
    case "set": {
      const v = evaluate(node.value, env);
      env.set(node.name, v);
      return v;
    }
    case "neg": return -evaluate(node.arg, env);
    case "bin": return OPS[node.op](evaluate(node.left, env), evaluate(node.right, env));
    case "call": return FUNCS[node.name](...node.args.map((a) => evaluate(a, env)));
    default: throw new Error(`Knoten ${node.k}`);
  }
}

// ---------- Dijkstra ----------
function dijkstra(edges, start) {
  const graph = new Map();
  for (const [a, b, w] of edges) {
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push([b, w]);
    graph.get(b).push([a, w]);
  }
  const dist = new Map([...graph.keys()].map((k) => [k, Infinity]));
  const prev = new Map();
  const todo = new Set(graph.keys());
  dist.set(start, 0);
  while (todo.size) {
    let u = null;
    for (const v of todo) if (u === null || dist.get(v) < dist.get(u)) u = v;
    todo.delete(u);
    for (const [v, w] of graph.get(u)) {
      const alt = dist.get(u) + w;
      if (alt < dist.get(v)) {
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }
  const pathTo = (target) => {
    const path = [];
    for (let n = target; n !== undefined; n = prev.get(n)) path.unshift(n);
    return path;
  };
  return { dist, pathTo };
}

// ---------- main ----------
const env = new Map([["pi", 3.14159]]);
const programs = ["x = 3", "y = x * 2 + 1", "2 ** 3 ** 2", "-(x + y) % 4", "max(x, y, 10) - min(4, sqrt(16))", "sum(1, 2, 3, x) / 2", "r = 2", "pi * r ** 2", "z + 1", "3 +"];
for (const src of programs) {
  try {
    const v = evaluate(new Parser(src).parse(), env);
    console.log(`${src.padEnd(34)} => ${Number.isInteger(v) ? v : v.toFixed(4)}`);
  } catch (e) {
    console.log(`${src.padEnd(34)} !! ${e.name}: ${e.message}`);
  }
}
console.log("env:", [...env].map(([k, v]) => `${k}=${v}`).join(", "));

const { dist, pathTo } = dijkstra(
  [["A", "B", 4], ["A", "C", 2], ["B", "C", 5], ["B", "D", 10], ["C", "E", 3], ["E", "D", 4], ["D", "F", 11]],
  "A",
);
for (const node of ["B", "D", "F"]) console.log(`A -> ${node}: ${dist.get(node)} via ${pathTo(node).join(" > ")}`);
