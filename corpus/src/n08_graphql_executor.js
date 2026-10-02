'use strict';
// n08: GraphQL-like query language: lexer, parser, validator, executor with
// fragments, variables, directives, unions/interfaces, null propagation,
// DataLoader batching, persisted queries and NDJSON subscriptions over http.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter, once, on } = require('events');

// ---------------------------------------------------------------- errors
class GraphQLSyntaxError extends Error {
  constructor(message, pos) { super(`Syntax Error: ${message}` + (pos !== undefined ? ` (at ${pos})` : '')); }
}
class GraphQLError extends Error {
  constructor(message, path, code) {
    super(message);
    this.path = path;
    this.code = code;
  }
  toJSON() { return { message: this.message, ...(this.path && { path: this.path }), ...(this.code && { extensions: { code: this.code } }) }; }
}
class PropagatedNull extends Error {}
function codedError(message, code) { return Object.assign(new Error(message), { code }); }

// ---------------------------------------------------------------- lexer / parser
class Lexer {
  #src;
  #pos = 0;
  constructor(src) { this.#src = src; }
  *tokens() {
    const s = this.#src;
    const re = /\s+|,|#[^\n]*|(\.\.\.)|([{}()[\]:!$@=|])|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*")|([_A-Za-z][_0-9A-Za-z]*)/y;
    while (this.#pos < s.length) {
      re.lastIndex = this.#pos;
      const at = this.#pos;
      const m = re.exec(s);
      if (!m) throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(s[this.#pos])}`, at);
      this.#pos = re.lastIndex;
      if (m[1]) yield { kind: 'spread', value: '...', at };
      else if (m[2]) yield { kind: 'punct', value: m[2], at };
      else if (m[3]) yield { kind: /[.eE]/.test(m[3]) ? 'float' : 'int', value: m[3], at };
      else if (m[4]) yield { kind: 'string', value: JSON.parse(m[4]), at };
      else if (m[5]) yield { kind: 'name', value: m[5], at };
    }
    yield { kind: 'eof', value: '<EOF>', at: s.length };
  }
}
class Parser {
  #toks;
  #i = 0;
  constructor(src) { this.#toks = [...new Lexer(src).tokens()]; }
  peek() { return this.#toks[this.#i]; }
  next() { return this.#toks[this.#i++]; }
  is(kind, value) { const t = this.peek(); return t.kind === kind && (value === undefined || t.value === value); }
  punct(v) { return this.is('punct', v); }
  expect(kind, value) {
    if (!this.is(kind, value)) throw new GraphQLSyntaxError(`Expected ${value ?? kind}, found ${this.peek().value}`, this.peek().at);
    return this.next();
  }
  many(open, close, item) {
    this.expect('punct', open);
    const out = [];
    while (!this.punct(close)) out.push(item());
    this.expect('punct', close);
    return out;
  }
  parseDocument() {
    const definitions = [];
    while (!this.is('eof')) definitions.push(this.parseDefinition());
    if (!definitions.length) throw new GraphQLSyntaxError('Empty document');
    return { kind: 'Document', definitions };
  }
  parseDefinition() {
    if (this.punct('{')) return { kind: 'Operation', operation: 'query', name: null, variables: [], directives: [], selectionSet: this.parseSelectionSet() };
    const t = this.expect('name');
    if (t.value === 'fragment') {
      const name = this.expect('name').value;
      this.expect('name', 'on');
      const typeCondition = this.expect('name').value;
      return { kind: 'Fragment', name, typeCondition, directives: this.parseDirectives(), selectionSet: this.parseSelectionSet() };
    }
    if (!['query', 'mutation', 'subscription'].includes(t.value)) throw new GraphQLSyntaxError(`Unexpected ${t.value}`, t.at);
    const name = this.is('name') ? this.next().value : null;
    const variables = this.punct('(') ? this.many('(', ')', () => {
      this.expect('punct', '$');
      const vname = this.expect('name').value;
      this.expect('punct', ':');
      const type = this.parseTypeNode();
      const def = this.punct('=') ? (this.next(), this.parseValue(true)) : undefined;
      return { name: vname, type, default: def };
    }) : [];
    return { kind: 'Operation', operation: t.value, name, variables, directives: this.parseDirectives(), selectionSet: this.parseSelectionSet() };
  }
  parseTypeNode() {
    let t;
    if (this.punct('[')) {
      this.next();
      t = { kind: 'LIST', of: this.parseTypeNode() };
      this.expect('punct', ']');
    } else t = { kind: 'NAMED', name: this.expect('name').value };
    if (this.punct('!')) { this.next(); t = { kind: 'NON_NULL', of: t }; }
    return t;
  }
  parseSelectionSet() { return this.many('{', '}', () => this.parseSelection()); }
  parseSelection() {
    if (this.is('spread')) {
      this.next();
      if (this.is('name') && !this.is('name', 'on')) return { kind: 'FragmentSpread', name: this.next().value, directives: this.parseDirectives() };
      const typeCondition = this.is('name', 'on') ? (this.next(), this.expect('name').value) : null;
      return { kind: 'InlineFragment', typeCondition, directives: this.parseDirectives(), selectionSet: this.parseSelectionSet() };
    }
    let alias = null, name = this.expect('name').value;
    if (this.punct(':')) { this.next(); alias = name; name = this.expect('name').value; }
    const args = this.punct('(') ? this.parseArgs(false) : [];
    const directives = this.parseDirectives();
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet: this.punct('{') ? this.parseSelectionSet() : null };
  }
  parseArgs(isConst) {
    return this.many('(', ')', () => {
      const name = this.expect('name').value;
      this.expect('punct', ':');
      return { name, value: this.parseValue(isConst) };
    });
  }
  parseDirectives() {
    const ds = [];
    while (this.punct('@')) {
      this.next();
      ds.push({ name: this.expect('name').value, arguments: this.punct('(') ? this.parseArgs(false) : [] });
    }
    return ds;
  }
  parseValue(isConst) {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new GraphQLSyntaxError('Unexpected variable in constant value', t.at);
      this.next();
      return { kind: 'Variable', name: this.expect('name').value };
    }
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string') { this.next(); return { kind: t.kind, value: t.value }; }
    if (this.punct('[')) return { kind: 'List', values: this.many('[', ']', () => this.parseValue(isConst)) };
    if (this.punct('{')) {
      return { kind: 'Object', fields: this.many('{', '}', () => {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        return { name, value: this.parseValue(isConst) };
      }) };
    }
    if (t.kind !== 'name') throw new GraphQLSyntaxError(`Unexpected ${t.value}`, t.at);
    this.next();
    if (t.value === 'true' || t.value === 'false') return { kind: 'Boolean', value: t.value === 'true' };
    return t.value === 'null' ? { kind: 'Null' } : { kind: 'Enum', value: t.value };
  }
}
function printType(t) {
  if (t.kind === 'NON_NULL') return printType(t.of) + '!';
  if (t.kind === 'LIST') return '[' + printType(t.of) + ']';
  return t.name;
}
function namedType(t) {
  while (t.kind !== 'NAMED') t = t.of;
  return t.name;
}

// ---------------------------------------------------------------- schema
class Schema {
  #types = new Map();
  static builtins;
  static {
    const int = (v) => {
      const n = typeof v === 'boolean' ? +v : Number(v);
      if (!Number.isInteger(n) || n > 2147483647 || n < -2147483648) throw new Error(`Int cannot represent non-integer value: ${JSON.stringify(v)}`);
      return n;
    };
    const strict = (type, name) => (v) => {
      if (typeof v !== type) throw new Error(`${name} cannot represent a non ${type} value: ${JSON.stringify(v)}`);
      return v;
    };
    Schema.builtins = [
      { name: 'Int', serialize: int, parseValue: int },
      { name: 'String', serialize: String, parseValue: strict('string', 'String') },
      { name: 'Boolean', serialize: (v) => !!v, parseValue: strict('boolean', 'Boolean') },
      { name: 'ID', serialize: String, parseValue: String },
      { name: 'BigInt', serialize: (v) => (typeof v === 'bigint' ? v : BigInt(v)).toString(), parseValue: (v) => BigInt(v) },
    ];
  }
  constructor() {
    for (const s of Schema.builtins) this.#types.set(s.name, { kind: 'SCALAR', builtin: true, ...s });
  }
  static #norm(spec) {
    const f = typeof spec === 'string' ? { type: spec } : { ...spec };
    f.type = new Parser(f.type).parseTypeNode();
    if (f.args) f.args = Object.fromEntries(Object.entries(f.args).map(([k, a]) => [k, Schema.#norm(a)]));
    return f;
  }
  #def(kind, name, extra, fields) {
    const t = { kind, name, ...extra };
    if (fields) t.fields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { args: {}, ...Schema.#norm(v) }]));
    this.#types.set(name, t);
    return this;
  }
  object(name, fields, interfaces = []) { return this.#def('OBJECT', name, { interfaces }, fields); }
  interface(name, fields, resolveType) { return this.#def('INTERFACE', name, { resolveType }, fields); }
  union(name, members, resolveType) { return this.#def('UNION', name, { members, fields: {}, resolveType }); }
  enum(name, values) { return this.#def('ENUM', name, { values }); }
  input(name, fields) { return this.#def('INPUT', name, {}, fields); }
  getType(name) { return this.#types.get(name); }
  get typeNames() { return [...this.#types.keys()].sort(); }
  possible(abstractName, concrete) {
    const t = this.getType(abstractName);
    if (t?.kind === 'UNION') return t.members.includes(concrete);
    if (t?.kind === 'INTERFACE') return (this.getType(concrete)?.interfaces || []).includes(abstractName);
    return abstractName === concrete;
  }
}

// ---------------------------------------------------------------- validation
function collectVars(v, used) {
  if (!v) return;
  if (v.kind === 'Variable') used.add(v.name);
  else if (v.kind === 'List') v.values.forEach((x) => collectVars(x, used));
  else if (v.kind === 'Object') v.fields.forEach((f) => collectVars(f.value, used));
}
function validate(schema, doc) {
  const errors = [];
  const frags = new Map();
  const ops = doc.definitions.filter((d) => d.kind === 'Operation');
  for (const d of doc.definitions.filter((x) => x.kind === 'Fragment')) {
    if (frags.has(d.name)) errors.push(`There can be only one fragment named "${d.name}".`);
    frags.set(d.name, d);
  }
  const spreadsOf = (sels, out = new Set()) => {
    for (const s of sels || []) s.kind === 'FragmentSpread' ? out.add(s.name) : spreadsOf(s.selectionSet, out);
    return out;
  };
  const reported = new Set();
  const dfs = (start, cur, trail) => {
    for (const nxt of spreadsOf(frags.get(cur)?.selectionSet)) {
      if (nxt === start) {
        const key = [...trail].sort().join(',');
        if (!reported.has(key)) errors.push(`Cannot spread fragment "${start}" within itself via ${trail.slice(1).concat(nxt).join(', ')}.`);
        reported.add(key);
      } else if (!trail.includes(nxt)) dfs(start, nxt, [...trail, nxt]);
    }
  };
  for (const [name] of frags) dfs(name, name, [name]);
  if (ops.length > 1 && ops.some((o) => !o.name)) errors.push('This anonymous operation must be the only defined operation.');
  for (const op of ops) {
    const defined = new Set(op.variables.map((v) => v.name));
    const used = new Set();
    const seenFrags = new Set();
    const root = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }[op.operation];
    const walk = (typeName, sels) => {
      const type = schema.getType(typeName);
      for (const s of sels) {
        for (const d of s.directives || []) d.arguments.forEach((a) => collectVars(a.value, used));
        if (s.kind === 'Field') {
          s.arguments.forEach((a) => collectVars(a.value, used));
          if (s.name === '__typename') continue;
          const def = type.fields?.[s.name];
          if (!def) { errors.push(`Cannot query field "${s.name}" on type "${typeName}".`); continue; }
          for (const a of s.arguments) if (!def.args[a.name]) errors.push(`Unknown argument "${a.name}" on field "${typeName}.${s.name}".`);
          for (const [an, ad] of Object.entries(def.args)) {
            if (ad.type.kind === 'NON_NULL' && ad.default === undefined && !s.arguments.some((a) => a.name === an)) errors.push(`Field "${s.name}" argument "${an}" of type "${printType(ad.type)}" is required, but it was not provided.`);
          }
          const nt = schema.getType(namedType(def.type));
          const leaf = nt.kind === 'SCALAR' || nt.kind === 'ENUM';
          if (leaf && s.selectionSet) errors.push(`Field "${s.name}" must not have a selection since type "${printType(def.type)}" has no subfields.`);
          else if (!leaf && !s.selectionSet) errors.push(`Field "${s.name}" of type "${printType(def.type)}" must have a selection of subfields.`);
          else if (!leaf) walk(nt.name, s.selectionSet);
        } else if (s.kind === 'FragmentSpread') {
          const f = frags.get(s.name);
          if (!f) errors.push(`Unknown fragment "${s.name}".`);
          else if (!seenFrags.has(s.name)) walk(f.typeCondition, f.selectionSet, seenFrags.add(s.name));
        } else {
          const tc = s.typeCondition || typeName;
          if (!schema.getType(tc)) errors.push(`Unknown type "${tc}".`);
          else walk(tc, s.selectionSet);
        }
      }
    };
    if (!schema.getType(root)) errors.push(`Schema is not configured for ${op.operation}s.`);
    else walk(root, op.selectionSet);
    for (const u of used) if (!defined.has(u)) errors.push(`Variable "$${u}" is not defined${op.name ? ` by operation "${op.name}"` : ''}.`);
    for (const d of defined) if (!used.has(d)) errors.push(`Variable "$${d}" is never used.`);
  }
  return errors;
}

// ---------------------------------------------------------------- executor
class Executor {
  #schema;
  #fragments = new Map();
  #vars = {};
  #context;
  errors = [];
  constructor(schema, doc, context) {
    [this.#schema, this.#context] = [schema, context];
    for (const d of doc.definitions) if (d.kind === 'Fragment') this.#fragments.set(d.name, d);
  }
  astToJs(node) {
    switch (node.kind) {
      case 'Variable': return this.#vars[node.name];
      case 'int': return parseInt(node.value, 10);
      case 'float': return parseFloat(node.value);
      case 'string': case 'Boolean': case 'Enum': return node.value;
      case 'Null': return null;
      case 'List': return node.values.map((v) => this.astToJs(v));
      case 'Object': return Object.fromEntries(node.fields.map((f) => [f.name, this.astToJs(f.value)]));
      default: throw new Error('bad value node ' + node.kind);
    }
  }
  coerceInput(type, v, where) {
    if (v == null) {
      if (type.kind === 'NON_NULL') throw new Error(`Expected non-null value for ${where}`);
      return null;
    }
    if (type.kind === 'NON_NULL') return this.coerceInput(type.of, v, where);
    if (type.kind === 'LIST') return (Array.isArray(v) ? v : [v]).map((x, i) => this.coerceInput(type.of, x, `${where}[${i}]`));
    const t = this.#schema.getType(type.name);
    if (t.kind === 'SCALAR') return t.parseValue(v);
    if (t.kind === 'ENUM' && !t.values.includes(v)) throw new Error(`Value ${JSON.stringify(v)} does not exist in "${t.name}" enum.`);
    if (t.kind === 'ENUM') return v;
    if (t.kind === 'INPUT') {
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`Expected object for ${where}`);
      for (const k of Object.keys(v)) if (!t.fields[k]) throw new Error(`Field "${k}" is not defined by type "${t.name}".`);
      const entries = Object.entries(t.fields).map(([k, f]) => [k, this.coerceInput(f.type, v[k] ?? f.default, `${where}.${k}`)]);
      return Object.fromEntries(entries.filter(([, val]) => val !== null));
    }
    throw new Error(`Cannot use ${t.kind} as input`);
  }
  coerceVariables(op, raw = {}) {
    const errs = [];
    for (const vd of op.variables) {
      try {
        if (Object.prototype.hasOwnProperty.call(raw, vd.name)) this.#vars[vd.name] = this.coerceInput(vd.type, raw[vd.name], `$${vd.name}`);
        else if (vd.default) this.#vars[vd.name] = this.coerceInput(vd.type, this.astToJs(vd.default), `$${vd.name}`);
        else if (vd.type.kind === 'NON_NULL') throw new Error(`Variable "$${vd.name}" of required type "${printType(vd.type)}" was not provided.`);
      } catch (e) { errs.push(e.message); }
    }
    return errs;
  }
  argsFor(def, node) {
    const out = {};
    for (const [name, ad] of Object.entries(def.args)) {
      const a = node.arguments.find((x) => x.name === name);
      let v = a ? this.astToJs(a.value) : ad.default;
      if (a && a.value.kind === 'Variable' && v === undefined) v = ad.default;
      const c = this.coerceInput(ad.type, v, `argument "${name}"`);
      if (c !== null) out[name] = c;
    }
    return out;
  }
  shouldInclude(node) {
    for (const d of node.directives || []) {
      const arg = d.arguments.find((a) => a.name === 'if');
      const val = arg ? this.astToJs(arg.value) : undefined;
      if (d.name === 'skip' && val === true) return false;
      if (d.name === 'include' && val === false) return false;
    }
    return true;
  }
  doesApply(cond, typeName) { return !cond || cond === typeName || this.#schema.possible(cond, typeName); }
  collectFields(typeName, sels, fields = new Map(), visited = new Set()) {
    for (const s of sels) {
      if (!this.shouldInclude(s)) continue;
      if (s.kind === 'Field') {
        const key = s.alias || s.name;
        fields.set(key, [...(fields.get(key) || []), s]);
      } else if (s.kind === 'FragmentSpread') {
        if (visited.has(s.name)) continue;
        visited.add(s.name);
        const f = this.#fragments.get(s.name);
        if (f && this.doesApply(f.typeCondition, typeName)) this.collectFields(typeName, f.selectionSet, fields, visited);
      } else if (this.doesApply(s.typeCondition, typeName)) this.collectFields(typeName, s.selectionSet, fields, visited);
    }
    return fields;
  }
  subfields(typeName, nodes) {
    const fields = new Map(), visited = new Set();
    for (const n of nodes) if (n.selectionSet) this.collectFields(typeName, n.selectionSet, fields, visited);
    return fields;
  }
  async executeOperation(op, root) {
    const rootType = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }[op.operation];
    const fields = this.collectFields(rootType, op.selectionSet);
    let data;
    try {
      data = op.operation === 'mutation' ? await this.executeSerially(rootType, root, fields) : await this.executeFields(rootType, root, fields, []);
    } catch (e) {
      if (!(e instanceof PropagatedNull)) throw e;
      data = null;
    }
    const errors = this.errors.slice().sort((a, b) => a.path.join('.').localeCompare(b.path.join('.')));
    return errors.length ? { data, errors } : { data };
  }
  async executeSerially(typeName, source, fields) {
    const out = {};
    for (const [k, nodes] of fields) out[k] = await this.resolveField(typeName, source, nodes, [k]);
    return out;
  }
  async executeFields(typeName, source, fields, path) {
    const keys = [...fields.keys()];
    const vals = await Promise.all(keys.map((k) => this.resolveField(typeName, source, fields.get(k), [...path, k])));
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  }
  async resolveField(parentType, source, nodes, path) {
    const node = nodes[0];
    if (node.name === '__typename') return parentType;
    const def = this.#schema.getType(parentType).fields[node.name];
    try {
      const args = this.argsFor(def, node);
      const info = { fieldName: node.name, parentType, path, returnType: printType(def.type), schema: this.#schema };
      const raw = await (def.resolve ? def.resolve(source, args, this.#context, info)
        : typeof source?.[node.name] === 'function' ? source[node.name](args) : source?.[node.name]);
      return await this.completeValue(def.type, nodes, raw, path);
    } catch (e) {
      if (!(e instanceof PropagatedNull)) this.errors.push(new GraphQLError(e.message, path, e.code));
      if (def.type.kind === 'NON_NULL') throw new PropagatedNull();
      return null;
    }
  }
  async completeValue(type, nodes, value, path) {
    if (type.kind === 'NON_NULL') {
      const r = await this.completeValue(type.of, nodes, value, path);
      if (r === null) throw new Error(`Cannot return null for non-nullable field ${path.filter((p) => typeof p === 'string').join('.')}.`);
      return r;
    }
    if (value === null || value === undefined) return null;
    if (value instanceof Error) throw value;
    if (type.kind === 'LIST') {
      if (typeof value[Symbol.iterator] !== 'function') throw new Error('Expected Iterable for list field');
      return Promise.all([...value].map(async (v, i) => {
        const p = [...path, i];
        try { return await this.completeValue(type.of, nodes, v, p); } catch (e) {
          if (!(e instanceof PropagatedNull)) this.errors.push(new GraphQLError(e.message, p, e.code));
          if (type.of.kind === 'NON_NULL') throw new PropagatedNull();
          return null;
        }
      }));
    }
    const t = this.#schema.getType(type.name);
    switch (t.kind) {
      case 'SCALAR': return t.serialize(value);
      case 'ENUM':
        if (!t.values.includes(value)) throw new Error(`Enum "${t.name}" cannot represent value: ${JSON.stringify(value)}`);
        return value;
      case 'OBJECT': return this.executeFields(t.name, value, this.subfields(t.name, nodes), path);
      default: {
        const concrete = t.resolveType(value);
        if (!this.#schema.possible(t.name, concrete)) throw new Error(`Abstract type "${t.name}" resolved to invalid "${concrete}"`);
        return this.executeFields(concrete, value, this.subfields(concrete, nodes), path);
      }
    }
  }
}

// ---------------------------------------------------------------- data loader
class Loader {
  #batchFn;
  #queue = [];
  #cache = new Map();
  batches = [];
  constructor(batchFn) { this.#batchFn = batchFn; }
  load(key) {
    if (this.#cache.has(key)) return this.#cache.get(key);
    const p = new Promise((resolve, reject) => {
      if (this.#queue.push({ key, resolve, reject }) === 1) process.nextTick(() => this.#dispatch());
    });
    return this.#cache.set(key, p).get(key);
  }
  loadMany(keys) { return Promise.all(keys.map((k) => this.load(k))); }
  clear(key) { this.#cache.delete(key); }
  #dispatch() {
    const [q] = [this.#queue, (this.#queue = [])];
    this.batches.push(q.map((x) => x.key).join(','));
    Promise.resolve(this.#batchFn(q.map((x) => x.key))).then(
      (vals) => q.forEach((x, i) => (vals[i] instanceof Error ? x.reject(vals[i]) : x.resolve(vals[i]))),
      (err) => q.forEach((x) => x.reject(err)),
    );
  }
}

// ---------------------------------------------------------------- data + schema
const db = { users: new Map(), posts: new Map(), comments: new Map(), nextPost: 1 };
function seed() {
  const users = [
    ['u1', 'Ada Lovelace', 'ADMIN', ['u2', 'u3']],
    ['u2', 'Grace Hopper', 'EDITOR', ['u1']],
    ['u3', 'Alan Turing', 'READER', ['u1', 'u2', 'u4']],
    ['u4', 'Edsger Dijkstra', 'EDITOR', []],
  ];
  for (const [id, name, role, friendIds] of users) db.users.set(id, { __kind: 'User', id, name, role, friendIds });
  const posts = [
    ['u1', 'Notes on the Engine', 'The analytical engine weaves algebraic patterns.', ['math', 'history'], 12],
    ['u2', 'Nanoseconds explained', 'A nanosecond is about thirty centimetres of wire.', ['hardware'], 30],
    ['u3', 'Computable numbers', 'On computable numbers with an application.', ['math', 'theory'], 25],
    ['u1', 'Poetical science', 'Imagination is the discovering faculty.', ['essay'], 7],
    ['u99', 'Orphaned draft', 'Author vanished.', ['orphan'], 0],
  ];
  for (const [authorId, title, body, tags, likes, id = 'p' + db.nextPost++] of posts) db.posts.set(id, { __kind: 'Post', id, authorId, title, body, tags, likes, published: authorId !== 'u99' });
  const comments = [['p1', 'u2', 'Brilliant!'], ['p1', 'u3', 'Which engine?'], ['p3', 'u1', 'Elegant proof.'], ['p3', 'u99', 'spam'], ['p2', 'u4', 'Goto considered harmful']];
  comments.forEach(([postId, authorId, text], i) => db.comments.set('c' + (i + 1), { __kind: 'Comment', id: 'c' + (i + 1), postId, authorId, text }));
}
const pubsub = new EventEmitter();
function makeContext(userId) {
  const userLoader = new Loader((ids) => ids.map((id) => db.users.get(id) || codedError(`User ${id} not found`, 'NOT_FOUND')));
  const postsByAuthor = new Loader((ids) => ids.map((id) => [...db.posts.values()].filter((p) => p.authorId === id && p.published)));
  return { user: userId ? db.users.get(userId) || null : null, userLoader, postsByAuthor };
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function karmaOf(user) {
  let k = 1n;
  const n = BigInt(user.id.slice(1));
  for (let i = 0n; i < n * 15n; i++) k = k * 3n + i;
  return k;
}
function buildSchema() {
  const s = new Schema();
  s.enum('Role', ['ADMIN', 'EDITOR', 'READER']);
  s.enum('PostOrder', ['LIKES_DESC', 'TITLE_ASC', 'ID_ASC']);
  s.input('PostInput', { title: 'String!', body: 'String', tags: '[String!]' });
  s.interface('Node', { id: 'ID!' }, (v) => ({ u: 'User', p: 'Post', c: 'Comment' })[v.id[0]]);
  s.union('SearchResult', ['User', 'Post'], (v) => v.__kind);
  s.object('User', {
    id: 'ID!', name: 'String!', role: 'Role!',
    friends: { type: '[User!]!', resolve: (u, a, ctx) => ctx.userLoader.loadMany(u.friendIds) },
    posts: { type: '[Post!]!', args: { first: 'Int' }, resolve: async (u, { first }, ctx) => (await ctx.postsByAuthor.load(u.id)).slice(0, first ?? 99) },
    postCount: { type: 'Int!', resolve: async (u, a, ctx) => (await ctx.postsByAuthor.load(u.id)).length },
    karma: { type: 'BigInt', resolve: (u) => karmaOf(u) },
    badge: { type: 'String', resolve: (u) => { if (u.role === 'READER') throw codedError('badge service unavailable for READER', 'UNAVAILABLE'); return `${u.role[0]}-${u.id}`; } },
  }, ['Node']);
  s.object('Post', {
    id: 'ID!', title: 'String!', tags: '[String!]!', likes: 'Int!',
    slug: { type: 'String!', resolve: (p) => slugify(p.title) },
    body: { type: 'String', args: { truncate: 'Int' }, resolve: (p, { truncate }) => (truncate && p.body.length > truncate ? p.body.slice(0, truncate) + '...' : p.body) },
    author: { type: 'User!', resolve: (p, a, ctx) => ctx.userLoader.load(p.authorId) },
    comments: { type: '[Comment]!', resolve: (p) => [...db.comments.values()].filter((c) => c.postId === p.id) },
  }, ['Node']);
  s.object('Comment', {
    id: 'ID!', text: 'String!',
    author: { type: 'User!', resolve: (c, a, ctx) => ctx.userLoader.load(c.authorId) },
    post: { type: 'Post', resolve: (c) => db.posts.get(c.postId) },
  }, ['Node']);
  s.object('Stats', { users: 'Int!', posts: 'Int!', comments: 'Int!', loaderBatches: '[String!]!' });
  s.object('__Field', { name: 'String!', type: 'String!', args: '[String!]!' });
  s.object('__Type', { name: 'String!', kind: 'String!', fields: '[__Field!]', possibleTypes: '[String!]', enumValues: '[String!]' });
  const describe = (t) => t && { name: t.name, kind: t.kind, possibleTypes: t.members ?? null, enumValues: t.values ?? null,
    fields: t.fields && t.kind !== 'UNION' ? Object.entries(t.fields).map(([n, f]) => ({ name: n, type: printType(f.type), args: Object.keys(f.args) })) : null };
  s.object('Query', {
    me: { type: 'User', resolve: (r, a, ctx) => ctx.user },
    user: { type: 'User', args: { id: 'ID!' }, resolve: (r, { id }, ctx) => ctx.userLoader.load(id).catch(() => null) },
    users: {
      type: '[User!]!', args: { role: 'Role', first: { type: 'Int', default: 10 }, offset: { type: 'Int', default: 0 } },
      resolve: (r, { role, first, offset }) => [...db.users.values()].filter((u) => !role || u.role === role).slice(offset, offset + first),
    },
    post: { type: 'Post', args: { id: 'ID!' }, resolve: (r, { id }) => db.posts.get(id) },
    posts: {
      type: '[Post!]!', args: { tag: 'String', orderBy: { type: 'PostOrder', default: 'ID_ASC' } },
      resolve: (r, { tag, orderBy }) => [...db.posts.values()].filter((p) => p.published && (!tag || p.tags.includes(tag)))
        .sort({ LIKES_DESC: (a, b) => b.likes - a.likes, TITLE_ASC: (a, b) => a.title.localeCompare(b.title), ID_ASC: (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) }[orderBy]),
    },
    search: {
      type: '[SearchResult!]!', args: { term: 'String!' },
      resolve: (r, { term }) => {
        const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return [...[...db.users.values()].filter((u) => re.test(u.name)), ...[...db.posts.values()].filter((p) => p.published && re.test(p.title))];
      },
    },
    node: { type: 'Node', args: { id: 'ID!' }, resolve: (r, { id }) => db.users.get(id) || db.posts.get(id) || db.comments.get(id) },
    fib: { type: 'BigInt!', args: { n: 'Int!' }, resolve: (r, { n }) => { if (n < 0) throw codedError('n must be >= 0', 'BAD_USER_INPUT'); let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; } },
    stats: { type: 'Stats!', resolve: async (r, a, ctx) => { await new Promise((res) => setImmediate(res)); return { users: db.users.size, posts: db.posts.size, comments: db.comments.size, loaderBatches: ctx.userLoader.batches.concat(ctx.postsByAuthor.batches.map((b) => 'posts:' + b)) }; } },
    failing: { type: 'String', resolve: () => { throw new Error('resolver failed on purpose'); } },
    strictFailing: { type: 'String!', resolve: () => null },
    __type: { type: '__Type', args: { name: 'String!' }, resolve: (r, { name }, ctx, info) => describe(info.schema.getType(name)) },
  });
  s.object('Mutation', {
    createPost: {
      type: 'Post!', args: { input: 'PostInput!' },
      resolve: (r, { input }, ctx) => {
        if (!ctx.user) throw codedError('must be logged in', 'UNAUTHENTICATED');
        if (!/^[\w\s'!?-]{3,40}$/.test(input.title)) throw codedError(`invalid title ${JSON.stringify(input.title)}`, 'BAD_USER_INPUT');
        const post = { __kind: 'Post', id: 'p' + db.nextPost++, authorId: ctx.user.id, title: input.title, body: input.body ?? '', tags: input.tags ?? [], likes: 0, published: true };
        return db.posts.set(post.id, post).get(post.id);
      },
    },
    likePost: {
      type: 'Post', args: { id: 'ID!', times: { type: 'Int', default: 1 } },
      resolve: (r, { id, times }) => {
        const p = db.posts.get(id);
        if (!p) throw codedError(`no post ${id}`, 'NOT_FOUND');
        p.likes += times;
        pubsub.emit('postLiked', p);
        return p;
      },
    },
    deleteComment: { type: 'Boolean!', args: { id: 'ID!' }, resolve: (r, { id }, ctx) => { if (ctx.user?.role !== 'ADMIN') throw codedError('forbidden', 'FORBIDDEN'); return db.comments.delete(id); } },
    renameUser: { type: 'User', args: { id: 'ID!', name: 'String!' }, resolve: (r, { id, name }) => { const u = db.users.get(id); if (u) u.name = name; return u; } },
  });
  s.object('Subscription', { postLiked: { type: 'Post', args: { limit: { type: 'Int', default: 2 } } } });
  return s;
}

// ---------------------------------------------------------------- server
class GraphQLServer extends EventEmitter {
  #schema;
  #server = null;
  #docCache = new Map();
  requests = 0;
  port = 0;
  constructor(schema) { super(); this.#schema = schema; }
  #parse(query) {
    if (!this.#docCache.has(query)) this.#docCache.set(query, new Parser(query).parseDocument());
    return this.#docCache.get(query);
  }
  get cacheSize() { return this.#docCache.size; }
  #send(res, status, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }).end(s);
  }
  async #handle(req, res) {
    this.requests++;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method !== 'POST' || req.url !== '/graphql') return this.#send(res, 404, { errors: [{ message: `No route for ${req.method} ${req.url.split('?')[0]}` }] });
    let payload, doc;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return this.#send(res, 400, { errors: [{ message: 'Invalid JSON body' }] }); }
    try { doc = this.#parse(payload.query || ''); } catch (e) { return this.#send(res, 400, { errors: [{ message: e.message }] }); }
    const verrs = validate(this.#schema, doc);
    if (verrs.length) return this.#send(res, 400, { errors: verrs.map((message) => ({ message })) });
    const ops = doc.definitions.filter((d) => d.kind === 'Operation');
    const op = payload.operationName ? ops.find((o) => o.name === payload.operationName) : ops[0];
    if (!op) return this.#send(res, 400, { errors: [{ message: `Unknown operation named "${payload.operationName}".` }] });
    const ctx = makeContext(req.headers['x-user']);
    if (op.operation === 'subscription') return this.#subscribe(res, doc, op, payload.variables, ctx);
    const ex = new Executor(this.#schema, doc, ctx);
    const vErrs = ex.coerceVariables(op, payload.variables);
    if (vErrs.length) return this.#send(res, 400, { errors: vErrs.map((message) => ({ message })) });
    const result = await ex.executeOperation(op, {});
    this.#send(res, 200, result);
  }
  async #subscribe(res, doc, op, variables, ctx) {
    const mk = () => { const ex = new Executor(this.#schema, doc, ctx); ex.coerceVariables(op, variables); return ex; };
    const field = op.selectionSet.find((s) => s.kind === 'Field');
    const { limit } = mk().argsFor(this.#schema.getType('Subscription').fields[field.name], field);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ ready: true, limit }) + '\n');
    let count = 0;
    for await (const [post] of on(pubsub, 'postLiked')) {
      res.write(JSON.stringify(await mk().executeOperation(op, { [field.name]: { ...post } })) + '\n');
      if (++count >= limit) break;
    }
    res.end(JSON.stringify({ complete: true, count }) + '\n');
  }
  async listen() {
    this.#server = http.createServer((req, res) => this.#handle(req, res).catch((e) => this.#send(res, 500, { errors: [{ message: 'internal: ' + e.message }] })));
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    this.port = this.#server.address().port;
  }
  async close() {
    const done = once(this.#server, 'close');
    this.#server.closeAllConnections();
    this.#server.close();
    await done;
  }
}

// ---------------------------------------------------------------- client
function rawRequest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = body == null ? headers : { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
async function* ndjson(stream) {
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}
class Client {
  #port;
  #n = 0;
  constructor(port) { this.#port = port; }
  async gql(label, query, variables, opts = {}) {
    const body = JSON.stringify({ query, variables, operationName: opts.operationName, extensions: opts.extensions });
    const r = await rawRequest(this.#port, 'POST', '/graphql', body, opts.user ? { 'x-user': opts.user } : {});
    this.print(label, r);
    return JSON.parse(r.text);
  }
  print(label, r) {
    this.#n++;
    const j = JSON.parse(r.text);
    console.log(`[${String(this.#n).padStart(2, '0')}] ${label} -> ${r.status}`);
    if ('data' in j) console.log('     data: ' + JSON.stringify(j.data));
    for (const e of j.errors || []) console.log(`     error: ${e.message}${e.path ? ' @' + e.path.join('.') : ''}${e.extensions ? ' [' + e.extensions.code + ']' : ''}`);
  }
  async get(label, path) { this.print(label, await rawRequest(this.#port, 'GET', path, null)); }
  raw(method, path, body) { return rawRequest(this.#port, method, path, body); }
  async subscribe(query, variables) {
    const body = JSON.stringify({ query, variables });
    const req = http.request({ host: '127.0.0.1', port: this.#port, method: 'POST', path: '/graphql', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.end(body);
    const [res] = await once(req, 'response');
    res.setEncoding('utf8');
    const it = ndjson(res);
    const first = (await it.next()).value;
    const done = (async () => { const all = []; for await (const line of it) all.push(line); return all; })();
    return { first, done };
  }
}

// ---------------------------------------------------------------- main
async function main() {
  seed();
  const schema = buildSchema();
  const server = new GraphQLServer(schema);
  await server.listen();
  const c = new Client(server.port);
  console.log('--- schema ---');
  console.log('  types: ' + schema.typeNames.join(' '));
  console.log('--- queries ---');
  await c.gql('simple', '{ user(id: "u1") { id name role } }');
  await c.gql('aliases+args', '{ a: user(id: "u2") { name } b: user(id: "u3") { name } missing: user(id: "u42") { name } }');
  await c.gql('nested friends (batched)', `query Friends { users(first: 3) { name friends { name friends { id } } } stats { loaderBatches } }`);
  await c.gql('fragments', `query WithFrags($id: ID!) { post(id: $id) { ...PostBits comments { ...CommentBits } } }
    fragment PostBits on Post { id title slug likes tags author { ...UserBits } } fragment UserBits on User { name postCount }
    fragment CommentBits on Comment { text author { name } }`, { id: 'p1' });
  await c.gql('directives', `query D($full: Boolean!, $lean: Boolean = true) { post(id: "p2") { title body @include(if: $full) likes @skip(if: $lean) short: body(truncate: 12) } }`, { full: false });
  await c.gql('directives flipped', `query D($full: Boolean!, $lean: Boolean = true) { post(id: "p2") { title body @include(if: $full) likes @skip(if: $lean) } }`, { full: true, lean: false });
  await c.gql('enum args + ordering', '{ posts(orderBy: LIKES_DESC) { id likes } editors: users(role: EDITOR) { name } }');
  await c.gql('filter by tag', '{ posts(tag: "math", orderBy: TITLE_ASC) { title author { name } } }');
  await c.gql('union search', '{ search(term: "o") { __typename ... on User { name role } ... on Post { title } } }');
  await c.gql('interface node', '{ a: node(id: "u4") { id __typename ... on User { name } } b: node(id: "c3") { id ... on Comment { text post { title } } } }');
  await c.gql('bigint scalars', '{ f90: fib(n: 90) f150: fib(n: 150) user(id: "u2") { karma } }');
  await c.gql('partial errors', '{ users { name badge } failing }');
  await c.gql('null propagation (nested)', '{ post(id: "p5") { title author { name } } }');
  await c.gql('null in list item', '{ post(id: "p3") { title comments { text author { name } } } }');
  await c.gql('null propagation (root)', '{ user(id: "u1") { name } strictFailing }');
  await c.gql('coded error', '{ fib(n: -1) }');
  await c.gql('introspection', '{ __type(name: "Post") { name kind fields { name type args } } r: __type(name: "Role") { enumValues } u: __type(name: "SearchResult") { possibleTypes } }');
  await c.gql('me anonymous', '{ me { name } }');
  await c.gql('me authed', '{ me { name posts(first: 1) { title } } }', undefined, { user: 'u2' });
  await c.gql('operationName select', 'query A { user(id: "u1") { name } } query B { user(id: "u4") { name } }', undefined, { operationName: 'B' });
  console.log('--- validation / syntax ---');
  await c.gql('unknown field', '{ user(id: "u1") { name email } }');
  await c.gql('missing arg + leaf selection', '{ user { name } fib(n: 3) { x } posts }');
  await c.gql('undefined/unused vars', 'query Q($unused: Int) { user(id: $nope) { name } }');
  await c.gql('fragment cycle', '{ user(id: "u1") { ...A } } fragment A on User { friends { ...B } } fragment B on User { ...A }');
  await c.gql('syntax error', '{ user(id: "u1") { name }');
  await c.gql('bad char', '{ user(id: "u1") { name % } }');
  await c.gql('bad variable type', 'query Q($id: ID!, $n: Int!) { user(id: $id) { name } fib(n: $n) }', { id: 'u1', n: 'ten' });
  await c.gql('missing variable', 'query Q($id: ID!) { user(id: $id) { name } }', {});
  await c.gql('unknown operation', 'query A { stats { users } }', undefined, { operationName: 'Z' });
  console.log('--- mutations ---');
  await c.gql('create unauthenticated', 'mutation { createPost(input: { title: "Hello" }) { id } }');
  await c.gql('create bad title', 'mutation { createPost(input: { title: "<script>" }) { id } }', undefined, { user: 'u4' });
  await c.gql('create with vars', 'mutation New($in: PostInput!) { createPost(input: $in) { id title slug tags author { name postCount } } }',
    { in: { title: "Go To Statement Considered Harmful", body: 'Letter to the editor', tags: ['essay', 'structured'] } }, { user: 'u4' });
  await c.gql('input unknown field', 'mutation New($in: PostInput!) { createPost(input: $in) { id } }', { in: { title: 'x y z', color: 'red' } }, { user: 'u4' });
  await c.gql('serial mutations', 'mutation { first: likePost(id: "p4") { likes } second: likePost(id: "p4", times: 5) { likes } rename: renameUser(id: "u3", name: "A. M. Turing") { name } gone: likePost(id: "p404") { likes } }');
  await c.gql('delete forbidden', 'mutation { deleteComment(id: "c4") }', undefined, { user: 'u2' });
  await c.gql('delete as admin', 'mutation { deleteComment(id: "c4") again: deleteComment(id: "c4") }', undefined, { user: 'u1' });
  await c.gql('after mutations', '{ posts(orderBy: LIKES_DESC) { id title likes } user(id: "u3") { name } }');
  console.log('--- transport ---');
  await c.gql('stats', '{ stats { users posts comments } }');
  await c.get('404 route', '/nowhere');
  const bad = await c.raw('POST', '/graphql', '{not json');
  c.print('invalid json', bad);
  console.log('--- subscription ---');
  const sub = await c.subscribe('subscription Watch($n: Int) { postLiked(limit: $n) { id title likes author { name } } }', { n: 3 });
  console.log('  first line: ' + sub.first);
  for (const id of ['p1', 'p2', 'p1']) await c.gql(`like ${id}`, `mutation { likePost(id: "${id}", times: 2) { likes } }`);
  const lines = await sub.done;
  lines.forEach((l) => console.log('  event: ' + l));
  console.log(`  pubsub listeners left: ${pubsub.listenerCount('postLiked')}`);
  console.log('--- summary ---');
  console.log(`  server requests=${server.requests} parsed docs cached=${server.cacheSize}`);
  console.log(`  posts=${db.posts.size} comments=${db.comments.size} digest=${crypto.createHash("sha1").update(JSON.stringify([...db.posts.values()])).digest("hex").slice(0, 12)}`);
  await server.close();
}
process.on('exit', (code) => console.log(`exit ${code}`));
main().catch((e) => {
  console.log('FATAL ' + e.stack);
  process.exitCode = 1;
});
